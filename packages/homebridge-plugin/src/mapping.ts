import {
  BOOST_MINUTES,
  SETPOINT_MAX,
  SETPOINT_MIN,
  type BoostMinutes,
  type ThermostatFunction,
  type ThermostatState,
} from '@much-smarther/core';
import type { Settings } from './settings.js';

/**
 * How the thermostat appears in the Home app (docs/FEATURES.md). Pure
 * functions, so that the mapping can be tested as tables.
 *
 * - "Off" is the app's "Off": `PROTECTION`.
 * - "Heat" or "Cool" is a manual temperature or a boost, in the current season.
 * - The weekly program is "Auto" (`automaticMode: 'auto'`) or a separate
 *   "Schedule" switch (`automaticMode: 'switch'`).
 * - The Home app offers only the current season, unless `seasonFromHome`.
 * - Optional switches: one per weekly program (on = that program runs) and
 *   "Off until the next change" (on = off with an end time).
 */

/** Values of the HomeKit characteristics, fixed by the HomeKit specification. */
export const TARGET_STATE = { OFF: 0, HEAT: 1, COOL: 2, AUTO: 3 } as const;
export const CURRENT_STATE = { OFF: 0, HEAT: 1, COOL: 2 } as const;

type ModeSettings = Pick<Settings, 'automaticMode' | 'seasonFromHome'>;

const seasonState = (fn: ThermostatFunction | undefined) => (fn === 'COOLING' ? TARGET_STATE.COOL : TARGET_STATE.HEAT);

/** The target states the Home app offers. */
export function targetStateValues(settings: ModeSettings, fn: ThermostatFunction | undefined): number[] {
  const seasons = settings.seasonFromHome ? [TARGET_STATE.HEAT, TARGET_STATE.COOL] : [seasonState(fn)];
  const values: number[] = [TARGET_STATE.OFF, ...seasons];
  if (settings.automaticMode === 'auto') values.push(TARGET_STATE.AUTO);
  return values;
}

export function targetState(state: ThermostatState, settings: ModeSettings): number | undefined {
  switch (state.mode) {
    case 'PROTECTION':
    case 'OFF':
      return TARGET_STATE.OFF;
    case 'AUTOMATIC':
      return settings.automaticMode === 'auto' ? TARGET_STATE.AUTO : seasonState(state.function);
    case 'MANUAL':
    case 'BOOST':
      return seasonState(state.function);
    default:
      return undefined;
  }
}

export function currentState(state: ThermostatState): number {
  if (state.heatingActive) return CURRENT_STATE.HEAT;
  if (state.coolingActive) return CURRENT_STATE.COOL;
  return CURRENT_STATE.OFF;
}

/** The target temperature, within the range the Home app is told about. */
export function targetTemperature(state: ThermostatState): number | undefined {
  if (state.setpoint === undefined) return undefined;
  return Math.min(SETPOINT_MAX, Math.max(SETPOINT_MIN, Math.round(state.setpoint * 10) / 10));
}

export function activeBoost(state: ThermostatState): BoostMinutes | undefined {
  return state.mode === 'BOOST' ? state.boostMinutes : undefined;
}

export function scheduleOn(state: ThermostatState): boolean {
  return state.mode === 'AUTOMATIC';
}

export function programOn(state: ThermostatState, number: number): boolean {
  return state.mode === 'AUTOMATIC' && state.programNumber === number;
}

export function offUntilChangeOn(state: ThermostatState): boolean {
  return (state.mode === 'PROTECTION' || state.mode === 'OFF') && state.validity?.end !== undefined;
}

/** What the user asked for in the Home app, before it becomes a command. */
export type Intent =
  | { readonly kind: 'off'; readonly untilNextChange?: true }
  | { readonly kind: 'automatic'; readonly program?: number }
  /** A manual temperature; `setpoint` undefined means "the comfortable one". */
  | { readonly kind: 'manual'; readonly function: ThermostatFunction; readonly setpoint?: number }
  | { readonly kind: 'boost'; readonly minutes: BoostMinutes };

/** The intent of a new target state, or `undefined` when nothing has to change. */
export function intentForTargetState(value: number, state: ThermostatState, settings: ModeSettings): Intent | undefined {
  const fn = state.function ?? 'HEATING';
  switch (value) {
    case TARGET_STATE.OFF:
      return state.mode === 'PROTECTION' || state.mode === 'OFF' ? undefined : { kind: 'off' };
    case TARGET_STATE.AUTO:
      return state.mode === 'AUTOMATIC' ? undefined : { kind: 'automatic' };
    case TARGET_STATE.HEAT:
    case TARGET_STATE.COOL: {
      const wanted: ThermostatFunction = value === TARGET_STATE.COOL ? 'COOLING' : 'HEATING';
      // The other season: only when allowed, at the comfortable temperature of that season.
      if (wanted !== fn) return settings.seasonFromHome ? { kind: 'manual', function: wanted } : undefined;
      switch (state.mode) {
        case 'MANUAL':
        case 'BOOST':
          return undefined; // already heating (or cooling) on demand
        case 'AUTOMATIC':
          // "Heat" during the program: hold the current temperature, as the app's manual does.
          if (settings.automaticMode === 'switch') return undefined;
          return { kind: 'manual', function: fn, ...(state.setpoint === undefined ? {} : { setpoint: state.setpoint }) };
        default:
          return { kind: 'manual', function: fn }; // from "Off": the comfortable temperature
      }
    }
    default:
      return undefined;
  }
}

/** The intent of a boost switch turned on or off. */
export function intentForBoost(minutes: BoostMinutes, on: boolean, state: ThermostatState): Intent | undefined {
  const active = activeBoost(state);
  if (on) return active === minutes ? undefined : { kind: 'boost', minutes };
  return active === minutes ? { kind: 'automatic' } : undefined;
}

/** The intent of the "Schedule" switch turned on or off. */
export function intentForSchedule(on: boolean, state: ThermostatState): Intent | undefined {
  if (on) return scheduleOn(state) ? undefined : { kind: 'automatic' };
  if (!scheduleOn(state)) return undefined;
  return {
    kind: 'manual',
    function: state.function ?? 'HEATING',
    ...(state.setpoint === undefined ? {} : { setpoint: state.setpoint }),
  };
}

/**
 * The intent of a program switch. The switches work like radio buttons: one
 * program always runs, so turning the running one off changes nothing.
 */
export function intentForProgram(number: number, on: boolean, state: ThermostatState): Intent | undefined {
  return on && !programOn(state, number) ? { kind: 'automatic', program: number } : undefined;
}

/** The intent of the "Off until the next change" switch; off goes back to the program. */
export function intentForOffUntilChange(on: boolean, state: ThermostatState): Intent | undefined {
  if (on) return offUntilChangeOn(state) ? undefined : { kind: 'off', untilNextChange: true };
  return offUntilChangeOn(state) ? { kind: 'automatic' } : undefined;
}

export { BOOST_MINUTES };
