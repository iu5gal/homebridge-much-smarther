import { BOOST_MINUTES, PROGRAM_NUMBER_MAX, type BoostMinutes } from '@much-smarther/core';
import { LANGUAGES, type Language } from './i18n.js';

/**
 * The plugin settings from Homebridge's config.json. The PswOpen is not
 * among them: it lives in the plugin's storage (pin-store.ts).
 */
export interface Settings {
  readonly name: string;
  readonly host: string;
  readonly port?: number;
  readonly language: Language;
  /** How the weekly program appears in the Home app: target state "Auto", or a separate switch. */
  readonly automaticMode: 'auto' | 'switch';
  /** How long a temperature set from the Home app lasts. */
  readonly manualEnd: 'nextChange' | 'forever' | 'duration';
  /** With `manualEnd: 'duration'`. */
  readonly manualMinutes: number;
  /** Let the Home app switch the season (heating / cooling). Off by default. */
  readonly seasonFromHome: boolean;
  readonly humiditySensor: boolean;
  /** Extra switches in the Home app: the boosts to show, and two optional groups. */
  readonly boostSwitches: readonly BoostMinutes[];
  /** The programs with a switch: `'all'`, including programs created later, or a list. */
  readonly programSwitches: 'all' | readonly number[];
  readonly offSwitch: boolean;
}

export class SettingsError extends Error {
  override name = 'SettingsError';
}

const HOSTNAME = /^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;
// eslint-disable-next-line no-control-regex -- matching control characters is the point
const NAME = /^[^\u0000-\u001f\u007f]{1,64}$/u;
const KNOWN_KEYS = new Set([
  'platform',
  'name',
  'host',
  'port',
  'language',
  'automaticMode',
  'manualEnd',
  'manualMinutes',
  'seasonFromHome',
  'humiditySensor',
  'boostSwitches',
  'programSwitches',
  'offSwitch',
  '_bridge',
]);
const DEFAULTS = {
  name: 'Smarther',
  language: 'en',
  automaticMode: 'auto',
  manualEnd: 'nextChange',
  manualMinutes: 120,
  seasonFromHome: false,
  humiditySensor: true,
  offSwitch: false,
} as const;
export const MANUAL_MINUTES = { min: 15, max: 1440, step: 15 } as const;

function oneOf<T extends string>(values: readonly T[], value: unknown, key: string, fallback: T): T {
  if (value === undefined) return fallback;
  if (typeof value === 'string' && (values as readonly string[]).includes(value)) return value as T;
  throw new SettingsError(`${key} must be one of ${values.join(', ')}`);
}

/** A list of program numbers (1–10); `true` means every program, `false` none. */
function programList(value: unknown): 'all' | readonly number[] {
  if (value === true) return 'all';
  if (value === undefined || value === false) return [];
  if (
    Array.isArray(value) &&
    value.every((item) => typeof item === 'number' && Number.isInteger(item) && item >= 1 && item <= PROGRAM_NUMBER_MAX)
  ) {
    return [...new Set(value as number[])].sort((a, b) => a - b);
  }
  throw new SettingsError(`programSwitches must be true, false or a list of program numbers from 1 to ${PROGRAM_NUMBER_MAX}`);
}

/** A list of minutes; `true` and `false` (all or none) are accepted too. */
function boosts(value: unknown): readonly BoostMinutes[] {
  if (value === undefined || value === true) return BOOST_MINUTES;
  if (value === false) return [];
  const allowed: readonly number[] = BOOST_MINUTES;
  if (Array.isArray(value) && value.every((item) => typeof item === 'number' && allowed.includes(item))) {
    return BOOST_MINUTES.filter((minutes) => value.includes(minutes));
  }
  throw new SettingsError(`boostSwitches must be a list of ${BOOST_MINUTES.join(', ')}`);
}

function flag(value: unknown, key: string, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (typeof value === 'boolean') return value;
  throw new SettingsError(`${key} must be true or false`);
}

/**
 * Checks the platform block of config.json. Throws `SettingsError` on a bad
 * value; returns the settings and warnings for keys it does not know.
 */
export function parseSettings(config: Readonly<Record<string, unknown>>): {
  settings: Settings;
  warnings: string[];
} {
  const warnings = Object.keys(config)
    .filter((key) => !KNOWN_KEYS.has(key))
    .map((key) => `unknown setting "${key}" ignored`);
  if ('pin' in config || 'password' in config || 'pswOpen' in config) {
    warnings.push('the thermostat password does not belong in config.json: set it in the plugin settings page');
  }

  const { name = DEFAULTS.name, host, port } = config;
  if (typeof name !== 'string' || !NAME.test(name)) throw new SettingsError('name must be 1 to 64 characters');
  if (typeof host !== 'string' || !HOSTNAME.test(host)) {
    throw new SettingsError('host must be the thermostat address, for example 192.0.2.10');
  }
  if (port !== undefined && (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535)) {
    throw new SettingsError('port must be a number from 1 to 65535');
  }

  const manualMinutes = config['manualMinutes'] ?? DEFAULTS.manualMinutes;
  if (
    typeof manualMinutes !== 'number' ||
    !Number.isInteger(manualMinutes) ||
    manualMinutes < MANUAL_MINUTES.min ||
    manualMinutes > MANUAL_MINUTES.max ||
    manualMinutes % MANUAL_MINUTES.step !== 0
  ) {
    throw new SettingsError(
      `manualMinutes must be ${MANUAL_MINUTES.min} to ${MANUAL_MINUTES.max} in steps of ${MANUAL_MINUTES.step}`,
    );
  }

  const settings: Settings = {
    name,
    host,
    ...(port === undefined ? {} : { port: port as number }),
    language: oneOf(LANGUAGES, config['language'], 'language', DEFAULTS.language),
    automaticMode: oneOf(['auto', 'switch'] as const, config['automaticMode'], 'automaticMode', DEFAULTS.automaticMode),
    manualEnd: oneOf(['nextChange', 'forever', 'duration'] as const, config['manualEnd'], 'manualEnd', DEFAULTS.manualEnd),
    manualMinutes,
    seasonFromHome: flag(config['seasonFromHome'], 'seasonFromHome', DEFAULTS.seasonFromHome),
    humiditySensor: flag(config['humiditySensor'], 'humiditySensor', DEFAULTS.humiditySensor),
    boostSwitches: boosts(config['boostSwitches']),
    programSwitches: programList(config['programSwitches']),
    offSwitch: flag(config['offSwitch'], 'offSwitch', DEFAULTS.offSwitch),
  };
  return { settings, warnings };
}
