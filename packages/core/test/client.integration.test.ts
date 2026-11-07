import net from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FAKE_PERSONAL_VALUES, FakeThermostat } from '@much-smarther/simulator';
import {
  AuthenticationError,
  CommandRejectedError,
  FramingError,
  NotConnectedError,
  ProtocolError,
  TimeoutError,
  ValidationError,
  XOpenClient,
  type DeviceStateRequest,
  type Logger,
  type ThermostatState,
  type XOpenClientOptions,
} from '../src/index.js';

const PASSWORD = 'fake-pin-7777';

const FAST: Partial<XOpenClientOptions> = {
  connectTimeoutMs: 500,
  handshakeTimeoutMs: 300,
  commandTimeoutMs: 300,
  keepAliveIntervalMs: 60_000,
  reconnectBaseDelayMs: 20,
  reconnectMaxDelayMs: 80,
  minCommandIntervalMs: 0,
};

async function waitFor(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

class CapturingLogger implements Logger {
  readonly lines: string[] = [];
  debug = (message: string) => this.lines.push(message);
  info = (message: string) => this.lines.push(message);
  warn = (message: string) => this.lines.push(message);
  error = (message: string) => this.lines.push(message);
}

describe('XOpenClient against the simulator', () => {
  let thermostat: FakeThermostat;
  let client: XOpenClient | undefined;
  let logger: CapturingLogger;
  let disconnects: Error[];
  let states: ThermostatState[];

  const connect = async (options: Partial<XOpenClientOptions> = {}, waitReady = true) => {
    client = new XOpenClient({
      host: '127.0.0.1',
      password: PASSWORD,
      logger,
      ...FAST,
      ...options,
      port: options.port ?? thermostat.port,
    });
    client.on('disconnected', (reason) => disconnects.push(reason));
    client.on('state', (state) => states.push(state));
    client.start();
    if (waitReady) await waitFor(() => client?.status === 'ready' && states.length > 0);
    return client;
  };

  beforeEach(async () => {
    thermostat = new FakeThermostat({ password: PASSWORD });
    await thermostat.start();
    logger = new CapturingLogger();
    disconnects = [];
    states = [];
  });

  afterEach(async () => {
    client?.stop();
    client = undefined;
    await thermostat.stop();
  });

  it('authenticates and reads the initial state', async () => {
    const c = await connect();
    expect(c.state).toMatchObject({ mode: 'AUTOMATIC', function: 'HEATING', setpoint: 20, humidity: 48 });
    expect(thermostat.commands).toEqual(['device_state']);
  });

  it('changes the setpoint and receives the resulting event', async () => {
    const c = await connect();
    await c.setDeviceState({ mode: 'MANUAL', function: 'HEATING', setpoint: 21.5 });
    await waitFor(() => c.state?.mode === 'MANUAL');
    expect(c.state?.setpoint).toBe(21.5);
    expect(thermostat.params.get('setpoint')).toBe('21.50000');
  });

  it('starts a boost', async () => {
    const c = await connect({ now: () => new Date(2026, 0, 1, 12, 0, 0) });
    await c.setDeviceState({ mode: 'BOOST', function: 'HEATING', minutes: 60 });
    await waitFor(() => c.state?.mode === 'BOOST');
    expect(c.state).toMatchObject({
      boostMinutes: 60,
      validity: { start: '2026-01-01T12:00:00', end: '2026-01-01T13:00:00' },
    });
  });

  it('sets a timed manual that the device reports with its window', async () => {
    const c = await connect({ now: () => new Date(2026, 0, 1, 12, 0, 0) });
    await c.setDeviceState({ mode: 'MANUAL', function: 'HEATING', setpoint: 21, until: new Date(2026, 0, 2, 7, 30, 0) });
    await waitFor(() => c.state?.mode === 'MANUAL');
    expect(c.state).toMatchObject({ setpoint: 21, validity: { start: '2026-01-01T12:00:00', end: '2026-01-02T07:30:00' } });
  });

  it('writes time windows in the thermostat zone, not in the local one', async () => {
    await thermostat.stop();
    thermostat = new FakeThermostat({ password: PASSWORD, utcOffsetMinutes: 330 });
    await thermostat.start();
    const c = await connect({ now: () => new Date(Date.UTC(2026, 0, 1, 12, 0, 0)) });
    expect(c.state?.utcOffsetMinutes).toBe(330);
    await c.setDeviceState({ mode: 'BOOST', function: 'HEATING', minutes: 30 });
    await waitFor(() => c.state?.mode === 'BOOST');
    expect(c.state?.validity).toEqual({ start: '2026-01-01T17:30:00', end: '2026-01-01T18:00:00' });
    expect(logger.lines.filter((line) => line.includes('clock unknown'))).toEqual([]);
  });

  it('falls back to the local zone when the thermostat clock is not valid', async () => {
    await thermostat.stop();
    thermostat = new FakeThermostat({
      password: PASSWORD,
      utcOffsetMinutes: 330,
      params: { is_device_date_and_time_valid: 'FALSE' },
    });
    await thermostat.start();
    const now = new Date(2026, 0, 1, 12, 0, 0);
    const c = await connect({ now: () => now });
    await c.setDeviceState({ mode: 'BOOST', function: 'HEATING', minutes: 30 });
    await waitFor(() => c.state?.mode === 'BOOST');
    expect(c.state?.validity?.start).toBe('2026-01-01T12:00:00');
    expect(logger.lines.some((line) => line.includes('clock unknown'))).toBe(true);
  });

  it('returns to the current program unless another one is chosen', async () => {
    await thermostat.stop();
    thermostat = new FakeThermostat({ password: PASSWORD, params: { program_number: '3' } });
    await thermostat.start();
    const c = await connect();
    await c.setDeviceState({ mode: 'MANUAL', function: 'HEATING', setpoint: 21 });
    await c.setDeviceState({ mode: 'AUTOMATIC', function: 'HEATING' });
    expect(thermostat.lastSet?.get('program_number')).toBe('3');
    await c.setDeviceState({ mode: 'AUTOMATIC', function: 'HEATING', programNumber: 2 });
    expect(thermostat.lastSet?.get('program_number')).toBe('2');
  });

  it('matches SET answers that come without a SeqID', async () => {
    thermostat.behaviour.omitSeqIdOnSet = true;
    const c = await connect();
    await expect(c.setDeviceState({ mode: 'OFF', function: 'HEATING' })).resolves.toBeUndefined();
  });

  it('reports a rejected command with its code', async () => {
    thermostat.behaviour.rejectSet = true;
    const c = await connect();
    const error = await c.setDeviceState({ mode: 'OFF', function: 'HEATING' }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(CommandRejectedError);
    expect(error).toMatchObject({ code: 430, message: expect.stringContaining('invalid parameters') as string });
    expect(c.status).toBe('ready');
  });

  it('retries a command once when the thermostat is busy', async () => {
    const c = await connect({ busyRetryDelayMs: 10 });
    thermostat.behaviour.busySets = 1;
    await c.setDeviceState({ mode: 'MANUAL', function: 'HEATING', setpoint: 21 });
    await waitFor(() => c.state?.mode === 'MANUAL');
    expect(thermostat.commands.filter((command) => command === 'device_state')).toHaveLength(3);

    thermostat.behaviour.busySets = 2;
    await expect(c.setDeviceState({ mode: 'AUTOMATIC', function: 'HEATING' })).rejects.toMatchObject({ code: 486 });
    expect(c.status).toBe('ready');
  });

  it('validates requests before sending anything', async () => {
    const c = await connect();
    const bad = { mode: 'MANUAL', function: 'HEATING', setpoint: 41 } as DeviceStateRequest;
    await expect(c.setDeviceState(bad)).rejects.toBeInstanceOf(ValidationError);
    expect(thermostat.commands).toEqual(['device_state']);
  });

  it('follows changes made on the device', async () => {
    const c = await connect();
    thermostat.update({ ambient_temperature_value: '23.0', heating_thermoregulation_load_state: 'INACTIVE' });
    await waitFor(() => c.state?.ambientTemperature === 23);
    expect(c.state?.heatingActive).toBe(false);
  });

  it('drops a measurement as soon as the thermostat flags it as not valid', async () => {
    const c = await connect();
    expect(c.state).toMatchObject({ ambientTemperature: 19.5, humidity: 48 });
    thermostat.update({ is_ambient_temperature_valid: 'FALSE', is_ambient_relative_humidity_valid: 'FALSE' });
    await waitFor(() => c.state?.ambientTemperatureValid === false);
    expect(c.state?.ambientTemperature).toBeUndefined();
    expect(c.state?.humidity).toBeUndefined();
    thermostat.update({ is_ambient_temperature_valid: 'TRUE' });
    await waitFor(() => c.state?.ambientTemperature === 19.5);
  });

  it('serialises concurrent commands in order', async () => {
    thermostat.behaviour.responseDelayMs = 20;
    const c = await connect({ minCommandIntervalMs: 10 });
    await Promise.all([
      c.setDeviceState({ mode: 'MANUAL', function: 'HEATING', setpoint: 21 }),
      c.setDeviceState({ mode: 'MANUAL', function: 'HEATING', setpoint: 22 }),
      c.refreshState(),
    ]);
    expect(thermostat.commands).toEqual(['device_state', 'device_state', 'device_state', 'device_state']);
    expect(c.state?.setpoint).toBe(22);
  });

  it('limits the number of queued commands', async () => {
    thermostat.behaviour.responseDelayMs = 50;
    const c = await connect({ maxQueuedCommands: 2 });
    const results = await Promise.allSettled(Array.from({ length: 5 }, () => c.refreshState()));
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(2);
  });

  it('reads the program list', async () => {
    const c = await connect();
    const programs = await c.getProgramList();
    expect(programs).toHaveLength(11);
    expect(programs.filter((slot) => slot.present).map((slot) => slot.number)).toEqual([0, 1, 2, 3]);
    expect(programs[1]).toEqual({ number: 1, present: true, changedAt: '2026-01-01T08:00:00+01:00' });
  });

  it('reads the diagnostics', async () => {
    const c = await connect();
    const { value, issues } = await c.getDiagnostic();
    expect(issues).toEqual([]);
    expect(value).toMatchObject({ applicationFirmwareVersion: '1.2.3', model: 'X0000', humidityAndTemperatureSensorWorking: true });
  });

  it('reads the configuration without ever exposing or logging its personal fields', async () => {
    await thermostat.stop();
    thermostat = new FakeThermostat({ password: PASSWORD, protectionTemperature: 8 });
    await thermostat.start();
    const c = await connect();
    const configuration = await c.getConfiguration();
    expect(configuration.value.heating).toMatchObject({ protection: 8, day: 19.8 });
    await c.refreshState();

    const exposed = JSON.stringify(configuration) + logger.lines.join('\n');
    expect(logger.lines.some((line) => line.includes('device_file'))).toBe(true);
    for (const personal of Object.values(FAKE_PERSONAL_VALUES)) expect(exposed).not.toContain(personal);
  });

  it('reads the programs, also an empty slot, and refuses other files', async () => {
    const c = await connect();
    const program = await c.getProgram(1);
    expect(program.value).toMatchObject({ number: 1, name: 'Program 1', type: 'WEEKLY' });
    expect(program.value.days.sunday).toHaveLength(3);
    await expect(c.getProgram(7)).resolves.toMatchObject({ value: { number: 7, valid: false } });
    await expect(c.getProgram(11)).rejects.toBeInstanceOf(ValidationError);
    await expect(c.readDeviceFile('firmware_descriptor.txt')).rejects.toBeInstanceOf(ValidationError);
    await expect(c.readDeviceFile('device_program_profile_2.xml')).resolves.toMatchObject({
      checksum: 'match',
      sha256sum: expect.stringMatching(/^[0-9a-f]{64}$/) as string,
    });
    expect(thermostat.commands.filter((command) => command === 'device_file')).toHaveLength(3);
  });

  it('reads the configuration despite its stale checksum, but rejects a program that does not match', async () => {
    const c = await connect();
    await expect(c.readDeviceFile('device_configuration.xml')).resolves.toMatchObject({ checksum: 'mismatch' });
    await expect(c.getConfiguration()).resolves.toMatchObject({ value: { heating: { day: 19.8 } } });
    await expect(c.getProgram(1)).resolves.toMatchObject({ value: { number: 1 } });

    thermostat.behaviour.badFileChecksum = true;
    await expect(c.getProgram(1)).rejects.toThrow(/checksum/);
    await expect(c.getProgram(1)).rejects.toBeInstanceOf(ProtocolError);
    expect(c.status).toBe('ready');
  });

  it('copes with the trailing AckMsg and duplicate events of the real device', async () => {
    await thermostat.stop();
    thermostat = new FakeThermostat({ password: PASSWORD, behaviour: { duplicateEvents: true } });
    await thermostat.start();
    const c = await connect();
    await c.refreshState();
    await c.getProgramList();
    await c.setDeviceState({ mode: 'MANUAL', function: 'HEATING', setpoint: 20.7 });
    await waitFor(() => c.state?.setpoint === 20.7);
    await c.refreshState();
    expect(c.state).toMatchObject({ mode: 'MANUAL', setpoint: 20.7, heatingActive: true });
    expect(logger.lines.filter((line) => line.startsWith('state:'))).toEqual([]);
    expect(disconnects).toEqual([]);
  });

  it('reports Off as PROTECTION at the protection temperature, and a timed window ending', async () => {
    await thermostat.stop();
    thermostat = new FakeThermostat({ password: PASSWORD, protectionTemperature: 10 });
    await thermostat.start();
    const c = await connect();
    await c.setDeviceState({ mode: 'PROTECTION', function: 'HEATING' });
    await waitFor(() => c.state?.mode === 'PROTECTION');
    expect(thermostat.lastSet?.get('setpoint')).toBe('7.00000');
    expect(c.state).toMatchObject({ setpoint: 10, heatingActive: false });

    await c.setDeviceState({ mode: 'AUTOMATIC', function: 'HEATING' });
    await waitFor(() => c.state?.mode === 'AUTOMATIC');
    await c.setDeviceState({ mode: 'BOOST', function: 'HEATING', minutes: 30 });
    await waitFor(() => c.state?.mode === 'BOOST');
    expect(c.state).toMatchObject({ setpoint: 20, heatingActive: true });
    expect(c.state?.raw.has('boostTime')).toBe(false);
    expect(c.state?.boostMinutes).toBe(30);
    expect(c.state?.validity?.end).toBeDefined();

    thermostat.expireWindow();
    await waitFor(() => c.state?.mode === 'AUTOMATIC');
    expect(c.state).toMatchObject({ setpoint: 20 });
    expect(c.state?.validity).toBeUndefined();
  });

  it('rejects commands while not connected', async () => {
    const c = new XOpenClient({ host: '127.0.0.1', port: thermostat.port, password: PASSWORD });
    await expect(c.refreshState()).rejects.toBeInstanceOf(NotConnectedError);
  });

  it('fails authentication with a wrong password and keeps retrying slowly', async () => {
    const failures: AuthenticationError[] = [];
    const c = await connect({ password: 'wrong-pin-0000' }, false);
    c.on('authenticationFailed', (error) => failures.push(error));
    await waitFor(() => failures.length >= 2);
    expect(c.state).toBeUndefined();
    expect(disconnects[0]).toBeInstanceOf(AuthenticationError);
    expect(thermostat.authAttempts).toBeGreaterThanOrEqual(2);
  });

  it('rejects a thermostat that cannot prove it knows the password', async () => {
    thermostat.behaviour.badServerDigest = true;
    await connect({}, false);
    await waitFor(() => disconnects.length > 0);
    expect(disconnects[0]).toBeInstanceOf(AuthenticationError);
    expect(thermostat.readySessions).toBe(0);
  });

  it('gives up on a silent thermostat', async () => {
    thermostat.behaviour.silent = true;
    await connect({}, false);
    await waitFor(() => disconnects.length > 0);
    expect(disconnects[0]).toBeInstanceOf(TimeoutError);
  });

  it('reconnects when the thermostat drops the connection', async () => {
    const c = await connect();
    thermostat.dropConnections();
    await waitFor(() => disconnects.length > 0);
    await waitFor(() => c.status === 'ready' && thermostat.readySessions === 1);
    expect(disconnects[0]).toBeInstanceOf(NotConnectedError);
  });

  it('reconnects after the thermostat restarts on the same port', async () => {
    const c = await connect();
    const port = thermostat.port;
    await thermostat.stop();
    await waitFor(() => c.status === 'waiting' || c.status === 'connecting');
    thermostat = new FakeThermostat({ password: PASSWORD });
    await thermostat.start(port);
    await waitFor(() => c.status === 'ready', 3_000);
  });

  it('drops the session when a command gets no answer', async () => {
    thermostat.behaviour.ignoreKeepAlive = true;
    const c = await connect({ keepAliveIntervalMs: 50 });
    await waitFor(() => disconnects.length > 0);
    expect(disconnects[0]).toBeInstanceOf(TimeoutError);
    await waitFor(() => c.status === 'ready');
  });

  it('keeps the session when keep-alives are answered with NackMsg', async () => {
    thermostat.behaviour.rejectKeepAlive = true;
    const c = await connect({ keepAliveIntervalMs: 20 });
    await waitFor(() => thermostat.commands.filter((command) => command === 'device_keep_alive').length >= 4);
    expect(disconnects).toEqual([]);
    expect(c.status).toBe('ready');
  });

  it('tolerates slow answers within the timeout', async () => {
    thermostat.behaviour.responseDelayMs = 100;
    const c = await connect();
    await expect(c.refreshState()).resolves.toMatchObject({ mode: 'AUTOMATIC' });
    expect(disconnects).toEqual([]);
  });

  it('drops the session on garbage from the thermostat', async () => {
    const c = await connect();
    thermostat.sendRaw('garbage');
    await waitFor(() => disconnects.length > 0);
    expect(disconnects[0]).toBeInstanceOf(FramingError);
    await waitFor(() => c.status === 'ready');
  });

  it('ignores events it does not know and legacy messages', async () => {
    const c = await connect();
    thermostat.sendRaw('<?xml version="1.0"?><OWNxml><Hdr/></OWNxml>');
    thermostat.sendRaw(
      '<OWNMsg Profile="V3"><Payload><Service TYPE="EVT"/><ActionID>other_event</ActionID></Payload></OWNMsg>',
    );
    thermostat.update({ setpoint: '19.0' });
    await waitFor(() => c.state?.setpoint === 19);
    expect(disconnects).toEqual([]);
  });

  it('retries when nothing listens on the port', async () => {
    const port = thermostat.port;
    await thermostat.stop();
    const c = await connect({ port }, false);
    await waitFor(() => disconnects.length >= 2);
    expect(c.status).not.toBe('ready');
  });

  it('times out a connection that never completes', async () => {
    const socket = new net.Socket();
    await connect({ createSocket: () => socket, connectTimeoutMs: 30 }, false);
    await waitFor(() => disconnects.length > 0);
    expect(disconnects[0]?.message).toMatch(/connection timed out/);
  });

  it('stops cleanly and does not reconnect', async () => {
    const c = await connect();
    c.stop();
    expect(c.status).toBe('stopped');
    await waitFor(() => thermostat.readySessions === 0);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(thermostat.readySessions).toBe(0);
    await expect(c.refreshState()).rejects.toBeInstanceOf(NotConnectedError);
  });

  it('is refused while another session is open, without disturbing it', async () => {
    const first = await connect();
    const second = new XOpenClient({ host: '127.0.0.1', port: thermostat.port, password: PASSWORD, ...FAST });
    const secondDisconnects: Error[] = [];
    second.on('disconnected', (reason) => secondDisconnects.push(reason));
    second.start();
    await waitFor(() => secondDisconnects.length >= 2);
    expect(secondDisconnects[0]).toBeInstanceOf(NotConnectedError);
    expect(thermostat.refusedConnections).toBeGreaterThanOrEqual(2);
    expect(first.status).toBe('ready');
    expect(disconnects).toEqual([]);

    first.stop();
    await waitFor(() => second.status === 'ready', 3_000);
    second.stop();
  });

  it('never logs the password or handshake material', async () => {
    const c = await connect();
    await c.setDeviceState({ mode: 'MANUAL', function: 'HEATING', setpoint: 21 });
    thermostat.dropConnections();
    await waitFor(() => c.status === 'ready' && disconnects.length > 0);
    c.stop(); // the device keeps one session: make room for the wrong password
    await waitFor(() => thermostat.readySessions === 0);
    const wrong = new XOpenClient({ host: '127.0.0.1', port: thermostat.port, password: PASSWORD + 'x', logger, ...FAST });
    wrong.start();
    await waitFor(() => wrong.status === 'waiting');
    wrong.stop();

    const log = logger.lines.join('\n');
    expect(log).toContain('ClientHandshakeHMAC');
    expect(log).not.toContain(PASSWORD);
    expect(log).not.toMatch(/(Random|Digest)="(?!\[redacted\])/);
  });
});
