import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Secret } from '@much-smarther/core';

/**
 * Where the plugin keeps what must not go into config.json: the thermostat's
 * password (PswOpen), and the control socket and its access key for the
 * setup UI.
 *
 * `<storage>/much-smarther/` is created with mode 0700 and the files with
 * mode 0600. Windows has no such modes: there the files rely on the access
 * rights of the Homebridge storage directory, normally in the user's profile.
 * Homebridge backups include the storage directory, so they contain the
 * password too (see the setup guide).
 */

export const PIN_PATTERN = /^[\x21-\x7e]{1,64}$/;
const DIRECTORY = 'much-smarther';
const PIN_FILE = 'pswopen';
const SOCKET_FILE = 'control.sock';
const KEY_FILE = 'control-key';
const KEY_PATTERN = /^[0-9a-f]{64}$/;

export class PinStore {
  readonly directory: string;
  readonly #file: string;
  readonly #keyFile: string;
  readonly #windows: boolean;

  constructor(storagePath: string, platform: NodeJS.Platform = process.platform) {
    this.directory = join(storagePath, DIRECTORY);
    this.#file = join(this.directory, PIN_FILE);
    this.#keyFile = join(this.directory, KEY_FILE);
    this.#windows = platform === 'win32';
  }

  /**
   * Where the control server between the setup UI and the plugin listens: a
   * Unix socket in the directory, or on Windows a named pipe whose name is
   * derived from the directory, so that two Homebridge instances never share one.
   */
  get socketPath(): string {
    if (!this.#windows) return join(this.directory, SOCKET_FILE);
    const id = createHash('sha256').update(this.directory).digest('hex').slice(0, 16);
    return `\\\\.\\pipe\\much-smarther-${id}`;
  }

  has(): boolean {
    return existsSync(this.#file);
  }

  /**
   * The saved password, or `undefined`. A file readable by others has its
   * permissions tightened, and `tightened` says so.
   */
  read(): { pin: Secret; tightened: boolean } | undefined {
    if (!existsSync(this.#file)) return undefined;
    let tightened = false;
    if (!this.#windows && (statSync(this.#file).mode & 0o077) !== 0) {
      chmodSync(this.#file, 0o600);
      tightened = true;
    }
    const value = readFileSync(this.#file, 'utf8').trim();
    if (!PIN_PATTERN.test(value)) return undefined;
    return { pin: new Secret(value), tightened };
  }

  /** Saves `value` atomically, with mode 0600. Throws on an invalid password. */
  write(value: string): void {
    const pin = value.trim();
    if (!PIN_PATTERN.test(pin)) throw new RangeError('invalid thermostat password');
    this.#save(this.#file, pin);
  }

  /**
   * A new access key for the control server, saved with mode 0600: the
   * setup UI must send it with every request. The plugin makes one at each start.
   */
  createControlKey(): string {
    const key = randomBytes(32).toString('hex');
    this.#save(this.#keyFile, key);
    return key;
  }

  /** The current access key, or `undefined` when the plugin is not running. */
  readControlKey(): string | undefined {
    if (!existsSync(this.#keyFile)) return undefined;
    const key = readFileSync(this.#keyFile, 'utf8').trim();
    return KEY_PATTERN.test(key) ? key : undefined;
  }

  clearControlKey(): void {
    rmSync(this.#keyFile, { force: true });
  }

  #save(file: string, value: string): void {
    this.ensureDirectory();
    const temporary = `${file}.${randomBytes(6).toString('hex')}.tmp`;
    try {
      writeFileSync(temporary, `${value}\n`, { mode: 0o600, flag: 'wx' });
      renameSync(temporary, file);
    } finally {
      rmSync(temporary, { force: true });
    }
  }

  clear(): void {
    rmSync(this.#file, { force: true });
  }

  ensureDirectory(): void {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    chmodSync(this.directory, 0o700);
  }
}
