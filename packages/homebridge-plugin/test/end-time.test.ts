import { describe, expect, it } from 'vitest';
import { choiceFor, dayChoices, endInstant, MAX_DAYS, timeChoices } from '../homebridge-ui/public/end-time.js';

// 23:30 UTC on Friday 30 October is already Saturday 00:30 on a thermostat at +01:00.
const NOW = new Date(Date.UTC(2026, 9, 30, 23, 30, 0));

describe('end times of the setup page', () => {
  it('offers today to 10 days ahead on the thermostat clock', () => {
    const days = dayChoices(NOW, 60);
    expect(days).toHaveLength(MAX_DAYS + 1);
    expect(days[0]).toEqual({ days: 0, year: 2026, month: 10, day: 31 });
    expect(days[2]).toEqual({ days: 2, year: 2026, month: 11, day: 2 });
  });

  it('offers quarter hours', () => {
    const times = timeChoices();
    expect(times).toHaveLength(96);
    expect(times.slice(0, 3)).toEqual(['00:00', '00:15', '00:30']);
    expect(times.at(-1)).toBe('23:45');
  });

  it('turns a day and time of the thermostat into an instant', () => {
    expect(endInstant(0, '06:15', NOW, 60).toISOString()).toBe('2026-10-31T05:15:00.000Z');
    expect(endInstant(1, '22:30', NOW, 60).toISOString()).toBe('2026-11-01T21:30:00.000Z');
    expect(endInstant(0, '06:15', NOW, 330).toISOString()).toBe('2026-10-31T00:45:00.000Z');
  });

  it('finds the choice for the proposed next change, and gives up outside the choices', () => {
    expect(choiceFor(new Date('2026-10-31T05:15:00Z'), NOW, 60)).toEqual({ days: 0, time: '06:15' });
    expect(choiceFor(new Date('2026-11-02T04:30:00Z'), NOW, 60)).toEqual({ days: 2, time: '05:30' });
    expect(choiceFor(new Date('2026-10-31T05:20:00Z'), NOW, 60)).toBeUndefined();
    expect(choiceFor(new Date('2026-11-20T05:15:00Z'), NOW, 60)).toBeUndefined();
  });
});
