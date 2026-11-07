import { timingSafeEqual } from 'node:crypto';
import { chmodSync, lstatSync, rmSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import {
  BOOST_MINUTES,
  CommandRejectedError,
  FUNCTIONS,
  isValidSetpoint,
  NotConnectedError,
  PROGRAM_NUMBER_MAX,
  ProgramWriteError,
  ValidationError,
  type Logger,
  type ThermostatState,
} from '@much-smarther/core';
import { ProgramEditError, type Snapshot, type ThermostatController } from './controller.js';

/**
 * The setup UI runs in another process, and the thermostat accepts a single
 * local session, so the UI talks to the thermostat through the plugin: a
 * small HTTP server on a Unix socket in the plugin's storage, mode 0600, so
 * that only the Homebridge user can reach it. Windows has no such socket: there
 * it listens on a named pipe, which other local users could open. So every
 * request must also carry the access key that the plugin writes, with mode
 * 0600, next to the password at each start (`Authorization: Bearer <key>`).
 * No TCP port is opened.
 *
 * Only the requests below exist; there is no command passthrough.
 *
 *   GET  /v1/status
 *   POST /v1/manual   { setpoint, until?: ISO date | null, function? }
 *   POST /v1/boost    { minutes }
 *   POST /v1/off      { until?: ISO date | null }
 *   POST /v1/auto     { program? }
 *   POST /v1/season   { function }
 *   POST /v1/reload   {}   (read the password again and reconnect)
 *   POST /v1/refresh  {}   (read settings and programs again)
 *   GET  /v1/programs
 *   POST /v1/program/read     { number }
 *   POST /v1/program/save     { number?, version?, name, days }
 *   POST /v1/program/delete   { number }
 *   POST /v1/program/restore  { number, id }
 *
 * A saved program is taken as values only, and validated field by field:
 * no text from here ever becomes a file on the thermostat.
 */

export const MAX_BODY_BYTES = 4096;
/** Unix socket paths are limited to about 104 bytes on macOS and 108 on Linux. */
export const MAX_SOCKET_PATH = 100;

export interface ControlServerOptions {
  /** A Unix socket path, or a Windows named pipe (`\\\\.\\pipe\\…`). */
  readonly socketPath: string;
  /** The access key every request must carry. */
  readonly key: string;
  readonly controller: ThermostatController;
  readonly reload: () => void;
  readonly logger: Logger;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(code);
  }
}

type Body = Record<string, unknown>;

function only(body: Body, allowed: readonly string[]): void {
  for (const key of Object.keys(body)) {
    if (!allowed.includes(key)) throw new HttpError(400, 'invalid', { field: key });
  }
}

/** `undefined` (not given), `null` (forever) or a date. */
function until(value: unknown): Date | null | undefined {
  if (value === undefined || value === null) return value;
  if (typeof value !== 'string' || value.length > 40) throw new HttpError(400, 'invalid', { field: 'until' });
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new HttpError(400, 'invalid', { field: 'until' });
  return date;
}

/** The snapshot as JSON for the UI: no raw parameters (they include the thermostat's address). */
export function publicSnapshot(snapshot: Snapshot): Record<string, unknown> {
  const { state, nextChange, ...rest } = snapshot;
  return {
    ...rest,
    ...(state ? { state: publicState(state) } : {}),
    ...(nextChange ? { nextChange: { ...nextChange, at: nextChange.at.toISOString() } } : {}),
  };
}

function publicState(state: ThermostatState): Record<string, unknown> {
  return Object.fromEntries(Object.entries(state).filter(([key]) => key !== 'raw'));
}

const VERSION = /^[0-9a-f]{64}$/;
const VERSION_ID = /^[0-9TZ-]{1,32}$/;

function programNumber(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) throw new HttpError(400, 'invalid', { field: 'number' });
  return value;
}

async function readBody(request: IncomingMessage): Promise<Body> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, 'invalid');
    chunks.push(buffer);
  }
  if (size === 0) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'invalid');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new HttpError(400, 'invalid');
  return parsed as Body;
}

async function route(method: string, path: string, body: Body, options: ControlServerOptions): Promise<unknown> {
  const { controller } = options;
  const key = `${method} ${path}`;
  switch (key) {
    case 'GET /v1/status':
      return publicSnapshot(controller.snapshot);
    case 'POST /v1/manual': {
      only(body, ['setpoint', 'until', 'function']);
      if (!isValidSetpoint(body['setpoint'])) throw new HttpError(400, 'invalid', { field: 'setpoint' });
      const fn = body['function'] ?? controller.snapshot.state?.function ?? 'HEATING';
      if (!(FUNCTIONS as readonly unknown[]).includes(fn)) throw new HttpError(400, 'invalid', { field: 'function' });
      await controller.manual(fn as (typeof FUNCTIONS)[number], body['setpoint'], until(body['until']));
      return { ok: true };
    }
    case 'POST /v1/boost': {
      only(body, ['minutes']);
      const minutes = BOOST_MINUTES.find((value) => value === body['minutes']);
      if (minutes === undefined) throw new HttpError(400, 'invalid', { field: 'minutes' });
      await controller.boost(minutes);
      return { ok: true };
    }
    case 'POST /v1/off': {
      only(body, ['until']);
      await controller.switchOff(until(body['until']) ?? undefined);
      return { ok: true };
    }
    case 'POST /v1/auto': {
      only(body, ['program']);
      const program = body['program'];
      if (
        program !== undefined &&
        (typeof program !== 'number' || !Number.isInteger(program) || program < 0 || program > PROGRAM_NUMBER_MAX)
      ) {
        throw new HttpError(400, 'invalid', { field: 'program' });
      }
      await controller.automatic(program as number | undefined);
      return { ok: true };
    }
    case 'POST /v1/season': {
      only(body, ['function']);
      const fn = FUNCTIONS.find((value) => value === body['function']);
      if (fn === undefined) throw new HttpError(400, 'invalid', { field: 'function' });
      await controller.season(fn);
      return { ok: true };
    }
    case 'POST /v1/reload':
      only(body, []);
      options.reload();
      return { ok: true };
    case 'POST /v1/refresh':
      only(body, []);
      await controller.refreshFiles();
      return { ok: true };
    case 'GET /v1/programs':
      return controller.programsView();
    case 'POST /v1/program/read':
      only(body, ['number']);
      return controller.readProgramToEdit(programNumber(body['number']));
    case 'POST /v1/program/save': {
      only(body, ['number', 'version', 'name', 'days']);
      const { number, version, name, days } = body;
      if (number === undefined) {
        if (version !== undefined) throw new HttpError(400, 'invalid', { field: 'version' });
        return controller.saveProgram({ name, days });
      }
      if (typeof version !== 'string' || !VERSION.test(version)) throw new HttpError(400, 'invalid', { field: 'version' });
      return controller.saveProgram({ number: programNumber(number), version, name, days });
    }
    case 'POST /v1/program/delete':
      only(body, ['number']);
      await controller.deleteProgram(programNumber(body['number']));
      return { ok: true };
    case 'POST /v1/program/restore': {
      only(body, ['number', 'id']);
      const { id } = body;
      if (typeof id !== 'string' || !VERSION_ID.test(id)) throw new HttpError(400, 'invalid', { field: 'id' });
      return controller.restoreProgram(programNumber(body['number']), id);
    }
    default:
      throw new HttpError(404, 'invalid');
  }
}

const isNamedPipe = (path: string) => path.startsWith('\\\\.\\pipe\\');

function authorized(header: string | undefined, key: string): boolean {
  const expected = Buffer.from(`Bearer ${key}`);
  const given = Buffer.from(header ?? '');
  return given.length === expected.length && timingSafeEqual(given, expected);
}

function send(response: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  response.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) });
  response.end(text);
}

/** Removes a socket left by a previous run that did not shut down cleanly, but never another file. */
function removeStaleSocket(socketPath: string): void {
  if (Buffer.byteLength(socketPath) > MAX_SOCKET_PATH) {
    throw new Error(`the control socket path is too long (${socketPath.length} characters)`);
  }
  try {
    if (lstatSync(socketPath).isSocket()) rmSync(socketPath);
    else throw new Error(`${socketPath} exists and is not a socket`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

/** Starts the control server. A stale socket left by a previous run is replaced. */
export async function startControlServer(options: ControlServerOptions): Promise<{ close(): Promise<void> }> {
  const { socketPath, logger } = options;
  const pipe = isNamedPipe(socketPath);
  if (!/^[0-9a-f]{64}$/.test(options.key)) throw new Error('the control key is not valid');
  if (!pipe) removeStaleSocket(socketPath);

  const server: Server = createServer((request, response) => {
    const method = request.method ?? '';
    const path = (request.url ?? '').split('?')[0] ?? '';
    if (!authorized(request.headers.authorization, options.key)) {
      response.setHeader('Connection', 'close');
      send(response, 401, { error: 'unauthorized' });
      return;
    }
    readBody(request)
      .then((body) => route(method, path, body, options))
      .then((result) => send(response, 200, result))
      .catch((error: unknown) => {
        if (error instanceof HttpError) return send(response, error.status, { error: error.code, ...error.details });
        if (error instanceof ValidationError) return send(response, 400, { error: 'invalid' });
        if (error instanceof CommandRejectedError) return send(response, 502, { error: 'rejected', code: error.code });
        if (error instanceof NotConnectedError) return send(response, 503, { error: 'not-connected' });
        if (error instanceof ProgramEditError) return send(response, 409, { error: error.problem });
        if (error instanceof ProgramWriteError) return send(response, 502, { error: 'program-write' });
        logger.warn(`control request ${method} ${path} failed: ${error instanceof Error ? error.message : String(error)}`);
        return send(response, 500, { error: 'failed' });
      });
  });
  server.headersTimeout = 10_000;
  server.requestTimeout = 30_000;

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => {
      server.off('error', reject);
      resolve();
    });
  });
  server.on('error', (error) => logger.warn(`control socket: ${error.message}`));
  if (!pipe) {
    try {
      chmodSync(socketPath, 0o600);
    } catch (error) {
      server.close();
      throw error;
    }
  }
  return {
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          if (!pipe) rmSync(socketPath, { force: true });
          resolve();
        });
      }),
  };
}
