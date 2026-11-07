import { describe, expect, it } from 'vitest';
import { cleanProgramName, validateProgramDraft } from '@much-smarther/core';
import {
  canSave,
  cleanName,
  dayProblems,
  DAYS,
  mergedDay,
  NAME_MAX,
  nameForCopy,
  nameToSave,
  newProgramDays,
  stretches,
  withDayCopied,
  withLevel,
  withSlotAdded,
  withSlotRemoved,
  withTime,
} from '../homebridge-ui/public/program-edit.js';

const DAY = [
  { time: '00:00', preset: 'NIGHT' },
  { time: '06:30', preset: 'DAY' },
  { time: '22:30', preset: 'NIGHT' },
];

describe('the program editor', () => {
  it('starts a new program with a day that can be saved once it has a name', () => {
    const days = newProgramDays();
    expect(canSave({ name: '', days }, 10)).toBe(false);
    expect(canSave({ name: 'Mine', days }, 10)).toBe(true);
    expect(days['monday']).not.toBe(days['tuesday']);
  });

  it('draws a day as stretches that add up to 24 hours', () => {
    expect(stretches(DAY)).toEqual([
      { preset: 'NIGHT', from: '00:00', to: '06:30', minutes: 390 },
      { preset: 'DAY', from: '06:30', to: '22:30', minutes: 960 },
      { preset: 'NIGHT', from: '22:30', to: '24:00', minutes: 90 },
    ]);
  });

  it('draws neighbouring slots with the same level as one stretch', () => {
    const slots = [DAY[0], { time: '03:00', preset: 'NIGHT' }, DAY[1]].flatMap((slot) => (slot ? [slot] : []));
    expect(stretches(slots).map((stretch) => stretch.minutes)).toEqual([390, 1050]);
  });

  describe('adding a slot', () => {
    it('goes in the middle of the longest stretch, on a quarter hour, with another level', () => {
      expect(withSlotAdded(DAY)).toEqual([
        DAY[0],
        DAY[1],
        { time: '14:30', preset: 'NIGHT' },
        DAY[2],
      ]);
      expect(withSlotAdded([{ time: '00:00', preset: 'NIGHT' }])).toEqual([
        { time: '00:00', preset: 'NIGHT' },
        { time: '12:00', preset: 'DAY' },
      ]);
    });

    it('keeps the day in order, with a quarter hour, up to ten slots and more', () => {
      let slots = [{ time: '00:00', preset: 'DAY' }];
      for (let count = 0; count < 12; count++) slots = withSlotAdded(slots);
      expect(slots).toHaveLength(13);
      expect(dayProblems(slots, 20)).toEqual({ sameTime: false, tooMany: false, offQuarter: false });
      expect(slots.map((slot) => slot.time)).toEqual(slots.map((slot) => slot.time).sort());
    });

    it('does nothing when no stretch has room', () => {
      const full = Array.from({ length: 96 }, (_, index) => ({
        time: `${String(Math.floor(index / 4)).padStart(2, '0')}:${String((index % 4) * 15).padStart(2, '0')}`,
        preset: index % 2 ? 'DAY' : 'NIGHT',
      }));
      expect(withSlotAdded(full)).toHaveLength(96);
    });
  });

  it('removes a slot, but never the one at midnight', () => {
    expect(withSlotRemoved(DAY, 1)).toEqual([DAY[0], DAY[2]]);
    expect(withSlotRemoved(DAY, 0)).toEqual(DAY);
  });

  it('puts the slots back in order after a change of time, leaving midnight alone', () => {
    expect(withTime(DAY, 2, '05:00')).toEqual([DAY[0], { time: '05:00', preset: 'NIGHT' }, DAY[1]]);
    expect(withTime(DAY, 0, '05:00')).toEqual(DAY);
  });

  it('changes a level', () => {
    expect(withLevel(DAY, 1, 'AWAY')[1]).toEqual({ time: '06:30', preset: 'AWAY' });
    expect(DAY[1]?.preset).toBe('DAY');
  });

  it('copies a day over the chosen ones, as a separate copy', () => {
    const days: Record<string, readonly { time: string; preset: string }[]> = {
      ...newProgramDays(),
      friday: [{ time: '00:00', preset: 'AWAY' }],
    };
    const copied = withDayCopied(days, 'friday', ['monday', 'friday']);
    expect(copied['monday']).toEqual(days['friday']);
    expect(copied['monday']).not.toBe(copied['friday']);
    expect(copied['tuesday']).toBe(days['tuesday']);
  });

  it('finds what stops a day from being saved', () => {
    expect(dayProblems(DAY, 10)).toEqual({ sameTime: false, tooMany: false, offQuarter: false });
    expect(dayProblems([DAY[0], DAY[1], DAY[1]].flatMap((slot) => (slot ? [slot] : [])), 10).sameTime).toBe(true);
    expect(dayProblems(DAY, 2).tooMany).toBe(true);
    expect(dayProblems([{ time: '00:10', preset: 'DAY' }], 10).offQuarter).toBe(true);
  });

  it('counts the slots after merging them', () => {
    const slots = [{ time: '00:00', preset: 'DAY' }, { time: '01:00', preset: 'DAY' }, { time: '02:00', preset: 'NIGHT' }];
    expect(mergedDay(slots)).toEqual([slots[0], slots[2]]);
    expect(dayProblems(slots, 2).tooMany).toBe(false);
  });

  it('makes a name for a copy that can be written', () => {
    expect(nameForCopy('Work week')).toBe('Work week 2');
    expect(nameForCopy('Home/away')).toBe('Home away 2');
    expect(nameForCopy('///')).toBe('');
    expect(nameForCopy(undefined)).toBe('');
    expect(nameForCopy('n'.repeat(40))).toHaveLength(NAME_MAX);
    expect(cleanName(nameForCopy('n'.repeat(40)))).toBe(nameForCopy('n'.repeat(40)));
    expect(cleanName(nameForCopy(`${'n'.repeat(29)} abc`))).toBe(nameForCopy(`${'n'.repeat(29)} abc`));
  });

  describe('the name to save', () => {
    it.each([
      ['Work week', 'Work week'],
      ['Caffè lungo', 'Caffe lungo'],
      ['Città/Mare', 'CittaMare'],
      ['  a   b  ', 'a b'],
      ['Müller & Söhne', 'Muller Sohne'],
      ['<b>x</b>', 'bxb'],
      ['a]]>b', 'ab'],
      ['Ελληνικά', ''],
      ['日本語', ''],
      ['///', ''],
      ['n'.repeat(40), 'n'.repeat(32)],
      [`${'n'.repeat(31)} x`, 'n'.repeat(31)],
    ])('%j becomes %j, here and in the library', (typed, saved) => {
      expect(cleanName(typed)).toBe(saved);
      expect(cleanProgramName(typed)).toBe(saved);
    });

    it('leaves a name that was not changed', () => {
      expect(nameToSave('Home/away', 'Home/away')).toBe('Home/away');
      expect(nameToSave('Home/away 2', 'Home/away')).toBe('Homeaway 2');
      expect(nameToSave('Home/away', undefined)).toBe('Homeaway');
    });

    it('needs something left to save', () => {
      expect(canSave({ name: 'Città', days: newProgramDays() }, 10)).toBe(true);
      expect(canSave({ name: '日本語', days: newProgramDays() }, 10)).toBe(false);
      expect(canSave({ name: '日本語', existingName: '日本語', days: newProgramDays() }, 10)).toBe(true);
    });
  });

  describe('agrees with the library', () => {
    const draft = (typed: string, existingName: string | undefined, days: Record<string, readonly { time: string; preset: string }[]>) => {
      const name = nameToSave(typed, existingName);
      const fromCore = (() => {
        try {
          validateProgramDraft(
            { number: 5, name, createdAt: '2026-01-01T00:00:00', days },
            existingName === undefined ? { maxSlotsPerDay: 10 } : { existingName, maxSlotsPerDay: 10 },
          );
          return true;
        } catch {
          return false;
        }
      })();
      return { fromCore, fromPage: canSave({ name: typed, ...(existingName === undefined ? {} : { existingName }), days }, 10) };
    };
    const days = newProgramDays();

    it.each([
      ['Work week', undefined],
      ['Work', 'Work'],
      ['Home/away', 'Home/away'],
      ['Home/away', undefined],
      ['Caffè', undefined],
      ['', undefined],
      ['   ', undefined],
      [' Work', undefined],
      ['Work ', undefined],
      ['n'.repeat(32), undefined],
      ['n'.repeat(33), undefined],
      ['n'.repeat(64), undefined],
      ['a<b', undefined],
    ])('about the name %j', (name, existing) => {
      const { fromCore, fromPage } = draft(name, existing, days);
      expect(fromPage).toBe(fromCore);
    });

    const withDay = (slots: readonly { time: string; preset: string }[]) => ({ ...days, monday: slots });
    const alternating = (count: number) =>
      Array.from({ length: count }, (_, index) => ({
        time: `${String(index).padStart(2, '0')}:00`,
        preset: index % 2 ? 'DAY' : 'NIGHT',
      }));

    it.each([
      ['an ordinary day', DAY],
      ['one level all day', [{ time: '00:00', preset: 'DAY' }]],
      ['ten slots', alternating(10)],
      ['eleven slots', alternating(11)],
      ['the same time twice', [{ time: '00:00', preset: 'DAY' }, { time: '07:00', preset: 'NIGHT' }, { time: '07:00', preset: 'AWAY' }]],
      ['a time off the quarter hour', [{ time: '00:00', preset: 'DAY' }, { time: '07:10', preset: 'NIGHT' }]],
      ['an empty day', []],
    ])('about %s', (_name, slots) => {
      const { fromCore, fromPage } = draft('Mine', undefined, withDay(slots));
      expect(fromPage).toBe(fromCore);
    });
  });

  it('knows the seven days, Monday first', () => {
    expect(DAYS).toHaveLength(7);
    expect(DAYS[0]).toBe('monday');
  });
});
