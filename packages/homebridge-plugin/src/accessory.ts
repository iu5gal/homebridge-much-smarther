import type { CharacteristicValue, HAP, PlatformAccessory, Service, WithUUID } from 'homebridge';
import { SETPOINT_MAX, SETPOINT_MIN, type BoostMinutes, type Logger, type ThermostatState } from '@much-smarther/core';
import type { ThermostatController } from './controller.js';
import type { Translate } from './i18n.js';
import {
  activeBoost,
  BOOST_MINUTES,
  currentState,
  intentForBoost,
  intentForOffUntilChange,
  intentForProgram,
  intentForSchedule,
  intentForTargetState,
  offUntilChangeOn,
  programOn,
  scheduleOn,
  targetState,
  targetStateValues,
  targetTemperature,
} from './mapping.js';

/** The parts of a platform accessory this class uses (a HAP-NodeJS `Accessory` has them too). */
export type AccessoryHost = Pick<PlatformAccessory, 'getService' | 'getServiceById' | 'addService' | 'removeService' | 'services'>;

/** After this long without a session, the Home app shows "No response". */
export const OFFLINE_GRACE_MS = 60_000;

/** `HAPStatus.SERVICE_COMMUNICATION_FAILURE`, which shows as "No response" (a const enum in the HAP types). */
const SERVICE_COMMUNICATION_FAILURE = -70402;

type ServiceType = WithUUID<typeof Service>;

const PROGRAM_SUBTYPE = /^program-(\d+)$/;

/**
 * A name the Home app accepts: letters, digits, spaces and apostrophes,
 * starting and ending with a letter or digit.
 */
export function homeKitName(text: string, fallback: string): string {
  const name = text
    .replace(/[^\p{L}\p{N}' ]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '')
    .slice(0, 64)
    .trim();
  return name === '' ? fallback : name;
}

/**
 * Makes every value of an accessory read as "No response" and refuses every
 * change: for a cached accessory when the plugin cannot run.
 */
export function showNoResponse(hap: HAP, host: AccessoryHost): void {
  const fail = () => {
    throw new hap.HapStatusError(SERVICE_COMMUNICATION_FAILURE);
  };
  const names = [hap.Characteristic.Name.UUID, hap.Characteristic.ConfiguredName.UUID];
  for (const service of host.services) {
    if (service.UUID === hap.Service.AccessoryInformation.UUID) continue;
    for (const characteristic of service.characteristics) {
      if (!names.includes(characteristic.UUID)) characteristic.onGet(fail).onSet(fail);
    }
  }
}

/**
 * One HomeKit accessory for the thermostat (docs/features.md): a Thermostat
 * service and, as the settings ask, a Humidity Sensor, three Boost switches,
 * a Schedule switch, a switch per weekly program and an "Off until the next
 * change" switch. Values come from the controller's snapshot; changes go to
 * the controller as intents.
 */
export class ThermostatAccessory {
  readonly #hap: HAP;
  readonly #host: AccessoryHost;
  readonly #controller: ThermostatController;
  readonly #t: Translate;
  readonly #log: Logger;
  readonly #now: () => number;
  readonly #thermostat: Service;
  readonly #humidity: Service | undefined;
  readonly #boosts = new Map<BoostMinutes, Service>();
  readonly #schedule: Service | undefined;
  readonly #offSwitch: Service | undefined;
  readonly #programs = new Map<number, Service>();
  #downSince: number | undefined;
  #function: string | undefined;
  #temperatureInvalid = false;

  constructor(options: {
    hap: HAP;
    host: AccessoryHost;
    controller: ThermostatController;
    translate: Translate;
    logger: Logger;
    serialNumber: string;
    now?: () => number;
  }) {
    this.#hap = options.hap;
    this.#host = options.host;
    this.#controller = options.controller;
    this.#t = options.translate;
    this.#log = options.logger;
    this.#now = options.now ?? Date.now;
    const { Service: S, Characteristic: C } = this.#hap;
    const settings = this.#controller.settings;

    this.#host
      .getService(S.AccessoryInformation)
      ?.setCharacteristic(C.Manufacturer, 'BTicino')
      .setCharacteristic(C.Model, 'Smarther X8000')
      .setCharacteristic(C.SerialNumber, options.serialNumber);

    this.#thermostat = this.#service(S.Thermostat, undefined, settings.name);
    this.#setUpThermostat();

    this.#humidity = settings.humiditySensor
      ? this.#service(S.HumiditySensor, undefined, this.#t('service.humidity'))
      : this.#drop(S.HumiditySensor);
    this.#humidity?.getCharacteristic(C.CurrentRelativeHumidity).onGet(() => this.#read((state) => state.humidity));

    for (const minutes of BOOST_MINUTES) {
      if (!settings.boostSwitches.includes(minutes)) {
        this.#drop(S.Switch, `boost-${minutes}`);
        continue;
      }
      const service = this.#service(S.Switch, `boost-${minutes}`, this.#t('service.boost', { minutes }));
      service
        .getCharacteristic(C.On)
        .onGet(() => this.#read((state) => activeBoost(state) === minutes))
        .onSet((value) => this.#act((state) => intentForBoost(minutes, value === true, state)));
      this.#boosts.set(minutes, service);
    }

    this.#schedule =
      settings.automaticMode === 'switch'
        ? this.#service(S.Switch, 'schedule', this.#t('service.schedule'))
        : this.#drop(S.Switch, 'schedule');
    this.#schedule
      ?.getCharacteristic(C.On)
      .onGet(() => this.#read((state) => scheduleOn(state)))
      .onSet((value) => this.#act((state) => intentForSchedule(value === true, state)));

    this.#offSwitch = settings.offSwitch
      ? this.#service(S.Switch, 'off-next', this.#t('service.offUntilChange'))
      : this.#drop(S.Switch, 'off-next');
    this.#offSwitch
      ?.getCharacteristic(C.On)
      .onGet(() => this.#read((state) => offUntilChangeOn(state)))
      .onSet((value) => this.#act((state) => intentForOffUntilChange(value === true, state)));

    // Program switches from the cache keep working until the programs are read again.
    for (const service of [...this.#host.services]) {
      const number = Number(PROGRAM_SUBTYPE.exec(service.subtype ?? '')?.[1] ?? Number.NaN);
      if (Number.isNaN(number)) continue;
      if (this.#wantsProgram(number)) this.#programSwitch(number, service);
      else this.#host.removeService(service);
    }

    this.#controller.on('change', () => this.#update());
    this.#push();
  }

  /** Follows the controller; an unexpected error is logged, never thrown into the controller. */
  #update(): void {
    try {
      this.#push();
    } catch (error) {
      this.#log.error(`could not update the Home app: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  #setUpThermostat(): void {
    const { Characteristic: C } = this.#hap;
    const settings = this.#controller.settings;
    const t = this.#thermostat;
    t.getCharacteristic(C.CurrentHeatingCoolingState).onGet(() => this.#read((state) => currentState(state)));
    t.getCharacteristic(C.TargetHeatingCoolingState)
      .setProps({ validValues: targetStateValues(settings, 'HEATING') })
      .onGet(() => this.#read((state) => targetState(state, settings)))
      .onSet((value) => this.#act((state) => intentForTargetState(Number(value), state, settings)));
    t.getCharacteristic(C.CurrentTemperature)
      .setProps({ minValue: -20, maxValue: 60, minStep: 0.1 })
      .onGet(() => this.#read((state) => state.ambientTemperature));
    t.getCharacteristic(C.TargetTemperature)
      .setProps({ minValue: SETPOINT_MIN, maxValue: SETPOINT_MAX, minStep: 0.1 })
      .onGet(() => this.#read((state) => targetTemperature(state)))
      .onSet((value) => {
        this.#ensureAvailable();
        this.#controller.setTargetTemperature(Math.round(Number(value) * 10) / 10);
      });
    t.getCharacteristic(C.TemperatureDisplayUnits)
      .onGet(() => this.#displayUnits())
      .onSet(() => {
        // Display only: the thermostat keeps its own unit, set in the BTicino app.
      });
    t.getCharacteristic(C.CurrentRelativeHumidity).onGet(() => this.#read((state) => state.humidity));
  }

  /** The service of that type and subtype, created if missing, named `name`. */
  #service(type: ServiceType, subtype: string | undefined, name: string): Service {
    const existing = subtype === undefined ? this.#host.getService(type) : this.#host.getServiceById(type, subtype);
    const Constructor = type as unknown as new (displayName: string, subtype?: string) => Service;
    const service =
      existing ?? this.#host.addService(subtype === undefined ? new Constructor(name) : new Constructor(name, subtype));
    this.#name(service, name);
    return service;
  }

  /**
   * Gives a service the plugin's name, on every start. When pairing, the Home
   * app can write its own default ("Switch 2") into ConfiguredName; the names
   * also follow the configured name and language.
   */
  #name(service: Service, name: string): void {
    const { Characteristic: C } = this.#hap;
    if (service.getCharacteristic(C.Name).value !== name) service.setCharacteristic(C.Name, name);
    if (!service.testCharacteristic(C.ConfiguredName)) service.addOptionalCharacteristic(C.ConfiguredName);
    const configured = service.getCharacteristic(C.ConfiguredName).value;
    if (configured === name) return;
    if (typeof configured === 'string' && configured !== '') this.#log.debug(`service "${configured}" renamed "${name}"`);
    service.setCharacteristic(C.ConfiguredName, name);
  }

  /** Wires a program switch, created if missing. */
  #programSwitch(number: number, existing?: Service): Service {
    const { Service: S, Characteristic: C } = this.#hap;
    const service = existing ?? this.#service(S.Switch, `program-${number}`, this.#t('service.program', { number }));
    service
      .getCharacteristic(C.On)
      .onGet(() => this.#read((state) => programOn(state, number)))
      .onSet((value) => this.#act((state) => intentForProgram(number, value === true, state)));
    this.#programs.set(number, service);
    return service;
  }

  #wantsProgram(number: number): boolean {
    const wanted = this.#controller.settings.programSwitches;
    return number !== 0 && (wanted === 'all' || wanted.includes(number));
  }

  /** A switch for each chosen program on the thermostat (never the system program 0), named as in the app. */
  #syncPrograms(): void {
    const all = this.#controller.snapshot.programs;
    if (all.length === 0) return; // not read yet
    const programs = all.filter((program) => this.#wantsProgram(program.number));
    const present = new Set(programs.map((program) => program.number));
    for (const [number, service] of this.#programs) {
      if (present.has(number)) continue;
      this.#host.removeService(service);
      this.#programs.delete(number);
    }
    for (const program of programs) {
      const fallback = this.#t('service.program', { number: program.number });
      const name = homeKitName(program.name ?? '', fallback);
      const service = this.#programs.get(program.number) ?? this.#programSwitch(program.number);
      this.#name(service, name);
    }
  }

  /** Removes a service left over from other settings. */
  #drop(type: ServiceType, subtype?: string): undefined {
    const existing = subtype === undefined ? this.#host.getService(type) : this.#host.getServiceById(type, subtype);
    if (existing) this.#host.removeService(existing);
    return undefined;
  }

  get #available(): boolean {
    const snapshot = this.#controller.snapshot;
    if (!snapshot.state || snapshot.authenticationFailed || snapshot.status === 'no-pin') return false;
    return this.#downSince === undefined || this.#now() - this.#downSince < OFFLINE_GRACE_MS;
  }

  #ensureAvailable(): void {
    if (!this.#available || this.#controller.snapshot.status !== 'ready') {
      throw new this.#hap.HapStatusError(SERVICE_COMMUNICATION_FAILURE);
    }
  }

  /** A value for the Home app, or "No response" when the thermostat is unreachable. */
  #read(pick: (state: ThermostatState) => CharacteristicValue | undefined): CharacteristicValue {
    const state = this.#controller.snapshot.state;
    const value = state && this.#available ? pick(state) : undefined;
    if (value === undefined) throw new this.#hap.HapStatusError(SERVICE_COMMUNICATION_FAILURE);
    return value;
  }

  #act(intentOf: (state: ThermostatState) => ReturnType<typeof intentForBoost>): void {
    this.#ensureAvailable();
    const state = this.#controller.snapshot.state;
    const intent = state ? intentOf(state) : undefined;
    if (intent) this.#controller.run(intent);
    else setTimeout(() => this.#update(), 0); // nothing to do: show the real state again
  }

  #displayUnits(): number {
    const units = this.#hap.Characteristic.TemperatureDisplayUnits;
    return this.#controller.snapshot.configuration?.temperatureFormat === 'FAHRENHEIT' ? units.FAHRENHEIT : units.CELSIUS;
  }

  /** Pushes the current snapshot to the Home app. */
  #push(): void {
    const { Characteristic: C } = this.#hap;
    const snapshot = this.#controller.snapshot;
    if (snapshot.status === 'ready') this.#downSince = undefined;
    else this.#downSince ??= this.#now();
    this.#syncPrograms();

    const state = snapshot.state;
    if (!state || !this.#available) return;
    const settings = this.#controller.settings;
    const t = this.#thermostat;

    if (state.function !== this.#function) {
      this.#function = state.function;
      t.getCharacteristic(C.TargetHeatingCoolingState).setProps({
        validValues: targetStateValues(settings, state.function),
      });
    }
    t.updateCharacteristic(C.CurrentHeatingCoolingState, currentState(state));
    const target = targetState(state, settings);
    if (target !== undefined) t.updateCharacteristic(C.TargetHeatingCoolingState, target);
    const setpoint = targetTemperature(state);
    if (setpoint !== undefined) t.updateCharacteristic(C.TargetTemperature, setpoint);
    if (state.ambientTemperature !== undefined) t.updateCharacteristic(C.CurrentTemperature, state.ambientTemperature);
    const temperatureInvalid = state.ambientTemperatureValid === false;
    if (temperatureInvalid && !this.#temperatureInvalid) this.#log.warn('the thermostat reports its temperature as not valid');
    this.#temperatureInvalid = temperatureInvalid;
    t.updateCharacteristic(C.TemperatureDisplayUnits, this.#displayUnits());
    if (state.humidity !== undefined) {
      t.updateCharacteristic(C.CurrentRelativeHumidity, state.humidity);
      this.#humidity?.updateCharacteristic(C.CurrentRelativeHumidity, state.humidity);
    }
    this.#humidity?.updateCharacteristic(
      C.StatusFault,
      state.humidityValid === false ? C.StatusFault.GENERAL_FAULT : C.StatusFault.NO_FAULT,
    );
    const boost = activeBoost(state);
    for (const [minutes, service] of this.#boosts) service.updateCharacteristic(C.On, boost === minutes);
    this.#schedule?.updateCharacteristic(C.On, scheduleOn(state));
    this.#offSwitch?.updateCharacteristic(C.On, offUntilChangeOn(state));
    for (const [number, service] of this.#programs) service.updateCharacteristic(C.On, programOn(state, number));
  }
}
