import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CommandRejectedError, ProgramWriteError, ValidationError, WEEKDAYS, type TimeSlot, type Weekday } from '@much-smarther/core';
import { ProgramEditError } from '../src/controller.js';
import { ProgramBackups } from '../src/program-backups.js';
import { connected, waitFor } from './helpers.js';

const week = (slots: readonly TimeSlot[]) =>
  Object.fromEntries(WEEKDAYS.map((day) => [day, slots])) as Record<Weekday, readonly TimeSlot[]>;
const allDay = (preset: TimeSlot['preset']) => week([{ time: '00:00', preset }]);

describe('changing programs', () => {
  let storage: string;
  let backups: ProgramBackups;
  const cleanup: (() => Promise<void>)[] = [];

  beforeEach(() => {
    storage = mkdtempSync(join(tmpdir(), 'ms-edit-'));
    backups = new ProgramBackups(join(storage, 'program-backups'));
  });
  afterEach(async () => {
    for (const step of cleanup.splice(0)) await step();
    rmSync(storage, { recursive: true, force: true });
  });

  async function setup(options: Parameters<typeof connected>[0] = {}) {
    const result = await connected({
      ...options,
      controller: {
        programBackups: backups,
        client: { commandTimeoutMs: 1_000, reconnectBaseDelayMs: 20, minCommandIntervalMs: 0, minProgramWriteIntervalMs: 0 },
        ...options.controller,
      },
    });
    cleanup.push(result.stop);
    return result;
  }

  it('lists the user programs with their slots, never the system program', async () => {
    const { controller } = await setup();
    const view = controller.programsView();
    expect(view.programs.map((program) => program.number)).toEqual([1, 2, 3]);
    expect(view.programs[0]).toMatchObject({ name: 'Program 1', type: 'WEEKLY' });
    expect(view.programs[0]?.days.monday).toHaveLength(3);
    expect(view).toMatchObject({ versions: [], maxSlotsPerDay: 10 });
  });

  it('reads a program now, with a version that stands for its content', async () => {
    const { controller, thermostat } = await setup();
    const reads = () => thermostat.commands.filter((command) => command === 'device_file').length;
    const before = reads();
    const program = await controller.readProgramToEdit(2);
    expect(program).toMatchObject({ number: 2, name: 'Program 2' });
    expect(program.version).toMatch(/^[0-9a-f]{64}$/);
    expect(reads()).toBe(before + 1);
    expect((await controller.readProgramToEdit(2)).version).toBe(program.version);
  });

  it.each([[0], [11], [1.5]])('refuses to open program %s', async (number) => {
    const { controller } = await setup();
    await expect(controller.readProgramToEdit(number)).rejects.toBeInstanceOf(ValidationError);
  });

  it('refuses to open a slot that is empty', async () => {
    const { controller } = await setup();
    await expect(controller.readProgramToEdit(7)).rejects.toBeInstanceOf(ProgramEditError);
  });

  it('creates a program in the first free slot, without activating it', async () => {
    const { controller, thermostat } = await setup();
    const saved = await controller.saveProgram({ name: 'New one', days: allDay('AWAY') });
    expect(saved).toMatchObject({ number: 4, name: 'New one', type: 'DAILY' });
    expect(controller.snapshot.programs.map((program) => program.number)).toEqual([0, 1, 2, 3, 4]);
    expect(controller.snapshot.state?.programNumber).toBe(1);
    expect(thermostat.sets).toEqual([]);
    expect(thermostat.fileWrites).toEqual(['device_program_profile_4.xml']);
  });

  it('dates a new program on the thermostat clock', async () => {
    const { controller, thermostat } = await setup({
      thermostat: { password: 'fake-pin-2468', utcOffsetMinutes: 60 },
      controller: {
        now: () => new Date('2026-11-07T10:20:30Z'),
        programBackups: backups,
        client: { commandTimeoutMs: 1_000, reconnectBaseDelayMs: 20, minCommandIntervalMs: 0, minProgramWriteIntervalMs: 0 },
      },
    });
    await controller.saveProgram({ name: 'New one', days: allDay('AWAY') });
    thermostat.update({ program_number: '4' });
    await waitFor(() => controller.snapshot.activeProgram?.number === 4);
    expect(controller.snapshot.activeProgram?.createdAt).toBe('2026-11-07T11:20:30');
  });

  it('says so when all ten programs exist', async () => {
    const { controller, thermostat } = await setup({ thermostat: { password: 'fake-pin-2468', programs: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10] } });
    await expect(controller.saveProgram({ name: 'One too many', days: allDay('AWAY') })).rejects.toMatchObject({ problem: 'full' });
    expect(thermostat.fileWrites).toEqual([]);
  });

  it('edits a program, keeping its creation date', async () => {
    const { controller, thermostat } = await setup();
    const { version } = await controller.readProgramToEdit(1);
    const saved = await controller.saveProgram({ number: 1, version, name: 'Renamed', days: allDay('NIGHT') });
    expect(saved).toMatchObject({ number: 1, name: 'Renamed', days: { monday: [{ time: '00:00', preset: 'NIGHT' }] } });
    expect(thermostat.fileWrites).toEqual(['device_program_profile_1.xml']);
    expect(controller.snapshot.programs.find((program) => program.number === 1)?.name).toBe('Renamed');
    expect(controller.snapshot.activeProgram?.createdAt).toBe('2026-01-01T08:00:00');
  });

  it('refuses to overwrite a program that changed in the meantime', async () => {
    const { controller, thermostat } = await setup();
    const { version } = await controller.readProgramToEdit(2);
    await controller.saveProgram({ number: 2, version, name: 'First', days: allDay('NIGHT') });
    thermostat.fileWrites.length = 0;
    await expect(controller.saveProgram({ number: 2, version, name: 'Second', days: allDay('DAY') })).rejects.toMatchObject({ problem: 'conflict' });
    expect(thermostat.fileWrites).toEqual([]);
    expect(controller.snapshot.programs.find((program) => program.number === 2)?.name).toBe('First');
  });

  it('refuses an edit without its version', async () => {
    const { controller, thermostat } = await setup();
    await expect(controller.saveProgram({ number: 2, name: 'Blind', days: allDay('DAY') })).rejects.toMatchObject({ problem: 'conflict' });
    expect(thermostat.fileWrites).toEqual([]);
  });

  it.each([
    ['the system program', { number: 0, version: 'x', name: 'Mine', days: allDay('DAY') }],
    ['a name with nothing left to save', { name: '&&&', days: allDay('DAY') }],
    ['a name that is not text', { name: 5, days: allDay('DAY') }],
    ['days that are not days', { name: 'Mine', days: 'all of them' }],
    ['an unknown level', { name: 'Mine', days: allDay('ECO' as TimeSlot['preset']) }],
    ['a day not starting at midnight', { name: 'Mine', days: week([{ time: '06:00', preset: 'DAY' }]) }],
  ])('rejects %s, leaving no copy behind', async (_name, edit) => {
    const { controller, thermostat } = await setup();
    await expect(controller.saveProgram(edit)).rejects.toBeInstanceOf(ValidationError);
    expect(thermostat.fileWrites).toEqual([]);
    expect(existsSync(join(storage, 'program-backups'))).toBe(false);
  });

  it('keeps the current name when it could not be written as a new one', async () => {
    const { controller } = await setup();
    const first = await controller.readProgramToEdit(2);
    expect(first.name).toBe('Program 2');
    await expect(controller.saveProgram({ number: 2, version: first.version, name: 'Program 2', days: allDay('NIGHT') })).resolves.toMatchObject({ name: 'Program 2' });
    const second = await controller.readProgramToEdit(2);
    await expect(controller.saveProgram({ number: 2, version: second.version, name: 'Prog/ràm', days: allDay('NIGHT') })).resolves.toMatchObject({ name: 'Prog/ram' });
  });

  it.each([
    ['Città/Mare', 'Citta/Mare'],
    ['n'.repeat(64), 'n'.repeat(32)],
  ])('saves the name %s as %s', async (name, saved) => {
    const { controller } = await setup();
    await expect(controller.saveProgram({ name, days: allDay('DAY') })).resolves.toMatchObject({ name: saved });
  });

  describe('copies', () => {
    it('copies every slot once, before the first write', async () => {
      const { controller, thermostat } = await setup();
      thermostat.behaviour.rejectFileWrites = true;
      await expect(controller.saveProgram({ name: 'Refused', days: allDay('DAY') })).rejects.toBeInstanceOf(CommandRejectedError);
      const initial = join(storage, 'program-backups', 'initial');
      expect(readdirSync(initial)).toHaveLength(11);
      expect(readFileSync(join(initial, 'device_program_profile_1.xml'), 'utf8')).toContain('Program 1');
      thermostat.behaviour.rejectFileWrites = false;
      await controller.saveProgram({ name: 'Accepted', days: allDay('DAY') });
      expect(readFileSync(join(initial, 'device_program_profile_4.xml'), 'utf8')).toContain('>FALSE<');
    });

    it('keeps what each write replaces, and nothing for an empty slot', async () => {
      const { controller } = await setup();
      await controller.saveProgram({ name: 'New one', days: allDay('AWAY') });
      expect(controller.programsView().versions).toEqual([]);
      const { version } = await controller.readProgramToEdit(2);
      await controller.saveProgram({ number: 2, version, name: 'Renamed', days: allDay('NIGHT') });
      expect(controller.programsView().versions).toMatchObject([{ number: 2, name: 'Program 2' }]);
    });

    it('does not write when the copy cannot be made', async () => {
      class FullDisk extends ProgramBackups {
        override saveVersion(): void {
          throw new Error('disk full');
        }
      }
      const { controller, thermostat } = await setup({
        controller: {
          programBackups: new FullDisk(join(storage, 'program-backups')),
          client: { commandTimeoutMs: 1_000, reconnectBaseDelayMs: 20, minCommandIntervalMs: 0, minProgramWriteIntervalMs: 0 },
        },
      });
      const { version } = await controller.readProgramToEdit(2);
      await expect(controller.saveProgram({ number: 2, version, name: 'Renamed', days: allDay('NIGHT') })).rejects.toThrow(/disk full/);
      expect(thermostat.fileWrites).toEqual([]);
    });

    it('cannot change programs without a place for the copies', async () => {
      const { controller, thermostat } = await setup({ controller: { programBackups: undefined as unknown as ProgramBackups } });
      await expect(controller.saveProgram({ name: 'Mine', days: allDay('DAY') })).rejects.toMatchObject({ problem: 'unavailable' });
      await expect(controller.deleteProgram(2)).rejects.toMatchObject({ problem: 'unavailable' });
      expect(thermostat.fileWrites).toEqual([]);
      expect(controller.programsView().versions).toEqual([]);
    });
  });

  describe('the program in use', () => {
    it('follows a change at once, with no state command', async () => {
      const { controller, thermostat } = await setup();
      const { version } = await controller.readProgramToEdit(1);
      await controller.saveProgram({ number: 1, version, name: 'Program 1', days: allDay('AWAY') });
      expect(thermostat.sets).toEqual([]);
      expect(controller.snapshot.state).toMatchObject({ mode: 'AUTOMATIC', setpoint: 16 });
    });

    it('updates the next change of level', async () => {
      const { controller } = await setup();
      expect(controller.snapshot.nextChange).toBeDefined();
      const { version } = await controller.readProgramToEdit(1);
      await controller.saveProgram({ number: 1, version, name: 'Program 1', days: allDay('AWAY') });
      expect(controller.snapshot.nextChange).toBeUndefined();
    });

    it('cannot be deleted', async () => {
      const { controller, thermostat } = await setup();
      await expect(controller.deleteProgram(1)).rejects.toMatchObject({ problem: 'in-use' });
      expect(thermostat.fileWrites).toEqual([]);
    });
  });

  it('deletes a program, keeping a copy', async () => {
    const { controller, thermostat } = await setup();
    await controller.deleteProgram(3);
    expect(thermostat.fileWrites).toEqual(['device_program_profile_3.xml']);
    expect(controller.snapshot.programs.map((program) => program.number)).toEqual([0, 1, 2]);
    expect(controller.programsView().versions).toMatchObject([{ number: 3, name: 'Program 3' }]);
  });

  it.each([[0], [11]])('cannot delete program %s', async (number) => {
    const { controller, thermostat } = await setup();
    await expect(controller.deleteProgram(number)).rejects.toBeInstanceOf(ValidationError);
    expect(thermostat.fileWrites).toEqual([]);
  });

  describe('restoring', () => {
    it('brings back a deleted program', async () => {
      const { controller } = await setup();
      await controller.deleteProgram(3);
      const [version] = controller.programsView().versions;
      const restored = await controller.restoreProgram(3, version?.id ?? '');
      expect(restored).toMatchObject({ number: 3, name: 'Program 3' });
      expect(controller.snapshot.programs.map((program) => program.number)).toEqual([0, 1, 2, 3]);
    });

    it('brings back an older version, keeping the one it replaces', async () => {
      const { controller } = await setup();
      const { version } = await controller.readProgramToEdit(2);
      await controller.saveProgram({ number: 2, version, name: 'Changed', days: allDay('NIGHT') });
      const [older] = controller.programsView().versions;
      await expect(controller.restoreProgram(2, older?.id ?? '')).resolves.toMatchObject({ name: 'Program 2' });
      expect(controller.programsView().versions.map((item) => item.name).sort()).toEqual(['Changed', 'Program 2']);
    });

    it.each([
      ['a path', '../../pswopen'],
      ['an unknown version', '20200101T000000000Z'],
    ])('refuses %s', async (_name, id) => {
      const { controller, thermostat } = await setup();
      await expect(controller.restoreProgram(2, id)).rejects.toMatchObject({ problem: 'no-version' });
      expect(thermostat.fileWrites).toEqual([]);
    });

    it('refuses the system program', async () => {
      const { controller } = await setup();
      await expect(controller.restoreProgram(0, '20200101T000000000Z')).rejects.toBeInstanceOf(ValidationError);
    });
  });

  it('reports a program stored differently, and shows what the thermostat holds now', async () => {
    const { controller, thermostat } = await setup();
    const { version } = await controller.readProgramToEdit(2);
    thermostat.behaviour.damageWrittenNames = true;
    await expect(controller.saveProgram({ number: 2, version, name: 'Damaged', days: allDay('NIGHT') })).rejects.toBeInstanceOf(ProgramWriteError);
    expect(controller.snapshot.programs.find((program) => program.number === 2)).toBeDefined();
    expect(controller.snapshot.programs.find((program) => program.number === 2)?.name).not.toBe('Program 2');
  });

  describe('names', () => {
    it.each([
      ['the same name', 'Program 2'],
      ['the same name in other capitals', 'PROGRAM 2'],
      ['a name that becomes the same when cleaned', 'Prògram & 2'],
    ])('refuses a new program with %s', async (_case, name) => {
      const { controller, thermostat } = await setup();
      await expect(controller.saveProgram({ name, days: allDay('DAY') })).rejects.toMatchObject({ problem: 'name-taken' });
      expect(thermostat.fileWrites).toEqual([]);
    });

    it('refuses to rename a program as another one', async () => {
      const { controller } = await setup();
      const { version } = await controller.readProgramToEdit(1);
      await expect(controller.saveProgram({ number: 1, version, name: 'Program 2', days: allDay('DAY') })).rejects.toMatchObject({ problem: 'name-taken' });
    });

    it('accepts a change of capitals to its own name', async () => {
      const { controller } = await setup();
      const { version } = await controller.readProgramToEdit(1);
      await expect(controller.saveProgram({ number: 1, version, name: 'PROGRAM 1', days: allDay('DAY') })).resolves.toMatchObject({ name: 'PROGRAM 1' });
    });

    it('leaves alone two programs that already share a name', async () => {
      const { controller } = await setup();
      const first = await controller.readProgramToEdit(3);
      await controller.saveProgram({ number: 3, version: first.version, name: 'Twin', days: allDay('DAY') });
      const second = await controller.readProgramToEdit(2);
      await controller.saveProgram({ number: 2, version: second.version, name: 'Twin 2', days: allDay('DAY') });
      controller.snapshot.programs.find((program) => program.number === 2);
      const third = await controller.readProgramToEdit(2);
      await expect(controller.saveProgram({ number: 2, version: third.version, name: 'Twin 2', days: allDay('NIGHT') })).resolves.toMatchObject({ number: 2 });
    });

    it('frees a name when its program is deleted', async () => {
      const { controller } = await setup();
      await controller.deleteProgram(3);
      await expect(controller.saveProgram({ name: 'Program 3', days: allDay('DAY') })).resolves.toMatchObject({ number: 3 });
    });

    it('does not count the system program', async () => {
      const { controller } = await setup();
      await expect(controller.saveProgram({ name: 'Program 0', days: allDay('DAY') })).resolves.toMatchObject({ number: 4 });
    });
  });

  it('runs concurrent changes one at a time', async () => {
    const { controller } = await setup();
    const saved = await Promise.all([
      controller.saveProgram({ name: 'First', days: allDay('DAY') }),
      controller.saveProgram({ name: 'Second', days: allDay('DAY') }),
    ]);
    expect(saved.map((program) => program.number)).toEqual([4, 5]);
  });

  it('goes on after a change that failed', async () => {
    const { controller } = await setup();
    await expect(controller.saveProgram({ name: '&&&', days: allDay('DAY') })).rejects.toBeInstanceOf(ValidationError);
    await expect(controller.saveProgram({ name: 'Good', days: allDay('DAY') })).resolves.toMatchObject({ number: 4 });
  });

  it('is refused while not connected', async () => {
    const { controller } = await setup();
    controller.stop();
    await expect(controller.saveProgram({ name: 'Mine', days: allDay('DAY') })).rejects.toThrow(/not connected/);
    await expect(controller.readProgramToEdit(2)).rejects.toThrow(/not connected/);
  });

  it('reads the programs again when the thermostat announces a change made elsewhere', async () => {
    const { thermostat } = await setup();
    const reads = () => thermostat.commands.filter((command) => command === 'device_program_number_list').length;
    const before = reads();
    thermostat.announceProgramChange();
    await waitFor(() => reads() > before, 4_000);
  });

  it('does not read them again after its own write', async () => {
    const { controller, thermostat } = await setup();
    await controller.saveProgram({ name: 'Mine', days: allDay('DAY') });
    const reads = thermostat.commands.filter((command) => command === 'device_program_number_list').length;
    await new Promise((resolve) => setTimeout(resolve, 2_300));
    expect(thermostat.commands.filter((command) => command === 'device_program_number_list')).toHaveLength(reads);
  });

  it('never logs a program name', async () => {
    const { controller, logger } = await setup();
    await controller.saveProgram({ name: 'Private schedule', days: allDay('DAY') });
    await controller.deleteProgram(4);
    expect(logger.lines.some((line) => line.includes('saving program 4'))).toBe(true);
    expect(logger.lines.join('\n')).not.toContain('Private schedule');
  });
});
