// Arguments of tools/command.mjs. Only these commands exist; each becomes a
// DeviceStateRequest that the core validates again before sending.

export const USAGE = `usage: npm run command -- <thermostat-address[:port]> <command> [--watch <minutes>]

commands:
  state                               read the state only
  manual <°C> [until <time> | for <minutes>]
  boost <30|60|90>
  off [until <time> | for <minutes>]  "Off" as the app does it (PROTECTION)
  auto [<program 0-10>]               back to the weekly program

<time> is HH:MM (today, or tomorrow if already past) or YYYY-MM-DDTHH:MM, in this computer's time.
--watch: minutes to keep listening for events after the command (default 2, at most 120).`;

const SETPOINT = /^[0-9]{1,2}(?:\.[0-9])?$/;
const MINUTES = /^[0-9]{1,5}$/;
const CLOCK = /^([01]?[0-9]|2[0-3]):([0-5][0-9])$/;
const DATE_TIME = /^([0-9]{4})-([0-9]{2})-([0-9]{2})[T ]([01][0-9]|2[0-3]):([0-5][0-9])$/;
const MAX_WATCH_MINUTES = 120;

export class UsageError extends Error {}

/**
 * @param {string | undefined} text
 * @param {Date} now
 * @returns {Date}
 */
function parseTime(text, now) {
  const clock = CLOCK.exec(text ?? '');
  if (clock) {
    const date = new Date(now);
    date.setHours(Number(clock[1]), Number(clock[2]), 0, 0);
    if (date.getTime() <= now.getTime()) date.setDate(date.getDate() + 1);
    return date;
  }
  const full = DATE_TIME.exec(text ?? '');
  if (full) {
    const [, year, month, day, hours, minutes] = full.map(Number);
    const date = new Date(year ?? 0, (month ?? 1) - 1, day ?? 1, hours ?? 0, minutes ?? 0, 0, 0);
    if (date.getMonth() !== (month ?? 1) - 1) throw new UsageError(`invalid date ${text}`);
    return date;
  }
  throw new UsageError(`invalid time ${text ?? '(missing)'}`);
}

/**
 * The optional end of a timed mode: `until <time>` or `for <minutes>`.
 * @param {string[]} rest
 * @param {Date} now
 * @returns {{ until?: Date }}
 */
function parseEnd(rest, now) {
  if (rest.length === 0) return {};
  const [keyword, value, ...extra] = rest;
  if (extra.length > 0) throw new UsageError(`unexpected ${extra.join(' ')}`);
  if (keyword === 'until') return { until: parseTime(value, now) };
  if (keyword === 'for' && MINUTES.test(value ?? '')) return { until: new Date(now.getTime() + Number(value) * 60_000) };
  throw new UsageError(`expected "until <time>" or "for <minutes>", got ${rest.join(' ')}`);
}

/**
 * @typedef {import('@much-smarther/core').ThermostatFunction} ThermostatFunction
 * @typedef {import('@much-smarther/core').DeviceStateRequest} DeviceStateRequest
 * @typedef {{ kind: 'state', watchMinutes: number }
 *   | { kind: 'set', watchMinutes: number, build: (fn: ThermostatFunction) => DeviceStateRequest }} Command
 */

/**
 * Parses the command words. The function (heating or cooling) is not an
 * argument: the tool always keeps the thermostat's current one.
 * @param {string[]} words
 * @param {Date} now
 * @returns {Command}
 */
export function parseCommand(words, now) {
  const args = [...words];
  let watchMinutes = 2;
  const watch = args.indexOf('--watch');
  if (watch !== -1) {
    const value = args[watch + 1] ?? '';
    if (!MINUTES.test(value) || Number(value) > MAX_WATCH_MINUTES) throw new UsageError('invalid --watch');
    watchMinutes = Number(value);
    args.splice(watch, 2);
  }
  const [name, ...rest] = args;
  switch (name) {
    case 'state':
      if (rest.length > 0) throw new UsageError('state takes no arguments');
      return { kind: 'state', watchMinutes };
    case 'manual': {
      const [setpointText, ...end] = rest;
      if (!SETPOINT.test(setpointText ?? '')) throw new UsageError('manual needs a temperature such as 20.5');
      const setpoint = Number(setpointText);
      const timed = parseEnd(end, now);
      return { kind: 'set', watchMinutes, build: (fn) => ({ mode: 'MANUAL', function: fn, setpoint, ...timed }) };
    }
    case 'boost': {
      const minutes = Number(rest[0]);
      if (rest.length !== 1 || (minutes !== 30 && minutes !== 60 && minutes !== 90)) {
        throw new UsageError('boost needs 30, 60 or 90');
      }
      return { kind: 'set', watchMinutes, build: (fn) => ({ mode: 'BOOST', function: fn, minutes }) };
    }
    case 'off': {
      const timed = parseEnd(rest, now);
      return { kind: 'set', watchMinutes, build: (fn) => ({ mode: 'PROTECTION', function: fn, ...timed }) };
    }
    case 'auto': {
      if (rest.length > 1 || (rest.length === 1 && !/^(?:[0-9]|10)$/.test(rest[0] ?? ''))) {
        throw new UsageError('auto takes an optional program number 0-10');
      }
      const program = rest.length === 1 ? { programNumber: Number(rest[0]) } : {};
      return { kind: 'set', watchMinutes, build: (fn) => ({ mode: 'AUTOMATIC', function: fn, ...program }) };
    }
    default:
      throw new UsageError(`unknown command ${name ?? '(missing)'}`);
  }
}
