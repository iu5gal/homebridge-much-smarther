import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import {
  assertUserProgram,
  cleanProgramName,
  draftFromProfile,
  formatLocalDateTime,
  nextLevelChange,
  NotConnectedError,
  parseProgramProfile,
  PROGRAM_NUMBER_MAX,
  programFileName,
  ProgramWriteError,
  slotsPerDayLimit,
  USER_PROGRAM_MIN,
  validateProgramDraft,
  withMidnightSlots,
  XOpenClient,
  type BoostMinutes,
  type ClientStatus,
  type DeviceConfiguration,
  type DeviceDiagnostic,
  type DeviceStateRequest,
  type LevelChange,
  type Logger,
  type ProgramProfile,
  type Secret,
  type ThermostatFunction,
  type ThermostatState,
  type TimeSlot,
  type Weekday,
  type XOpenClientOptions,
} from '@much-smarther/core';
import type { Intent } from './mapping.js';
import type { ProgramBackups, ProgramVersion } from './program-backups.js';
import type { Settings } from './settings.js';

/**
 * Everything the plugin knows about the thermostat, and the only way it sends
 * commands. It owns the single local session the thermostat allows
 * (PROTOCOL.md §1), so the HomeKit accessory and the setup UI both go
 * through it.
 */

export type ConnectionStatus = ClientStatus | 'no-pin';

export interface ProgramInfo {
  readonly number: number;
  readonly name?: string;
  readonly type?: 'DAILY' | 'WEEKLY';
}

export interface Snapshot {
  readonly status: ConnectionStatus;
  readonly authenticationFailed: boolean;
  readonly state?: ThermostatState;
  readonly configuration?: DeviceConfiguration;
  readonly diagnostic?: DeviceDiagnostic;
  /** Programs that exist on the thermostat, by slot. */
  readonly programs: readonly ProgramInfo[];
  /** The time slots of the active program, when read. */
  readonly activeProgram?: ProgramProfile;
  /** When the active program next changes level, if it does. */
  readonly nextChange?: LevelChange;
}

/** Why a change to a program was not made, for a clear message on the setup page. */
export type ProgramEditProblem = 'conflict' | 'full' | 'in-use' | 'name-taken' | 'no-version' | 'unavailable';

export class ProgramEditError extends Error {
  override name = 'ProgramEditError';

  constructor(readonly problem: ProgramEditProblem) {
    super(`the program was not changed: ${problem}`);
  }
}

/** A user program with its slots, for the setup page. */
export interface ProgramDetails {
  readonly number: number;
  readonly name?: string;
  readonly type?: 'DAILY' | 'WEEKLY';
  readonly days: Readonly<Record<Weekday, readonly TimeSlot[]>>;
}

/** What the setup page needs to list the programs. */
export interface ProgramsView {
  readonly programs: readonly ProgramDetails[];
  readonly versions: readonly ProgramVersion[];
  readonly maxSlotsPerDay: number;
}

/** A program read now from the thermostat. `version` stands for its exact content. */
export interface ProgramToEdit extends ProgramDetails {
  readonly version: string;
}

export interface ProgramEdit {
  /** Absent for a new program, which goes to the first free slot. */
  readonly number?: number;
  /** The `version` that was edited. Required with `number`. */
  readonly version?: string;
  readonly name: unknown;
  readonly days: unknown;
}

export interface ControllerOptions {
  readonly settings: Settings;
  readonly logger: Logger;
  /** Where copies of the programs go before a write. Without it, programs cannot be changed. */
  readonly programBackups?: ProgramBackups;
  /** Extra client options, for tests. */
  readonly client?: Partial<Omit<XOpenClientOptions, 'host' | 'port' | 'password' | 'logger'>>;
  readonly now?: () => Date;
  /** Quiet time before a temperature from the Home app slider is sent. */
  readonly debounceMs?: number;
  /** How often configuration and programs are read again; they change without events. */
  readonly refreshIntervalMs?: number;
  readonly diagnosticIntervalMs?: number;
}

const COMFORT_DEFAULT: Readonly<Record<ThermostatFunction, number>> = { HEATING: 20, COOLING: 24 };
/** The thermostat announces program changes; several can come together. */
const PROGRAMS_CHANGED_DELAY_MS = 2_000;
/** Its announcement of our own write needs no new reading. */
const OWN_WRITE_QUIET_MS = 5_000;

const versionOf = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

export class ThermostatController extends EventEmitter<{ change: [] }> {
  readonly #settings: Settings;
  readonly #log: Logger;
  readonly #options: ControllerOptions;
  readonly #now: () => Date;
  #client: XOpenClient | undefined;
  #status: ConnectionStatus = 'no-pin';
  #authenticationFailed = false;
  #configuration: DeviceConfiguration | undefined;
  #diagnostic: DeviceDiagnostic | undefined;
  #programs: ProgramInfo[] = [];
  #profiles = new Map<number, ProgramProfile>();
  #lastSetpoint = new Map<ThermostatFunction, number>();
  #pendingSetpoint: number | undefined;
  #debounce: NodeJS.Timeout | undefined;
  #refreshTimer: NodeJS.Timeout | undefined;
  #diagnosticTimer: NodeJS.Timeout | undefined;
  #refreshing: Promise<void> | undefined;
  #programsChangedTimer: NodeJS.Timeout | undefined;
  #ownWriteAt = Number.NEGATIVE_INFINITY;
  /** Changes to programs run one at a time, each with its checks and copies. */
  #programEdits: Promise<unknown> = Promise.resolve();

  constructor(options: ControllerOptions) {
    super();
    this.#options = options;
    this.#settings = options.settings;
    this.#log = options.logger;
    this.#now = options.now ?? (() => new Date());
  }

  get snapshot(): Snapshot {
    const state = this.#client?.state;
    const activeProgram = state?.programNumber === undefined ? undefined : this.#profiles.get(state.programNumber);
    const fn = state?.function ?? 'HEATING';
    const levels = fn === 'COOLING' ? this.#configuration?.cooling : this.#configuration?.heating;
    const nextChange =
      activeProgram === undefined
        ? undefined
        : nextLevelChange(activeProgram, this.#now(), {
            ...(state?.utcOffsetMinutes === undefined ? {} : { utcOffsetMinutes: state.utcOffsetMinutes }),
            ...(levels ? { levels } : {}),
          });
    return {
      status: this.#status,
      authenticationFailed: this.#authenticationFailed,
      programs: this.#programs,
      ...(state ? { state } : {}),
      ...(this.#configuration ? { configuration: this.#configuration } : {}),
      ...(this.#diagnostic ? { diagnostic: this.#diagnostic } : {}),
      ...(activeProgram ? { activeProgram } : {}),
      ...(nextChange ? { nextChange } : {}),
    };
  }

  /** Starts the session, or waits for a password when there is none. */
  start(pin: Secret | undefined): void {
    this.stop();
    if (!pin) {
      this.#setStatus('no-pin');
      this.#log.warn('no thermostat password yet: set it in the plugin settings page');
      return;
    }
    const { settings } = this;
    const client = new XOpenClient({
      ...this.#options.client,
      host: settings.host,
      ...(settings.port === undefined ? {} : { port: settings.port }),
      password: pin,
      logger: this.#log,
    });
    this.#client = client;
    client.on('status', (status) => this.#setStatus(status));
    client.on('ready', () => {
      this.#authenticationFailed = false;
      void this.refreshFiles();
      void this.#refreshDiagnostic();
    });
    client.on('authenticationFailed', () => {
      this.#authenticationFailed = true;
      this.#log.error(
        'the thermostat rejected the password. It was probably reset: retrieve the password again in the plugin settings page',
      );
      this.emit('change');
    });
    client.on('state', (state) => this.#onState(state));
    client.on('programsChanged', () => this.#onProgramsChanged());
    this.#refreshTimer = setInterval(() => void this.refreshFiles(), this.#options.refreshIntervalMs ?? 30 * 60_000);
    this.#diagnosticTimer = setInterval(
      () => void this.#refreshDiagnostic(),
      this.#options.diagnosticIntervalMs ?? 6 * 60 * 60_000,
    );
    this.#refreshTimer.unref();
    this.#diagnosticTimer.unref();
    client.start();
  }

  stop(): void {
    clearTimeout(this.#debounce);
    clearTimeout(this.#programsChangedTimer);
    clearInterval(this.#refreshTimer);
    clearInterval(this.#diagnosticTimer);
    this.#pendingSetpoint = undefined;
    this.#client?.stop();
    this.#client?.removeAllListeners();
    this.#client = undefined;
  }

  get settings(): Settings {
    return this.#settings;
  }

  // -------------------------------------------------------------------------
  // Commands

  /**
   * A temperature from the Home app. The slider sends many values, so only the
   * last one is sent after `debounceMs` of quiet. Errors are logged, and the
   * accessory goes back to the reported state.
   */
  setTargetTemperature(setpoint: number): void {
    this.#pendingSetpoint = setpoint;
    clearTimeout(this.#debounce);
    this.#debounce = setTimeout(() => {
      const value = this.#pendingSetpoint;
      this.#pendingSetpoint = undefined;
      if (value === undefined) return;
      const fn = this.#client?.state?.function ?? 'HEATING';
      this.manual(fn, value).catch((error: unknown) => this.#commandFailed(error));
    }, this.#options.debounceMs ?? 1_000);
  }

  /** Carries out an intent from the Home app. Errors are logged, not thrown. */
  run(intent: Intent): void {
    this.#run(intent).catch((error: unknown) => this.#commandFailed(error));
  }

  async #run(intent: Intent): Promise<void> {
    switch (intent.kind) {
      case 'off':
        return this.switchOff(intent.untilNextChange ? this.snapshot.nextChange?.at : undefined);
      case 'automatic':
        return this.automatic(intent.program);
      case 'boost':
        return this.boost(intent.minutes);
      case 'manual':
        return this.manual(intent.function, intent.setpoint ?? this.#comfortable(intent.function));
    }
  }

  /**
   * A manual temperature. `until` undefined applies the plugin setting (next
   * change of level, forever or a duration); `null` means forever.
   */
  async manual(fn: ThermostatFunction, setpoint: number, until?: Date | null): Promise<void> {
    const end = until === undefined ? this.#defaultManualEnd() : (until ?? undefined);
    await this.#send({ mode: 'MANUAL', function: fn, setpoint, ...(end ? { until: end } : {}) });
  }

  async boost(minutes: BoostMinutes): Promise<void> {
    await this.#send({ mode: 'BOOST', function: this.#function(), minutes });
  }

  /** "Off" as the app does it: `PROTECTION`, forever or until a time. */
  async switchOff(until?: Date): Promise<void> {
    await this.#send({ mode: 'PROTECTION', function: this.#function(), ...(until ? { until } : {}) });
  }

  async automatic(programNumber?: number): Promise<void> {
    await this.#send({
      mode: 'AUTOMATIC',
      function: this.#function(),
      ...(programNumber === undefined ? {} : { programNumber }),
    });
  }

  /** Changes the season, staying on the weekly program. */
  async season(fn: ThermostatFunction): Promise<void> {
    await this.#send({ mode: 'AUTOMATIC', function: fn });
  }

  async #send(request: DeviceStateRequest): Promise<void> {
    const client = this.#client;
    if (!client) throw new NotConnectedError('no thermostat password yet');
    this.#log.info(`sending ${describeRequest(request)}`);
    await client.setDeviceState(request);
  }

  #commandFailed(error: unknown): void {
    this.#log.error(`command failed: ${error instanceof Error ? error.message : String(error)}`);
    this.emit('change'); // let the accessory show the reported state again
  }

  #function(): ThermostatFunction {
    return this.#client?.state?.function ?? 'HEATING';
  }

  /** The temperature for "Heat" from "Off": the last one used, else the "Home" level. */
  #comfortable(fn: ThermostatFunction): number {
    const levels = fn === 'COOLING' ? this.#configuration?.cooling : this.#configuration?.heating;
    return this.#lastSetpoint.get(fn) ?? levels?.day ?? COMFORT_DEFAULT[fn];
  }

  #defaultManualEnd(): Date | undefined {
    switch (this.#settings.manualEnd) {
      case 'forever':
        return undefined;
      case 'duration':
        return new Date(this.#now().getTime() + this.#settings.manualMinutes * 60_000);
      case 'nextChange':
        return this.snapshot.nextChange?.at;
    }
  }

  // -------------------------------------------------------------------------
  // Changing programs

  /** The user programs as last read, and the versions that can be restored. */
  programsView(): ProgramsView {
    const programs: ProgramDetails[] = [];
    for (const { number } of this.#programs) {
      const profile = this.#profiles.get(number);
      if (number >= USER_PROGRAM_MIN && profile) programs.push(detailsOf(number, profile));
    }
    return {
      programs,
      versions: this.#options.programBackups?.list() ?? [],
      maxSlotsPerDay: slotsPerDayLimit(this.#configuration?.firmwareVersionOfLastSaving),
    };
  }

  /** Reads a program now, since it may have changed in the app. */
  async readProgramToEdit(number: number): Promise<ProgramToEdit> {
    assertUserProgram(number);
    const client = this.#readyClient();
    const text = await this.#programText(client, number);
    const profile = parseProgramProfile(text).value;
    if (profile.valid === false) throw new ProgramEditError('conflict');
    this.#remember(number, profile);
    return { ...detailsOf(number, profile), version: versionOf(text) };
  }

  /** Saves a program. What it replaces is copied first, and the result is read back. */
  saveProgram(edit: ProgramEdit): Promise<ProgramDetails> {
    return this.#oneEdit(async (client, backups) => {
      const creating = edit.number === undefined;
      if (!creating) assertUserProgram(edit.number);
      const number = edit.number ?? (await this.#freeSlot(client));
      // Checked now, so that a program that can never be written leaves no copy behind.
      const createdAt = formatLocalDateTime(this.#now(), this.#client?.state?.utcOffsetMinutes);
      const text = await this.#programText(client, number);
      const current = parseProgramProfile(text).value;
      const options = {
        ...(current.name === undefined || current.valid === false ? {} : { existingName: current.name }),
        maxSlotsPerDay: slotsPerDayLimit(this.#configuration?.firmwareVersionOfLastSaving),
      };
      // A name left as it was stays, whatever it holds. A new one is cleaned here, whatever sent it.
      const name = typeof edit.name === 'string' && edit.name !== options.existingName ? cleanProgramName(edit.name) : edit.name;
      const draft = validateProgramDraft(
        { number, name, days: edit.days, createdAt: current.valid === false ? createdAt : (current.createdAt ?? createdAt) },
        options,
      );
      if (creating ? current.valid !== false : edit.version !== versionOf(text)) throw new ProgramEditError('conflict');
      if (draft.name !== options.existingName && this.#nameIsTaken(draft.name, number)) throw new ProgramEditError('name-taken');
      await this.#keepCopies(client, backups, number, text);
      this.#log.info(`saving program ${number}`);
      return detailsOf(number, await this.#write(client, number, draft, options));
    });
  }

  /** Empties a program, after copying it. The one in use cannot be erased. */
  deleteProgram(number: number): Promise<void> {
    return this.#oneEdit(async (client, backups) => {
      assertUserProgram(number);
      if ((await client.refreshState()).programNumber === number) throw new ProgramEditError('in-use');
      await this.#keepCopies(client, backups, number, await this.#programText(client, number));
      this.#log.info(`deleting program ${number}`);
      try {
        await client.eraseProgram(number);
      } finally {
        await this.#reread(client, number);
      }
      this.emit('change');
    });
  }

  /** Puts a kept version back in its slot. What is there now becomes a version too. */
  restoreProgram(number: number, id: string): Promise<ProgramDetails> {
    return this.#oneEdit(async (client, backups) => {
      assertUserProgram(number);
      const saved = backups.read(number, id);
      if (saved === undefined) throw new ProgramEditError('no-version');
      const profile = parseProgramProfile(saved).value;
      if (profile.number !== number || profile.valid === false) throw new ProgramEditError('no-version');
      const fallback = formatLocalDateTime(this.#now(), this.#client?.state?.utcOffsetMinutes);
      const options = {
        ...(profile.name === undefined ? {} : { existingName: profile.name }),
        maxSlotsPerDay: slotsPerDayLimit(this.#configuration?.firmwareVersionOfLastSaving),
      };
      const draft = validateProgramDraft(draftFromProfile(profile, fallback), options);
      await this.#keepCopies(client, backups, number, await this.#programText(client, number));
      this.#log.info(`restoring program ${number}`);
      return detailsOf(number, await this.#write(client, number, draft, options));
    });
  }

  #oneEdit<T>(edit: (client: XOpenClient, backups: ProgramBackups) => Promise<T>): Promise<T> {
    const run = this.#programEdits.then(async () => {
      const backups = this.#options.programBackups;
      if (!backups) throw new ProgramEditError('unavailable');
      return edit(this.#readyClient(), backups);
    });
    this.#programEdits = run.catch(() => undefined);
    return run;
  }

  #readyClient(): XOpenClient {
    const client = this.#client;
    if (!client || client.status !== 'ready') throw new NotConnectedError('thermostat not connected');
    return client;
  }

  async #programText(client: XOpenClient, number: number): Promise<string> {
    const file = await client.readDeviceFile(programFileName(number));
    if (file.checksum === 'mismatch') throw new ProgramWriteError(`program ${number} does not match its checksum`);
    return file.text;
  }

  /** Two programs with one name could not be told apart. "Casa" and "casa" count as the same. */
  #nameIsTaken(name: string, number: number): boolean {
    const wanted = name.toLowerCase();
    return [...this.#profiles].some(
      ([slot, profile]) => slot >= USER_PROGRAM_MIN && slot !== number && profile.name?.toLowerCase() === wanted,
    );
  }

  async #freeSlot(client: XOpenClient): Promise<number> {
    const slot = (await client.getProgramList()).find((candidate) => candidate.number >= USER_PROGRAM_MIN && !candidate.present);
    if (slot === undefined || slot.number > PROGRAM_NUMBER_MAX) throw new ProgramEditError('full');
    return slot.number;
  }

  /** Copies everything before the first write, and what this write replaces. A failure stops the write. */
  async #keepCopies(client: XOpenClient, backups: ProgramBackups, number: number, text: string): Promise<void> {
    if (!backups.hasInitialCopy) {
      const files = new Map<number, string>();
      for (let slot = 0; slot <= PROGRAM_NUMBER_MAX; slot++) files.set(slot, await this.#programText(client, slot));
      backups.saveInitialCopy(files);
    }
    if (parseProgramProfile(text).value.valid !== false) backups.saveVersion(number, text);
  }

  async #write(
    client: XOpenClient,
    number: number,
    draft: unknown,
    options: { existingName?: string; maxSlotsPerDay: number },
  ): Promise<ProgramProfile> {
    this.#ownWriteAt = Date.now();
    try {
      const stored = await client.writeProgram(draft, options);
      this.#remember(number, stored);
      return stored;
    } catch (error) {
      await this.#reread(client, number);
      throw error;
    }
  }

  /** What the slot holds now is the truth, whatever happened. If it cannot be read, nothing more can be done. */
  async #reread(client: XOpenClient, number: number): Promise<void> {
    this.#ownWriteAt = Date.now();
    try {
      const present = (await client.getProgramList()).find((slot) => slot.number === number)?.present === true;
      this.#remember(number, present ? (await client.getProgram(number)).value : undefined);
    } catch (error) {
      this.#log.warn(`could not read program ${number} again: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** Updates what is known of one program, and the next change of level that depends on it. */
  #remember(number: number, profile: ProgramProfile | undefined): void {
    if (profile) this.#profiles.set(number, profile);
    else this.#profiles.delete(number);
    this.#programs = [...this.#profiles.keys()].sort((a, b) => a - b).map((slot) => infoOf(slot, this.#profiles.get(slot)));
    this.emit('change');
  }

  #onProgramsChanged(): void {
    if (Date.now() - this.#ownWriteAt < OWN_WRITE_QUIET_MS) return;
    clearTimeout(this.#programsChangedTimer);
    this.#programsChangedTimer = setTimeout(() => void this.refreshFiles(), PROGRAMS_CHANGED_DELAY_MS);
    this.#programsChangedTimer.unref();
  }

  // -------------------------------------------------------------------------
  // Reading

  #onState(state: ThermostatState): void {
    if (
      state.function !== undefined &&
      state.setpoint !== undefined &&
      (state.mode === 'MANUAL' || state.mode === 'AUTOMATIC' || state.mode === 'BOOST')
    ) {
      this.#lastSetpoint.set(state.function, state.setpoint);
    }
    const number = state.programNumber;
    if (number !== undefined && !this.#profiles.has(number) && this.#status === 'ready') void this.#readProgram(number);
    this.emit('change');
  }

  /** Reads configuration and programs again. Concurrent calls share one run. */
  refreshFiles(): Promise<void> {
    this.#refreshing ??= this.#refreshFiles().finally(() => (this.#refreshing = undefined));
    return this.#refreshing;
  }

  async #refreshFiles(): Promise<void> {
    const client = this.#client;
    if (!client || client.status !== 'ready') return;
    try {
      this.#configuration = (await client.getConfiguration()).value;
      const present = (await client.getProgramList()).filter((slot) => slot.present).map((slot) => slot.number);
      const profiles = new Map<number, ProgramProfile>();
      for (const number of present) profiles.set(number, (await client.getProgram(number)).value);
      this.#profiles = profiles;
      this.#programs = present.map((number) => infoOf(number, profiles.get(number)));
    } catch (error) {
      this.#log.warn(`could not read the thermostat settings: ${error instanceof Error ? error.message : String(error)}`);
    }
    this.emit('change');
  }

  async #readProgram(number: number): Promise<void> {
    try {
      const profile = (await this.#client?.getProgram(number))?.value;
      if (profile) this.#profiles.set(number, profile);
      this.emit('change');
    } catch (error) {
      this.#log.warn(`could not read program ${number}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async #refreshDiagnostic(): Promise<void> {
    const client = this.#client;
    if (!client || client.status !== 'ready') return;
    try {
      this.#diagnostic = (await client.getDiagnostic()).value;
      this.emit('change');
    } catch (error) {
      this.#log.warn(`could not read the diagnostics: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  #setStatus(status: ConnectionStatus): void {
    if (this.#status === status) return;
    this.#status = status;
    this.emit('change');
  }
}

function infoOf(number: number, profile: ProgramProfile | undefined): ProgramInfo {
  return { number, ...(profile?.name ? { name: profile.name } : {}), ...(profile?.type ? { type: profile.type } : {}) };
}

/** A program for the setup page: every day starts at midnight, so that it can be shown and edited on its own. */
function detailsOf(number: number, profile: ProgramProfile): ProgramDetails {
  return { ...infoOf(number, profile), days: withMidnightSlots(profile.days) };
}

/** A log line for a command, without anything personal. */
function describeRequest(request: DeviceStateRequest): string {
  const parts: string[] = [request.mode.toLowerCase(), request.function.toLowerCase()];
  if (request.mode === 'MANUAL') parts.push(`${request.setpoint} °C`);
  if (request.mode === 'BOOST') parts.push(`${request.minutes} min`);
  if ((request.mode === 'MANUAL' || request.mode === 'PROTECTION') && request.until) {
    parts.push(`until ${request.until.toISOString()}`);
  }
  if (request.mode === 'AUTOMATIC' && request.programNumber !== undefined) parts.push(`program ${request.programNumber}`);
  return parts.join(', ');
}
