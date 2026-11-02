import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { Framer, FramingError, type Frame } from '../src/index.js';

const MSG = '<OWNMsg Profile="V3"><Payload><ActionID>a</ActionID></Payload></OWNMsg>';
const LEGACY = '<OWNxml><Hdr/></OWNxml>';

const bytes = (text: string) => Buffer.from(text, 'utf8');

describe('Framer', () => {
  it('splits OpenWebNet and XML frames, skipping whitespace and declarations', () => {
    const framer = new Framer();
    const frames = framer.push(bytes(`*#*1##\r\n${MSG}  <?xml version="1.0"?>${LEGACY}`));
    expect(frames).toEqual<Frame[]>([
      { kind: 'own', text: '*#*1##' },
      { kind: 'xml', text: MSG },
      { kind: 'xml', text: LEGACY },
    ]);
    expect(framer.pendingBytes).toBe(0);
  });

  it('waits for incomplete frames', () => {
    const framer = new Framer();
    expect(framer.push(bytes('*#*1'))).toEqual([]);
    expect(framer.push(bytes('##<OWN'))).toEqual([{ kind: 'own', text: '*#*1##' }]);
    expect(framer.push(bytes(MSG.slice(4, 30)))).toEqual([]);
    expect(framer.push(bytes(MSG.slice(30)))).toEqual([{ kind: 'xml', text: MSG }]);
  });

  it('reassembles any chunking of a stream', () => {
    const stream = `*#*1##${MSG}\n${MSG}*#*0##${LEGACY}`;
    const expected = new Framer().push(bytes(stream));
    fc.assert(
      fc.property(fc.array(fc.nat(stream.length), { maxLength: 12 }), (cuts) => {
        const points = [...new Set(cuts)].sort((a, b) => a - b);
        const framer = new Framer();
        const frames: Frame[] = [];
        let previous = 0;
        for (const point of [...points, stream.length]) {
          frames.push(...framer.push(bytes(stream.slice(previous, point))));
          previous = point;
        }
        expect(frames).toEqual(expected);
      }),
    );
  });

  it('keeps multi-byte characters split across chunks', () => {
    const text = '<OWNMsg>é</OWNMsg>';
    const raw = bytes(text);
    const framer = new Framer();
    expect(framer.push(raw.subarray(0, 9))).toEqual([]);
    expect(framer.push(raw.subarray(9))).toEqual([{ kind: 'xml', text }]);
  });

  it.each([
    ['garbage', 'hello'],
    ['unknown root', '<Other/>'],
    ['root with a longer name', '<OWNMsgX>'],
    ['malformed OpenWebNet frame', '*ab##'],
    ['overlong OpenWebNet frame', `*${'1'.repeat(100)}`],
    ['overlong declaration', `<?xml ${'a'.repeat(300)}`],
  ])('rejects %s', (_name, input) => {
    expect(() => new Framer().push(bytes(input))).toThrow(FramingError);
  });

  it('rejects frames over the size limit', () => {
    const framer = new Framer(100);
    expect(() => framer.push(bytes(`<OWNMsg>${'x'.repeat(200)}`))).toThrow(/too large/);
  });

  it('rejects invalid UTF-8', () => {
    const framer = new Framer();
    expect(() => framer.push(Buffer.concat([bytes('<OWNMsg>'), Buffer.from([0xff]), bytes('</OWNMsg>')]))).toThrow(
      /UTF-8/,
    );
  });

  it('can be reset', () => {
    const framer = new Framer();
    framer.push(bytes('<OWNMsg>'));
    framer.reset();
    expect(framer.pendingBytes).toBe(0);
  });
});
