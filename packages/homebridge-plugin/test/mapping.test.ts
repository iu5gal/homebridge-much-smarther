import { describe, expect, it } from 'vitest';
import type { ThermostatState } from '@much-smarther/core';
import {
  activeBoost,
  CURRENT_STATE,
  currentState,
  intentForBoost,
  intentForOffUntilChange,
  intentForProgram,
  intentForSchedule,
  intentForTargetState,
  offUntilChangeOn,
  programOn,
  scheduleOn,
  TARGET_STATE,
  targetState,
  targetStateValues,
  targetTemperature,
} from '../src/mapping.js';

const { OFF, HEAT, COOL, AUTO } = TARGET_STATE;
const state = (fields: Partial<ThermostatState>): ThermostatState => ({ raw: new Map(), function: 'HEATING', ...fields });
const AUTO_MODE = { automaticMode: 'auto', seasonFromHome: false } as const;
const SWITCH_MODE = { automaticMode: 'switch', seasonFromHome: false } as const;
const BOTH_SEASONS = { automaticMode: 'auto', seasonFromHome: true } as const;

describe('target states offered', () => {
  it.each([
    [AUTO_MODE, 'HEATING', [OFF, HEAT, AUTO]],
    [AUTO_MODE, 'COOLING', [OFF, COOL, AUTO]],
    [SWITCH_MODE, 'HEATING', [OFF, HEAT]],
    [SWITCH_MODE, 'COOLING', [OFF, COOL]],
    [BOTH_SEASONS, 'HEATING', [OFF, HEAT, COOL, AUTO]],
    [AUTO_MODE, undefined, [OFF, HEAT, AUTO]],
  ] as const)('%j in %s', (settings, fn, expected) => {
    expect(targetStateValues(settings, fn)).toEqual(expected);
  });
});

describe('state → HomeKit', () => {
  it.each<[Partial<ThermostatState>, typeof AUTO_MODE | typeof SWITCH_MODE, number | undefined]>([
    [{ mode: 'AUTOMATIC' }, AUTO_MODE, AUTO],
    [{ mode: 'AUTOMATIC' }, SWITCH_MODE, HEAT],
    [{ mode: 'AUTOMATIC', function: 'COOLING' }, SWITCH_MODE, COOL],
    [{ mode: 'MANUAL' }, AUTO_MODE, HEAT],
    [{ mode: 'MANUAL', function: 'COOLING' }, AUTO_MODE, COOL],
    [{ mode: 'BOOST' }, AUTO_MODE, HEAT],
    [{ mode: 'PROTECTION' }, AUTO_MODE, OFF],
    [{ mode: 'OFF' }, AUTO_MODE, OFF],
    [{}, AUTO_MODE, undefined],
  ])('target state of %j', (fields, settings, expected) => {
    expect(targetState(state(fields), settings)).toBe(expected);
  });

  it.each<[Partial<ThermostatState>, number]>([
    [{ heatingActive: true }, CURRENT_STATE.HEAT],
    [{ coolingActive: true, heatingActive: false }, CURRENT_STATE.COOL],
    [{ heatingActive: false, coolingActive: false }, CURRENT_STATE.OFF],
    [{}, CURRENT_STATE.OFF],
  ])('current state of %j', (fields, expected) => {
    expect(currentState(state(fields))).toBe(expected);
  });

  it.each<[number | undefined, number | undefined]>([
    [19.8, 19.8],
    [19.799999, 19.8],
    [5, 7],
    [45, 40],
    [undefined, undefined],
  ])('target temperature %s → %s', (setpoint, expected) => {
    expect(targetTemperature(state(setpoint === undefined ? {} : { setpoint }))).toBe(expected);
  });

  it('shows the active boost and the schedule', () => {
    expect(activeBoost(state({ mode: 'BOOST', boostMinutes: 60 }))).toBe(60);
    expect(activeBoost(state({ mode: 'MANUAL', boostMinutes: 60 }))).toBeUndefined();
    expect(scheduleOn(state({ mode: 'AUTOMATIC' }))).toBe(true);
    expect(scheduleOn(state({ mode: 'MANUAL' }))).toBe(false);
  });

  it('shows the running program and an off with an end', () => {
    expect(programOn(state({ mode: 'AUTOMATIC', programNumber: 2 }), 2)).toBe(true);
    expect(programOn(state({ mode: 'AUTOMATIC', programNumber: 1 }), 2)).toBe(false);
    expect(programOn(state({ mode: 'MANUAL', programNumber: 2 }), 2)).toBe(false);
    expect(offUntilChangeOn(state({ mode: 'PROTECTION', validity: { end: '2026-11-01T06:15:00' } }))).toBe(true);
    expect(offUntilChangeOn(state({ mode: 'PROTECTION' }))).toBe(false);
    expect(offUntilChangeOn(state({ mode: 'MANUAL', validity: { end: '2026-11-01T06:15:00' } }))).toBe(false);
  });
});

describe('HomeKit → intent', () => {
  it.each<[number, Partial<ThermostatState>, typeof AUTO_MODE | typeof SWITCH_MODE | typeof BOTH_SEASONS, unknown]>([
    [OFF, { mode: 'AUTOMATIC' }, AUTO_MODE, { kind: 'off' }],
    [OFF, { mode: 'PROTECTION' }, AUTO_MODE, undefined],
    [AUTO, { mode: 'MANUAL' }, AUTO_MODE, { kind: 'automatic' }],
    [AUTO, { mode: 'AUTOMATIC' }, AUTO_MODE, undefined],
    // "Heat" during the program holds the current temperature, as the app's manual does.
    [HEAT, { mode: 'AUTOMATIC', setpoint: 19.8 }, AUTO_MODE, { kind: 'manual', function: 'HEATING', setpoint: 19.8 }],
    [HEAT, { mode: 'AUTOMATIC', setpoint: 19.8 }, SWITCH_MODE, undefined],
    // From "Off" the temperature is the comfortable one, chosen by the controller.
    [HEAT, { mode: 'PROTECTION', setpoint: 7 }, AUTO_MODE, { kind: 'manual', function: 'HEATING' }],
    [HEAT, { mode: 'MANUAL', setpoint: 21 }, AUTO_MODE, undefined],
    [HEAT, { mode: 'BOOST' }, AUTO_MODE, undefined],
    // The other season only when allowed.
    [COOL, { mode: 'AUTOMATIC' }, AUTO_MODE, undefined],
    [COOL, { mode: 'AUTOMATIC' }, BOTH_SEASONS, { kind: 'manual', function: 'COOLING' }],
    [COOL, { mode: 'MANUAL', function: 'COOLING' }, AUTO_MODE, undefined],
    [7, { mode: 'AUTOMATIC' }, AUTO_MODE, undefined],
  ])('target %s from %j', (value, fields, settings, expected) => {
    expect(intentForTargetState(value, state(fields), settings)).toEqual(expected);
  });

  it.each<[30 | 60 | 90, boolean, Partial<ThermostatState>, unknown]>([
    [30, true, { mode: 'AUTOMATIC' }, { kind: 'boost', minutes: 30 }],
    [60, true, { mode: 'BOOST', boostMinutes: 30 }, { kind: 'boost', minutes: 60 }],
    [30, true, { mode: 'BOOST', boostMinutes: 30 }, undefined],
    [30, false, { mode: 'BOOST', boostMinutes: 30 }, { kind: 'automatic' }],
    [60, false, { mode: 'BOOST', boostMinutes: 30 }, undefined],
  ])('boost %s %s from %j', (minutes, on, fields, expected) => {
    expect(intentForBoost(minutes, on, state(fields))).toEqual(expected);
  });

  it.each<[boolean, Partial<ThermostatState>, unknown]>([
    [true, { mode: 'MANUAL' }, { kind: 'automatic' }],
    [true, { mode: 'AUTOMATIC' }, undefined],
    [false, { mode: 'AUTOMATIC', setpoint: 18.4 }, { kind: 'manual', function: 'HEATING', setpoint: 18.4 }],
    [false, { mode: 'MANUAL' }, undefined],
  ])('schedule %s from %j', (on, fields, expected) => {
    expect(intentForSchedule(on, state(fields))).toEqual(expected);
  });

  it.each<[number, boolean, Partial<ThermostatState>, unknown]>([
    [2, true, { mode: 'AUTOMATIC', programNumber: 1 }, { kind: 'automatic', program: 2 }],
    [2, true, { mode: 'MANUAL', programNumber: 2 }, { kind: 'automatic', program: 2 }],
    [2, true, { mode: 'AUTOMATIC', programNumber: 2 }, undefined],
    // Like radio buttons: turning off the running program changes nothing.
    [2, false, { mode: 'AUTOMATIC', programNumber: 2 }, undefined],
  ])('program %s %s from %j', (number, on, fields, expected) => {
    expect(intentForProgram(number, on, state(fields))).toEqual(expected);
  });

  it.each<[boolean, Partial<ThermostatState>, unknown]>([
    [true, { mode: 'AUTOMATIC' }, { kind: 'off', untilNextChange: true }],
    [true, { mode: 'PROTECTION' }, { kind: 'off', untilNextChange: true }],
    [true, { mode: 'PROTECTION', validity: { end: '2026-11-01T06:15:00' } }, undefined],
    [false, { mode: 'PROTECTION', validity: { end: '2026-11-01T06:15:00' } }, { kind: 'automatic' }],
    [false, { mode: 'AUTOMATIC' }, undefined],
  ])('off until the next change %s from %j', (on, fields, expected) => {
    expect(intentForOffUntilChange(on, state(fields))).toEqual(expected);
  });
});
