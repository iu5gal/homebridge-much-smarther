import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FAKE_PERSONAL_VALUES, FakeThermostat, syntheticConfiguration, syntheticProgram } from '@much-smarther/simulator';
import { createHash } from 'node:crypto';
import { XOpenClient } from '@much-smarther/core';
import {
  checksumDiagnosis,
  denylistBlocks,
  denylistEntry,
  describeStructure,
  HIDDEN,
  personalCandidates,
} from '../../tools/lib/file-report.mjs';
import { runProbe } from '../../tools/lib/probe.mjs';

const PASSWORD = 'fake-pin-5555';

describe('describeStructure', () => {
  it('shows known settings and hides everything else', () => {
    const lines = describeStructure(syntheticConfiguration());
    expect(lines).toContain('    heating_protection_temperature = 7.000000');
    expect(lines).toContain('    heating_day_temperature = 19.799999');
    expect(lines).toContain('      ssid = «hidden»');
    expect(lines).toContain('      password = «hidden»');
    expect(lines).toContain('  plant_id = «hidden»');
    const text = lines.join('\n');
    for (const personal of Object.values(FAKE_PERSONAL_VALUES)) expect(text).not.toContain(personal);
  });

  it('hides fields it does not know', () => {
    expect(describeStructure('<configuration><owner_email>a@example.com</owner_email></configuration>')).toEqual([
      'configuration',
      `  owner_email = ${HIDDEN}`,
    ]);
  });

  it('shows the slots of a program but not its name', () => {
    const lines = describeStructure(syntheticProgram(1));
    expect(lines).toContain('    name = «hidden»');
    expect(lines).toContain('    type = WEEKLY');
    expect(lines).toContain('      slot [id="1" preset="DAY" time="06:30"]');
  });

  it('hides attributes of other elements', () => {
    expect(describeStructure('<configuration><x secret="1"/></configuration>')).toEqual([
      'configuration',
      `  x [secret=${HIDDEN}]`,
    ]);
  });
});

describe('personalCandidates', () => {
  it('lists the values that identify the installation, never the Wi-Fi password', () => {
    const candidates = personalCandidates(syntheticConfiguration());
    expect(candidates).toEqual([
      { field: 'plant_id', value: FAKE_PERSONAL_VALUES.plantId },
      { field: 'friendly_name', value: FAKE_PERSONAL_VALUES.friendlyName },
      { field: 'router_mac_address', value: FAKE_PERSONAL_VALUES.routerMac },
      { field: 'network/wlan/ssid', value: FAKE_PERSONAL_VALUES.ssid },
      { field: 'geolocation/latitude', value: FAKE_PERSONAL_VALUES.latitude },
      { field: 'geolocation/longitude', value: FAKE_PERSONAL_VALUES.longitude },
    ]);
    expect(JSON.stringify(candidates)).not.toContain(FAKE_PERSONAL_VALUES.wifiPassword);
  });

  it('skips defaults such as zero coordinates and an all-zero identifier', () => {
    const text =
      '<configuration><plant_id>00000000000</plant_id><geolocation><latitude>0.0</latitude>' +
      '<longitude>0.0</longitude></geolocation><friendly_name /></configuration>';
    expect(personalCandidates(text)).toEqual([]);
  });
});

describe('checksumDiagnosis', () => {
  const sha = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
  const text = '<configuration>\n<friendly_name>Caffè</friendly_name>\n</configuration>';

  it.each([
    ['Latin-1 bytes', sha(Buffer.from(text, 'latin1'))],
    ['CRLF line ends', sha(text.replace(/\n/g, '\r\n'))],
    ['with a final newline', sha(`${text}\n`)],
    ['with an XML declaration', sha(`<?xml version="1.0" encoding="utf-8"?>${text}`)],
  ])('finds the variant %s', (variant, expected) => {
    expect(checksumDiagnosis(text, expected).matching).toEqual([variant]);
  });

  it('reports facts about the text but never the text', () => {
    const { facts, matching } = checksumDiagnosis(text, '0'.repeat(64));
    expect(matching).toEqual([]);
    expect(facts).toContain('1 non-ASCII characters');
    expect(facts).toContain('2 LF, 0 CR');
    expect(facts.join(' ')).not.toContain('Caff');
  });
});

describe('denylist helpers', () => {
  const denylist = ['# comment', 'literal:192.0.2.', 'exact:Example Home', ''].join('\n');

  it.each([
    ['192.0.2.7', true],
    ['example home', true],
    ['Example Home 2', false],
    ['198.51.100.1', false],
  ])('knows whether %j is blocked', (value, blocked) => {
    expect(denylistBlocks(denylist, value)).toBe(blocked);
  });

  it('writes exact entries', () => {
    expect(denylistEntry('Example Home')).toBe('exact:Example Home');
  });
});

describe('runProbe against the simulator', () => {
  let thermostat: FakeThermostat;
  let client: XOpenClient;
  const logLines: string[] = [];

  beforeEach(async () => {
    thermostat = new FakeThermostat({ password: PASSWORD, programs: [0, 1] });
    await thermostat.start();
    const log = (line: string) => logLines.push(line);
    client = new XOpenClient({
      host: '127.0.0.1',
      port: thermostat.port,
      password: PASSWORD,
      logger: { debug: log, info: log, warn: log, error: log },
      minCommandIntervalMs: 0,
    });
    const ready = new Promise((resolve) => client.once('ready', () => resolve(undefined)));
    client.start();
    await ready;
  });

  afterEach(async () => {
    client.stop();
    await thermostat.stop();
  });

  it('prints a summary, records structures and returns the candidates, sending only GETs', async () => {
    const lines: string[] = [];
    const structures = new Map<string, string>();
    const candidates = await runProbe(
      client,
      (line = '') => lines.push(line),
      (name, text) => structures.set(name, describeStructure(text).join('\n')),
    );
    const printed = lines.join('\n');
    expect(printed).toContain('applicationFirmwareVersion=1.2.3');
    expect(printed).toMatch(/heating: day=19\.8 · night=18 · away=16 · protection=7 · regulationBand=0\.1/);
    expect(printed).toContain('program 1 "Program 1" (WEEKLY, valid=true)');
    expect(printed).toMatch(/monday\s+00:00 NIGHT, 06:30 DAY, 22:30 NIGHT/);
    expect([...structures.keys()]).toEqual([
      'device_configuration.xml',
      'device_program_profile_0.xml',
      'device_program_profile_1.xml',
    ]);
    expect(candidates?.map((candidate) => candidate.field)).toContain('network/wlan/ssid');
    expect(thermostat.lastSet).toBeUndefined();

    // The Wi-Fi password appears nowhere: not printed, not in the structure, not in the log.
    const everything = [printed, ...structures.values(), ...logLines].join('\n');
    expect(everything).not.toContain(FAKE_PERSONAL_VALUES.wifiPassword);
    expect(logLines.join('\n')).not.toContain(FAKE_PERSONAL_VALUES.ssid);
  });

  it('still reads a file whose checksum does not match, and explains it', async () => {
    thermostat.behaviour.badFileChecksum = true;
    const lines: string[] = [];
    const candidates = await runProbe(client, (line = '') => lines.push(line), () => {});
    const printed = lines.join('\n');
    expect(printed).toMatch(/Configuration:\n {2}checksum: mismatch\n {4}text: \d+ characters/);
    expect(printed).toContain('variants with the expected checksum: with a final newline');
    expect(printed).toMatch(/heating: day=19\.8/);
    expect(candidates?.map((candidate) => candidate.field)).toContain('plant_id');
    expect(printed).not.toContain(FAKE_PERSONAL_VALUES.wifiPassword);
  });
});
