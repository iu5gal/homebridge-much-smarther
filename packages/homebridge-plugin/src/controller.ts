import { EventEmitter } from 'node:events';
import {
  nextLevelChange,
  NotConnectedError,
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
  type XOpenClientOptions,
} from '@much-smarther/core';
import type { Intent } from './mapping.js';
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

export interface ControllerOptions {
  readonly settings: Settings;
  readonly logger: Logger;
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
      this.#programs = present.map((number) => {
        const profile = profiles.get(number);
        return { number, ...(profile?.name ? { name: profile.name } : {}), ...(profile?.type ? { type: profile.type } : {}) };
      });
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
