import { describe, expect, it } from 'vitest';
import {
  activePreset,
  formatLocalDateTime,
  levelTemperature,
  nextLevelChange,
  WEEKDAYS,
  type Preset,
  type ProgramProfile,
  type TimeSlot,
  type Weekday,
} from '../src/index.js';

const slots = (spec: string): TimeSlot[] =>
  spec
    .split(',')
    .filter(Boolean)
    .map((part) => {
      const [time = '', preset = ''] = part.trim().split(' ');
      return { time, preset: preset as Preset };
    });

const WORKDAY = slots('00:00 NIGHT, 05:30 DAY, 07:45 AWAY, 16:00 DAY, 22:30 NIGHT');
const WEEKEND = slots('00:00 NIGHT, 06:15 DAY, 22:30 NIGHT');

/** A synthetic weekly program shaped like the observed ones. */
function program(days: Partial<Record<Weekday, TimeSlot[]>> = {}, valid = true): ProgramProfile {
  const base = Object.fromEntries(
    WEEKDAYS.map((day) => [day, day === 'saturday' || day === 'sunday' ? WEEKEND : WORKDAY]),
  ) as Record<Weekday, TimeSlot[]>;
  return { number: 1, type: 'WEEKLY', valid, days: { ...base, ...days } };
}

const OFFSET = 60; // +01:00, as in the device's timestamp in winter
/** An instant given as the thermostat's wall clock in +01:00. */
const at = (wall: string) => new Date(`${wall}+01:00`);
const wall = (date: Date | undefined) => (date ? formatLocalDateTime(date, OFFSET) : undefined);

describe('nextLevelChange', () => {
  it.each([
    // Observed on 2026-10-30: Friday night, midnight is NIGHT again, DAY starts on Saturday at 06:15.
    ['Friday evening, next slot has the same preset', '2026-10-30T22:58:51', '2026-10-31T06:15:00', 'DAY'],
    ['inside a slot, the next one differs', '2026-10-26T10:00:00', '2026-10-26T16:00:00', 'DAY'],
    ['exactly at the start of a slot', '2026-10-26T07:45:00', '2026-10-26T16:00:00', 'DAY'],
    ['one second before a change', '2026-10-26T07:44:59', '2026-10-26T07:45:00', 'AWAY'],
    ['Sunday night, across the end of the week', '2026-11-01T23:00:00', '2026-11-02T05:30:00', 'DAY'],
  ])('%s', (_name, now, expected, preset) => {
    const change = nextLevelChange(program(), at(now), { utcOffsetMinutes: OFFSET });
    expect(wall(change?.at)).toBe(expected);
    expect(change?.preset).toBe(preset);
  });

  it('continues the preset of the day before on a day without slots', () => {
    const p = program({ tuesday: [] });
    // Monday ends in NIGHT and Tuesday has no slots, so NIGHT lasts until Wednesday 05:30.
    expect(wall(nextLevelChange(p, at('2026-10-27T12:00:00'), { utcOffsetMinutes: OFFSET })?.at)).toBe('2026-10-28T05:30:00');
    expect(activePreset(p, at('2026-10-27T12:00:00'), { utcOffsetMinutes: OFFSET })).toBe('NIGHT');
  });

  it('takes the last preset of the week before the first slot of Monday', () => {
    const p = program({ monday: slots('06:00 DAY') });
    expect(activePreset(p, at('2026-10-26T03:00:00'), { utcOffsetMinutes: OFFSET })).toBe('NIGHT');
    expect(wall(nextLevelChange(p, at('2026-10-26T03:00:00'), { utcOffsetMinutes: OFFSET })?.at)).toBe('2026-10-26T06:00:00');
  });

  it('finds a change earlier in the week, one week later', () => {
    const p = program({
      ...Object.fromEntries(WEEKDAYS.map((day) => [day, slots('00:00 NIGHT')])),
      monday: slots('00:00 NIGHT, 08:00 DAY, 09:00 NIGHT'),
    });
    expect(wall(nextLevelChange(p, at('2026-10-28T12:00:00'), { utcOffsetMinutes: OFFSET })?.at)).toBe('2026-11-02T08:00:00');
  });

  it.each<[string, ProgramProfile]>([
    ['a program with one preset only, like slot 0', program(Object.fromEntries(WEEKDAYS.map((day) => [day, slots('00:00 PROTECTION')])))],
    ['a program without slots', program(Object.fromEntries(WEEKDAYS.map((day) => [day, []])))],
    ['a program marked as not valid', program({}, false)],
  ])('returns nothing ("forever") for %s', (_name, p) => {
    expect(nextLevelChange(p, at('2026-10-30T22:00:00'), { utcOffsetMinutes: OFFSET })).toBeUndefined();
  });

  it('gives the temperature of the next level', () => {
    const levels = { day: 19.8, night: 18.4, away: 19, protection: 7 };
    expect(nextLevelChange(program(), at('2026-10-30T22:58:51'), { utcOffsetMinutes: OFFSET, levels })).toMatchObject({
      preset: 'DAY',
      temperature: 19.8,
    });
    expect(levelTemperature(levels, 'AWAY')).toBe(19);
    expect(levelTemperature({}, 'NIGHT')).toBeUndefined();
  });

  it('uses the thermostat zone, not the one of this machine', () => {
    // Monday 21:00 UTC is 22:00 in +01:00 (still DAY until 22:30) and Tuesday 02:00 in +05:00 (NIGHT).
    const now = new Date(Date.UTC(2026, 9, 26, 21, 0, 0));
    expect(activePreset(program(), now, { utcOffsetMinutes: 60 })).toBe('DAY');
    expect(activePreset(program(), now, { utcOffsetMinutes: 300 })).toBe('NIGHT');
    expect(formatLocalDateTime(nextLevelChange(program(), now, { utcOffsetMinutes: 300 })?.at ?? now, 300)).toBe(
      '2026-10-27T05:30:00',
    );
  });

  it('keeps the slot time across a change of daylight saving time', () => {
    // Saturday 2026-10-24 23:00 in +02:00; the next change is Sunday 06:15, after the switch to +01:00.
    const change = nextLevelChange(program(), new Date('2026-10-24T23:00:00+02:00'), { utcOffsetMinutes: 120 });
    expect(formatLocalDateTime(change?.at ?? new Date(0), 120)).toBe('2026-10-25T06:15:00');
  });
});
