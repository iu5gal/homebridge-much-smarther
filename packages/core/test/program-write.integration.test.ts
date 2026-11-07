import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeThermostat } from '@much-smarther/simulator';
import {
  CommandRejectedError,
  NotConnectedError,
  ProgramWriteError,
  TimeoutError,
  ValidationError,
  WEEKDAYS,
  XOpenClient,
  type Logger,
  type TimeSlot,
  type Weekday,
  type XOpenClientOptions,
} from '../src/index.js';

const PASSWORD = 'fake-pin-7777';
const SECRET_NAME = 'Private schedule';

const week = (slots: readonly TimeSlot[]) =>
  Object.fromEntries(WEEKDAYS.map((day) => [day, slots])) as Record<Weekday, readonly TimeSlot[]>;

const allDay = (preset: TimeSlot['preset']) => week([{ time: '00:00', preset }]);

const draft = (overrides: Record<string, unknown> = {}) => ({
  number: 7,
  name: 'Bridge',
  createdAt: '2026-01-02T03:04:05',
  days: allDay('AWAY'),
  ...overrides,
});

async function waitFor(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe('writing programs against the simulator', () => {
  let thermostat: FakeThermostat;
  let client: XOpenClient;
  let lines: string[];

  const connect = async (options: Partial<XOpenClientOptions> = {}) => {
    const log = (message: string) => void lines.push(message);
    const logger: Logger = { debug: log, info: log, warn: log, error: log };
    client = new XOpenClient({
      host: '127.0.0.1',
      port: thermostat.port,
      password: PASSWORD,
      logger,
      keepAliveIntervalMs: 60_000,
      commandTimeoutMs: 300,
      programWriteTimeoutMs: 600,
      minCommandIntervalMs: 0,
      minProgramWriteIntervalMs: 0,
      busyRetryDelayMs: 1,
      reconnectBaseDelayMs: 20,
      ...options,
    });
    client.start();
    await waitFor(() => client.status === 'ready' && client.state !== undefined);
  };

  const programs = async () => (await client.getProgramList()).filter((slot) => slot.present).map((slot) => slot.number);

  beforeEach(async () => {
    thermostat = new FakeThermostat({ password: PASSWORD });
    await thermostat.start();
    lines = [];
  });

  afterEach(async () => {
    client.stop();
    await thermostat.stop();
  });

  it('creates a program, which then shows in the list and reads back', async () => {
    await connect();
    const stored = await client.writeProgram(draft());
    expect(stored).toMatchObject({ number: 7, name: 'Bridge', type: 'DAILY', valid: true, createdAt: '2026-01-02T03:04:05' });
    expect(stored.days.monday).toEqual([{ time: '00:00', preset: 'AWAY' }]);
    expect(await programs()).toEqual([0, 1, 2, 3, 7]);
    expect(thermostat.fileWrites).toEqual(['device_program_profile_7.xml']);
  });

  it('leaves the state alone when the program is not the active one', async () => {
    await connect();
    const before = client.state;
    await client.writeProgram(draft());
    expect(thermostat.sets).toEqual([]);
    expect(client.state).toMatchObject({ mode: before?.mode, setpoint: before?.setpoint, programNumber: 1 });
  });

  it('follows a change to the active program at once, without any state command', async () => {
    await connect();
    await client.writeProgram(draft({ number: 1, name: 'Program 1', days: allDay('AWAY') }));
    expect(client.state).toMatchObject({ mode: 'AUTOMATIC', setpoint: 16, programNumber: 1 });
    expect(thermostat.sets).toEqual([]);
  });

  it('keeps a manual temperature when the active program changes', async () => {
    await connect();
    await client.setDeviceState({ mode: 'MANUAL', function: 'HEATING', setpoint: 22 });
    await client.writeProgram(draft({ number: 1, name: 'Program 1', days: allDay('AWAY') }));
    expect(client.state).toMatchObject({ mode: 'MANUAL', setpoint: 22 });
    await client.setDeviceState({ mode: 'AUTOMATIC', function: 'HEATING' });
    await waitFor(() => client.state?.setpoint === 16);
  });

  it('announces a change in the list of programs', async () => {
    await connect();
    let announced = 0;
    client.on('programsChanged', () => announced++);
    await client.writeProgram(draft());
    await waitFor(() => announced === 1);
  });

  it('validates before sending anything', async () => {
    await connect();
    await expect(client.writeProgram(draft({ number: 0 }))).rejects.toBeInstanceOf(ValidationError);
    await expect(client.writeProgram(draft({ name: 'n'.repeat(64) }))).rejects.toBeInstanceOf(ValidationError);
    await expect(client.writeProgram({ raw: '<program_profile/>' })).rejects.toBeInstanceOf(ValidationError);
    expect(thermostat.fileWrites).toEqual([]);
  });

  it('accepts the current name of a program when told it is unchanged', async () => {
    await connect();
    await expect(client.writeProgram(draft({ name: 'Home/away' }), { existingName: 'Home/away' })).resolves.toMatchObject({
      name: 'Home/away',
    });
  });

  it('applies the limit of slots it is given', async () => {
    await connect();
    const slots: TimeSlot[] = Array.from({ length: 9 }, (_, index) => ({
      time: `${String(index).padStart(2, '0')}:00`,
      preset: index % 2 === 0 ? 'DAY' : 'NIGHT',
    }));
    await expect(client.writeProgram(draft({ days: week(slots) }), { maxSlotsPerDay: 8 })).rejects.toBeInstanceOf(ValidationError);
    await expect(client.writeProgram(draft({ days: week(slots) }))).resolves.toMatchObject({ number: 7 });
  });

  it('reports a refusal with its code, and does not try again', async () => {
    thermostat.behaviour.rejectFileWrites = true;
    await connect();
    await expect(client.writeProgram(draft())).rejects.toBeInstanceOf(CommandRejectedError);
    expect(thermostat.fileWrites).toHaveLength(1);
    expect(await programs()).toEqual([0, 1, 2, 3]);
  });

  it('tries once more only when the thermostat is busy', async () => {
    thermostat.behaviour.busySets = 1;
    await connect();
    await expect(client.writeProgram(draft())).resolves.toMatchObject({ number: 7 });
    expect(thermostat.fileWrites).toHaveLength(2);
  });

  it('notices a program stored with a damaged name', async () => {
    thermostat.behaviour.damageWrittenNames = true;
    await connect();
    await expect(client.writeProgram(draft())).rejects.toBeInstanceOf(ProgramWriteError);
  });

  it('notices a write that was accepted but not stored', async () => {
    thermostat.behaviour.ignoreFileWrites = true;
    await connect();
    await expect(client.writeProgram(draft())).rejects.toBeInstanceOf(ProgramWriteError);
  });

  it('notices an erase that did not happen', async () => {
    thermostat.behaviour.ignoreFileWrites = true;
    await connect();
    await expect(client.eraseProgram(2)).rejects.toBeInstanceOf(ProgramWriteError);
  });

  it('gives a write longer than other commands', async () => {
    await connect();
    // The write waits up to 600 ms; any other command would drop the session after 300 ms.
    thermostat.behaviour.fileWriteDelayMs = 400;
    await expect(client.writeProgram(draft())).resolves.toMatchObject({ number: 7 });
    expect(client.status).toBe('ready');
  });

  it('reports a write without an answer, and drops the session', async () => {
    await connect({ programWriteTimeoutMs: 50 });
    thermostat.behaviour.fileWriteDelayMs = 200;
    await expect(client.writeProgram(draft())).rejects.toBeInstanceOf(TimeoutError);
  });

  it('refuses to write while not connected', async () => {
    await connect();
    client.stop();
    await expect(client.writeProgram(draft())).rejects.toBeInstanceOf(NotConnectedError);
    await expect(client.eraseProgram(2)).rejects.toBeInstanceOf(NotConnectedError);
  });

  it('runs concurrent writes one at a time, each with its own check', async () => {
    await connect();
    const results = await Promise.all([
      client.writeProgram(draft({ number: 7, name: 'Seven' })),
      client.writeProgram(draft({ number: 8, name: 'Eight' })),
    ]);
    expect(results.map((result) => result.name)).toEqual(['Seven', 'Eight']);
    expect(thermostat.commands.filter((command) => command === 'device_file')).toHaveLength(4);
  });

  it('keeps going after a failed write', async () => {
    thermostat.behaviour.rejectFileWrites = true;
    await connect();
    await expect(client.writeProgram(draft())).rejects.toBeInstanceOf(CommandRejectedError);
    thermostat.behaviour.rejectFileWrites = false;
    await expect(client.writeProgram(draft())).resolves.toMatchObject({ number: 7 });
  });

  it('spaces program writes out', async () => {
    await connect({ minProgramWriteIntervalMs: 120 });
    const started = Date.now();
    await client.writeProgram(draft({ number: 7 }));
    await client.writeProgram(draft({ number: 8 }));
    expect(Date.now() - started).toBeGreaterThanOrEqual(110);
  });

  it('erases a program, leaving the slot empty', async () => {
    await connect();
    await client.writeProgram(draft());
    await client.eraseProgram(7);
    expect(await programs()).toEqual([0, 1, 2, 3]);
    await expect(client.getProgram(7)).resolves.toMatchObject({ value: { valid: false } });
  });

  it('cannot erase the program in use, nor the system program', async () => {
    await connect();
    await expect(client.eraseProgram(1)).rejects.toThrow(/in use/);
    await expect(client.eraseProgram(0)).rejects.toBeInstanceOf(ValidationError);
    await expect(client.eraseProgram(11)).rejects.toBeInstanceOf(ValidationError);
    expect(thermostat.fileWrites).toEqual([]);
  });

  it('notices that the program in use has changed before erasing', async () => {
    await connect();
    thermostat.update({ program_number: '2' });
    await waitFor(() => client.state?.programNumber === 2);
    await expect(client.eraseProgram(2)).rejects.toThrow(/in use/);
    await expect(client.eraseProgram(1)).resolves.toBeUndefined();
  });

  it('never logs a program', async () => {
    await connect();
    await client.writeProgram(draft({ name: SECRET_NAME }));
    await client.getProgram(7);
    expect(lines.some((line) => line.includes('device_file'))).toBe(true);
    expect(lines.join('\n')).not.toContain(SECRET_NAME);
    expect(lines.join('\n')).not.toContain('preset=');
  });
});
