import { describe, expect, it } from 'vitest';
import { parseDeviceState, parseProgramList, type ThermostatState } from '../src/index.js';

const parse = (params: Record<string, string>) => parseDeviceState(new Map(Object.entries(params)));

describe('parseDeviceState', () => {
  it('maps every known field', () => {
    const { state, issues } = parse({
      function: 'HEATING',
      mode: 'BOOST',
      setpoint: '21.5',
      program_number: '2',
      is_ambient_temperature_valid: 'TRUE',
      ambient_temperature_value: '19.8',
      measured_temperature: '19.75',
      is_ambient_relative_humidity_valid: 'TRUE',
      ambient_relative_humidity_value: '47',
      heating_thermoregulation_load_state: 'ACTIVE',
      cooling_thermoregulation_load_state: 'INACTIVE',
      use_date_and_time_validity: 'TRUE',
      init_date_and_time_validity: '2026-01-02T03:04:05',
      end_date_and_time_validity: '2026-01-02T03:34:05',
      boostTime: '30',
      is_device_date_and_time_valid: 'TRUE',
      timestamp: '2026-01-02T03:04:06',
      unknown_field: 'kept in raw',
    });
    expect(issues).toEqual([]);
    expect(state).toEqual<ThermostatState>({
      function: 'HEATING',
      mode: 'BOOST',
      setpoint: 21.5,
      programNumber: 2,
      ambientTemperature: 19.8,
      ambientTemperatureValid: true,
      measuredTemperature: 19.75,
      humidity: 47,
      humidityValid: true,
      heatingActive: true,
      coolingActive: false,
      validity: { start: '2026-01-02T03:04:05', end: '2026-01-02T03:34:05' },
      boostMinutes: 30,
      deviceClockValid: true,
      timestamp: '2026-01-02T03:04:06',
      raw: expect.any(Map) as ReadonlyMap<string, string>,
    });
    expect(state.raw.get('unknown_field')).toBe('kept in raw');
  });

  it('reads decimals padded to five places, as the device sends them', () => {
    const { state, issues } = parse({ setpoint: '19.80000', ambient_temperature_value: '20.2' });
    expect(issues).toEqual([]);
    expect(state).toMatchObject({ setpoint: 19.8, ambientTemperature: 20.2 });
  });

  it('leaves out measurements the thermostat flags as not valid', () => {
    const { state, issues } = parse({
      is_ambient_temperature_valid: 'FALSE',
      ambient_temperature_value: '0.0',
      is_ambient_relative_humidity_valid: 'FALSE',
      ambient_relative_humidity_value: '0.0',
    });
    expect(issues).toEqual([]);
    expect(state).toMatchObject({ ambientTemperatureValid: false, humidityValid: false });
    expect(state.ambientTemperature).toBeUndefined();
    expect(state.humidity).toBeUndefined();
  });

  it('keeps a measurement without a validity flag', () => {
    expect(parse({ ambient_temperature_value: '20.2' }).state).toMatchObject({ ambientTemperature: 20.2 });
  });

  it('omits the validity window when it is not in use', () => {
    expect(parse({ use_date_and_time_validity: 'FALSE', end_date_and_time_validity: '' }).state.validity).toBeUndefined();
  });

  it.each([
    ['ON', true],
    ['on', true],
    ['1', true],
    ['OFF', false],
    ['0', false],
    ['INACTIVE', false],
  ])('reads load state %s', (value, expected) => {
    expect(parse({ heating_thermoregulation_load_state: value }).state.heatingActive).toBe(expected);
  });

  it.each([
    ['mode', 'ECO'],
    ['function', 'heating'],
    ['setpoint', '21,5'],
    ['setpoint', '99'],
    ['setpoint', '19.8000000'],
    ['ambient_temperature_value', 'NaN'],
    ['ambient_relative_humidity_value', '101'],
    ['program_number', '-1'],
    ['program_number', '11'],
    ['heating_thermoregulation_load_state', 'MAYBE'],
    ['is_ambient_temperature_valid', 'MAYBE'],
    ['boostTime', '45'],
    ['timestamp', 'x'.repeat(65)],
  ])('reports invalid %s=%j as an issue and leaves it out', (key, value) => {
    const { state, issues } = parse({ [key]: value });
    expect(issues).toEqual([`invalid ${key}`]);
    expect(Object.keys(state)).toEqual(['raw']);
  });

  it('reports an invalid validity date', () => {
    const { state, issues } = parse({ use_date_and_time_validity: 'TRUE', end_date_and_time_validity: 'tomorrow' });
    expect(issues).toEqual(['invalid end_date_and_time_validity']);
    expect(state.validity).toEqual({});
  });

  it('derives the boost duration from the validity window', () => {
    const boost = (end: string) =>
      parse({
        mode: 'BOOST',
        use_date_and_time_validity: 'TRUE',
        init_date_and_time_validity: '2026-01-02T03:04:05',
        end_date_and_time_validity: end,
      }).state.boostMinutes;
    expect(boost('2026-01-02T04:04:05')).toBe(60);
    expect(boost('2026-01-02T04:34:06')).toBe(90);
    expect(boost('2026-01-02T03:49:05')).toBeUndefined();
    const manual = parse({
      mode: 'MANUAL',
      use_date_and_time_validity: 'TRUE',
      init_date_and_time_validity: '2026-01-02T03:04:05',
      end_date_and_time_validity: '2026-01-02T03:34:05',
    });
    expect(manual.state.boostMinutes).toBeUndefined();
  });

  it.each([
    ['2026-01-02T18:36:47+01:00', 60],
    ['2026-07-02T18:36:47+02:00', 120],
    ['2026-01-02T18:36:47-03:30', -210],
    ['2026-01-02T18:36:47Z', 0],
    ['2026-01-02T18:36:47', undefined],
    ['2026-01-02T18:36:47+15:00', undefined],
    ['yesterday+01:00', undefined],
  ])('reads the clock offset of timestamp %s', (timestamp, offset) => {
    const { state, issues } = parse({ timestamp });
    expect(issues).toEqual([]);
    expect(state.timestamp).toBe(timestamp);
    expect(state.utcOffsetMinutes).toBe(offset);
  });

  it('ignores empty values', () => {
    expect(parse({ setpoint: '' })).toMatchObject({ issues: [] });
  });
});

describe('parseProgramList', () => {
  const groups = (...entries: Record<string, string>[]) => entries.map((entry) => new Map(Object.entries(entry)));

  it('sorts the slots and keeps the change time when present', () => {
    expect(
      parseProgramList(
        groups(
          { program_2_present: 'FALSE' },
          { program_1_present: 'TRUE', timestamp: '2026-01-01T08:00:00+01:00' },
          { program_0_present: 'TRUE', timestamp: '' },
        ),
      ),
    ).toEqual([
      { number: 0, present: true },
      { number: 1, present: true, changedAt: '2026-01-01T08:00:00+01:00' },
      { number: 2, present: false },
    ]);
  });

  it('leaves out malformed slots', () => {
    expect(
      parseProgramList(
        groups(
          { program_x_present: 'TRUE' },
          { program_1_present: 'MAYBE' },
          { program_number: '1' },
          { program_3_present: 'TRUE', timestamp: 'x'.repeat(65) },
        ),
      ),
    ).toEqual([{ number: 3, present: true }]);
  });
});
