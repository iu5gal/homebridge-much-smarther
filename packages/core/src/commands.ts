import { ValidationError } from './errors.js';
import { encodeMessage } from './message.js';

/**
 * The only messages this library can send (PROTOCOL.md §4–5). There is no
 * generic "send" on purpose: every value that reaches the thermostat goes
 * through one of these builders and their validation.
 */

export const MODES = ['AUTOMATIC', 'MANUAL', 'BOOST', 'PROTECTION', 'OFF'] as const;
export type Mode = (typeof MODES)[number];

export const FUNCTIONS = ['HEATING', 'COOLING'] as const;
export type ThermostatFunction = (typeof FUNCTIONS)[number];

export const BOOST_MINUTES = [30, 60, 90] as const;
export type BoostMinutes = (typeof BOOST_MINUTES)[number];

export const SETPOINT_MIN = 7;
export const SETPOINT_MAX = 40;
export const SETPOINT_STEP = 0.1;
/** Program slots: 0 is the system program, 1–10 the user programs. */
export const PROGRAM_NUMBER_MAX = 10;
/**
 * Setpoint sent with `PROTECTION`, whatever the function, as the BTicino app
 * does for "Off". The device then reports its own protection temperature.
 */
export const PROTECTION_SETPOINT = 7;
/** Furthest end time of a timed mode, as offered by the BTicino app. */
export const UNTIL_MAX_DAYS = 10;

const WHO_THERMOREGULATION = '4';
const WHO_FILES = '1004';

/** The configuration file of the thermostat (PROTOCOL.md §5.2). */
export const CONFIGURATION_FILE = 'device_configuration.xml';
const PROGRAM_FILE = /^device_program_profile_(?:[0-9]|10)\.xml$/;

/** The file of program `number` (0–10). */
export function programFileName(number: number): string {
  if (!Number.isInteger(number) || number < 0 || number > PROGRAM_NUMBER_MAX) {
    throw new ValidationError('invalid program number');
  }
  return `device_program_profile_${number}.xml`;
}

/** Only these files can be read: there is no access to arbitrary files. */
export function isDeviceFileName(name: unknown): name is string {
  return typeof name === 'string' && (name === CONFIGURATION_FILE || PROGRAM_FILE.test(name));
}

export type DeviceStateRequest =
  | { readonly mode: 'AUTOMATIC'; readonly function: ThermostatFunction; readonly programNumber?: number }
  | { readonly mode: 'MANUAL'; readonly function: ThermostatFunction; readonly setpoint: number; readonly until?: Date }
  | { readonly mode: 'BOOST'; readonly function: ThermostatFunction; readonly minutes: BoostMinutes }
  | { readonly mode: 'PROTECTION'; readonly function: ThermostatFunction; readonly until?: Date }
  | { readonly mode: 'OFF'; readonly function: ThermostatFunction };

export function isValidSetpoint(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= SETPOINT_MIN &&
    value <= SETPOINT_MAX &&
    // Tolerance for binary floating point: 20.7 / 0.1 is 206.99999999999997.
    Math.abs(value / SETPOINT_STEP - Math.round(value / SETPOINT_STEP)) < 1e-6
  );
}

function isOneOf<T extends string | number>(values: readonly T[], value: unknown): value is T {
  return (values as readonly unknown[]).includes(value);
}

/** `until` of a timed mode: absent ("forever"), or a time after `now` and at most `UNTIL_MAX_DAYS` later. */
function validateUntil(until: unknown, now: Date): { until?: Date } {
  if (until === undefined) return {};
  if (!(until instanceof Date) || !Number.isFinite(until.getTime())) throw new ValidationError('until must be a date');
  if (until.getTime() <= now.getTime()) throw new ValidationError('until must be in the future');
  if (until.getTime() > now.getTime() + UNTIL_MAX_DAYS * 86_400_000) {
    throw new ValidationError(`until must be at most ${UNTIL_MAX_DAYS} days ahead`);
  }
  return { until: new Date(until.getTime()) };
}

/**
 * Checks an untrusted value (from the UI, the config or HomeKit) and returns
 * it as a request, or throws `ValidationError`. Unknown keys are rejected.
 */
export function validateDeviceStateRequest(input: unknown, now: Date = new Date()): DeviceStateRequest {
  if (typeof input !== 'object' || input === null) throw new ValidationError('request must be an object');
  const record = input as Record<string, unknown>;
  const { mode, function: fn } = record;
  if (!isOneOf(MODES, mode)) throw new ValidationError('invalid mode');
  if (!isOneOf(FUNCTIONS, fn)) throw new ValidationError('invalid function');

  const allowed: Record<Mode, readonly string[]> = {
    AUTOMATIC: ['programNumber'],
    MANUAL: ['setpoint', 'until'],
    BOOST: ['minutes'],
    PROTECTION: ['until'],
    OFF: [],
  };
  for (const key of Object.keys(record)) {
    if (key !== 'mode' && key !== 'function' && !allowed[mode].includes(key)) {
      throw new ValidationError(`unexpected field "${key}" for mode ${mode}`);
    }
  }

  switch (mode) {
    case 'AUTOMATIC': {
      const { programNumber } = record;
      if (programNumber === undefined) return { mode, function: fn };
      if (
        typeof programNumber !== 'number' ||
        !Number.isInteger(programNumber) ||
        programNumber < 0 ||
        programNumber > PROGRAM_NUMBER_MAX
      ) {
        throw new ValidationError('invalid program number');
      }
      return { mode, function: fn, programNumber };
    }
    case 'MANUAL': {
      const { setpoint } = record;
      if (!isValidSetpoint(setpoint)) {
        throw new ValidationError(`setpoint must be ${SETPOINT_MIN}–${SETPOINT_MAX} in steps of ${SETPOINT_STEP}`);
      }
      return { mode, function: fn, setpoint, ...validateUntil(record['until'], now) };
    }
    case 'BOOST': {
      const { minutes } = record;
      if (!isOneOf(BOOST_MINUTES, minutes)) throw new ValidationError('boost must be 30, 60 or 90 minutes');
      return { mode, function: fn, minutes };
    }
    case 'PROTECTION':
      return { mode, function: fn, ...validateUntil(record['until'], now) };
    case 'OFF':
      return { mode, function: fn };
  }
}

/**
 * Local date-time as the thermostat expects it: `YYYY-MM-DDTHH:MM:SS`, no
 * offset. With `utcOffsetMinutes` (the thermostat's own offset) the wall
 * clock of that zone is used, otherwise the local zone of this machine.
 */
export function formatLocalDateTime(date: Date, utcOffsetMinutes?: number): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  if (utcOffsetMinutes !== undefined) {
    const shifted = new Date(date.getTime() + utcOffsetMinutes * 60_000);
    return (
      `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}` +
      `T${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}:${pad(shifted.getUTCSeconds())}`
    );
  }
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  );
}

/** True when the request is sent with a validity window (PROTOCOL.md §5.1). */
export function hasValidityWindow(request: DeviceStateRequest): boolean {
  return request.mode === 'BOOST' || ((request.mode === 'MANUAL' || request.mode === 'PROTECTION') && !!request.until);
}

export function buildNegotiate(seqId: string): string {
  return encodeMessage({
    style: 'handshake',
    service: 'SET',
    seqId,
    progress: 0,
    actionId: 'OWNSetProtocol',
    params: [{ Version: '3' }, { Command: '1' }, { Monitor: '1' }, { ConnAlwaysOn: '1' }],
  });
}

export function buildClientHandshake(
  seqId: string,
  progress: number,
  randomDecimal: string,
  digestDecimal: string,
): string {
  return encodeMessage({
    style: 'handshake',
    service: 'SET',
    seqId,
    progress,
    actionId: 'ClientHandshakeHMAC',
    params: [{ Random: randomDecimal }, { Digest: digestDecimal }],
  });
}

export function buildHandshakeAck(seqId: string, progress: number): string {
  return encodeMessage({ style: 'handshake', service: 'RSP', seqId, progress, actionId: 'AckMsg' });
}

function buildGet(
  seqId: string,
  actionId: string,
  who = WHO_THERMOREGULATION,
  params?: readonly Record<string, string>[],
): string {
  return encodeMessage({ style: 'command', service: 'GET', seqId, progress: 0, actionId, who, ...(params ? { params } : {}) });
}

export function buildGetDeviceState(seqId: string): string {
  return buildGet(seqId, 'device_state');
}

export function buildKeepAlive(seqId: string): string {
  return buildGet(seqId, 'device_keep_alive');
}

export function buildGetProgramList(seqId: string): string {
  return buildGet(seqId, 'device_program_number_list');
}

export function buildGetDiagnostic(seqId: string): string {
  return buildGet(seqId, 'device_diagnostic');
}

/** `GET device_file` for one of the files `isDeviceFileName` allows. */
export function buildGetFile(seqId: string, fileName: string): string {
  if (!isDeviceFileName(fileName)) throw new ValidationError('this file cannot be read');
  return buildGet(seqId, 'device_file', WHO_FILES, [{ file_name: fileName }]);
}

/**
 * `SET device_state`. The request is validated again here, whatever its
 * origin. Parameters go in a fixed order (PROTOCOL.md §5.1). A boost, a timed
 * manual and a timed off carry their end only as the validity window.
 */
export function buildSetDeviceState(
  seqId: string,
  input: DeviceStateRequest,
  now: Date,
  utcOffsetMinutes?: number,
): string {
  const request = validateDeviceStateRequest(input, now);
  const params: Record<string, string>[] = [
    { temperature_format: 'CELSIUS' },
    { function: request.function },
    { mode: request.mode },
  ];
  let end: Date | undefined;
  if (request.mode === 'BOOST') end = new Date(now.getTime() + request.minutes * 60_000);
  else if (request.mode === 'MANUAL' || request.mode === 'PROTECTION') end = request.until;
  if (end) {
    params.push({
      use_date_and_time_validity: 'TRUE',
      init_date_and_time_validity: formatLocalDateTime(now, utcOffsetMinutes),
      end_date_and_time_validity: formatLocalDateTime(end, utcOffsetMinutes),
    });
  } else {
    params.push({
      use_date_and_time_validity: 'FALSE',
      end_date_and_time_validity: '',
      init_date_and_time_validity: '',
    });
  }
  // Five decimals, as the device writes the setpoint itself.
  if (request.mode === 'MANUAL') params.push({ setpoint: request.setpoint.toFixed(5) });
  if (request.mode === 'PROTECTION') params.push({ setpoint: PROTECTION_SETPOINT.toFixed(5) });
  if (request.mode === 'AUTOMATIC' && request.programNumber !== undefined) {
    params.push({ program_number: String(request.programNumber) });
  }
  return encodeMessage({
    style: 'command',
    service: 'SET',
    seqId,
    progress: 0,
    actionId: 'device_state',
    who: WHO_THERMOREGULATION,
    params,
  });
}
