import { randomBytes } from 'node:crypto';
import { connect } from 'node:net';
import { join } from 'node:path';
import { FakeThermostat } from '@much-smarther/simulator';
import type { Logger } from '@much-smarther/core';
import { ThermostatController, type ControllerOptions } from '../src/controller.js';
import { parseSettings, type Settings } from '../src/settings.js';

export const PASSWORD = 'fake-pin-2468';

/** Windows has named pipes instead of Unix sockets, and no file modes. */
export const WINDOWS = process.platform === 'win32';

/** Where a test's control server listens: a socket in `directory`, or a named pipe on Windows. */
export function testSocketPath(directory: string): string {
  return WINDOWS ? `\\\\.\\pipe\\ms-test-${randomBytes(8).toString('hex')}` : join(directory, 'c.sock');
}

/** Whether a server accepts connections at a socket or pipe path. */
export function listening(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect(path);
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
  });
}

export async function waitFor(condition: () => boolean | Promise<boolean>, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

export class CapturingLogger implements Logger {
  readonly lines: string[] = [];
  debug = (message: string) => this.lines.push(`DEBUG ${message}`);
  info = (message: string) => this.lines.push(`INFO ${message}`);
  warn = (message: string) => this.lines.push(`WARN ${message}`);
  error = (message: string) => this.lines.push(`ERROR ${message}`);
}

export function settingsFor(port: number, extra: Record<string, unknown> = {}): Settings {
  return parseSettings({ platform: 'MuchSmarther', host: '127.0.0.1', port, ...extra }).settings;
}

/** A simulator and a controller connected to it, ready for commands. */
export async function connected(
  options: {
    settings?: Record<string, unknown>;
    thermostat?: ConstructorParameters<typeof FakeThermostat>[0];
    controller?: Partial<ControllerOptions>;
    start?: boolean;
  } = {},
): Promise<{ thermostat: FakeThermostat; controller: ThermostatController; logger: CapturingLogger; stop: () => Promise<void> }> {
  const thermostat = new FakeThermostat({ password: PASSWORD, ...options.thermostat });
  const port = await thermostat.start();
  const logger = new CapturingLogger();
  const controller = new ThermostatController({
    settings: settingsFor(port, options.settings),
    logger,
    debounceMs: 20,
    client: { commandTimeoutMs: 1_000, reconnectBaseDelayMs: 20, reconnectMaxDelayMs: 80, minCommandIntervalMs: 0 },
    ...options.controller,
  });
  if (options.start !== false) {
    const { Secret } = await import('@much-smarther/core');
    controller.start(new Secret(PASSWORD));
    await waitFor(() => controller.snapshot.status === 'ready' && controller.snapshot.programs.length > 0);
  }
  return {
    thermostat,
    controller,
    logger,
    stop: async () => {
      controller.stop();
      await thermostat.stop();
    },
  };
}
