// End times for the manual and "Off until" commands of the setup UI, as in
// the BTicino app: a day (today, tomorrow, up to 10 days ahead) and a time in
// quarter hours, both on the thermostat's clock, whatever the browser's zone.

export const MAX_DAYS = 10;

/**
 * The thermostat's wall clock now, as a Date whose UTC fields hold it.
 * @param {Date} now
 * @param {number | undefined} offsetMinutes the thermostat's UTC offset, if known
 */
function wallClock(now, offsetMinutes) {
  const offset = offsetMinutes ?? -now.getTimezoneOffset();
  return new Date(now.getTime() + offset * 60_000);
}

/**
 * The days the user can choose: 0 = today … MAX_DAYS, with their wall-clock date.
 * @param {Date} now
 * @param {number | undefined} offsetMinutes
 * @returns {{ days: number, year: number, month: number, day: number }[]}
 */
export function dayChoices(now, offsetMinutes) {
  const wall = wallClock(now, offsetMinutes);
  return Array.from({ length: MAX_DAYS + 1 }, (_, days) => {
    const date = new Date(Date.UTC(wall.getUTCFullYear(), wall.getUTCMonth(), wall.getUTCDate() + days));
    return { days, year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
  });
}

/** Times of the day in quarter hours: "00:00" … "23:45". */
export function timeChoices() {
  return Array.from({ length: 96 }, (_, index) => {
    /** @param {number} value */
    const pad = (value) => String(value).padStart(2, '0');
    return `${pad(Math.floor(index / 4))}:${pad((index % 4) * 15)}`;
  });
}

/**
 * The instant of `time` on day `days` (0 = today) of the thermostat's clock.
 * @param {number} days
 * @param {string} time "HH:MM"
 * @param {Date} now
 * @param {number | undefined} offsetMinutes
 * @returns {Date}
 */
export function endInstant(days, time, now, offsetMinutes) {
  const offset = offsetMinutes ?? -now.getTimezoneOffset();
  const wall = wallClock(now, offsetMinutes);
  const [hours, minutes] = time.split(':').map(Number);
  const utc = Date.UTC(wall.getUTCFullYear(), wall.getUTCMonth(), wall.getUTCDate() + days, hours, minutes);
  return new Date(utc - offset * 60_000);
}

/**
 * The choice that matches an instant (for example the next change of level), or undefined.
 * @param {Date} at
 * @param {Date} now
 * @param {number | undefined} offsetMinutes
 * @returns {{ days: number, time: string } | undefined}
 */
export function choiceFor(at, now, offsetMinutes) {
  const offset = offsetMinutes ?? -now.getTimezoneOffset();
  const target = new Date(at.getTime() + offset * 60_000);
  const today = wallClock(now, offsetMinutes);
  const days = Math.round(
    (Date.UTC(target.getUTCFullYear(), target.getUTCMonth(), target.getUTCDate()) -
      Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate())) /
      86_400_000,
  );
  const time = `${String(target.getUTCHours()).padStart(2, '0')}:${String(target.getUTCMinutes()).padStart(2, '0')}`;
  if (days < 0 || days > MAX_DAYS || !timeChoices().includes(time)) return undefined;
  return { days, time };
}
