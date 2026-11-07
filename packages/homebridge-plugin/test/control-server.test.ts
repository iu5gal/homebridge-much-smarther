import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { createServer } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { controlRequest } from '../src/control-client.js';
import { MAX_BODY_BYTES, startControlServer } from '../src/control-server.js';
import { ProgramBackups } from '../src/program-backups.js';
import { connected, testSocketPath, waitFor, WINDOWS } from './helpers.js';

const KEY = 'a1'.repeat(32);

describe('control server', () => {
  let directory: string;
  let socketPath: string;
  let cleanup: (() => Promise<void>)[] = [];

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'ms-ctl-'));
    socketPath = testSocketPath(directory);
  });
  afterEach(async () => {
    for (const step of cleanup.reverse()) await step();
    cleanup = [];
    rmSync(directory, { recursive: true, force: true });
  });

  async function serve(options: Parameters<typeof connected>[0] = {}) {
    const setup = await connected(options);
    let reloads = 0;
    const server = await startControlServer({
      socketPath,
      key: KEY,
      controller: setup.controller,
      reload: () => reloads++,
      logger: setup.logger,
    });
    cleanup.push(setup.stop, () => server.close());
    const call = (method: 'GET' | 'POST', path: string, body?: Record<string, unknown>) =>
      controlRequest({ socketPath, key: KEY }, method, path, body);
    return { ...setup, call, reloads: () => reloads };
  }

  // Windows: a named pipe, protected by the access key alone (see the README).
  it.skipIf(WINDOWS)('listens on a socket only its user can use', async () => {
    await serve();
    expect(statSync(socketPath).isSocket()).toBe(true);
    expect(statSync(socketPath).mode & 0o777).toBe(0o600);
  });

  it('returns the status without the raw parameters and the thermostat address', async () => {
    const { call } = await serve();
    const { status, body } = await call('GET', '/v1/status');
    expect(status).toBe(200);
    expect(body).toMatchObject({ status: 'ready', state: { mode: 'AUTOMATIC', setpoint: 20 } });
    expect(JSON.stringify(body)).not.toContain('192.0.2.10');
    expect(JSON.stringify(body)).not.toContain('"raw"');
  });

  describe('programs', () => {
    const days = Object.fromEntries(
      ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'].map((day) => [day, [{ time: '00:00', preset: 'AWAY' }]]),
    );
    const withBackups = () =>
      serve({
        controller: {
          programBackups: new ProgramBackups(join(directory, 'backups')),
          client: { commandTimeoutMs: 1_000, reconnectBaseDelayMs: 20, minCommandIntervalMs: 0, minProgramWriteIntervalMs: 0 },
        },
      });

    it('lists, creates, edits, deletes and restores', async () => {
      const { call, thermostat } = await withBackups();
      const list = await call('GET', '/v1/programs');
      expect(list.status).toBe(200);
      expect(list.body).toMatchObject({ maxSlotsPerDay: 10, versions: [] });

      const created = await call('POST', '/v1/program/save', { name: 'Mine', days });
      expect(created).toMatchObject({ status: 200, body: { number: 4, name: 'Mine' } });

      const read = await call('POST', '/v1/program/read', { number: 4 });
      expect(read.body).toMatchObject({ number: 4, name: 'Mine', version: expect.stringMatching(/^[0-9a-f]{64}$/) as string });

      const edited = await call('POST', '/v1/program/save', { number: 4, version: read.body['version'], name: 'Changed', days });
      expect(edited).toMatchObject({ status: 200, body: { name: 'Changed' } });

      expect(await call('POST', '/v1/program/delete', { number: 4 })).toMatchObject({ status: 200 });
      const { versions } = (await call('GET', '/v1/programs')).body as { versions: { id: string; number: number }[] };
      expect(versions.map((version) => version.number)).toEqual([4, 4]);

      const restored = await call('POST', '/v1/program/restore', { number: 4, id: versions[0]?.id });
      expect(restored).toMatchObject({ status: 200, body: { name: 'Changed' } });
      expect(thermostat.sets).toEqual([]);
    });

    it('accepts a whole week with the most slots and the longest level', async () => {
      const { call } = await withBackups();
      const full = Object.fromEntries(
        Object.keys(days).map((day) => [
          day,
          Array.from({ length: 10 }, (_, index) => ({
            time: `${String(index * 2).padStart(2, '0')}:00`,
            preset: index % 2 ? 'PROTECTION' : 'NIGHT',
          })),
        ]),
      );
      const body = { number: 2, version: (await call('POST', '/v1/program/read', { number: 2 })).body['version'], name: 'n'.repeat(32), days: full };
      expect(JSON.stringify(body).length).toBeLessThan(MAX_BODY_BYTES);
      expect(await call('POST', '/v1/program/save', body)).toMatchObject({ status: 200 });
    });

    it.each([
      ['/v1/program/read', { number: 4, extra: true }],
      ['/v1/program/read', { number: '4' }],
      ['/v1/program/read', {}],
      ['/v1/program/save', { name: 'x', days, file: '<program_profile/>' }],
      ['/v1/program/save', { number: 2, name: 'x', days }],
      ['/v1/program/save', { number: 2, version: 'short', name: 'x', days }],
      ['/v1/program/save', { version: 'a'.repeat(64), name: 'x', days }],
      ['/v1/program/save', { name: '///', days }],
      ['/v1/program/save', { name: 'x', days: 'all' }],
      ['/v1/program/save', { number: 0, version: 'a'.repeat(64), name: 'x', days }],
      ['/v1/program/delete', { number: 0 }],
      ['/v1/program/delete', { number: 2, version: 'x' }],
      ['/v1/program/restore', { number: 2 }],
      ['/v1/program/restore', { number: 2, id: '../../pswopen' }],
    ])('refuses %s with %j', async (path, body) => {
      const { call, thermostat } = await withBackups();
      expect(await call('POST', path, body)).toMatchObject({ status: 400, body: { error: 'invalid' } });
      expect(thermostat.fileWrites).toEqual([]);
    });

    it('says why a change was not made', async () => {
      const { call, thermostat } = await withBackups();
      expect(await call('POST', '/v1/program/delete', { number: 1 })).toMatchObject({ status: 409, body: { error: 'in-use' } });
      expect(await call('POST', '/v1/program/save', { number: 2, version: 'a'.repeat(64), name: 'x', days })).toMatchObject({
        status: 409,
        body: { error: 'conflict' },
      });
      expect(await call('POST', '/v1/program/restore', { number: 2, id: '20200101T000000000Z' })).toMatchObject({
        status: 409,
        body: { error: 'no-version' },
      });
      thermostat.behaviour.rejectFileWrites = true;
      expect(await call('POST', '/v1/program/save', { name: 'x', days })).toMatchObject({ status: 502, body: { error: 'rejected', code: 430 } });
      thermostat.behaviour.rejectFileWrites = false;
      thermostat.behaviour.damageWrittenNames = true;
      expect(await call('POST', '/v1/program/save', { name: 'x', days })).toMatchObject({ status: 502, body: { error: 'program-write' } });
    });

    it('limits a saved program too', async () => {
      const { call } = await withBackups();
      const { status } = await call('POST', '/v1/program/save', { name: 'x'.repeat(MAX_BODY_BYTES + 1), days });
      expect(status).toBe(413);
    });
  });

  it('carries out the whitelisted commands', async () => {
    const { call, thermostat, reloads } = await serve();
    expect((await call('POST', '/v1/manual', { setpoint: 21, until: null })).status).toBe(200);
    expect(thermostat.lastSet?.get('use_date_and_time_validity')).toBe('FALSE');
    const until = new Date(Date.now() + 3 * 60 * 60_000);
    await call('POST', '/v1/manual', { setpoint: 21.5, until: until.toISOString() });
    expect(thermostat.lastSet?.get('use_date_and_time_validity')).toBe('TRUE');
    await call('POST', '/v1/boost', { minutes: 90 });
    expect(thermostat.lastSet?.get('mode')).toBe('BOOST');
    await call('POST', '/v1/off', {});
    expect(thermostat.lastSet?.get('mode')).toBe('PROTECTION');
    await call('POST', '/v1/auto', { program: 2 });
    expect(thermostat.lastSet?.get('program_number')).toBe('2');
    await call('POST', '/v1/season', { function: 'COOLING' });
    expect(thermostat.lastSet?.get('function')).toBe('COOLING');
    expect((await call('POST', '/v1/refresh', {})).status).toBe(200);
    await call('POST', '/v1/reload', {});
    expect(reloads()).toBe(1);
  });

  it.each<[string, 'GET' | 'POST', string, Record<string, unknown> | undefined, number]>([
    ['an unknown route', 'GET', '/v1/send', undefined, 404],
    ['a GET command', 'GET', '/v1/boost', undefined, 404],
    ['an unknown field', 'POST', '/v1/boost', { minutes: 30, raw: '<x/>' }, 400],
    ['a boost of 45 minutes', 'POST', '/v1/boost', { minutes: 45 }, 400],
    ['a setpoint out of range', 'POST', '/v1/manual', { setpoint: 41 }, 400],
    ['a setpoint as text', 'POST', '/v1/manual', { setpoint: '21' }, 400],
    ['an unknown season', 'POST', '/v1/season', { function: 'DRYING' }, 400],
    ['an invalid date', 'POST', '/v1/off', { until: 'tomorrow' }, 400],
    ['a past date', 'POST', '/v1/off', { until: '2020-01-01T00:00:00Z' }, 400],
    ['a program out of range', 'POST', '/v1/auto', { program: 11 }, 400],
  ])('rejects %s', async (_name, method, path, body, status) => {
    const { call, thermostat } = await serve();
    expect((await call(method, path, body)).status).toBe(status);
    expect(thermostat.sets).toHaveLength(0);
  });

  it.each([
    ['no key', undefined],
    ['a wrong key', 'b2'.repeat(32)],
    ['a shorter key', KEY.slice(1)],
  ])('refuses a request with %s, before reading it', async (_name, key) => {
    const { call, thermostat, controller } = await serve();
    const send = (path: string, body?: Record<string, unknown>) =>
      key === undefined
        ? new Promise<number>((resolve, reject) => {
            const req = request({ socketPath, method: 'POST', path }, (response) => {
              response.resume();
              resolve(response.statusCode ?? 0);
            });
            req.on('error', reject);
            req.end(JSON.stringify(body ?? {}));
          })
        : controlRequest({ socketPath, key }, 'POST', path, body).then((response) => response.status);
    expect(await send('/v1/boost', { minutes: 30 })).toBe(401);
    expect(await send('/v1/reload')).toBe(401);
    expect(thermostat.sets).toHaveLength(0);
    expect(controller.snapshot.status).toBe('ready');
    expect((await call('GET', '/v1/status')).status).toBe(200);
  });

  it('refuses to start without a valid key', async () => {
    const setup = await connected({ start: false });
    cleanup.push(setup.stop);
    await expect(
      startControlServer({ socketPath, key: 'short', controller: setup.controller, reload: () => {}, logger: setup.logger }),
    ).rejects.toThrow(/key/);
  });

  it('rejects a body that is too large or not JSON', async () => {
    await serve();
    const raw = (payload: string) =>
      new Promise<number>((resolve) => {
        const req = request({ socketPath, method: 'POST', path: '/v1/boost', headers: { Authorization: `Bearer ${KEY}` } }, (response) => {
          response.resume();
          resolve(response.statusCode ?? 0);
        });
        req.on('error', () => resolve(-1));
        req.end(payload);
      });
    expect(await raw('x'.repeat(MAX_BODY_BYTES + 1))).toBe(413);
    expect(await raw('{not json')).toBe(400);
    expect(await raw('[30]')).toBe(400);
  });

  it('tells a refused command and a missing session apart', async () => {
    const { call, thermostat, controller } = await serve();
    thermostat.behaviour.rejectSet = true;
    expect(await call('POST', '/v1/boost', { minutes: 30 })).toMatchObject({ status: 502, body: { code: 430 } });
    controller.start(undefined);
    await waitFor(() => controller.snapshot.status === 'no-pin');
    expect(await call('POST', '/v1/boost', { minutes: 30 })).toMatchObject({ status: 503, body: { error: 'not-connected' } });
  });

  it.skipIf(WINDOWS)('replaces a stale socket but never another file', async () => {
    // A socket left behind by a previous run that did not shut down cleanly.
    const leftover = createServer();
    await new Promise<void>((resolve) => leftover.listen(socketPath, resolve));
    cleanup.push(() => new Promise<void>((resolve) => leftover.close(() => resolve())));
    const { call } = await serve();
    expect((await call('GET', '/v1/status')).status).toBe(200);

    const fileDirectory = join(directory, 'file');
    mkdirSync(fileDirectory);
    const notASocket = join(fileDirectory, 'c.sock');
    writeFileSync(notASocket, 'keep me');
    const setup = await connected({ start: false });
    cleanup.push(setup.stop);
    await expect(
      startControlServer({ socketPath: notASocket, key: KEY, controller: setup.controller, reload: () => {}, logger: setup.logger }),
    ).rejects.toThrow(/not a socket/);
    await expect(
      startControlServer({
        socketPath: join(directory, 'x'.repeat(120)),
        key: KEY,
        controller: setup.controller,
        reload: () => {},
        logger: setup.logger,
      }),
    ).rejects.toThrow(/too long/);
  });
});
