import { describe, expect, it } from 'vitest';
import {
  buildClientHandshake,
  buildGetDeviceState,
  buildGetDiagnostic,
  buildGetFile,
  buildGetProgramList,
  buildHandshakeAck,
  buildKeepAlive,
  buildNegotiate,
  buildSetDeviceState,
  CommandRejectedError,
  decodeDocument,
  flattenParams,
  formatLocalDateTime,
  hasValidityWindow,
  isDeviceFileName,
  isValidSetpoint,
  programFileName,
  validateDeviceStateRequest,
  ValidationError,
  type DeviceStateRequest,
  type XOpenMessage,
} from '../src/index.js';

function decode(xml: string): XOpenMessage {
  const document = decodeDocument(xml);
  if (document.kind !== 'v3') throw new Error('expected V3');
  return document.message;
}

const NOW = new Date(2026, 0, 2, 3, 4, 5);

describe('handshake builders', () => {
  it('negotiates V3 with command, monitor and a persistent connection', () => {
    expect(buildNegotiate('sid')).toBe(
      '<OWNMsg Profile="V3"><Payload><Service TYPE="SET" /><SeqID ID="sid" Progress="0" />' +
        '<Address></Address><ActionID>OWNSetProtocol</ActionID><ParamList>' +
        '<Params Version="3" /><Params Command="1" /><Params Monitor="1" /><Params ConnAlwaysOn="1" />' +
        '</ParamList></Payload></OWNMsg>',
    );
  });

  it('sends Rb and the digest as separate Params', () => {
    const message = decode(buildClientHandshake('sid', 4, '0102', '0304'));
    expect(message).toMatchObject({ service: 'SET', seqId: 'sid', progress: 4, actionId: 'ClientHandshakeHMAC' });
    expect(message.params.map((group) => Object.fromEntries(group))).toEqual([{ Random: '0102' }, { Digest: '0304' }]);
  });

  it('acknowledges with an empty parameter list', () => {
    expect(buildHandshakeAck('sid', 3)).toContain('<ActionID>AckMsg</ActionID><ParamList />');
  });
});

describe('GET builders', () => {
  it.each([
    [buildGetDeviceState, 'device_state'],
    [buildKeepAlive, 'device_keep_alive'],
    [buildGetProgramList, 'device_program_number_list'],
  ])('builds %#', (build, actionId) => {
    expect(decode(build('s'))).toMatchObject({ service: 'GET', who: '4', where: '', actionId, params: [] });
  });
});

describe('device file and diagnostic builders', () => {
  it('reads the diagnostics with WHO 4', () => {
    expect(decode(buildGetDiagnostic('s'))).toMatchObject({ service: 'GET', who: '4', actionId: 'device_diagnostic' });
  });

  it('reads a file with WHO 1004 and its name', () => {
    const message = decode(buildGetFile('s', 'device_configuration.xml'));
    expect(message).toMatchObject({ service: 'GET', who: '1004', where: '', actionId: 'device_file' });
    expect(message.params.map((group) => Object.fromEntries(group))).toEqual([{ file_name: 'device_configuration.xml' }]);
  });

  it.each([0, 5, 10])('names the file of program %d', (number) => {
    expect(programFileName(number)).toBe(`device_program_profile_${number}.xml`);
    expect(isDeviceFileName(programFileName(number))).toBe(true);
  });

  it.each([-1, 11, 1.5])('refuses program %d', (number) => {
    expect(() => programFileName(number)).toThrow(ValidationError);
  });

  it.each([
    'firmware_descriptor.txt',
    'device_program_profile_11.xml',
    'device_program_profile_01.xml',
    '../device_configuration.xml',
    'device_configuration.xml ',
    '',
  ])('refuses to read %j', (name) => {
    expect(isDeviceFileName(name)).toBe(false);
    expect(() => buildGetFile('s', name)).toThrow(ValidationError);
  });
});

describe('SET device_state', () => {
  const params = (request: DeviceStateRequest) =>
    decode(buildSetDeviceState('s', request, NOW)).params.map((group) => Object.fromEntries(group));
  const noValidity = {
    use_date_and_time_validity: 'FALSE',
    end_date_and_time_validity: '',
    init_date_and_time_validity: '',
  };

  it('sets a manual setpoint with five decimals, after the validity', () => {
    expect(params({ mode: 'MANUAL', function: 'HEATING', setpoint: 21 })).toEqual([
      { temperature_format: 'CELSIUS' },
      { function: 'HEATING' },
      { mode: 'MANUAL' },
      noValidity,
      { setpoint: '21.00000' },
    ]);
  });

  it('starts a boost with only a validity window, without boostTime', () => {
    expect(params({ mode: 'BOOST', function: 'HEATING', minutes: 90 })).toEqual([
      { temperature_format: 'CELSIUS' },
      { function: 'HEATING' },
      { mode: 'BOOST' },
      {
        use_date_and_time_validity: 'TRUE',
        init_date_and_time_validity: '2026-01-02T03:04:05',
        end_date_and_time_validity: '2026-01-02T04:34:05',
      },
    ]);
  });

  it('returns to the weekly program, optionally choosing one', () => {
    expect(params({ mode: 'AUTOMATIC', function: 'COOLING' })).toEqual([
      { temperature_format: 'CELSIUS' },
      { function: 'COOLING' },
      { mode: 'AUTOMATIC' },
      noValidity,
    ]);
    expect(params({ mode: 'AUTOMATIC', function: 'HEATING', programNumber: 2 }).at(-1)).toEqual({ program_number: '2' });
  });

  it.each(['MANUAL', 'PROTECTION'] as const)('ends a timed %s at the chosen time', (mode) => {
    const until = new Date(2026, 0, 3, 22, 15, 0);
    const request: DeviceStateRequest =
      mode === 'MANUAL' ? { mode, function: 'HEATING', setpoint: 20.5, until } : { mode, function: 'HEATING', until };
    expect(params(request)).toContainEqual({
      use_date_and_time_validity: 'TRUE',
      init_date_and_time_validity: '2026-01-02T03:04:05',
      end_date_and_time_validity: '2026-01-03T22:15:00',
    });
  });

  it.each(['HEATING', 'COOLING'] as const)('sends %s PROTECTION like the app, forever and at 7 °C', (fn) => {
    expect(params({ mode: 'PROTECTION', function: fn })).toEqual([
      { temperature_format: 'CELSIUS' },
      { function: fn },
      { mode: 'PROTECTION' },
      noValidity,
      { setpoint: '7.00000' },
    ]);
  });

  it.each(['PROTECTION', 'OFF'] as const)('switches to %s', (mode) => {
    expect(flattenParams(decode(buildSetDeviceState('s', { mode, function: 'HEATING' }, NOW))).get('mode')).toBe(mode);
  });

  it('validates again inside the builder', () => {
    const bad = { mode: 'MANUAL', function: 'HEATING', setpoint: 50 } as DeviceStateRequest;
    expect(() => buildSetDeviceState('s', bad, NOW)).toThrow(ValidationError);
  });

  it('accepts every tenth of a degree in range and encodes it exactly', () => {
    for (let tenths = 70; tenths <= 400; tenths++) {
      const setpoint = tenths / 10;
      expect(isValidSetpoint(setpoint)).toBe(true);
      expect(params({ mode: 'MANUAL', function: 'HEATING', setpoint })).toContainEqual({ setpoint: setpoint.toFixed(5) });
    }
    expect(isValidSetpoint(20.1 + 0.2)).toBe(true);
  });
});

describe('validateDeviceStateRequest', () => {
  it.each([7, 7.1, 20.7, 21, 39.9, 40])('accepts setpoint %d', (setpoint) => {
    expect(validateDeviceStateRequest({ mode: 'MANUAL', function: 'HEATING', setpoint })).toEqual({
      mode: 'MANUAL',
      function: 'HEATING',
      setpoint,
    });
  });

  it.each([
    ['null', null],
    ['a string', 'MANUAL'],
    ['unknown mode', { mode: 'ECO', function: 'HEATING' }],
    ['unknown function', { mode: 'OFF', function: 'DRYING' }],
    ['setpoint below range', { mode: 'MANUAL', function: 'HEATING', setpoint: 6.9 }],
    ['setpoint above range', { mode: 'MANUAL', function: 'HEATING', setpoint: 40.1 }],
    ['setpoint off step', { mode: 'MANUAL', function: 'HEATING', setpoint: 21.25 }],
    ['setpoint as string', { mode: 'MANUAL', function: 'HEATING', setpoint: '21' }],
    ['NaN setpoint', { mode: 'MANUAL', function: 'HEATING', setpoint: Number.NaN }],
    ['missing setpoint', { mode: 'MANUAL', function: 'HEATING' }],
    ['boost of 45 minutes', { mode: 'BOOST', function: 'HEATING', minutes: 45 }],
    ['boost minutes as string', { mode: 'BOOST', function: 'HEATING', minutes: '30' }],
    ['negative program', { mode: 'AUTOMATIC', function: 'HEATING', programNumber: -1 }],
    ['fractional program', { mode: 'AUTOMATIC', function: 'HEATING', programNumber: 1.5 }],
    ['program too large', { mode: 'AUTOMATIC', function: 'HEATING', programNumber: 11 }],
    ['setpoint with OFF', { mode: 'OFF', function: 'HEATING', setpoint: 21 }],
    ['until with OFF', { mode: 'OFF', function: 'HEATING', until: new Date(2026, 0, 3) }],
    ['until with BOOST', { mode: 'BOOST', function: 'HEATING', minutes: 30, until: new Date(2026, 0, 3) }],
    ['until with AUTOMATIC', { mode: 'AUTOMATIC', function: 'HEATING', until: new Date(2026, 0, 3) }],
    ['until as string', { mode: 'PROTECTION', function: 'HEATING', until: '2026-01-03T00:00:00' }],
    ['invalid until', { mode: 'PROTECTION', function: 'HEATING', until: new Date(Number.NaN) }],
    ['until now', { mode: 'MANUAL', function: 'HEATING', setpoint: 21, until: NOW }],
    ['until in the past', { mode: 'MANUAL', function: 'HEATING', setpoint: 21, until: new Date(2026, 0, 1) }],
    ['until beyond 10 days', { mode: 'MANUAL', function: 'HEATING', setpoint: 21, until: new Date(2026, 0, 12, 3, 4, 6) }],
    ['extra field', { mode: 'MANUAL', function: 'HEATING', setpoint: 21, raw: '<x/>' }],
  ])('rejects %s', (_name, input) => {
    expect(() => validateDeviceStateRequest(input, NOW)).toThrow(ValidationError);
  });

  it('accepts an end time up to 10 days ahead, as a copy', () => {
    const until = new Date(2026, 0, 12, 3, 4, 5);
    const request = validateDeviceStateRequest({ mode: 'PROTECTION', function: 'HEATING', until }, NOW);
    expect(request).toEqual({ mode: 'PROTECTION', function: 'HEATING', until });
    until.setFullYear(2030);
    expect(request).toMatchObject({ until: new Date(2026, 0, 12, 3, 4, 5) });
  });

  it.each([0, 1, 10])('accepts program %d', (programNumber) => {
    expect(validateDeviceStateRequest({ mode: 'AUTOMATIC', function: 'HEATING', programNumber })).toMatchObject({
      programNumber,
    });
  });

  it('exposes the setpoint rule', () => {
    expect(isValidSetpoint(20.5)).toBe(true);
    expect(isValidSetpoint(Number.POSITIVE_INFINITY)).toBe(false);
  });
});

describe('formatLocalDateTime', () => {
  it('pads every field', () => {
    expect(formatLocalDateTime(NOW)).toBe('2026-01-02T03:04:05');
  });

  it('uses the wall clock of a given UTC offset', () => {
    const instant = new Date(Date.UTC(2026, 0, 1, 23, 30, 0));
    expect(formatLocalDateTime(instant, 60)).toBe('2026-01-02T00:30:00');
    expect(formatLocalDateTime(instant, -210)).toBe('2026-01-01T20:00:00');
    expect(formatLocalDateTime(instant, 0)).toBe('2026-01-01T23:30:00');
  });
});

describe('SET device_state in the thermostat zone', () => {
  it('writes the window in the given offset', () => {
    const now = new Date(Date.UTC(2026, 0, 1, 12, 0, 0));
    const message = decode(buildSetDeviceState('s', { mode: 'BOOST', function: 'HEATING', minutes: 30 }, now, 330));
    expect(flattenParams(message).get('init_date_and_time_validity')).toBe('2026-01-01T17:30:00');
    expect(flattenParams(message).get('end_date_and_time_validity')).toBe('2026-01-01T18:00:00');
  });

  it.each<[DeviceStateRequest, boolean]>([
    [{ mode: 'BOOST', function: 'HEATING', minutes: 30 }, true],
    [{ mode: 'MANUAL', function: 'HEATING', setpoint: 21, until: new Date(2026, 0, 3) }, true],
    [{ mode: 'PROTECTION', function: 'HEATING', until: new Date(2026, 0, 3) }, true],
    [{ mode: 'MANUAL', function: 'HEATING', setpoint: 21 }, false],
    [{ mode: 'PROTECTION', function: 'HEATING' }, false],
    [{ mode: 'AUTOMATIC', function: 'HEATING' }, false],
    [{ mode: 'OFF', function: 'HEATING' }, false],
  ])('knows whether %j has a window', (request, expected) => {
    expect(hasValidityWindow(request)).toBe(expected);
  });
});

describe('CommandRejectedError', () => {
  it.each([
    [430, 'the thermostat rejected the command (code 430: invalid parameters)'],
    [486, 'the thermostat rejected the command (code 486: interface busy)'],
    [999, 'the thermostat rejected the command (code 999)'],
    [undefined, 'the thermostat rejected the command'],
  ])('describes code %s', (code, message) => {
    expect(new CommandRejectedError(code)).toMatchObject({ code, message });
  });
});
