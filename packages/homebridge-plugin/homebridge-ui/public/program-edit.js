// What the program editor of the setup UI does to a program, without any page.
// A day is a list of slots: from `time` on it uses `preset`, until the next
// slot. The first slot is always at midnight, so a day means the same on its own.
// The plugin validates everything again: these checks only give an answer at once.

export const DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
export const WORKING_DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'];
export const LEVELS = ['DAY', 'NIGHT', 'AWAY', 'PROTECTION'];
export const QUARTERS = ['00', '15', '30', '45'];
export const NAME_MAX = 32;

const MINUTES_PER_DAY = 24 * 60;
const QUARTER_HOUR = /^(?:[01][0-9]|2[0-3]):(?:00|15|30|45)$/;

/** @typedef {{ time: string, preset: string }} Slot */

/** @param {string} time "HH:MM" */
export function minutesOf(time) {
  const [hours = 0, minutes = 0] = time.split(':').map(Number);
  return hours * 60 + minutes;
}

/** @param {number} minutes */
function timeOf(minutes) {
  const pad = (/** @type {number} */ value) => String(value).padStart(2, '0');
  return `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;
}

/** Where a new program starts: an ordinary day, ready to be changed. */
export function newProgramDays() {
  return Object.fromEntries(
    DAYS.map((day) => [
      day,
      [
        { time: '00:00', preset: 'NIGHT' },
        { time: '06:30', preset: 'DAY' },
        { time: '22:30', preset: 'NIGHT' },
      ],
    ]),
  );
}

/**
 * The day as stretches of one level each, for drawing it. The minutes add up to a whole day.
 * @param {readonly Slot[]} slots
 * @returns {{ preset: string, from: string, to: string, minutes: number }[]}
 */
export function stretches(slots) {
  const merged = mergedDay(slots);
  return merged.map((slot, index) => {
    const next = merged[index + 1];
    const end = next ? minutesOf(next.time) : MINUTES_PER_DAY;
    return { preset: slot.preset, from: slot.time, to: next ? next.time : '24:00', minutes: end - minutesOf(slot.time) };
  });
}

/**
 * Neighbouring slots with the same level mean the same as one.
 * @param {readonly Slot[]} slots
 * @returns {Slot[]}
 */
export function mergedDay(slots) {
  return slots.filter((slot, index) => slot.preset !== slots[index - 1]?.preset);
}

/**
 * Adds a slot in the middle of the longest stretch, with another level than the one before.
 * @param {readonly Slot[]} slots
 * @returns {Slot[]}
 */
export function withSlotAdded(slots) {
  let at = 0;
  let longest = -1;
  slots.forEach((slot, index) => {
    const next = slots[index + 1];
    const gap = (next ? minutesOf(next.time) : MINUTES_PER_DAY) - minutesOf(slot.time);
    if (gap > longest) {
      longest = gap;
      at = index;
    }
  });
  const before = slots[at];
  if (!before || longest < 30) return [...slots];
  const minutes = minutesOf(before.time) + Math.floor(longest / 2 / 15) * 15;
  const preset = before.preset === 'DAY' ? 'NIGHT' : 'DAY';
  const result = [...slots];
  result.splice(at + 1, 0, { time: timeOf(minutes), preset });
  return result;
}

/**
 * Removes a slot, except the first: a day always starts at midnight.
 * @param {readonly Slot[]} slots
 * @param {number} index
 * @returns {Slot[]}
 */
export function withSlotRemoved(slots, index) {
  return index === 0 ? [...slots] : slots.filter((_, position) => position !== index);
}

/**
 * Changes the time of a slot, except the first, and puts the slots back in order.
 * @param {readonly Slot[]} slots
 * @param {number} index
 * @param {string} time
 * @returns {Slot[]}
 */
export function withTime(slots, index, time) {
  if (index === 0) return [...slots];
  const result = slots.map((slot, position) => (position === index ? { ...slot, time } : slot));
  const [first, ...rest] = result;
  return first ? [first, ...rest.sort((a, b) => minutesOf(a.time) - minutesOf(b.time))] : result;
}

/**
 * @param {readonly Slot[]} slots
 * @param {number} index
 * @param {string} preset
 * @returns {Slot[]}
 */
export function withLevel(slots, index, preset) {
  return slots.map((slot, position) => (position === index ? { ...slot, preset } : slot));
}

/**
 * Copies one day over others.
 * @param {Record<string, readonly Slot[]>} days
 * @param {string} from
 * @param {readonly string[]} targets
 */
export function withDayCopied(days, from, targets) {
  const source = days[from] ?? [];
  return Object.fromEntries(
    Object.entries(days).map(([day, slots]) => [day, targets.includes(day) ? source.map((slot) => ({ ...slot })) : slots]),
  );
}

/**
 * What stops a day from being saved.
 * @param {readonly Slot[]} slots
 * @param {number} maxSlots
 * @returns {{ sameTime: boolean, tooMany: boolean, offQuarter: boolean }}
 */
export function dayProblems(slots, maxSlots) {
  return {
    sameTime: slots.some((slot, index) => index > 0 && slot.time === slots[index - 1]?.time),
    tooMany: mergedDay(slots).length > maxSlots,
    offQuarter: slots.some((slot) => !QUARTER_HOUR.test(slot.time)),
  };
}

/**
 * What a typed name becomes when it is saved, as the plugin does it: letters
 * without accents, digits and single spaces. The result may be empty.
 * @param {string} name
 */
export function cleanName(name) {
  return name
    .normalize('NFD')
    .replace(/[^a-zA-Z0-9 ]/g, '')
    .replace(/ +/g, ' ')
    .trim()
    .slice(0, NAME_MAX)
    .trim();
}

/**
 * The name that will be saved: one left as it was stays, a new one is cleaned.
 * @param {string} name
 * @param {string | undefined} existingName
 */
export function nameToSave(name, existingName) {
  return existingName !== undefined && name === existingName ? name : cleanName(name);
}

/**
 * @param {{ name: string, existingName?: string, days: Record<string, readonly Slot[]> }} draft
 * @param {number} maxSlots
 */
export function canSave(draft, maxSlots) {
  if (nameToSave(draft.name, draft.existingName).trim() === '') return false;
  return DAYS.every((day) => {
    const problems = dayProblems(draft.days[day] ?? [], maxSlots);
    return (draft.days[day] ?? []).length > 0 && !problems.sameTime && !problems.tooMany && !problems.offQuarter;
  });
}

/**
 * A name for the copy of a program, with a 2 at the end. Separators become spaces.
 * @param {string | undefined} name
 */
export function nameForCopy(name) {
  const clean = cleanName((name ?? '').replace(/[^\p{L}\p{M}\p{N} ]/gu, ' '));
  if (clean === '') return '';
  return `${clean.slice(0, NAME_MAX - 2).trim()} 2`;
}
