import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as hapNodeJs from '@homebridge/hap-nodejs';
import type { API, Logging, PlatformConfig } from 'homebridge';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeThermostat } from '@much-smarther/simulator';
import { controlRequest } from '../src/control-client.js';
import { PinStore } from '../src/pin-store.js';
import { MuchSmartherPlatform, PLATFORM_NAME, PLUGIN_NAME } from '../src/platform.js';
import { createUiHandlers } from '../src/ui-handlers.js';
import { CapturingLogger, listening, PASSWORD, waitFor, WINDOWS } from './helpers.js';

class FakePlatformAccessory extends hapNodeJs.Accessory {
  constructor(name: string, uuid: string, category: number) {
    super(name, uuid);
    this.category = category;
  }
  updateDisplayName(name: string) {
    this.displayName = name;
  }
}

class FakeApi extends EventEmitter {
  readonly hap = hapNodeJs;
  readonly platformAccessory = FakePlatformAccessory;
  readonly registered: FakePlatformAccessory[] = [];
  readonly unregistered: FakePlatformAccessory[] = [];
  readonly updated: FakePlatformAccessory[] = [];
  constructor(readonly storage: string) {
    super();
  }
  readonly user = { storagePath: () => this.storage };
  registerPlatformAccessories(plugin: string, platform: string, accessories: FakePlatformAccessory[]) {
    expect([plugin, platform]).toEqual([PLUGIN_NAME, PLATFORM_NAME]);
    this.registered.push(...accessories);
  }
  unregisterPlatformAccessories(_plugin: string, _platform: string, accessories: FakePlatformAccessory[]) {
    this.unregistered.push(...accessories);
  }
  updatePlatformAccessories(accessories: FakePlatformAccessory[]) {
    this.updated.push(...accessories);
  }
}

describe('MuchSmartherPlatform', () => {
  let storage: string;
  let thermostat: FakeThermostat;
  let api: FakeApi;
  let logger: CapturingLogger;

  beforeEach(async () => {
    storage = mkdtempSync(join(tmpdir(), 'ms-plat-'));
    thermostat = new FakeThermostat({ password: PASSWORD });
    await thermostat.start();
    api = new FakeApi(storage);
    logger = new CapturingLogger();
  });
  afterEach(async () => {
    api.emit('shutdown');
    await thermostat.stop();
    rmSync(storage, { recursive: true, force: true });
  });

  const platform = (config: Record<string, unknown>) =>
    new MuchSmartherPlatform(logger as unknown as Logging, config as PlatformConfig, api as unknown as API);
  const status = () => {
    const store = new PinStore(storage);
    return controlRequest({ socketPath: store.socketPath, key: store.readControlKey() ?? '' }, 'GET', '/v1/status');
  };

  it('starts without a password, then connects once the setup page saves one', async () => {
    platform({ platform: PLATFORM_NAME, host: '127.0.0.1', port: thermostat.port, language: 'it' });
    api.emit('didFinishLaunching');
    expect(api.registered).toHaveLength(1);
    expect(api.registered[0]?.category).toBe(9);
    await waitFor(() => listening(new PinStore(storage).socketPath));
    expect((await status()).body).toMatchObject({ status: 'no-pin' });

    const ui = createUiHandlers({ storagePath: storage, retrievePswOpen: async () => [] });
    await expect(ui['/pin/save']?.({ pin: PASSWORD })).resolves.toEqual({ ok: true, running: true });
    await waitFor(() => thermostat.readySessions === 1);
    let body: Record<string, unknown> = {};
    for (const deadline = Date.now() + 3_000; !(body['status'] === 'ready' && body['state']); ) {
      if (Date.now() > deadline) throw new Error('the plugin did not connect in time');
      await new Promise((resolve) => setTimeout(resolve, 20));
      body = (await status()).body;
    }
    expect(logger.lines.join('\n')).not.toContain(PASSWORD);
    expect(logger.lines.join('\n')).not.toContain(new PinStore(storage).readControlKey());

    api.emit('shutdown');
    await waitFor(async () => !(await listening(new PinStore(storage).socketPath)));
    if (!WINDOWS) expect(existsSync(new PinStore(storage).socketPath)).toBe(false);
    expect(new PinStore(storage).readControlKey()).toBeUndefined();
  });

  it('keeps the cached accessory and drops others', async () => {
    const plugin = platform({ platform: PLATFORM_NAME, host: '127.0.0.1', port: thermostat.port });
    const uuid = hapNodeJs.uuid.generate(`${PLUGIN_NAME}:thermostat`);
    const cached = new FakePlatformAccessory('Smarther', uuid, 9);
    const old = new FakePlatformAccessory('Old', hapNodeJs.uuid.generate('old'), 9);
    plugin.configureAccessory(cached as never);
    plugin.configureAccessory(old as never);
    api.emit('didFinishLaunching');
    expect(api.registered).toEqual([]);
    expect(api.unregistered).toEqual([old]);
    expect(cached.getService(hapNodeJs.Service.Thermostat)).toBeDefined();
    expect(api.updated).toEqual([]);
  });

  it('renames the cached accessory when the name in the settings changes', () => {
    const plugin = platform({ platform: PLATFORM_NAME, host: '127.0.0.1', port: thermostat.port, name: 'Termostato' });
    const cached = new FakePlatformAccessory('Smarther', hapNodeJs.uuid.generate(`${PLUGIN_NAME}:thermostat`), 9);
    plugin.configureAccessory(cached as never);
    api.emit('didFinishLaunching');
    expect(cached.displayName).toBe('Termostato');
    expect(api.updated).toEqual([cached]);
    const thermostatService = cached.getService(hapNodeJs.Service.Thermostat);
    expect(thermostatService?.getCharacteristic(hapNodeJs.Characteristic.ConfiguredName).value).toBe('Termostato');
  });

  const thermostatUuid = () => hapNodeJs.uuid.generate(`${PLUGIN_NAME}:thermostat`);
  const noResponse = (accessory: FakePlatformAccessory) =>
    accessory
      .getService(hapNodeJs.Service.Thermostat)
      ?.getCharacteristic(hapNodeJs.Characteristic.TargetTemperature)
      .handleGetRequest();

  it('waits quietly until it is configured', () => {
    platform({ platform: PLATFORM_NAME });
    api.emit('didFinishLaunching');
    expect(logger.lines).toEqual(['INFO not configured yet: enter the thermostat address in the plugin settings']);
    expect(api.registered).toEqual([]);
  });

  it('keeps its accessory with invalid settings, showing "No response"', async () => {
    platform({ platform: PLATFORM_NAME, host: '127.0.0.1', port: thermostat.port });
    api.emit('didFinishLaunching');
    const accessory = api.registered[0] as FakePlatformAccessory;
    api.emit('shutdown');
    api.removeAllListeners();

    const plugin = platform({ platform: PLATFORM_NAME, host: 'not a host' });
    const stale = new FakePlatformAccessory('Old', hapNodeJs.uuid.generate('x'), 9);
    plugin.configureAccessory(accessory as never);
    plugin.configureAccessory(stale as never);
    api.emit('didFinishLaunching');
    expect(logger.lines.join('\n')).toMatch(/ERROR invalid settings/);
    expect(api.unregistered).toEqual([stale]);
    expect(accessory.UUID).toBe(thermostatUuid());
    await expect(noResponse(accessory)).rejects.toBe(-70402);
    const boost = accessory.getServiceById(hapNodeJs.Service.Switch, 'boost-30');
    await expect(boost?.getCharacteristic(hapNodeJs.Characteristic.On).handleSetRequest(true)).rejects.toBe(-70402);
  });

  it('logs settings it cannot read instead of throwing', () => {
    const config = { platform: PLATFORM_NAME };
    Object.defineProperty(config, 'host', {
      enumerable: true,
      get: () => {
        throw new Error('broken config');
      },
    });
    expect(() => platform(config)).not.toThrow();
    expect(logger.lines.join('\n')).toMatch(/ERROR could not read the settings, the plugin is not started: broken config/);
  });

  it('logs a failed start instead of throwing, and shows "No response"', async () => {
    const file = join(storage, 'not-a-directory');
    writeFileSync(file, '');
    api = new FakeApi(file);
    const plugin = platform({ platform: PLATFORM_NAME, host: '127.0.0.1', port: thermostat.port });
    const cached = new FakePlatformAccessory('Smarther', thermostatUuid(), 9);
    plugin.configureAccessory(cached as never);
    expect(() => api.emit('didFinishLaunching')).not.toThrow();
    expect(logger.lines.join('\n')).toMatch(/ERROR the plugin could not start/);
    await expect(noResponse(cached)).rejects.toBe(-70402);
    expect(thermostat.readySessions).toBe(0);
  });
});
