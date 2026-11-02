import { createHash, randomBytes as cryptoRandomBytes, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import net from 'node:net';
import { bytesToDecimalText, clientDigest, CLIENT_RANDOM_BYTES, decimalTextToHex, digestsEqual, serverDigest } from './auth.js';
import {
  buildClientHandshake,
  buildGetDeviceState,
  buildGetDiagnostic,
  buildGetFile,
  buildGetProgramList,
  buildHandshakeAck,
  buildKeepAlive,
  buildNegotiate,
  buildSetDeviceState,
  CONFIGURATION_FILE,
  hasValidityWindow,
  isDeviceFileName,
  programFileName,
  validateDeviceStateRequest,
  type DeviceStateRequest,
} from './commands.js';
import {
  parseConfiguration,
  parseDiagnostic,
  parseProgramProfile,
  type DeviceConfiguration,
  type DeviceDiagnostic,
  type ParsedFile,
  type ProgramProfile,
} from './device-files.js';
import {
  AuthenticationError,
  CommandRejectedError,
  NotConnectedError,
  ProtocolError,
  TimeoutError,
  ValidationError,
  XOpenError,
} from './errors.js';
import { Framer, type Frame } from './framer.js';
import { redactingLogger, silentLogger, type Logger } from './logger.js';
import { decodeDocument, flattenParams, type XOpenMessage } from './message.js';
import { toSecret, type Secret, type SecretInput } from './secret.js';
import { parseDeviceState, parseProgramList, type ProgramSlot, type ThermostatState } from './state.js';

export const XOPEN_PORT = 40000;

export interface XOpenClientOptions {
  readonly host: string;
  readonly port?: number;
  /** The thermostat's local password (PswOpen). Never logged. */
  readonly password: SecretInput;
  readonly logger?: Logger;
  readonly connectTimeoutMs?: number;
  readonly handshakeTimeoutMs?: number;
  /** A command without a response within this time drops the connection. */
  readonly commandTimeoutMs?: number;
  readonly keepAliveIntervalMs?: number;
  /** Wait before the one retry of a command rejected as busy (`NackMsg` code 486). */
  readonly busyRetryDelayMs?: number;
  /** Minimum gap between two commands sent to the thermostat. */
  readonly minCommandIntervalMs?: number;
  readonly maxQueuedCommands?: number;
  readonly reconnectBaseDelayMs?: number;
  readonly reconnectMaxDelayMs?: number;
  /** Test hooks. */
  readonly createSocket?: (port: number, host: string) => net.Socket;
  readonly randomBytes?: (size: number) => Uint8Array;
  readonly now?: () => Date;
}

export type ClientStatus = 'stopped' | 'connecting' | 'ready' | 'waiting';

export type XOpenClientEvents = {
  status: [status: ClientStatus];
  ready: [];
  disconnected: [reason: Error];
  authenticationFailed: [error: AuthenticationError];
  state: [state: ThermostatState];
};

type Settings = Required<Omit<XOpenClientOptions, 'password' | 'logger'>>;

const DEFAULTS: Omit<Settings, 'host'> = {
  port: XOPEN_PORT,
  connectTimeoutMs: 6_000,
  handshakeTimeoutMs: 10_000,
  commandTimeoutMs: 10_000,
  keepAliveIntervalMs: 10_000,
  busyRetryDelayMs: 1_000,
  minCommandIntervalMs: 250,
  maxQueuedCommands: 16,
  reconnectBaseDelayMs: 2_000,
  reconnectMaxDelayMs: 60_000,
  createSocket: (port, host) => net.createConnection({ port, host }),
  randomBytes: (size) => cryptoRandomBytes(size),
  now: () => new Date(),
};

const OWN_ACK = '*#*1##';
const NACK_BUSY = 486;
const NACK_CODE = /^[0-9]{1,4}$/;
const SHA256_HEX = /^[0-9a-fA-F]{64}$/;

/** A file read from the thermostat. */
export interface DeviceFile {
  readonly text: string;
  /** The `sha256sum` sent with the file, lowercase. */
  readonly sha256sum?: string;
  /** Whether `sha256sum` is the SHA-256 of the UTF-8 text. */
  readonly checksum: 'match' | 'mismatch' | 'absent';
}

/** The text of a file whose checksum is right or absent. */
function checkedText(file: DeviceFile): string {
  if (file.checksum === 'mismatch') throw new ProtocolError('file checksum mismatch');
  return file.text;
}

/** The `Code` of a `NackMsg`, or `undefined` for any other message or a missing code. */
function nackCode(message: XOpenMessage): number | undefined {
  if (message.actionId !== 'NackMsg') return undefined;
  const code = flattenParams(message).get('Code');
  return code !== undefined && NACK_CODE.test(code) ? Number(code) : undefined;
}

interface ConnectionContext {
  readonly password: Secret;
  readonly log: Logger;
  readonly settings: Settings;
  readonly onReady: (connection: Connection) => void;
  readonly onClosed: (connection: Connection, reason: Error) => void;
  readonly onEvent: (message: XOpenMessage) => void;
}

interface InFlight {
  readonly seqId: string;
  readonly resolve: (message: XOpenMessage) => void;
  readonly reject: (error: Error) => void;
  readonly timer: NodeJS.Timeout;
}

/** One TCP session: handshake, then at most one command in flight. */
class Connection {
  readonly #socket: net.Socket;
  readonly #context: ConnectionContext;
  readonly #framer = new Framer();
  #step: 'connecting' | 'own-ack' | 'challenge' | 'server-digest' | 'ready' = 'connecting';
  #seqId: string = randomUUID();
  #progress = 0;
  #challenge = '';
  #response = '';
  #inFlight: InFlight | undefined;
  #timer: NodeJS.Timeout | undefined;
  #closed = false;

  constructor(context: ConnectionContext) {
    this.#context = context;
    const { settings } = context;
    this.#socket = settings.createSocket(settings.port, settings.host);
    this.#timer = setTimeout(() => this.close(new TimeoutError('connection timed out')), settings.connectTimeoutMs);
    this.#socket.setNoDelay(true);
    this.#socket.on('connect', () => {
      this.#step = 'own-ack';
      clearTimeout(this.#timer);
      this.#timer = setTimeout(() => this.close(new TimeoutError('handshake timed out')), settings.handshakeTimeoutMs);
    });
    this.#socket.on('data', (chunk: Buffer) => this.#onData(chunk));
    this.#socket.on('error', (error) => this.close(new NotConnectedError(`socket error: ${error.message}`)));
    this.#socket.on('close', () => this.close(new NotConnectedError('connection closed by the thermostat')));
  }

  get ready(): boolean {
    return this.#step === 'ready' && !this.#closed;
  }

  request(seqId: string, frame: string): Promise<XOpenMessage> {
    if (!this.ready) return Promise.reject(new NotConnectedError('thermostat not connected'));
    if (this.#inFlight) return Promise.reject(new XOpenError('a command is already in flight'));
    return new Promise((resolve, reject) => {
      const timeout = this.#context.settings.commandTimeoutMs;
      // The stream may now be out of step (a late answer without SeqID would
      // be matched to the next command), so a timeout drops the session.
      const timer = setTimeout(() => this.close(new TimeoutError(`no response within ${timeout} ms`)), timeout);
      this.#inFlight = { seqId, resolve, reject, timer };
      this.#write(frame);
    });
  }

  close(reason: Error): void {
    if (this.#closed) return;
    this.#closed = true;
    clearTimeout(this.#timer);
    if (this.#inFlight) {
      clearTimeout(this.#inFlight.timer);
      this.#inFlight.reject(reason);
      this.#inFlight = undefined;
    }
    this.#socket.destroy();
    this.#context.onClosed(this, reason);
  }

  #write(frame: string): void {
    this.#context.log.debug(`TX ${frame}`);
    this.#socket.write(frame);
  }

  #onData(chunk: Buffer): void {
    try {
      for (const frame of this.#framer.push(chunk)) {
        if (this.#closed) return;
        this.#onFrame(frame);
      }
    } catch (error) {
      this.close(error instanceof Error ? error : new XOpenError(String(error)));
    }
  }

  #onFrame(frame: Frame): void {
    this.#context.log.debug(`RX ${frame.text}`);
    if (frame.kind === 'own') {
      if (this.#step !== 'own-ack') return;
      if (frame.text !== OWN_ACK) throw new ProtocolError(`unexpected greeting ${frame.text}`);
      this.#step = 'challenge';
      this.#write(buildNegotiate(this.#seqId));
      return;
    }
    const document = decodeDocument(frame.text);
    if (document.kind === 'legacy') {
      this.#context.log.debug('ignoring legacy OWNxml message');
      return;
    }
    this.#onMessage(document.message);
  }

  #onMessage(message: XOpenMessage): void {
    const { password, settings } = this.#context;
    switch (this.#step) {
      case 'connecting':
      case 'own-ack':
        throw new ProtocolError('message before the OpenWebNet greeting');

      case 'challenge': {
        if (message.actionId === 'NackMsg') throw new ProtocolError('protocol negotiation rejected');
        if (message.actionId !== 'RandomStringHMAC') throw new ProtocolError(`expected challenge, got ${message.actionId}`);
        const challenge = flattenParams(message).get('Random');
        if (challenge === undefined) throw new ProtocolError('challenge without Random');
        decimalTextToHex(challenge); // validates
        this.#challenge = challenge;
        this.#seqId = message.seqId ?? this.#seqId;
        this.#progress = message.progress ?? 0;
        this.#response = bytesToDecimalText(settings.randomBytes(CLIENT_RANDOM_BYTES));
        const digest = clientDigest(password, this.#challenge, this.#response);
        this.#step = 'server-digest';
        this.#write(buildClientHandshake(this.#seqId, this.#progress + 1, this.#response, digest));
        return;
      }

      case 'server-digest': {
        if (message.actionId === 'NackMsg') throw new AuthenticationError('the thermostat rejected the password');
        if (message.actionId !== 'ServerHandshakeHMAC') {
          throw new ProtocolError(`expected server digest, got ${message.actionId}`);
        }
        const received = flattenParams(message).get('Digest') ?? '';
        const expected = serverDigest(password, this.#challenge, this.#response);
        if (!digestsEqual(expected, received)) {
          throw new AuthenticationError('the thermostat failed to prove it knows the password');
        }
        this.#write(buildHandshakeAck(this.#seqId, this.#progress));
        this.#step = 'ready';
        clearTimeout(this.#timer);
        this.#context.onReady(this);
        return;
      }

      case 'ready': {
        const inFlight = this.#inFlight;
        if (
          message.service === 'RSP' &&
          inFlight &&
          (message.seqId === inFlight.seqId || message.seqId === undefined)
        ) {
          clearTimeout(inFlight.timer);
          this.#inFlight = undefined;
          inFlight.resolve(message);
          return;
        }
        if (message.service === 'EVT') {
          this.#context.onEvent(message);
          return;
        }
        this.#context.log.debug(`ignoring unsolicited ${message.service} ${message.actionId}`);
        return;
      }
    }
  }
}

interface QueuedCommand {
  readonly build: (seqId: string) => string;
  readonly resolve: (message: XOpenMessage) => void;
  readonly reject: (error: Error) => void;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Client for one X8000. Keeps a session open, re-authenticates and
 * reconnects with backoff, serialises and rate-limits commands, and emits
 * `state` whenever the thermostat reports a change.
 */
export class XOpenClient extends EventEmitter<XOpenClientEvents> {
  readonly #settings: Settings;
  readonly #password: Secret;
  readonly #log: Logger;
  #status: ClientStatus = 'stopped';
  #connection: Connection | undefined;
  #state: ThermostatState | undefined;
  readonly #rawState = new Map<string, string>();
  readonly #queue: QueuedCommand[] = [];
  #draining = false;
  #lastCommandAt = 0;
  #attempt = 0;
  #keepAliveTimer: NodeJS.Timeout | undefined;
  #reconnectTimer: NodeJS.Timeout | undefined;

  constructor(options: XOpenClientOptions) {
    super();
    const { password, logger, ...rest } = options;
    this.#password = toSecret(password);
    this.#settings = { ...DEFAULTS, ...rest };
    this.#log = redactingLogger(logger ?? silentLogger, [this.#password.reveal()]);
  }

  get status(): ClientStatus {
    return this.#status;
  }

  /** Last known state, or `undefined` before the first report. */
  get state(): ThermostatState | undefined {
    return this.#state;
  }

  start(): void {
    if (this.#status !== 'stopped') return;
    this.#open();
  }

  stop(): void {
    if (this.#status === 'stopped') return;
    this.#setStatus('stopped');
    clearTimeout(this.#reconnectTimer);
    clearInterval(this.#keepAliveTimer);
    this.#rejectQueued(new NotConnectedError('client stopped'));
    this.#connection?.close(new NotConnectedError('client stopped'));
    this.#connection = undefined;
  }

  /** Reads the state from the thermostat (also emits `state`). */
  async refreshState(): Promise<ThermostatState> {
    const response = await this.#command(buildGetDeviceState);
    if (response.actionId !== 'device_state') throw new ProtocolError(`unexpected answer ${response.actionId}`);
    return this.#applyState(response);
  }

  /** Changes mode, setpoint, boost or end time. The request is validated first. */
  async setDeviceState(request: DeviceStateRequest): Promise<void> {
    const validated = validateDeviceStateRequest(request, this.#settings.now());
    await this.#command((seqId) => {
      const now = this.#settings.now();
      return buildSetDeviceState(seqId, this.#withCurrentProgram(validated), now, this.#windowUtcOffset(validated));
    });
  }

  /** `AUTOMATIC` without a program number stays on the current program, which is then sent explicitly. */
  #withCurrentProgram(request: DeviceStateRequest): DeviceStateRequest {
    const current = this.#state?.programNumber;
    if (request.mode !== 'AUTOMATIC' || request.programNumber !== undefined || current === undefined) return request;
    return { ...request, programNumber: current };
  }

  /**
   * Validity windows are in the thermostat's local time, so they use the
   * offset of its last report. Without a valid clock, this machine's zone.
   */
  #windowUtcOffset(request: DeviceStateRequest): number | undefined {
    if (!hasValidityWindow(request)) return undefined;
    const state = this.#state;
    if (state?.deviceClockValid !== false && state?.utcOffsetMinutes !== undefined) return state.utcOffsetMinutes;
    this.#log.warn('thermostat clock unknown: the time window uses the local time of this machine');
    return undefined;
  }

  /** Which program slots hold a program (PROTOCOL.md §5). */
  async getProgramList(): Promise<readonly ProgramSlot[]> {
    return parseProgramList((await this.#command(buildGetProgramList)).params);
  }

  /** Firmware, hardware and sensor health (PROTOCOL.md §5.2). */
  async getDiagnostic(): Promise<ParsedFile<DeviceDiagnostic>> {
    const response = await this.#command(buildGetDiagnostic);
    if (response.actionId !== 'device_diagnostic') throw new ProtocolError(`unexpected answer ${response.actionId}`);
    return this.#logIssues('diagnostic', parseDiagnostic(flattenParams(response)));
  }

  /**
   * Settings and temperature levels, from the configuration file. Personal
   * fields are never read. Its `sha256sum` is not checked: the device rewrites
   * the file itself and keeps an older checksum (PROTOCOL.md §5.2). Every value
   * is validated instead.
   */
  async getConfiguration(): Promise<ParsedFile<DeviceConfiguration>> {
    const file = await this.readDeviceFile(CONFIGURATION_FILE);
    return this.#logIssues('configuration', parseConfiguration(file.text));
  }

  /** Name, type and time slots of program `number` (0–10). */
  async getProgram(number: number): Promise<ParsedFile<ProgramProfile>> {
    const file = await this.readDeviceFile(programFileName(number));
    return this.#logIssues(`program ${number}`, parseProgramProfile(checkedText(file)));
  }

  /**
   * One of the files `isDeviceFileName` allows, with the result of the check
   * against its SHA-256. The configuration file holds the Wi-Fi password:
   * prefer `getConfiguration()`, and never log or store the text.
   */
  async readDeviceFile(fileName: string): Promise<DeviceFile> {
    if (!isDeviceFileName(fileName)) throw new ValidationError('this file cannot be read');
    const response = await this.#command((seqId) => buildGetFile(seqId, fileName));
    const file = response.fileData;
    if (response.actionId !== 'device_file' || !file) throw new ProtocolError(`no file in the answer (${response.actionId})`);
    if (file.encoding !== '') throw new ProtocolError(`unsupported file encoding "${file.encoding}"`);
    const sha256sum = flattenParams(response).get('sha256sum');
    if (sha256sum === undefined || !SHA256_HEX.test(sha256sum)) return { text: file.text, checksum: 'absent' };
    const actual = createHash('sha256').update(file.text, 'utf8').digest('hex');
    return {
      text: file.text,
      sha256sum: sha256sum.toLowerCase(),
      checksum: actual === sha256sum.toLowerCase() ? 'match' : 'mismatch',
    };
  }

  #logIssues<T>(what: string, parsed: ParsedFile<T>): ParsedFile<T> {
    for (const issue of parsed.issues) this.#log.warn(`${what}: ${issue}`);
    return parsed;
  }

  #setStatus(status: ClientStatus): void {
    if (this.#status === status) return;
    this.#status = status;
    this.emit('status', status);
  }

  #open(): void {
    this.#setStatus('connecting');
    this.#log.info(`connecting to ${this.#settings.host}:${this.#settings.port}`);
    this.#connection = new Connection({
      password: this.#password,
      log: this.#log,
      settings: this.#settings,
      onReady: (connection) => this.#onReady(connection),
      onClosed: (connection, reason) => this.#onClosed(connection, reason),
      onEvent: (message) => this.#onEvent(message),
    });
  }

  #onReady(connection: Connection): void {
    if (connection !== this.#connection) return;
    this.#log.info('authenticated');
    this.#attempt = 0;
    this.#setStatus('ready');
    this.emit('ready');
    this.#keepAliveTimer = setInterval(() => this.#keepAlive(), this.#settings.keepAliveIntervalMs);
    this.refreshState().catch((error: unknown) => this.#log.warn(`initial state read failed: ${String(error)}`));
  }

  #onClosed(connection: Connection, reason: Error): void {
    if (connection !== this.#connection) return;
    this.#connection = undefined;
    clearInterval(this.#keepAliveTimer);
    this.#rejectQueued(new NotConnectedError('connection lost'));
    if (this.#status === 'stopped') return;

    let delay = Math.min(this.#settings.reconnectMaxDelayMs, this.#settings.reconnectBaseDelayMs * 2 ** this.#attempt);
    this.#attempt++;
    if (reason instanceof AuthenticationError) {
      this.#log.error(`authentication failed: ${reason.message}`);
      this.emit('authenticationFailed', reason);
      delay = this.#settings.reconnectMaxDelayMs;
    } else {
      this.#log.warn(`disconnected: ${reason.message}`);
    }
    this.emit('disconnected', reason);
    delay = Math.round(delay * (0.75 + Math.random() * 0.25));
    this.#log.info(`reconnecting in ${delay} ms`);
    this.#setStatus('waiting');
    this.#reconnectTimer = setTimeout(() => this.#open(), delay);
  }

  #onEvent(message: XOpenMessage): void {
    if (message.actionId === 'device_state') this.#applyState(message);
    else this.#log.debug(`ignoring event ${message.actionId}`);
  }

  #applyState(message: XOpenMessage): ThermostatState {
    for (const [key, value] of flattenParams(message)) this.#rawState.set(key, value);
    const { state, issues } = parseDeviceState(this.#rawState);
    for (const issue of issues) this.#log.warn(`state: ${issue}`);
    this.#state = state;
    this.emit('state', state);
    return state;
  }

  #keepAlive(): void {
    if (this.#draining || this.#queue.length > 0) return; // traffic already proves liveness
    // A NackMsg is still an answer, so the thermostat is alive. Only a
    // missing answer means a dead session, and the timeout already drops it.
    this.#command(buildKeepAlive).catch((error: unknown) => {
      if (error instanceof CommandRejectedError) this.#log.debug(`keep-alive: ${error.message}`);
    });
  }

  #command(build: (seqId: string) => string): Promise<XOpenMessage> {
    if (this.#status !== 'ready' || !this.#connection?.ready) {
      return Promise.reject(new NotConnectedError('thermostat not connected'));
    }
    if (this.#queue.length >= this.#settings.maxQueuedCommands) {
      return Promise.reject(new XOpenError('too many queued commands'));
    }
    return new Promise((resolve, reject) => {
      this.#queue.push({ build, resolve, reject });
      void this.#drain();
    });
  }

  async #drain(): Promise<void> {
    if (this.#draining) return;
    this.#draining = true;
    try {
      for (let next = this.#queue.shift(); next; next = this.#queue.shift()) {
        const wait = this.#lastCommandAt + this.#settings.minCommandIntervalMs - Date.now();
        if (wait > 0) await sleep(wait);
        try {
          let response = await this.#send(next.build);
          if (nackCode(response) === NACK_BUSY) {
            this.#log.warn('the thermostat is busy: retrying the command once');
            await sleep(this.#settings.busyRetryDelayMs);
            response = await this.#send(next.build);
          }
          if (response.actionId === 'NackMsg') next.reject(new CommandRejectedError(nackCode(response)));
          else next.resolve(response);
        } catch (error) {
          next.reject(error instanceof Error ? error : new XOpenError(String(error)));
        } finally {
          this.#lastCommandAt = Date.now();
        }
      }
    } finally {
      this.#draining = false;
    }
  }

  /** Sends one command with a fresh SeqID on the current connection. */
  #send(build: (seqId: string) => string): Promise<XOpenMessage> {
    const connection = this.#connection;
    if (!connection?.ready) return Promise.reject(new NotConnectedError('thermostat not connected'));
    const seqId = randomUUID();
    return connection.request(seqId, build(seqId));
  }

  #rejectQueued(reason: Error): void {
    for (const queued of this.#queue.splice(0)) queued.reject(reason);
  }
}
