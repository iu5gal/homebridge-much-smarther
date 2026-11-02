import { WEEKDAYS, type Preset, type ProgramProfile, type TemperatureLevels } from './device-files.js';

/**
 * Where the weekly program stands at a given time, computed as the BTicino
 * app does (PROTOCOL.md §6.1): the program is one week of slots, each slot
 * holds its preset until the next one, and the "next change" is the next
 * slot with a different preset, not merely the next slot.
 *
 * Times are the thermostat's wall clock. With `utcOffsetMinutes` (its offset,
 * from the state) the wall clock of that zone is used, otherwise this
 * machine's. A result formatted with the same offset gives back the exact
 * slot time, whatever happens with daylight saving in between.
 */

export interface LevelChange {
  /** When the next level starts. */
  readonly at: Date;
  readonly preset: Preset;
  /** Temperature of that level, when `levels` were given. */
  readonly temperature?: number;
}

export interface ScheduleOptions {
  readonly utcOffsetMinutes?: number;
  /** Levels of the current function (heating or cooling), for the temperatures. */
  readonly levels?: TemperatureLevels;
}

interface Entry {
  /** Minutes since Monday 00:00. */
  readonly minute: number;
  readonly preset: Preset;
}

const MINUTES_PER_DAY = 24 * 60;
const MINUTES_PER_WEEK = 7 * MINUTES_PER_DAY;

/** The slots of the week in order, as minutes since Monday 00:00. */
function timeline(program: ProgramProfile): Entry[] {
  const entries: Entry[] = [];
  WEEKDAYS.forEach((day, index) => {
    for (const slot of program.days[day]) {
      const [hours, minutes] = slot.time.split(':').map(Number);
      entries.push({ minute: index * MINUTES_PER_DAY + (hours ?? 0) * 60 + (minutes ?? 0), preset: slot.preset });
    }
  });
  return entries.sort((a, b) => a.minute - b.minute);
}

/** Wall-clock position in the week, and the instant of the week's start. */
function weekPosition(now: Date, utcOffsetMinutes: number | undefined): { minute: number; weekStart: number } {
  const offset = utcOffsetMinutes ?? -now.getTimezoneOffset();
  const wall = new Date(now.getTime() + offset * 60_000);
  const weekday = (wall.getUTCDay() + 6) % 7; // Monday = 0
  const minute = weekday * MINUTES_PER_DAY + wall.getUTCHours() * 60 + wall.getUTCMinutes();
  const wallMidnight = Date.UTC(wall.getUTCFullYear(), wall.getUTCMonth(), wall.getUTCDate());
  return { minute, weekStart: wallMidnight - weekday * MINUTES_PER_DAY * 60_000 - offset * 60_000 };
}

function usable(program: ProgramProfile): boolean {
  return program.valid !== false;
}

/** The entry in force at `minute`: the last one at or before it, or the last of the previous week. */
function entryAt(entries: readonly Entry[], minute: number): Entry | undefined {
  let current = entries[entries.length - 1];
  for (const entry of entries) {
    if (entry.minute > minute) break;
    current = entry;
  }
  return current;
}

/** The preset the program holds at `now`, or `undefined` for a program without slots. */
export function activePreset(program: ProgramProfile, now: Date, options: ScheduleOptions = {}): Preset | undefined {
  if (!usable(program)) return undefined;
  return entryAt(timeline(program), weekPosition(now, options.utcOffsetMinutes).minute)?.preset;
}

/**
 * The next change of level after `now`, or `undefined` when the program
 * never changes level (the app then proposes "forever").
 */
export function nextLevelChange(
  program: ProgramProfile,
  now: Date,
  options: ScheduleOptions = {},
): LevelChange | undefined {
  if (!usable(program)) return undefined;
  const entries = timeline(program);
  const { minute, weekStart } = weekPosition(now, options.utcOffsetMinutes);
  const current = entryAt(entries, minute);
  if (!current) return undefined;

  // Later this week first, then the whole of next week up to now.
  const candidates = [
    ...entries.filter((entry) => entry.minute > minute),
    ...entries.filter((entry) => entry.minute <= minute).map((entry) => ({ ...entry, minute: entry.minute + MINUTES_PER_WEEK })),
  ];
  const next = candidates.find((entry) => entry.preset !== current.preset);
  if (!next) return undefined;

  const temperature = options.levels ? levelTemperature(options.levels, next.preset) : undefined;
  return {
    at: new Date(weekStart + next.minute * 60_000),
    preset: next.preset,
    ...(temperature === undefined ? {} : { temperature }),
  };
}

/** The temperature of a preset in the given levels. */
export function levelTemperature(levels: TemperatureLevels, preset: Preset): number | undefined {
  switch (preset) {
    case 'DAY':
      return levels.day;
    case 'NIGHT':
      return levels.night;
    case 'AWAY':
      return levels.away;
    case 'PROTECTION':
      return levels.protection;
  }
}
