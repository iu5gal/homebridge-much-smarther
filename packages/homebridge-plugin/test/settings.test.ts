import { describe, expect, it } from 'vitest';
import { parseSettings, SettingsError } from '../src/settings.js';

const base = { platform: 'MuchSmarther', host: '192.0.2.10' };

describe('parseSettings', () => {
  it('applies the defaults', () => {
    expect(parseSettings(base)).toEqual({
      settings: {
        name: 'Smarther',
        host: '192.0.2.10',
        language: 'en',
        automaticMode: 'auto',
        manualEnd: 'nextChange',
        manualMinutes: 120,
        seasonFromHome: false,
        humiditySensor: true,
        boostSwitches: [30, 60, 90],
        programSwitches: [],
        offSwitch: false,
      },
      warnings: [],
    });
  });

  it('reads every setting', () => {
    const { settings } = parseSettings({
      ...base,
      name: 'Soggiorno',
      host: 'thermostat.example.com',
      port: 40000,
      language: 'it',
      automaticMode: 'switch',
      manualEnd: 'duration',
      manualMinutes: 90,
      seasonFromHome: true,
      humiditySensor: false,
      boostSwitches: [90, 30],
      programSwitches: [3, 1, 3],
      offSwitch: true,
      _bridge: { username: 'x' },
    });
    expect(settings).toEqual({
      name: 'Soggiorno',
      host: 'thermostat.example.com',
      port: 40000,
      language: 'it',
      automaticMode: 'switch',
      manualEnd: 'duration',
      manualMinutes: 90,
      seasonFromHome: true,
      humiditySensor: false,
      boostSwitches: [30, 90],
      programSwitches: [1, 3],
      offSwitch: true,
    });
  });

  it('takes program switches as a flag too', () => {
    expect(parseSettings({ ...base, programSwitches: true }).settings.programSwitches).toBe('all');
    expect(parseSettings({ ...base, programSwitches: false }).settings.programSwitches).toEqual([]);
  });

  it('takes boost switches as a flag too', () => {
    expect(parseSettings({ ...base, boostSwitches: true }).settings.boostSwitches).toEqual([30, 60, 90]);
    expect(parseSettings({ ...base, boostSwitches: false }).settings.boostSwitches).toEqual([]);
  });

  it('warns about unknown keys and a password in config.json', () => {
    expect(parseSettings({ ...base, colour: 'red', pin: '1234' }).warnings).toEqual([
      'unknown setting "colour" ignored',
      'unknown setting "pin" ignored',
      'the thermostat password does not belong in config.json: set it in the plugin settings page',
    ]);
  });

  it.each([
    ['no host', { platform: 'MuchSmarther' }],
    ['a host with a scheme', { ...base, host: 'http://192.0.2.10' }],
    ['a host with a space', { ...base, host: 'my thermostat' }],
    ['a port as text', { ...base, port: '40000' }],
    ['port 0', { ...base, port: 0 }],
    ['port 65536', { ...base, port: 65536 }],
    ['an unknown language', { ...base, language: 'xx' }],
    ['an unknown automatic mode', { ...base, automaticMode: 'both' }],
    ['an unknown manual end', { ...base, manualEnd: 'never' }],
    ['manual minutes off the step', { ...base, manualMinutes: 100 }],
    ['manual minutes too long', { ...base, manualMinutes: 1500 }],
    ['a flag as text', { ...base, seasonFromHome: 'yes' }],
    ['an unknown boost', { ...base, boostSwitches: [30, 45] }],
    ['boost switches as text', { ...base, boostSwitches: '30' }],
    ['the system program', { ...base, programSwitches: [0, 1] }],
    ['program 11', { ...base, programSwitches: [11] }],
    ['an empty name', { ...base, name: '' }],
    ['a name with a control character', { ...base, name: 'a\u0007b' }],
  ])('rejects %s', (_name, config) => {
    expect(() => parseSettings(config)).toThrow(SettingsError);
  });
});
