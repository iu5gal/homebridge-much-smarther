import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { decodeDocument, flattenParams, Framer, parseDeviceState, parseProgramList, type XOpenMessage } from '../src/index.js';

// Messages captured from a real X8000 and sanitized: synthetic SeqIDs,
// address, setpoints and program dates (see PROTOCOL.md §6.1).
const fixture = (name: string) => readFileSync(new URL(`fixtures/x8000/${name}.xml`, import.meta.url), 'utf8').trim();

function decode(name: string): XOpenMessage {
  const frames = new Framer().push(Buffer.from(fixture(name)));
  expect(frames).toHaveLength(1);
  const document = decodeDocument(frames[0]?.text ?? '');
  if (document.kind !== 'v3') throw new Error('not a V3 message');
  return document.message;
}

function state(name: string) {
  const { state, issues } = parseDeviceState(flattenParams(decode(name)));
  expect(issues).toEqual([]);
  return state;
}

describe('real device messages', () => {
  it('reads the state in AUTOMATIC', () => {
    const message = decode('rsp-device-state-automatic');
    expect(message).toMatchObject({ service: 'RSP', progress: 2, who: '4', where: '', actionId: 'device_state' });
    expect(state('rsp-device-state-automatic')).toMatchObject({
      mode: 'AUTOMATIC',
      function: 'HEATING',
      setpoint: 20,
      programNumber: 1,
      heatingActive: false,
      coolingActive: false,
      deviceClockValid: true,
    });
    expect(state('rsp-device-state-automatic').validity).toBeUndefined();
  });

  it('reads the AckMsg that follows a data response', () => {
    const ack = decode('rsp-ack-after-data');
    expect(ack).toMatchObject({ service: 'RSP', actionId: 'AckMsg', params: [] });
    expect(ack.seqId).toBe(decode('rsp-device-state-automatic').seqId);
  });

  it('reads a timed MANUAL', () => {
    expect(state('evt-manual-until')).toMatchObject({
      mode: 'MANUAL',
      setpoint: 20.7,
      heatingActive: true,
      validity: { start: '2026-10-28T18:37:52', end: '2026-10-28T23:00:00' },
    });
  });

  it('reads a BOOST and derives its duration', () => {
    const boost = state('evt-boost');
    expect(boost).toMatchObject({ mode: 'BOOST', heatingActive: true, boostMinutes: 30 });
    expect(boost.raw.has('boostTime')).toBe(false);
  });

  it('reads Off as PROTECTION, with and without an end time', () => {
    expect(state('evt-protection-forever')).toMatchObject({ mode: 'PROTECTION', setpoint: 7 });
    expect(state('evt-protection-forever').validity).toBeUndefined();
    expect(state('evt-protection-until')).toMatchObject({
      mode: 'PROTECTION',
      setpoint: 7,
      validity: { start: '2026-10-29T21:57:14', end: '2026-10-29T22:00:01' },
    });
  });

  it('reads the program list', () => {
    const slots = parseProgramList(decode('rsp-program-list').params);
    expect(slots).toHaveLength(11);
    expect(slots.filter((slot) => slot.present).map((slot) => slot.number)).toEqual([0, 1, 2, 3]);
    expect(slots[0]).toEqual({ number: 0, present: true });
    expect(slots[10]).toEqual({ number: 10, present: false });
  });

  it('contains no real address', () => {
    for (const name of ['rsp-device-state-automatic', 'evt-manual-until', 'evt-boost', 'evt-protection-until']) {
      expect(flattenParams(decode(name)).get('ip')).toBe('192.0.2.10');
    }
  });
});
