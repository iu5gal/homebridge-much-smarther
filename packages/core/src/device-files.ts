import { ProtocolError, XmlError } from './errors.js';
import type { Params } from './message.js';
import { PROGRAM_NUMBER_MAX } from './commands.js';
import { parseXml, type XmlElement } from './xml.js';

/**
 * Parsers for what the thermostat reports about itself (PROTOCOL.md §5.2):
 * diagnostics, its configuration file and its program files.
 *
 * Each parser builds its result only from a fixed list of fields. The
 * configuration file also holds the Wi-Fi credentials, the installation's
 * name, identifier and coordinates and the router's MAC address: those are
 * never read, so they cannot leak through a result, a log or a test.
 */

export interface ParsedFile<T> {
  readonly value: T;
  /** Fields that were present but invalid, and therefore left out. */
  readonly issues: readonly string[];
}

// ---------------------------------------------------------------------------
// Diagnostics (`GET device_diagnostic`)

export interface DeviceDiagnostic {
  readonly applicationFirmwareVersion?: string;
  readonly recoveryFirmwareVersion?: string;
  readonly hardwareVersion?: string;
  readonly brand?: string;
  readonly model?: string;
  readonly deviceType?: string;
  readonly firmwareUpdateAvailable?: boolean;
  readonly recoveryFirmwareRunning?: boolean;
  readonly capacitiveSensorWorking?: boolean;
  readonly humidityAndTemperatureSensorWorking?: boolean;
  readonly deviceClockValid?: boolean;
  readonly externalSensorValid?: boolean;
}

const LABEL = /^[\x20-\x7e]{1,64}$/;

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

function flagValue(value: string): boolean | undefined {
  if (value === 'TRUE') return true;
  if (value === 'FALSE') return false;
  return undefined;
}

const DIAGNOSTIC_LABELS: readonly [string, keyof DeviceDiagnostic][] = [
  ['application_firmware_version', 'applicationFirmwareVersion'],
  ['recovery_firmware_version', 'recoveryFirmwareVersion'],
  ['hardware_version', 'hardwareVersion'],
  ['device_brand', 'brand'],
  ['device_model_object', 'model'],
  ['device_type', 'deviceType'],
];

const DIAGNOSTIC_FLAGS: readonly [string, keyof DeviceDiagnostic][] = [
  ['is_firmware_update_available', 'firmwareUpdateAvailable'],
  ['is_recovery_firmware_running_now', 'recoveryFirmwareRunning'],
  ['is_capacitive_sensor_working', 'capacitiveSensorWorking'],
  ['is_humidity_and_temperature_sensor_working', 'humidityAndTemperatureSensorWorking'],
  ['is_device_date_and_time_valid', 'deviceClockValid'],
  ['is_external_temperature_from_sensor_valid', 'externalSensorValid'],
];

export function parseDiagnostic(params: Params): ParsedFile<DeviceDiagnostic> {
  const value: Mutable<DeviceDiagnostic> = {};
  const issues: string[] = [];
  for (const [key, field] of DIAGNOSTIC_LABELS) {
    const raw = params.get(key);
    if (raw === undefined || raw === '') continue;
    if (LABEL.test(raw)) (value as Record<string, unknown>)[field] = raw;
    else issues.push(`invalid ${key}`);
  }
  for (const [key, field] of DIAGNOSTIC_FLAGS) {
    const raw = params.get(key);
    if (raw === undefined || raw === '') continue;
    const flag = flagValue(raw);
    if (flag === undefined) issues.push(`invalid ${key}`);
    else (value as Record<string, unknown>)[field] = flag;
  }
  return { value, issues };
}

// ---------------------------------------------------------------------------
// Shared helpers for the XML files

/** Limits for a file inside a message: smaller than a whole message. */
const FILE_LIMITS = { maxLength: 48 * 1024, maxDepth: 8, maxElements: 512, maxAttributes: 8 };

const DECIMAL = /^-?[0-9]{1,3}(?:\.[0-9]{1,6})?$/;

function parseFile(text: string, rootName: string): XmlElement {
  let root: XmlElement;
  try {
    root = parseXml(text, FILE_LIMITS);
  } catch (error) {
    throw new ProtocolError(`malformed file: ${error instanceof XmlError ? error.message : String(error)}`);
  }
  if (root.name !== rootName) throw new ProtocolError(`unexpected file root <${root.name}>`);
  return root;
}

/** The text of the element at `path` below `root`, if there is exactly one. */
function textAt(root: XmlElement, path: readonly string[]): string | undefined {
  let element: XmlElement | undefined = root;
  for (const name of path) {
    const matches: XmlElement[] = element.children.filter((candidate) => candidate.name === name);
    if (matches.length !== 1) return undefined;
    element = matches[0];
    if (!element) return undefined;
  }
  const text = element.text.trim();
  return text === '' ? undefined : text;
}

class FieldReader {
  readonly issues: string[] = [];

  constructor(private readonly root: XmlElement) {}

  /** A decimal in `min`–`max`, rounded to 0.1: the device writes float artefacts such as `19.799999`. */
  tenths(path: readonly string[], min: number, max: number): number | undefined {
    return this.#read(path, (text) => {
      if (!DECIMAL.test(text)) return undefined;
      const number = Math.round(Number(text) * 10) / 10;
      return number >= min && number <= max ? number + 0 : undefined; // + 0 turns -0 into 0
    });
  }

  onOff(path: readonly string[]): boolean | undefined {
    return this.#read(path, (text) => (text === 'ON' ? true : text === 'OFF' ? false : undefined));
  }

  match(path: readonly string[], pattern: RegExp): string | undefined {
    return this.#read(path, (text) => (pattern.test(text) ? text : undefined));
  }

  #read<T>(path: readonly string[], parse: (text: string) => T | undefined): T | undefined {
    const text = textAt(this.root, path);
    if (text === undefined) return undefined;
    const value = parse(text);
    if (value === undefined) this.issues.push(`invalid ${path.join('/')}`);
    return value;
  }
}

/** Drops the `undefined` entries, so that optional fields are absent rather than undefined. */
function defined<T extends object>(value: { readonly [K in keyof T]-?: T[K] | undefined }): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;
}

// ---------------------------------------------------------------------------
// Configuration (`device_configuration.xml`)

export interface TemperatureLevels {
  /** The "Home" level of the app. */
  readonly day?: number;
  readonly night?: number;
  readonly away?: number;
  readonly protection?: number;
  /** Hysteresis, °C. */
  readonly regulationBand?: number;
}

export interface DeviceConfiguration {
  readonly firmwareVersionOfLastSaving?: string;
  readonly heating: TemperatureLevels;
  readonly cooling: TemperatureLevels;
  readonly ambientTemperatureCalibration?: number;
  readonly externalSensorTemperatureCalibration?: number;
  readonly temperatureFormat?: 'CELSIUS' | 'FAHRENHEIT';
  readonly standByBrightness?: string;
  readonly buzzer?: boolean;
  readonly haptic?: boolean;
  /** The touch panel accepts input (off = child lock). */
  readonly keysEnabled?: boolean;
  readonly localSettingsEnabled?: boolean;
}

/** Ranges the BTicino app accepts. Values outside are implausible. */
export const HEATING_PROTECTION_RANGE = { min: 3, max: 18 } as const;
export const COOLING_PROTECTION_RANGE = { min: 28, max: 40 } as const;
const LEVEL_RANGE = { min: 3, max: 40 } as const;
const BAND_RANGE = { min: 0.1, max: 1 } as const;
const CALIBRATION_RANGE = { min: -10, max: 10 } as const;
const VERSION = /^[0-9A-Za-z._-]{1,32}$/;
const BRIGHTNESS = /^STAND_BY_BRIGHTNESS_(?:OFF|AUTOMATIC_WITH_OFF|AUTOMATIC_WITHOUT_OFF|[1-9]|10)$/;
const TEMPERATURE_FORMAT = /^(?:CELSIUS|FAHRENHEIT)$/;

function levels(
  read: FieldReader,
  prefix: 'heating' | 'cooling',
  protection: { readonly min: number; readonly max: number },
): TemperatureLevels {
  const at = (name: string) => ['heating_and_cooling', `${prefix}_${name}`];
  return defined<TemperatureLevels>({
    day: read.tenths(at('day_temperature'), LEVEL_RANGE.min, LEVEL_RANGE.max),
    night: read.tenths(at('night_temperature'), LEVEL_RANGE.min, LEVEL_RANGE.max),
    away: read.tenths(at('away_temperature'), LEVEL_RANGE.min, LEVEL_RANGE.max),
    protection: read.tenths(at('protection_temperature'), protection.min, protection.max),
    regulationBand: read.tenths(at('regulation_band'), BAND_RANGE.min, BAND_RANGE.max),
  });
}

/**
 * Parses `device_configuration.xml`, reading only the fields listed in
 * `DeviceConfiguration`. Temperatures are rounded to 0.1 °C.
 */
export function parseConfiguration(text: string): ParsedFile<DeviceConfiguration> {
  const read = new FieldReader(parseFile(text, 'configuration'));
  const value = defined<DeviceConfiguration>({
    firmwareVersionOfLastSaving: read.match(['firmware_version_of_last_saving'], VERSION),
    heating: levels(read, 'heating', HEATING_PROTECTION_RANGE),
    cooling: levels(read, 'cooling', COOLING_PROTECTION_RANGE),
    ambientTemperatureCalibration: read.tenths(
      ['ambient_temperature_calibration'],
      CALIBRATION_RANGE.min,
      CALIBRATION_RANGE.max,
    ),
    externalSensorTemperatureCalibration: read.tenths(
      ['external_sensor_temperature_calibration'],
      CALIBRATION_RANGE.min,
      CALIBRATION_RANGE.max,
    ),
    temperatureFormat: read.match(['temperature_format'], TEMPERATURE_FORMAT) as 'CELSIUS' | 'FAHRENHEIT' | undefined,
    standByBrightness: read.match(['stand_by_brightness'], BRIGHTNESS),
    buzzer: read.onOff(['buzzer_enable']),
    haptic: read.onOff(['haptic_enable']),
    keysEnabled: read.onOff(['key_user_interface_enable']),
    localSettingsEnabled: read.onOff(['local_user_settings_enable']),
  });
  return { value, issues: read.issues };
}

// ---------------------------------------------------------------------------
// Programs (`device_program_profile_N.xml`)

export const PRESETS = ['DAY', 'NIGHT', 'AWAY', 'PROTECTION'] as const;
export type Preset = (typeof PRESETS)[number];

export const WEEKDAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'] as const;
export type Weekday = (typeof WEEKDAYS)[number];

/** From `time` on, the program uses `preset`, until the next slot of the day. */
export interface TimeSlot {
  /** `HH:MM`. */
  readonly time: string;
  readonly preset: Preset;
}

export interface ProgramProfile {
  readonly number?: number;
  readonly name?: string;
  readonly type?: 'DAILY' | 'WEEKLY';
  readonly valid?: boolean;
  /** `YYYY-MM-DDTHH:MM:SS`, kept when the program is edited. */
  readonly createdAt?: string;
  /** Slots of each day, sorted by time. A day without slots keeps the preset of the day before. */
  readonly days: Readonly<Record<Weekday, readonly TimeSlot[]>>;
}

const MAX_SLOTS_PER_DAY = 16;
const SLOT_TIME = /^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/;
const PROGRAM_TYPE = /^(?:DAILY|WEEKLY)$/;
const CREATION_DATE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}$/;
// Names are typed by the user: printable characters only, no markup.
// eslint-disable-next-line no-control-regex -- matching control characters is the point
const NAME_FORBIDDEN = /[\u0000-\u001f\u007f<>]/;
const MAX_NAME_LENGTH = 64;

/** Parses a program file. Malformed slots are left out and reported. */
export function parseProgramProfile(text: string): ParsedFile<ProgramProfile> {
  const root = parseFile(text, 'program_profile');
  const read = new FieldReader(root);
  const description = ['program_description'];
  const numberText = read.match([...description, 'number'], /^[0-9]{1,2}$/);
  const number = numberText === undefined ? undefined : Number(numberText);
  const nameText = textAt(root, [...description, 'name']);
  let name: string | undefined;
  if (nameText !== undefined) {
    if (nameText.length <= MAX_NAME_LENGTH && !NAME_FORBIDDEN.test(nameText)) name = nameText;
    else read.issues.push('invalid program_description/name');
  }
  const validText = read.match([...description, 'is_program_profile_valid'], /^(?:TRUE|FALSE)$/);

  const days = {} as Record<Weekday, TimeSlot[]>;
  const weekday = root.children.find((child) => child.name === 'weekday');
  for (const day of WEEKDAYS) {
    const slots: TimeSlot[] = [];
    const element = weekday?.children.find((child) => child.name === day);
    for (const slot of element?.children ?? []) {
      if (slot.name !== 'slot') continue;
      const time = slot.attributes.get('time') ?? '';
      const preset = slot.attributes.get('preset') ?? '';
      if (SLOT_TIME.test(time) && (PRESETS as readonly string[]).includes(preset) && slots.length < MAX_SLOTS_PER_DAY) {
        slots.push({ time, preset: preset as Preset });
      } else {
        read.issues.push(`invalid slot on ${day}`);
      }
    }
    days[day] = slots.sort((a, b) => a.time.localeCompare(b.time));
  }

  const value = defined<ProgramProfile>({
    number: number !== undefined && number <= PROGRAM_NUMBER_MAX ? number : undefined,
    name,
    type: read.match([...description, 'type'], PROGRAM_TYPE) as 'DAILY' | 'WEEKLY' | undefined,
    valid: validText === undefined ? undefined : validText === 'TRUE',
    createdAt: read.match([...description, 'creation_date'], CREATION_DATE),
    days,
  });
  if (number !== undefined && number > PROGRAM_NUMBER_MAX) read.issues.push('invalid program_description/number');
  return { value, issues: read.issues };
}
