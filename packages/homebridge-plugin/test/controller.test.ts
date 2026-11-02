import { afterEach, describe, expect, it } from 'vitest';
import { formatLocalDateTime, NotConnectedError, Secret } from '@much-smarther/core';
import { connected, waitFor } from './helpers.js';

describe('ThermostatController', () => {
  let stop: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await stop?.();
    stop = undefined;
  });

  it('waits for a password and refuses commands without one', async () => {
    const setup = await connected({ start: false });
    stop = setup.stop;
    setup.controller.start(undefined);
    expect(setup.controller.snapshot).toMatchObject({ status: 'no-pin', programs: [] });
    await expect(setup.controller.boost(30)).rejects.toBeInstanceOf(NotConnectedError);
    expect(setup.logger.lines.join('\n')).toMatch(/no thermostat password yet/);
  });

  it('reads state, settings, programs and diagnostics once connected', async () => {
    const setup = await connected();
    stop = setup.stop;
    await waitFor(() => setup.controller.snapshot.diagnostic !== undefined);
    const snapshot = setup.controller.snapshot;
    expect(snapshot.state).toMatchObject({ mode: 'AUTOMATIC', programNumber: 1 });
    expect(snapshot.configuration?.heating).toMatchObject({ day: 19.8, protection: 7 });
    expect(snapshot.programs.map((program) => program.number)).toEqual([0, 1, 2, 3]);
    expect(snapshot.programs[1]).toEqual({ number: 1, name: 'Program 1', type: 'WEEKLY' });
    expect(snapshot.activeProgram?.number).toBe(1);
    expect(snapshot.nextChange?.preset).toMatch(/^(DAY|NIGHT)$/);
    expect(snapshot.diagnostic?.applicationFirmwareVersion).toBe('1.2.3');
  });

  it('sends only the last temperature of a slider move', async () => {
    const setup = await connected({ settings: { manualEnd: 'forever' } });
    stop = setup.stop;
    for (const value of [20.5, 21, 21.5, 22]) setup.controller.setTargetTemperature(value);
    await waitFor(() => setup.controller.snapshot.state?.mode === 'MANUAL');
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(setup.thermostat.sets).toHaveLength(1);
    expect(setup.thermostat.lastSet?.get('setpoint')).toBe('22.00000');
    expect(setup.thermostat.lastSet?.get('use_date_and_time_validity')).toBe('FALSE');
  });

  it('ends a temperature from the Home app at the next change of level', async () => {
    const setup = await connected();
    stop = setup.stop;
    const { nextChange, state } = setup.controller.snapshot;
    expect(nextChange).toBeDefined();
    await setup.controller.manual('HEATING', 21);
    expect(setup.thermostat.lastSet?.get('end_date_and_time_validity')).toBe(
      formatLocalDateTime(nextChange?.at ?? new Date(0), state?.utcOffsetMinutes),
    );
  });

  it('ends it after a fixed time with manualEnd "duration"', async () => {
    const now = new Date(2026, 0, 5, 10, 0, 0);
    const setup = await connected({
      settings: { manualEnd: 'duration', manualMinutes: 45 },
      controller: {
        now: () => now,
        client: { commandTimeoutMs: 1_000, minCommandIntervalMs: 0, now: () => now },
      },
    });
    stop = setup.stop;
    await setup.controller.manual('HEATING', 21);
    expect(setup.thermostat.lastSet?.get('end_date_and_time_validity')).toMatch(/T10:45:00$/);
  });

  it('turns "Heat" from "Off" into the last temperature used', async () => {
    const setup = await connected();
    stop = setup.stop;
    await setup.controller.switchOff();
    await waitFor(() => setup.controller.snapshot.state?.mode === 'PROTECTION');
    setup.controller.run({ kind: 'manual', function: 'HEATING' });
    await waitFor(() => setup.controller.snapshot.state?.mode === 'MANUAL');
    expect(setup.controller.snapshot.state?.setpoint).toBe(20);
  });

  it('carries out boost, off until, program and season', async () => {
    const setup = await connected();
    stop = setup.stop;
    const c = setup.controller;
    await c.boost(60);
    await waitFor(() => c.snapshot.state?.mode === 'BOOST');
    expect(c.snapshot.state?.boostMinutes).toBe(60);
    await c.switchOff(new Date(Date.now() + 60 * 60_000));
    await waitFor(() => c.snapshot.state?.mode === 'PROTECTION');
    expect(c.snapshot.state?.validity?.end).toBeDefined();
    await c.automatic(2);
    await waitFor(() => c.snapshot.state?.programNumber === 2);
    await waitFor(() => c.snapshot.activeProgram?.number === 2);
    await c.season('COOLING');
    await waitFor(() => c.snapshot.state?.function === 'COOLING');
  });

  it('logs a rejected command from the Home app instead of throwing', async () => {
    const setup = await connected();
    stop = setup.stop;
    setup.thermostat.behaviour.rejectSet = true;
    let changes = 0;
    setup.controller.on('change', () => changes++);
    setup.controller.run({ kind: 'boost', minutes: 30 });
    await waitFor(() => setup.logger.lines.some((line) => line.startsWith('ERROR command failed')));
    expect(setup.logger.lines.join('\n')).toMatch(/code 430/);
    expect(changes).toBeGreaterThan(0);
  });

  it('reports a rejected password', async () => {
    const setup = await connected({ start: false });
    stop = setup.stop;
    setup.controller.start(new Secret('wrong-pin-0000'));
    await waitFor(() => setup.controller.snapshot.authenticationFailed);
    expect(setup.logger.lines.join('\n')).toMatch(/rejected the password/);
    expect(setup.logger.lines.join('\n')).not.toContain('wrong-pin-0000');
  });
});
