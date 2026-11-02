import * as hapNodeJs from '@homebridge/hap-nodejs';
import type { HAP } from 'homebridge';
import { afterEach, describe, expect, it } from 'vitest';
import { homeKitName, OFFLINE_GRACE_MS, ThermostatAccessory } from '../src/accessory.js';
import type { ThermostatController } from '../src/controller.js';
import { translator } from '../src/i18n.js';
import { TARGET_STATE } from '../src/mapping.js';
import { connected, waitFor } from './helpers.js';

const hap = hapNodeJs as unknown as HAP;
const { Service: S, Characteristic: C } = hapNodeJs;
const NO_RESPONSE = -70402;

function makeAccessory(controller: ThermostatController, options: { now?: () => number; host?: hapNodeJs.Accessory } = {}) {
  const host = options.host ?? new hapNodeJs.Accessory('Smarther', hapNodeJs.uuid.generate('much-smarther-test'));
  new ThermostatAccessory({
    hap,
    host,
    controller,
    translate: translator('it'),
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    serialNumber: 'TEST123',
    ...(options.now ? { now: options.now } : {}),
  });
  return host;
}

const read = (service: hapNodeJs.Service | undefined, type: typeof C.On | typeof C.TargetTemperature) =>
  service?.getCharacteristic(type).handleGetRequest();

describe('ThermostatAccessory', () => {
  let stop: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await stop?.();
    stop = undefined;
  });

  it('creates the services with names in the configured language', async () => {
    const setup = await connected();
    stop = setup.stop;
    const host = makeAccessory(setup.controller);
    expect(host.getService(S.AccessoryInformation)?.getCharacteristic(C.Manufacturer).value).toBe('BTicino');
    expect(host.getService(S.AccessoryInformation)?.getCharacteristic(C.SerialNumber).value).toBe('TEST123');
    expect(host.getService(S.Thermostat)?.getCharacteristic(C.ConfiguredName).value).toBe('Smarther');
    expect(host.getService(S.HumiditySensor)?.getCharacteristic(C.ConfiguredName).value).toBe('Umidità');
    expect(host.getServiceById(S.Switch, 'boost-60')?.getCharacteristic(C.ConfiguredName).value).toBe('Boost 60 min');
    expect(host.getServiceById(S.Switch, 'schedule')).toBeUndefined();
  });

  it('restores the names the Home app replaced with its defaults', async () => {
    const first = await connected();
    const host = makeAccessory(first.controller);
    await first.stop();
    host.getServiceById(S.Switch, 'boost-90')?.setCharacteristic(C.ConfiguredName, 'Switch 2');
    const setup = await connected({ settings: { name: 'Termostato' } });
    stop = setup.stop;
    makeAccessory(setup.controller, { host });
    expect(host.getServiceById(S.Switch, 'boost-90')?.getCharacteristic(C.ConfiguredName).value).toBe('Boost 90 min');
    expect(host.getService(S.Thermostat)?.getCharacteristic(C.ConfiguredName).value).toBe('Termostato');
    expect(host.getService(S.Thermostat)?.getCharacteristic(C.Name).value).toBe('Termostato');
  });

  it('adds the Schedule switch in switch mode and drops services no longer wanted', async () => {
    const auto = await connected();
    const host = makeAccessory(auto.controller);
    await auto.stop();
    const setup = await connected({ settings: { automaticMode: 'switch', humiditySensor: false } });
    stop = setup.stop;
    makeAccessory(setup.controller, { host });
    expect(host.getServiceById(S.Switch, 'schedule')?.getCharacteristic(C.ConfiguredName).value).toBe('Programma');
    expect(host.getService(S.HumiditySensor)).toBeUndefined();
    expect(host.services.filter((service) => service.UUID === S.Thermostat.UUID)).toHaveLength(1);
    expect(host.getService(S.Thermostat)?.getCharacteristic(C.TargetHeatingCoolingState).props.validValues).toEqual([
      TARGET_STATE.OFF,
      TARGET_STATE.HEAT,
    ]);
  });

  it('answers reads from the reported state', async () => {
    const setup = await connected();
    stop = setup.stop;
    const host = makeAccessory(setup.controller);
    const thermostat = host.getService(S.Thermostat);
    await expect(thermostat?.getCharacteristic(C.CurrentTemperature).handleGetRequest()).resolves.toBe(19.5);
    await expect(thermostat?.getCharacteristic(C.TargetTemperature).handleGetRequest()).resolves.toBe(20);
    await expect(thermostat?.getCharacteristic(C.TargetHeatingCoolingState).handleGetRequest()).resolves.toBe(
      TARGET_STATE.AUTO,
    );
    await expect(thermostat?.getCharacteristic(C.CurrentHeatingCoolingState).handleGetRequest()).resolves.toBe(1);
    await expect(thermostat?.getCharacteristic(C.TemperatureDisplayUnits).handleGetRequest()).resolves.toBe(0);
    await expect(
      host.getService(S.HumiditySensor)?.getCharacteristic(C.CurrentRelativeHumidity).handleGetRequest(),
    ).resolves.toBe(48);
    await expect(read(host.getServiceById(S.Switch, 'boost-30'), C.On)).resolves.toBe(false);
    expect(thermostat?.getCharacteristic(C.TargetTemperature).props).toMatchObject({ minValue: 7, maxValue: 40, minStep: 0.1 });
  });

  it('turns Home app changes into commands and follows the events', async () => {
    const setup = await connected();
    stop = setup.stop;
    const host = makeAccessory(setup.controller);
    const thermostat = host.getService(S.Thermostat);
    const target = thermostat?.getCharacteristic(C.TargetHeatingCoolingState);

    await target?.handleSetRequest(TARGET_STATE.OFF);
    await waitFor(() => setup.thermostat.params.get('mode') === 'PROTECTION');
    await waitFor(() => target?.value === TARGET_STATE.OFF);

    await thermostat?.getCharacteristic(C.TargetTemperature).handleSetRequest(21.5);
    await waitFor(() => setup.thermostat.params.get('mode') === 'MANUAL');
    expect(setup.thermostat.params.get('setpoint')).toBe('21.50000');
    await waitFor(() => target?.value === TARGET_STATE.HEAT);

    const boost60 = host.getServiceById(S.Switch, 'boost-60')?.getCharacteristic(C.On);
    await boost60?.handleSetRequest(true);
    await waitFor(() => setup.thermostat.params.get('mode') === 'BOOST');
    await waitFor(() => setup.controller.snapshot.state?.boostMinutes === 60);
    expect(boost60?.value).toBe(true);
    await boost60?.handleSetRequest(false);
    await waitFor(() => setup.thermostat.params.get('mode') === 'AUTOMATIC');
    await waitFor(() => target?.value === TARGET_STATE.AUTO);
  });

  it('offers Cool instead of Heat when the season changes', async () => {
    const setup = await connected();
    stop = setup.stop;
    const host = makeAccessory(setup.controller);
    const target = host.getService(S.Thermostat)?.getCharacteristic(C.TargetHeatingCoolingState);
    expect(target?.props.validValues).toEqual([TARGET_STATE.OFF, TARGET_STATE.HEAT, TARGET_STATE.AUTO]);
    await setup.controller.season('COOLING');
    await waitFor(() => target?.props.validValues?.includes(TARGET_STATE.COOL) === true);
    expect(target?.props.validValues).toEqual([TARGET_STATE.OFF, TARGET_STATE.COOL, TARGET_STATE.AUTO]);
  });

  it('shows "No response" without a password, and after the grace time without a session', async () => {
    const offline = await connected({ start: false });
    offline.controller.start(undefined);
    const lonely = makeAccessory(offline.controller);
    await expect(read(lonely.getService(S.Thermostat), C.TargetTemperature)).rejects.toBe(NO_RESPONSE);
    await expect(
      lonely.getService(S.Thermostat)?.getCharacteristic(C.TargetTemperature).handleSetRequest(21),
    ).rejects.toBe(NO_RESPONSE);
    await offline.stop();

    let now = Date.now();
    const setup = await connected();
    stop = setup.stop;
    const host = makeAccessory(setup.controller, { now: () => now });
    setup.thermostat.behaviour.silent = true;
    setup.thermostat.dropConnections();
    await waitFor(() => setup.controller.snapshot.status !== 'ready');
    await expect(read(host.getService(S.Thermostat), C.TargetTemperature)).resolves.toBe(20);
    now += OFFLINE_GRACE_MS + 1;
    await expect(read(host.getService(S.Thermostat), C.TargetTemperature)).rejects.toBe(NO_RESPONSE);
  });

  it('adds the optional switches the settings ask for, and works them', async () => {
    const setup = await connected({ settings: { programSwitches: [2, 3], offSwitch: true, boostSwitches: [60] } });
    stop = setup.stop;
    const host = makeAccessory(setup.controller);
    expect(host.getServiceById(S.Switch, 'boost-30')).toBeUndefined();
    expect(host.getServiceById(S.Switch, 'boost-60')).toBeDefined();
    expect(host.getServiceById(S.Switch, 'boost-90')).toBeUndefined();
    expect(host.getServiceById(S.Switch, 'program-0')).toBeUndefined();
    expect(host.getServiceById(S.Switch, 'program-1')).toBeUndefined();
    const program2 = host.getServiceById(S.Switch, 'program-2');
    expect(program2?.getCharacteristic(C.ConfiguredName).value).toBe('Program 2');
    expect(host.getServiceById(S.Switch, 'program-3')).toBeDefined();

    await program2?.getCharacteristic(C.On).handleSetRequest(true);
    await waitFor(() => setup.controller.snapshot.state?.programNumber === 2);
    await waitFor(() => program2?.getCharacteristic(C.On).value === true);
    expect(host.getServiceById(S.Switch, 'program-3')?.getCharacteristic(C.On).value).toBe(false);

    const off = host.getServiceById(S.Switch, 'off-next')?.getCharacteristic(C.On);
    expect(host.getServiceById(S.Switch, 'off-next')?.getCharacteristic(C.ConfiguredName).value).toBe(
      'Spento fino al prossimo cambio',
    );
    await off?.handleSetRequest(true);
    await waitFor(() => setup.controller.snapshot.state?.mode === 'PROTECTION');
    expect(setup.controller.snapshot.state?.validity?.end).toBeDefined();
    await waitFor(() => off?.value === true);
    await off?.handleSetRequest(false);
    await waitFor(() => setup.controller.snapshot.state?.mode === 'AUTOMATIC');
  });

  it('removes the optional switches when the settings no longer ask for them', async () => {
    const first = await connected({ settings: { programSwitches: true, offSwitch: true } });
    const host = makeAccessory(first.controller);
    await first.stop();
    expect(host.getServiceById(S.Switch, 'program-1')).toBeDefined();
    const setup = await connected();
    stop = setup.stop;
    makeAccessory(setup.controller, { host });
    expect(host.services.filter((service) => service.subtype?.startsWith('program-'))).toEqual([]);
    expect(host.getServiceById(S.Switch, 'off-next')).toBeUndefined();
    expect(host.getServiceById(S.Switch, 'boost-30')).toBeDefined();
  });

  it('logs an error while following the thermostat instead of throwing it', async () => {
    const setup = await connected();
    stop = setup.stop;
    const lines: string[] = [];
    const host = new hapNodeJs.Accessory('Smarther', hapNodeJs.uuid.generate('much-smarther-test'));
    new ThermostatAccessory({
      hap,
      host,
      controller: setup.controller,
      translate: translator('it'),
      logger: { debug() {}, info() {}, warn() {}, error: (line) => lines.push(line) },
      serialNumber: 'TEST123',
    });
    const thermostat = host.getService(S.Thermostat);
    if (!thermostat) throw new Error('no thermostat service');
    thermostat.updateCharacteristic = () => {
      throw new Error('boom');
    };
    expect(() => setup.controller.emit('change')).not.toThrow();
    expect(lines).toEqual(['could not update the Home app: boom']);
  });

  it.each([
    ['Weekend lungo!', 'Weekend lungo'],
    ["Casa d'estate", "Casa d'estate"],
    ['--- 2 ---', '2'],
    ['***', 'Programma 4'],
  ])('makes %j a Home app name', (text, expected) => {
    expect(homeKitName(text, 'Programma 4')).toBe(expected);
  });
});
