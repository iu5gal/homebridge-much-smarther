import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseProgramProfile, USER_PROGRAM_MIN, PROGRAM_NUMBER_MAX, XOpenError } from '@much-smarther/core';

/**
 * Copies of the weekly programs, made before anything is written to the
 * thermostat, in the plugin's own directory:
 *
 *   initial/device_program_profile_N.xml   every slot, once, before the first write
 *   versions/N/<id>.xml                    what each write or erase replaced
 *
 * Program names and times tell something about the household, so the
 * directories are private to the Homebridge user, and the files are never
 * logged. Homebridge backups include them, as they do the password.
 */

/** Versions kept for each program. The initial copies are never removed. */
export const VERSIONS_KEPT = 10;

const INITIAL = 'initial';
const VERSIONS = 'versions';
const VERSION_ID = /^[0-9]{8}T[0-9]{9}Z(?:-[0-9]{1,3})?$/;

export interface ProgramVersion {
  readonly id: string;
  readonly number: number;
  /** The name it had, if it can be read. */
  readonly name?: string;
  /** ISO date of the copy. */
  readonly savedAt: string;
}

const isUserProgram = (number: number) => Number.isInteger(number) && number >= USER_PROGRAM_MIN && number <= PROGRAM_NUMBER_MAX;

export class ProgramBackups {
  readonly #directory: string;
  readonly #now: () => Date;

  constructor(directory: string, now: () => Date = () => new Date()) {
    this.#directory = directory;
    this.#now = now;
  }

  get hasInitialCopy(): boolean {
    return existsSync(join(this.#directory, INITIAL));
  }

  /** The state before the first write. Renamed into place at the end, so a partial copy never counts. */
  saveInitialCopy(files: ReadonlyMap<number, string>): void {
    const partial = join(this.#directory, `${INITIAL}.partial`);
    rmSync(partial, { recursive: true, force: true });
    mkdirSync(partial, { recursive: true, mode: 0o700 });
    for (const [number, text] of files) {
      writeFileSync(join(partial, `device_program_profile_${number}.xml`), text, { mode: 0o600, flag: 'wx' });
    }
    renameSync(partial, join(this.#directory, INITIAL));
  }

  /** Keeps `text` as a version of its program, unless the newest one is the same already. */
  saveVersion(number: number, text: string): void {
    if (!isUserProgram(number)) throw new XOpenError('only user programs have versions');
    const directory = this.#versionsOf(number);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const existing = this.#ids(number);
    const newest = existing.at(-1);
    if (newest !== undefined && readFileSync(join(directory, `${newest}.xml`), 'utf8') === text) return;
    const stamp = this.#now().toISOString().replace(/[-:.]/g, '');
    let id = stamp;
    for (let attempt = 1; existing.includes(id); attempt++) id = `${stamp}-${attempt}`;
    writeFileSync(join(directory, `${id}.xml`), text, { mode: 0o600, flag: 'wx' });
    for (const old of [...existing, id].slice(0, -VERSIONS_KEPT)) rmSync(join(directory, `${old}.xml`), { force: true });
  }

  /** Every version, newest first. */
  list(): ProgramVersion[] {
    const versions: ProgramVersion[] = [];
    for (let number = USER_PROGRAM_MIN; number <= PROGRAM_NUMBER_MAX; number++) {
      for (const id of this.#ids(number)) {
        versions.push({
          id,
          number,
          savedAt: `${id.slice(0, 4)}-${id.slice(4, 6)}-${id.slice(6, 8)}T${id.slice(9, 11)}:${id.slice(11, 13)}:${id.slice(13, 15)}.${id.slice(15, 18)}Z`,
          ...this.#nameOf(number, id),
        });
      }
    }
    return versions.sort((a, b) => b.id.localeCompare(a.id));
  }

  /** The text of a version, or `undefined`. The id comes from outside: nothing else can be reached with it. */
  read(number: number, id: string): string | undefined {
    if (!isUserProgram(number) || !VERSION_ID.test(id)) return undefined;
    const file = join(this.#versionsOf(number), `${id}.xml`);
    return existsSync(file) ? readFileSync(file, 'utf8') : undefined;
  }

  #versionsOf(number: number): string {
    return join(this.#directory, VERSIONS, String(number));
  }

  /** Oldest first: the ids sort by time. */
  #ids(number: number): string[] {
    const directory = this.#versionsOf(number);
    if (!existsSync(directory)) return [];
    return readdirSync(directory)
      .filter((name) => name.endsWith('.xml') && VERSION_ID.test(name.slice(0, -4)))
      .map((name) => name.slice(0, -4))
      .sort();
  }

  #nameOf(number: number, id: string): { name?: string } {
    try {
      const name = parseProgramProfile(readFileSync(join(this.#versionsOf(number), `${id}.xml`), 'utf8')).value.name;
      return name === undefined ? {} : { name };
    } catch {
      return {};
    }
  }
}
