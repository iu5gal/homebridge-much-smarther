import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { API, DynamicPlatformPlugin, Logging, PlatformAccessory, PlatformConfig } from 'homebridge';
import { showNoResponse, ThermostatAccessory } from './accessory.js';
import { startControlServer } from './control-server.js';
import { ThermostatController } from './controller.js';
import { translator } from './i18n.js';
import { PinStore } from './pin-store.js';
import { ProgramBackups } from './program-backups.js';
import { parseSettings, SettingsError, type Settings } from './settings.js';

export const PLUGIN_NAME = 'homebridge-much-smarther';
export const PLATFORM_NAME = 'MuchSmarther';
/** `Categories.THERMOSTAT` (a const enum in the HAP types). */
const CATEGORY_THERMOSTAT = 9;

/**
 * The Homebridge platform: one thermostat, one accessory. Version 1 supports
 * one thermostat per Homebridge instance, so the accessory UUID is fixed and
 * renaming it in config.json does not create a new accessory.
 */
export class MuchSmartherPlatform implements DynamicPlatformPlugin {
  readonly #log: Logging;
  readonly #api: API;
  readonly #cached: PlatformAccessory[] = [];
  #settings: Settings | undefined;
  #controller: ThermostatController | undefined;
  #control: { close(): Promise<void> } | undefined;
  #store: PinStore | undefined;

  constructor(log: Logging, config: PlatformConfig, api: API) {
    this.#log = log;
    this.#api = api;
    try {
      if (config['host'] === undefined || config['host'] === '') {
        log.info('not configured yet: enter the thermostat address in the plugin settings');
      } else {
        const { settings, warnings } = parseSettings(config);
        this.#settings = settings;
        for (const warning of warnings) log.warn(warning);
      }
    } catch (error) {
      log.error(
        error instanceof SettingsError
          ? `invalid settings, the plugin is not started: ${error.message}`
          : `could not read the settings, the plugin is not started: ${message(error)}`,
      );
    }
    api.on('didFinishLaunching', () => this.#launch());
    api.on('shutdown', () => this.#shutdown());
  }

  configureAccessory(accessory: PlatformAccessory): void {
    this.#cached.push(accessory);
  }

  /**
   * Without valid settings the cached accessory stays, showing "No response",
   * so the room, names and automations in the Home app survive a mistake.
   */
  #launch(): void {
    let accessory: PlatformAccessory | undefined;
    try {
      const uuid = this.#api.hap.uuid.generate(`${PLUGIN_NAME}:thermostat`);
      const stale = this.#cached.filter((candidate) => candidate.UUID !== uuid);
      if (stale.length > 0) this.#api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, stale);
      accessory = this.#cached.find((candidate) => candidate.UUID === uuid);
      if (this.#settings) accessory = this.#start(this.#settings, uuid, accessory);
      else if (accessory) showNoResponse(this.#api.hap, accessory);
    } catch (error) {
      this.#log.error(`the plugin could not start: ${message(error)}`);
      this.#controller?.stop();
      if (accessory) showNoResponse(this.#api.hap, accessory);
    }
  }

  #start(settings: Settings, uuid: string, cached: PlatformAccessory | undefined): PlatformAccessory {
    const { hap } = this.#api;
    let accessory = cached;
    if (!accessory) {
      accessory = new this.#api.platformAccessory(settings.name, uuid, CATEGORY_THERMOSTAT);
      this.#api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
    } else if (accessory.displayName !== settings.name) {
      accessory.updateDisplayName(settings.name);
      this.#api.updatePlatformAccessories([accessory]);
    }

    const store = new PinStore(this.#api.user.storagePath());
    this.#store = store;
    const controller = new ThermostatController({
      settings,
      logger: this.#log,
      programBackups: new ProgramBackups(join(store.directory, 'program-backups')),
    });
    this.#controller = controller;
    new ThermostatAccessory({
      hap,
      host: accessory,
      controller,
      translate: translator(settings.language),
      logger: this.#log,
      serialNumber: createHash('sha256').update(uuid).digest('hex').slice(0, 12).toUpperCase(),
    });

    const start = () => {
      const saved = store.read();
      if (saved?.tightened) this.#log.warn('the password file was readable by others: its permissions are now 0600');
      controller.start(saved?.pin);
    };
    start();

    const key = store.createControlKey();
    startControlServer({ socketPath: store.socketPath, key, controller, reload: start, logger: this.#log }).then(
      (control) => (this.#control = control),
      (error: unknown) => this.#log.warn(`the setup page cannot reach the plugin: ${message(error)}`),
    );
    return accessory;
  }

  #shutdown(): void {
    this.#controller?.stop();
    void this.#control?.close();
    try {
      this.#store?.clearControlKey();
    } catch {
      // The next start writes a new key anyway.
    }
  }
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
