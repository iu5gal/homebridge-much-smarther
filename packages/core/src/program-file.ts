import { createHash } from 'node:crypto';
import { PROGRAM_NUMBER_MAX, programFileName, WHO_FILES } from './commands.js';
import { PRESETS, WEEKDAYS, type Preset, type ProgramProfile, type TimeSlot, type Weekday } from './device-files.js';
import { ValidationError } from './errors.js';
import { encodeMessage } from './message.js';
import { escapeXml } from './xml.js';

/**
 * Writing the weekly programs (PROTOCOL.md §5.3). A program reaches the
 * thermostat only as a validated `ProgramDraft`, written out here field by
 * field: no text from outside is ever sent as a file, and only the user
 * programs `1`–`10` can be written or erased.
 */

/** The user programs. `0` is the system program, which is never written. */
export const USER_PROGRAM_MIN = 1;
/** Below the app's 64: a name of 64 characters comes back damaged (PROTOCOL.md §5.3). */
export const PROGRAM_NAME_MAX_LENGTH = 32;
export const SLOTS_PER_DAY_MAX = 10;
/** Older firmware takes fewer slots a day (PROTOCOL.md §5.3). */
const SLOTS_PER_DAY_OLD_FIRMWARE = 8;
const OLD_FIRMWARE = /^1\.0\./;

/** Printable ASCII without what has a meaning in XML. Accents and other scripts are not known to be safe. */
const NEW_NAME = /^[!#-%(-;=?-~](?:[ !#-%(-;=?-~]*[!#-%(-;=?-~])?$/;
// A name already on the thermostat may hold more than a new one, such as "/".
// eslint-disable-next-line no-control-regex -- matching control characters is the point
const NAME_FORBIDDEN = /[\u0000-\u001f\u007f<>]/;
const EXISTING_NAME_MAX_LENGTH = 63;
const QUARTER_HOUR = /^(?:[01][0-9]|2[0-3]):(?:00|15|30|45)$/;
const MIDNIGHT = '00:00';
const CREATED_AT = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}$/;
const ERASE = 'ERASE';
/** The order of the days in the file (PROTOCOL.md §5.3). */
const FILE_DAYS: readonly Weekday[] = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

export interface ProgramDraft {
  /** `1`–`10`. */
  readonly number: number;
  readonly name: string;
  /** `YYYY-MM-DDTHH:MM:SS`, on the thermostat's clock. Kept when a program is edited. */
  readonly createdAt: string;
  /** Slots of each day, in time order, the first one at `00:00`. */
  readonly days: Readonly<Record<Weekday, readonly TimeSlot[]>>;
}

export interface ProgramDraftOptions {
  /** The current name of the program: it is accepted unchanged even if a new name could not be written like that. */
  readonly existingName?: string;
  /** From `slotsPerDayLimit()`. Default `SLOTS_PER_DAY_MAX`. */
  readonly maxSlotsPerDay?: number;
}

/** How many slots a day the firmware takes, from `firmware_version_of_last_saving`. */
export function slotsPerDayLimit(firmwareVersion: string | undefined): number {
  return firmwareVersion !== undefined && OLD_FIRMWARE.test(firmwareVersion) ? SLOTS_PER_DAY_OLD_FIRMWARE : SLOTS_PER_DAY_MAX;
}

/** Throws `ValidationError` unless `number` is a user program. */
export function assertUserProgram(number: unknown): asserts number is number {
  if (typeof number !== 'number' || !Number.isInteger(number) || number < USER_PROGRAM_MIN || number > PROGRAM_NUMBER_MAX) {
    throw new ValidationError(`only the programs ${USER_PROGRAM_MIN}–${PROGRAM_NUMBER_MAX} can be changed`);
  }
}

/**
 * What a typed name becomes when it is saved: letters without their accents,
 * digits, plain symbols and single spaces, within the length limit. Other
 * scripts and the characters with a meaning in XML go, since the thermostat is
 * not known to handle them. The result may be empty.
 */
export function cleanProgramName(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[^ !#-%(-;=?-~]/g, '')
    .replace(/ +/g, ' ')
    .trim()
    .slice(0, PROGRAM_NAME_MAX_LENGTH)
    .trim();
}

function validName(name: unknown, existingName: string | undefined): string {
  if (typeof name !== 'string') throw new ValidationError('the program name must be text');
  if (name === existingName && name.trim() !== '' && name.length <= EXISTING_NAME_MAX_LENGTH && !NAME_FORBIDDEN.test(name)) {
    return name;
  }
  if (!NEW_NAME.test(name) || name.length > PROGRAM_NAME_MAX_LENGTH) {
    throw new ValidationError(`the program name must be 1–${PROGRAM_NAME_MAX_LENGTH} plain letters, digits, spaces or symbols`);
  }
  return name;
}

function validSlot(input: unknown): TimeSlot {
  if (typeof input !== 'object' || input === null) throw new ValidationError('a time slot must be an object');
  const record = input as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (key !== 'time' && key !== 'preset') throw new ValidationError(`unexpected field "${key}" in a time slot`);
  }
  const { time, preset } = record;
  if (typeof time !== 'string' || !QUARTER_HOUR.test(time)) throw new ValidationError('a time must be HH:MM, in quarter hours');
  if (!(PRESETS as readonly unknown[]).includes(preset)) throw new ValidationError('unknown temperature level');
  return { time, preset: preset as Preset };
}

function validDay(day: Weekday, input: unknown, maxSlots: number): TimeSlot[] {
  if (!Array.isArray(input) || input.length === 0) throw new ValidationError(`${day} needs at least one time slot`);
  // Far more than a real day: a merged day can be shorter, but nothing this long is worth reading.
  if (input.length > SLOTS_PER_DAY_MAX * 8) throw new ValidationError(`${day} has too many time slots`);
  const slots = input.map(validSlot);
  if (slots[0]?.time !== MIDNIGHT) throw new ValidationError(`${day} must start at ${MIDNIGHT}`);
  slots.forEach((slot, index) => {
    const before = slots[index - 1];
    if (before && before.time >= slot.time) throw new ValidationError(`the times of ${day} must be in order`);
  });
  // A slot with the level of the one before changes nothing.
  const merged = slots.filter((slot, index) => slot.preset !== slots[index - 1]?.preset);
  if (merged.length > maxSlots) throw new ValidationError(`${day} can have at most ${maxSlots} time slots`);
  return merged;
}

/**
 * Checks an untrusted value and returns it as a draft, or throws
 * `ValidationError`. Unknown keys are rejected. Neighbouring slots with the
 * same level are merged, since they mean the same as one.
 */
export function validateProgramDraft(input: unknown, options: ProgramDraftOptions = {}): ProgramDraft {
  if (typeof input !== 'object' || input === null) throw new ValidationError('a program must be an object');
  const record = input as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!['number', 'name', 'createdAt', 'days'].includes(key)) throw new ValidationError(`unexpected field "${key}"`);
  }
  const { number, name, createdAt, days } = record;
  assertUserProgram(number);
  if (typeof createdAt !== 'string' || !CREATED_AT.test(createdAt)) throw new ValidationError('invalid creation date');
  if (typeof days !== 'object' || days === null) throw new ValidationError('a program needs its days');
  const dayRecord = days as Record<string, unknown>;
  for (const key of Object.keys(dayRecord)) {
    if (!(WEEKDAYS as readonly string[]).includes(key)) throw new ValidationError(`unknown day "${key}"`);
  }
  const maxSlots = options.maxSlotsPerDay ?? SLOTS_PER_DAY_MAX;
  const checked = {} as Record<Weekday, readonly TimeSlot[]>;
  for (const day of WEEKDAYS) checked[day] = validDay(day, dayRecord[day], maxSlots);
  return { number, name: validName(name, options.existingName), createdAt, days: checked };
}

/**
 * The days with a slot at `00:00` each. A day may leave it out, and then keeps
 * the level of the day before (PROTOCOL.md §5.2): this writes that out, so the
 * meaning stays the same when a day is edited or copied on its own.
 */
export function withMidnightSlots(days: Readonly<Record<Weekday, readonly TimeSlot[]>>): Record<Weekday, TimeSlot[]> {
  const week = WEEKDAYS.map((day) => days[day]);
  let level = [...week].reverse().find((slots) => slots.length > 0)?.at(-1)?.preset;
  const result = {} as Record<Weekday, TimeSlot[]>;
  WEEKDAYS.forEach((day, index) => {
    const slots = week[index] ?? [];
    const first = slots[0];
    result[day] = level !== undefined && first?.time !== MIDNIGHT ? [{ time: MIDNIGHT, preset: level }, ...slots] : [...slots];
    level = slots.at(-1)?.preset ?? level;
  });
  return result;
}

/**
 * A program read from the thermostat, as a draft to edit or to write back.
 * The result is not validated: a program whose name was left out comes back
 * with an empty one, for the user to fill in.
 */
export function draftFromProfile(profile: ProgramProfile, fallbackCreatedAt: string): ProgramDraft {
  assertUserProgram(profile.number);
  return {
    number: profile.number,
    name: profile.name ?? '',
    createdAt: profile.createdAt ?? fallbackCreatedAt,
    days: withMidnightSlots(profile.days),
  };
}

function programType(days: ProgramDraft['days']): 'DAILY' | 'WEEKLY' {
  const week = WEEKDAYS.map((day) => JSON.stringify(days[day]));
  return week.every((day) => day === week[0]) ? 'DAILY' : 'WEEKLY';
}

/** The file text, laid out exactly as the thermostat itself lays it out (PROTOCOL.md §5.3). */
export function serializeProgram(draft: ProgramDraft): string {
  const lines = [
    '<program_profile>',
    `\t<filename>${programFileName(draft.number)}</filename>`,
    '\t<program_description>',
    '\t\t<is_program_profile_valid>TRUE</is_program_profile_valid>',
    `\t\t<number>${draft.number}</number>`,
    `\t\t<name>${escapeXml(draft.name)}</name>`,
    `\t\t<type>${programType(draft.days)}</type>`,
    '\t\t<is_creation_date_valid>TRUE</is_creation_date_valid>',
    `\t\t<creation_date>${draft.createdAt}</creation_date>`,
    '\t</program_description>',
    '\t<weekday>',
  ];
  for (const day of FILE_DAYS) {
    lines.push(`\t\t<${day}>`);
    draft.days[day].forEach((slot, id) => {
      lines.push(`\t\t\t<slot id="${id}" preset="${slot.preset}" time="${slot.time}"/>`);
    });
    lines.push(`\t\t</${day}>`);
  }
  lines.push('\t</weekday>', '</program_profile>', '');
  return lines.join('\n');
}

function buildSetFile(seqId: string, number: number, content: string): string {
  return encodeMessage({
    style: 'command',
    service: 'SET',
    seqId,
    progress: 0,
    actionId: 'device_file',
    who: WHO_FILES,
    params: [
      {
        file_name: programFileName(number),
        sha256sum: createHash('sha256').update(content, 'utf8').digest('hex'),
      },
    ],
    file: content,
  });
}

/** `SET device_file` with a program. The draft is validated again here, whatever its origin. */
export function buildSetProgram(seqId: string, input: unknown, options: ProgramDraftOptions = {}): string {
  const draft = validateProgramDraft(input, options);
  return buildSetFile(seqId, draft.number, serializeProgram(draft));
}

/** `SET device_file` that empties a user program. */
export function buildEraseProgram(seqId: string, number: unknown): string {
  assertUserProgram(number);
  return buildSetFile(seqId, number, ERASE);
}

/** Whether a program read from the thermostat says the same as the draft that was written. */
export function programMatchesDraft(profile: ProgramProfile, input: ProgramDraft): boolean {
  return (
    profile.valid === true &&
    profile.number === input.number &&
    profile.name === input.name &&
    profile.type === programType(input.days) &&
    WEEKDAYS.every((day) => JSON.stringify(profile.days[day]) === JSON.stringify(input.days[day]))
  );
}
