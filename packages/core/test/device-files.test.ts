import { describe, expect, it } from 'vitest';
import { FAKE_PERSONAL_VALUES, syntheticConfiguration, syntheticProgram } from '@much-smarther/simulator';
import {
  parseConfiguration,
  parseDiagnostic,
  parseProgramProfile,
  ProtocolError,
  type DeviceConfiguration,
} from '../src/index.js';

const params = (entries: Record<string, string>) => new Map(Object.entries(entries));

describe('parseDiagnostic', () => {
  it('maps the known fields', () => {
    const { value, issues } = parseDiagnostic(
      params({
        application_firmware_version: '1.2.3',
        recovery_firmware_version: '1.0.0',
        hardware_version: 'HW-1',
        device_brand: 'Example',
        device_model_object: 'X0000',
        device_type: 'THERMOSTAT',
        is_firmware_update_available: 'FALSE',
        is_recovery_firmware_running_now: 'FALSE',
        is_capacitive_sensor_working: 'TRUE',
        is_humidity_and_temperature_sensor_working: 'TRUE',
        is_device_date_and_time_valid: 'TRUE',
        is_external_temperature_from_sensor_valid: 'FALSE',
        something_else: 'ignored',
      }),
    );
    expect(issues).toEqual([]);
    expect(value).toEqual({
      applicationFirmwareVersion: '1.2.3',
      recoveryFirmwareVersion: '1.0.0',
      hardwareVersion: 'HW-1',
      brand: 'Example',
      model: 'X0000',
      deviceType: 'THERMOSTAT',
      firmwareUpdateAvailable: false,
      recoveryFirmwareRunning: false,
      capacitiveSensorWorking: true,
      humidityAndTemperatureSensorWorking: true,
      deviceClockValid: true,
      externalSensorValid: false,
    });
  });

  it.each([
    ['application_firmware_version', 'x'.repeat(65)],
    ['device_brand', 'tab\there'],
    ['is_firmware_update_available', 'yes'],
  ])('reports invalid %s', (key, value) => {
    expect(parseDiagnostic(params({ [key]: value }))).toEqual({ value: {}, issues: [`invalid ${key}`] });
  });
});

describe('parseConfiguration', () => {
  it('reads the settings and levels of the synthetic file', () => {
    const { value, issues } = parseConfiguration(syntheticConfiguration(8));
    expect(issues).toEqual([]);
    expect(value).toEqual<DeviceConfiguration>({
      firmwareVersionOfLastSaving: '1.2.3',
      heating: { day: 19.8, night: 18, away: 16, protection: 8, regulationBand: 0.1 },
      cooling: { day: 24, night: 26, away: 28, protection: 35, regulationBand: 0.1 },
      ambientTemperatureCalibration: -0.8,
      externalSensorTemperatureCalibration: 0,
      temperatureFormat: 'CELSIUS',
      standByBrightness: 'STAND_BY_BRIGHTNESS_AUTOMATIC_WITH_OFF',
      buzzer: false,
      haptic: false,
      keysEnabled: true,
      localSettingsEnabled: true,
    });
  });

  it('never returns the personal fields of the file', () => {
    const text = JSON.stringify(parseConfiguration(syntheticConfiguration()));
    for (const personal of Object.values(FAKE_PERSONAL_VALUES)) expect(text).not.toContain(personal);
  });

  const withField = (name: string, value: string) =>
    syntheticConfiguration().replace(new RegExp(`<${name}>[^<]*</${name}>`), `<${name}>${value}</${name}>`);

  it.each([
    ['heating_protection_temperature', '2.9', 'heating_and_cooling/heating_protection_temperature'],
    ['heating_protection_temperature', '18.1', 'heating_and_cooling/heating_protection_temperature'],
    ['cooling_protection_temperature', '27.9', 'heating_and_cooling/cooling_protection_temperature'],
    ['heating_day_temperature', '41', 'heating_and_cooling/heating_day_temperature'],
    ['heating_regulation_band', '1.2', 'heating_and_cooling/heating_regulation_band'],
    ['ambient_temperature_calibration', '12', 'ambient_temperature_calibration'],
    ['buzzer_enable', 'MAYBE', 'buzzer_enable'],
    ['stand_by_brightness', 'BRIGHT', 'stand_by_brightness'],
    ['temperature_format', 'KELVIN', 'temperature_format'],
  ])('rejects an implausible %s=%s', (name, value, path) => {
    const { issues } = parseConfiguration(withField(name, value));
    expect(issues).toEqual([`invalid ${path}`]);
  });

  it('accepts the limits of the protection ranges', () => {
    expect(parseConfiguration(withField('heating_protection_temperature', '3.0')).value.heating.protection).toBe(3);
    expect(parseConfiguration(withField('heating_protection_temperature', '18')).value.heating.protection).toBe(18);
    expect(parseConfiguration(withField('cooling_protection_temperature', '40.00000')).value.cooling.protection).toBe(40);
  });

  it('rounds the float artefacts of the device to 0.1', () => {
    expect(parseConfiguration(withField('heating_day_temperature', '19.799999')).value.heating.day).toBe(19.8);
    expect(parseConfiguration(withField('heating_night_temperature', '18.400000')).value.heating.night).toBe(18.4);
    expect(parseConfiguration(withField('ambient_temperature_calibration', '-0.000001')).value).toMatchObject({
      ambientTemperatureCalibration: 0,
    });
  });

  it('copes with missing fields', () => {
    expect(parseConfiguration('<configuration/>')).toEqual({ value: { heating: {}, cooling: {} }, issues: [] });
  });

  it.each([
    ['not XML', 'ERASE'],
    ['another root', '<program_profile/>'],
    ['a DOCTYPE', '<!DOCTYPE c><configuration/>'],
    ['too large', `<configuration>${'x'.repeat(48 * 1024)}</configuration>`],
  ])('rejects a file that is %s', (_name, text) => {
    expect(() => parseConfiguration(text)).toThrow(ProtocolError);
  });
});

describe('parseProgramProfile', () => {
  it('reads name, type and sorted slots of every day', () => {
    const { value, issues } = parseProgramProfile(syntheticProgram(2));
    expect(issues).toEqual([]);
    expect(value).toMatchObject({ number: 2, name: 'Program 2', type: 'WEEKLY', valid: true });
    expect(Object.keys(value.days)).toEqual(['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday']);
    expect(value.days.monday).toEqual([
      { time: '00:00', preset: 'NIGHT' },
      { time: '06:30', preset: 'DAY' },
      { time: '22:30', preset: 'NIGHT' },
    ]);
  });

  it('sorts slots by time and leaves out malformed ones', () => {
    const text =
      '<program_profile><program_description><number>1</number><name>Mine</name></program_description><weekday>' +
      '<monday><slot preset="DAY" time="07:00"/><slot preset="NIGHT" time="00:00"/>' +
      '<slot preset="ECO" time="09:00"/><slot preset="DAY" time="24:00"/><other/></monday>' +
      '</weekday></program_profile>';
    const { value, issues } = parseProgramProfile(text);
    expect(value.days.monday).toEqual([
      { time: '00:00', preset: 'NIGHT' },
      { time: '07:00', preset: 'DAY' },
    ]);
    expect(value.days.tuesday).toEqual([]);
    expect(issues).toEqual(['invalid slot on monday', 'invalid slot on monday']);
  });

  it.each([
    ['a name with markup characters', '<name>a &lt;b&gt;</name>', 'invalid program_description/name'],
    ['a name that is too long', `<name>${'n'.repeat(65)}</name>`, 'invalid program_description/name'],
    ['a program number out of range', '<number>11</number>', 'invalid program_description/number'],
    ['an unknown type', '<type>YEARLY</type>', 'invalid program_description/type'],
  ])('reports %s', (_name, description, issue) => {
    const text = `<program_profile><program_description>${description}</program_description></program_profile>`;
    const { value, issues } = parseProgramProfile(text);
    expect(issues).toEqual([issue]);
    expect(value).not.toHaveProperty('name');
    expect(value).not.toHaveProperty('type');
    expect(value).not.toHaveProperty('number');
  });

  it('reads a program marked as not valid', () => {
    const text =
      '<program_profile><program_description><is_program_profile_valid>FALSE</is_program_profile_valid>' +
      '</program_description></program_profile>';
    expect(parseProgramProfile(text).value.valid).toBe(false);
  });

  it('rejects a file with another root', () => {
    expect(() => parseProgramProfile('<configuration/>')).toThrow(ProtocolError);
  });
});
