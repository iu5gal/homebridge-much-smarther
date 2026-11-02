import { BOOST_MINUTES, FUNCTIONS, MODES, PROGRAM_NUMBER_MAX, type BoostMinutes, type Mode, type ThermostatFunction } from './commands.js';
import type { Params } from './message.js';

/** Typed view of the `device_state` parameters (PROTOCOL.md §6). */
export interface ThermostatState {
  readonly function?: ThermostatFunction;
  readonly mode?: Mode;
  readonly setpoint?: number;
  readonly programNumber?: number;
  /** Left out when the thermostat flags the measurement as not valid. */
  readonly ambientTemperature?: number;
  readonly ambientTemperatureValid?: boolean;
  readonly measuredTemperature?: number;
  /** Left out when the thermostat flags the measurement as not valid. */
  readonly humidity?: number;
  readonly humidityValid?: boolean;
  readonly heatingActive?: boolean;
  readonly coolingActive?: boolean;
  /** Time window of the current mode (boost, timed manual or off), local time. */
  readonly validity?: { readonly start?: string; readonly end?: string };
  /** From `boostTime`, or derived from the validity window of a boost. */
  readonly boostMinutes?: BoostMinutes;
  readonly deviceClockValid?: boolean;
  readonly timestamp?: string;
  /** UTC offset of the thermostat's clock, from `timestamp` (for example +60 for `+01:00`). */
  readonly utcOffsetMinutes?: number;
  /** Every parameter as received, including unknown ones. */
  readonly raw: ReadonlyMap<string, string>;
}

export interface ParsedState {
  readonly state: ThermostatState;
  /** Fields that were present but invalid, and therefore left out. */
  readonly issues: readonly string[];
}

// The device pads decimals to five places, for example "19.80000".
const DECIMAL = /^-?[0-9]{1,3}(?:\.[0-9]{1,6})?$/;
const INTEGER = /^[0-9]{1,3}$/;
const DATE_TIME = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}$/;
const TIMESTAMP_OFFSET = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:Z|([+-])([0-9]{2}):([0-9]{2}))$/;
const MAX_UTC_OFFSET_MINUTES = 14 * 60;
const ACTIVE_VALUES = new Set(['ACTIVE', 'ON', 'TRUE', '1']);
const INACTIVE_VALUES = new Set(['INACTIVE', 'OFF', 'FALSE', '0']);

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

/** Parses `device_state` parameters strictly; invalid fields become issues. */
export function parseDeviceState(params: ReadonlyMap<string, string>): ParsedState {
  const state: Mutable<ThermostatState> = { raw: new Map(params) };
  const issues: string[] = [];

  const read = <T>(key: string, parse: (value: string) => T | undefined, assign: (value: T) => void) => {
    const value = params.get(key);
    if (value === undefined || value === '') return;
    const parsed = parse(value);
    if (parsed === undefined) issues.push(`invalid ${key}`);
    else assign(parsed);
  };
  const decimal = (min: number, max: number) => (value: string) => {
    if (!DECIMAL.test(value)) return undefined;
    const number = Number(value);
    return number >= min && number <= max ? number : undefined;
  };
  const oneOf =
    <T extends string>(values: readonly T[]) =>
    (value: string) =>
      (values as readonly string[]).includes(value) ? (value as T) : undefined;
  const flag = (value: string) => {
    const upper = value.toUpperCase();
    if (ACTIVE_VALUES.has(upper)) return true;
    if (INACTIVE_VALUES.has(upper)) return false;
    return undefined;
  };
  const dateTime = (value: string) => (DATE_TIME.test(value) ? value : undefined);

  read('function', oneOf(FUNCTIONS), (v) => (state.function = v));
  read('mode', oneOf(MODES), (v) => (state.mode = v));
  read('setpoint', decimal(0, 50), (v) => (state.setpoint = v));
  // A value flagged as not valid is not a measurement (PROTOCOL.md §6).
  read('is_ambient_temperature_valid', flag, (v) => (state.ambientTemperatureValid = v));
  read('is_ambient_relative_humidity_valid', flag, (v) => (state.humidityValid = v));
  read('ambient_temperature_value', decimal(-40, 80), (v) => {
    if (state.ambientTemperatureValid !== false) state.ambientTemperature = v;
  });
  read('measured_temperature', decimal(-40, 80), (v) => (state.measuredTemperature = v));
  read('ambient_relative_humidity_value', decimal(0, 100), (v) => {
    if (state.humidityValid !== false) state.humidity = v;
  });
  read(
    'program_number',
    (v) => (INTEGER.test(v) && Number(v) <= PROGRAM_NUMBER_MAX ? Number(v) : undefined),
    (v) => (state.programNumber = v),
  );
  read('heating_thermoregulation_load_state', flag, (v) => (state.heatingActive = v));
  read('cooling_thermoregulation_load_state', flag, (v) => (state.coolingActive = v));
  read('is_device_date_and_time_valid', flag, (v) => (state.deviceClockValid = v));
  read('timestamp', (v) => (v.length <= 64 ? v : undefined), (v) => (state.timestamp = v));
  if (state.timestamp !== undefined) {
    const offset = utcOffsetOf(state.timestamp);
    if (offset !== undefined) state.utcOffsetMinutes = offset;
  }
  read(
    'boostTime',
    (v) => BOOST_MINUTES.find((minutes) => String(minutes) === v),
    (v) => (state.boostMinutes = v),
  );

  read('use_date_and_time_validity', flag, (inUse) => {
    if (!inUse) return;
    const validity: Mutable<NonNullable<ThermostatState['validity']>> = {};
    read('init_date_and_time_validity', dateTime, (v) => (validity.start = v));
    read('end_date_and_time_validity', dateTime, (v) => (validity.end = v));
    state.validity = validity;
  });

  // The device does not report boostTime: the duration shows as the window.
  if (state.mode === 'BOOST' && state.boostMinutes === undefined && state.validity?.start && state.validity.end) {
    const minutes = (Date.parse(state.validity.end) - Date.parse(state.validity.start)) / 60_000;
    const boost = BOOST_MINUTES.find((candidate) => candidate === Math.round(minutes));
    if (boost !== undefined) state.boostMinutes = boost;
  }

  return { state, issues };
}

/** Offset of a `timestamp` such as `2026-01-02T18:36:47+01:00`, in minutes; `undefined` without one. */
function utcOffsetOf(timestamp: string): number | undefined {
  const match = TIMESTAMP_OFFSET.exec(timestamp);
  if (!match) return undefined;
  const [, sign, hours, minutes] = match;
  if (sign === undefined) return 0; // "Z"
  const offset = (sign === '-' ? -1 : 1) * (Number(hours) * 60 + Number(minutes));
  return Math.abs(offset) <= MAX_UTC_OFFSET_MINUTES ? offset : undefined;
}

/** One slot of `device_program_number_list` (PROTOCOL.md §5). */
export interface ProgramSlot {
  readonly number: number;
  readonly present: boolean;
  /** When the program was last changed, as sent by the device. */
  readonly changedAt?: string;
}

const PROGRAM_PRESENT = /^program_([0-9]{1,3})_present$/;

/** Parses the program list; malformed slots are left out. */
export function parseProgramList(groups: readonly Params[]): ProgramSlot[] {
  const slots: ProgramSlot[] = [];
  for (const group of groups) {
    for (const [key, value] of group) {
      const match = PROGRAM_PRESENT.exec(key);
      if (!match || (value !== 'TRUE' && value !== 'FALSE')) continue;
      const changedAt = group.get('timestamp');
      slots.push({
        number: Number(match[1]),
        present: value === 'TRUE',
        ...(changedAt && changedAt.length <= 64 ? { changedAt } : {}),
      });
    }
  }
  return slots.sort((a, b) => a.number - b.number);
}
