import { createHash, randomBytes, randomUUID } from 'node:crypto';
import net from 'node:net';
import {
  BOOST_MINUTES,
  bytesToDecimalText,
  clientDigest,
  decodeDocument,
  digestsEqual,
  encodeMessage,
  escapeXml,
  flattenParams,
  Framer,
  FUNCTIONS,
  isValidSetpoint,
  MODES,
  Secret,
  serverDigest,
  type OutgoingMessage,
  type XOpenMessage,
} from '@much-smarther/core';

/**
 * A fake X8000 implementing the protocol subset of docs/PROTOCOL.md, for
 * integration tests. It follows our understanding of the protocol, so it
 * cannot prove that understanding right: only the real device can.
 *
 * Where the real device has been observed (PROTOCOL.md, [OBS]) the fake
 * copies it: grouped parameters, setpoints padded to five decimals, a
 * trailing `AckMsg` after every data response, "Off" as `PROTECTION` at the
 * protection temperature, no `boostTime` in reports, and a single local
 * session at a time.
 */

export interface FakeThermostatBehaviour {
  /** Answer `SET` commands without a SeqID, as the device reportedly does. */
  omitSeqIdOnSet?: boolean;
  /** Never answer keep-alives. */
  ignoreKeepAlive?: boolean;
  /** Answer keep-alives with `NackMsg`. */
  rejectKeepAlive?: boolean;
  /** Delay before every answer once authenticated. */
  responseDelayMs?: number;
  /** Send a wrong digest in `ServerHandshakeHMAC`. */
  badServerDigest?: boolean;
  /** Accept the TCP connection but never send anything. */
  silent?: boolean;
  /** Answer every `SET` with `NackMsg` code 430. */
  rejectSet?: boolean;
  /** Answer this many next `SET`s with `NackMsg` code 486 (busy). */
  busySets?: number;
  /** Send every state event twice, as the real device usually does. */
  duplicateEvents?: boolean;
  /** Send program files with a wrong `sha256sum` too (the configuration always has one). */
  badFileChecksum?: boolean;
  /** Accept a second connection while one is open; the real device closes it at once. */
  allowSeveralSessions?: boolean;
}

export interface FakeThermostatOptions {
  readonly password: string;
  readonly params?: Readonly<Record<string, string>>;
  readonly behaviour?: FakeThermostatBehaviour;
  /** Heating protection temperature, used as the setpoint of `PROTECTION`. Default 7. */
  readonly protectionTemperature?: number;
  /** Slots of the program list that hold a program. Default 0–3. */
  readonly programs?: readonly number[];
  /** UTC offset of the fake device's clock, in minutes. Default: this machine's. */
  readonly utcOffsetMinutes?: number;
}

/** Synthetic state, in the order and format the real device uses. */
export const DEFAULT_PARAMS: Readonly<Record<string, string>> = {
  use_date_and_time_validity: 'FALSE',
  setpoint: '20.00000',
  temperature_format: 'CELSIUS',
  function: 'HEATING',
  mode: 'AUTOMATIC',
  program_number: '1',
  is_ambient_temperature_valid: 'TRUE',
  ambient_temperature_value: '19.5',
  is_ambient_relative_humidity_valid: 'TRUE',
  ambient_relative_humidity_value: '48.0',
  is_external_temperature_from_sensor_valid: 'FALSE',
  is_external_temperature_from_remote_valid: 'FALSE',
  is_device_date_and_time_valid: 'TRUE',
  is_ipv4_valid: 'TRUE',
  ip: '192.0.2.10',
  heating_thermoregulation_load_state: 'ACTIVE',
  cooling_thermoregulation_load_state: 'INACTIVE',
};

/** Parameters the device sends together in one `Params` element. */
const PARAM_GROUPS: readonly (readonly string[])[] = [
  ['use_date_and_time_validity', 'end_date_and_time_validity', 'init_date_and_time_validity'],
  ['is_ambient_temperature_valid', 'ambient_temperature_value'],
  ['is_ambient_relative_humidity_valid', 'ambient_relative_humidity_value'],
  ['is_device_date_and_time_valid', 'timestamp'],
  ['is_ipv4_valid', 'ip'],
];
const PROGRAM_SLOTS = 11;
/** Parameters a `SET device_state` may carry; anything else is refused with 430. */
const SET_PARAMS: ReadonlySet<string> = new Set([
  'temperature_format',
  'function',
  'mode',
  'use_date_and_time_validity',
  'init_date_and_time_validity',
  'end_date_and_time_validity',
  'setpoint',
  'program_number',
]);
const NACK_INVALID_PARAMETERS = '430';
const NACK_BUSY = '486';
const NACK_UNKNOWN = '404';

/**
 * Personal values in the synthetic configuration. They are fake, but they
 * stand for the Wi-Fi credentials, installation and router data of a real
 * file, so tests check that none of them ever leaves the client.
 */
export const FAKE_PERSONAL_VALUES = {
  ssid: 'example-network',
  wifiPassword: 'fake-wifi-password',
  plantId: '00000000042',
  friendlyName: 'Example thermostat',
  routerMac: '00:00:5E:00:53:FF',
  latitude: '45.000001',
  longitude: '9.000001',
} as const;

/** A temperature as the device writes it in its configuration: six decimals, float artefacts included. */
function deviceDecimal(value: number): string {
  return Math.fround(value).toFixed(6);
}

/**
 * A synthetic `device_configuration.xml`, shaped like the observed one
 * (PROTOCOL.md §5.2), values with six decimals as the device writes them.
 */
export function syntheticConfiguration(protectionTemperature = 7): string {
  const p = FAKE_PERSONAL_VALUES;
  return (
    '<configuration><filename>device_configuration.xml</filename>' +
    '<firmware_version_of_last_saving>1.2.3</firmware_version_of_last_saving>' +
    `<plant_id>${p.plantId}</plant_id>` +
    `<network><wlan><ssid>${p.ssid}</ssid><password>${p.wifiPassword}</password><user_id /></wlan>` +
    '<network_frequency>FREQUENCY_2_4_GHZ</network_frequency></network>' +
    '<time_zone><time_zone_identifier>Etc/UTC</time_zone_identifier><utc_offset>00:00</utc_offset></time_zone>' +
    `<geolocation><latitude>${p.latitude}</latitude><longitude>${p.longitude}</longitude>` +
    '<geolocation_enable>OFF</geolocation_enable></geolocation>' +
    '<heating_and_cooling>' +
    `<heating_day_temperature>${deviceDecimal(19.8)}</heating_day_temperature>` +
    `<heating_night_temperature>${deviceDecimal(18)}</heating_night_temperature>` +
    `<heating_away_temperature>${deviceDecimal(16)}</heating_away_temperature>` +
    `<heating_protection_temperature>${deviceDecimal(protectionTemperature)}</heating_protection_temperature>` +
    `<heating_regulation_band>${deviceDecimal(0.1)}</heating_regulation_band>` +
    `<cooling_day_temperature>${deviceDecimal(24)}</cooling_day_temperature>` +
    `<cooling_night_temperature>${deviceDecimal(26)}</cooling_night_temperature>` +
    `<cooling_away_temperature>${deviceDecimal(28)}</cooling_away_temperature>` +
    `<cooling_protection_temperature>${deviceDecimal(35)}</cooling_protection_temperature>` +
    `<cooling_regulation_band>${deviceDecimal(0.1)}</cooling_regulation_band>` +
    '</heating_and_cooling>' +
    `<friendly_name>${p.friendlyName}</friendly_name>` +
    `<router_mac_address>${p.routerMac}</router_mac_address>` +
    `<ambient_temperature_calibration>${deviceDecimal(-0.8)}</ambient_temperature_calibration>` +
    `<external_sensor_temperature_calibration>${deviceDecimal(0)}</external_sensor_temperature_calibration>` +
    '<temperature_format>CELSIUS</temperature_format><date_format>DD_MM_YYYY</date_format>' +
    '<stand_by_brightness>STAND_BY_BRIGHTNESS_AUTOMATIC_WITH_OFF</stand_by_brightness>' +
    '<buzzer_enable>OFF</buzzer_enable><haptic_enable>OFF</haptic_enable>' +
    '<key_user_interface_enable>ON</key_user_interface_enable>' +
    '<local_user_settings_enable>ON</local_user_settings_enable>' +
    '</configuration>'
  );
}

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'] as const;

/** A synthetic program file: slot 0 holds "day" all day, the others a working-day pattern. */
export function syntheticProgram(number: number): string {
  const slots =
    number === 0
      ? '<slot id="0" preset="DAY" time="00:00" />'
      : '<slot id="0" preset="NIGHT" time="00:00" /><slot id="1" preset="DAY" time="06:30" />' +
        '<slot id="2" preset="NIGHT" time="22:30" />';
  return (
    '<program_profile>' +
    `<filename>device_program_profile_${number}.xml</filename>` +
    '<program_description><is_program_profile_valid>TRUE</is_program_profile_valid>' +
    `<number>${number}</number><name>Program ${number}</name><type>${number === 0 ? 'DAILY' : 'WEEKLY'}</type>` +
    '<is_creation_date_valid>TRUE</is_creation_date_valid><creation_date>2026-01-01T08:00:00</creation_date>' +
    '</program_description><weekday>' +
    WEEKDAYS.map((day) => `<${day}>${slots}</${day}>`).join('') +
    '</weekday></program_profile>'
  );
}

/** Synthetic diagnostics. */
export const DIAGNOSTIC_PARAMS: readonly Readonly<Record<string, string>>[] = [
  { application_firmware_version: '1.2.3' },
  { recovery_firmware_version: '1.0.0' },
  { hardware_version: 'HW-1' },
  { device_brand: 'Example' },
  { device_model_object: 'X0000' },
  { device_type: 'THERMOSTAT' },
  { is_firmware_update_available: 'FALSE' },
  { is_recovery_firmware_running_now: 'FALSE' },
  { is_capacitive_sensor_working: 'TRUE' },
  { is_humidity_and_temperature_sensor_working: 'TRUE' },
  { is_device_date_and_time_valid: 'TRUE' },
  { is_external_temperature_from_sensor_valid: 'FALSE' },
];

/** Not the real value (0): a non-zero one proves the client copies it. */
const HANDSHAKE_PROGRESS = 7;

interface Session {
  readonly socket: net.Socket;
  step: 'negotiate' | 'handshake' | 'ack' | 'ready';
  seqId: string;
  challenge: string;
  response: string;
}

export class FakeThermostat {
  readonly behaviour: FakeThermostatBehaviour;
  /** ActionIDs of the commands received from authenticated clients. */
  readonly commands: string[] = [];
  /** Number of `ClientHandshakeHMAC` messages received. */
  authAttempts = 0;
  /** Connections closed at once because another session was open. */
  refusedConnections = 0;
  /** Parameters of the last `SET device_state` received, accepted or not. */
  lastSet: ReadonlyMap<string, string> | undefined;
  /** Parameters of every `SET device_state` received, in order. */
  readonly sets: ReadonlyMap<string, string>[] = [];

  readonly #password: Secret;
  readonly #params: Map<string, string>;
  readonly #protectionSetpoint: string;
  readonly #programs: ReadonlySet<number>;
  readonly #utcOffsetMinutes: number | undefined;
  /** Setpoint of the current program slot, restored on return to `AUTOMATIC`. */
  #programSetpoint: string;
  readonly #sessions = new Set<Session>();
  readonly #server = net.createServer((socket) => this.#accept(socket));

  constructor(options: FakeThermostatOptions) {
    this.#password = new Secret(options.password);
    this.#params = new Map(Object.entries({ ...DEFAULT_PARAMS, ...options.params }));
    this.#programSetpoint = this.#params.get('setpoint') ?? DEFAULT_PARAMS['setpoint'] ?? '';
    this.#protectionSetpoint = (options.protectionTemperature ?? 7).toFixed(5);
    this.#programs = new Set(options.programs ?? [0, 1, 2, 3]);
    this.#utcOffsetMinutes = options.utcOffsetMinutes;
    this.behaviour = { ...options.behaviour };
  }

  /** Listens on 127.0.0.1 and resolves with the port. */
  start(port = 0): Promise<number> {
    return new Promise((resolve, reject) => {
      this.#server.once('error', reject);
      this.#server.listen(port, '127.0.0.1', () => resolve(this.port));
    });
  }

  get port(): number {
    const address = this.#server.address();
    if (address === null || typeof address === 'string') throw new Error('not listening');
    return address.port;
  }

  get params(): ReadonlyMap<string, string> {
    return this.#params;
  }

  /** Authenticated sessions currently open. */
  get readySessions(): number {
    return [...this.#sessions].filter((session) => session.step === 'ready').length;
  }

  stop(): Promise<void> {
    this.dropConnections();
    return new Promise((resolve) => this.#server.close(() => resolve()));
  }

  dropConnections(): void {
    for (const session of this.#sessions) session.socket.destroy();
    this.#sessions.clear();
  }

  /** Changes the state as if done on the panel, and pushes an event. */
  update(params: Readonly<Record<string, string>>): void {
    for (const [key, value] of Object.entries(params)) this.#params.set(key, value);
    this.#broadcastState();
  }

  /**
   * Ends the current time window (boost, timed manual or timed off) as if its
   * end time had passed: the device returns to the program.
   */
  expireWindow(): void {
    if (this.#params.get('use_date_and_time_validity') !== 'TRUE') return;
    this.#params.set('mode', 'AUTOMATIC');
    this.#params.set('setpoint', this.#programSetpoint);
    this.#setValidity('FALSE', '', '');
    this.#updateLoad();
    this.#broadcastState();
  }

  /** Sends raw bytes to every client, for protocol-violation tests. */
  sendRaw(data: string): void {
    for (const session of this.#sessions) session.socket.write(data);
  }

  #accept(socket: net.Socket): void {
    // The device keeps one local session: a further connection is closed at once.
    if (this.#sessions.size > 0 && !this.behaviour.allowSeveralSessions) {
      this.refusedConnections++;
      socket.destroy();
      return;
    }
    const session: Session = { socket, step: 'negotiate', seqId: '', challenge: '', response: '' };
    this.#sessions.add(session);
    socket.on('close', () => this.#sessions.delete(session));
    socket.on('error', () => socket.destroy());
    if (this.behaviour.silent) return;

    const framer = new Framer();
    socket.on('data', (chunk: Buffer) => {
      try {
        for (const frame of framer.push(chunk)) {
          if (frame.kind !== 'xml') continue;
          const document = decodeDocument(frame.text);
          if (document.kind === 'v3') this.#handle(session, document.message);
        }
      } catch {
        socket.destroy();
      }
    });
    socket.write('*#*1##');
  }

  #handle(session: Session, message: XOpenMessage): void {
    const params = flattenParams(message);
    switch (session.step) {
      case 'negotiate': {
        if (message.actionId !== 'OWNSetProtocol' || params.get('Version') !== '3') {
          session.socket.destroy();
          return;
        }
        session.seqId = randomUUID();
        session.challenge = bytesToDecimalText(randomBytes(32));
        session.step = 'handshake';
        this.#send(session, this.#handshake('SET', session.seqId, 'RandomStringHMAC', { Random: session.challenge }));
        return;
      }
      case 'handshake': {
        this.authAttempts++;
        const response = params.get('Random') ?? '';
        const digest = params.get('Digest') ?? '';
        const valid =
          message.actionId === 'ClientHandshakeHMAC' &&
          message.seqId === session.seqId &&
          message.progress === HANDSHAKE_PROGRESS + 1 &&
          safeDigestCheck(() => digestsEqual(clientDigest(this.#password, session.challenge, response), digest));
        if (!valid) {
          this.#send(session, this.#handshake('RSP', session.seqId, 'NackMsg'));
          session.socket.end();
          return;
        }
        session.response = response;
        session.step = 'ack';
        const proof = this.behaviour.badServerDigest
          ? '00'.repeat(64)
          : serverDigest(this.#password, session.challenge, response);
        this.#send(session, this.#handshake('SET', session.seqId, 'ServerHandshakeHMAC', { Digest: proof }));
        return;
      }
      case 'ack': {
        const ok =
          message.actionId === 'AckMsg' && message.seqId === session.seqId && message.progress === HANDSHAKE_PROGRESS;
        if (ok) session.step = 'ready';
        else session.socket.destroy();
        return;
      }
      case 'ready':
        this.commands.push(message.actionId);
        this.#later(() => this.#command(session, message, params));
        return;
    }
  }

  #command(session: Session, message: XOpenMessage, params: ReadonlyMap<string, string>): void {
    const seqId = message.seqId ?? '';
    const key = `${message.service} ${message.actionId}`;
    switch (key) {
      case 'GET device_state':
        this.#send(session, this.#stateMessage('RSP', seqId));
        this.#send(session, this.#reply(seqId, 'AckMsg'));
        return;
      case 'GET device_keep_alive':
        if (this.behaviour.ignoreKeepAlive) return;
        this.#send(session, this.behaviour.rejectKeepAlive ? this.#nack(seqId, NACK_UNKNOWN) : this.#reply(seqId, 'AckMsg'));
        return;
      case 'GET device_program_number_list':
        this.#send(session, this.#reply(seqId, 'device_program_number_list', this.#programList()));
        this.#send(session, this.#reply(seqId, 'AckMsg'));
        return;
      case 'GET device_diagnostic':
        this.#send(session, this.#reply(seqId, 'device_diagnostic', DIAGNOSTIC_PARAMS.map((group) => ({ ...group }))));
        this.#send(session, this.#reply(seqId, 'AckMsg'));
        return;
      case 'GET device_file': {
        const text = this.#file(params.get('file_name') ?? '');
        if (text === undefined) {
          this.#send(session, this.#nack(seqId, NACK_INVALID_PARAMETERS));
          return;
        }
        // The device rewrites its configuration but keeps an older checksum.
        const name = params.get('file_name') ?? '';
        const stale = this.behaviour.badFileChecksum || name === 'device_configuration.xml';
        this.#sendText(session, fileMessage(seqId, name, text, stale));
        this.#send(session, this.#reply(seqId, 'AckMsg'));
        return;
      }
      case 'SET device_state': {
        this.lastSet = params;
        this.sets.push(params);
        const replySeqId = this.behaviour.omitSeqIdOnSet ? '' : seqId;
        if ((this.behaviour.busySets ?? 0) > 0) {
          this.behaviour.busySets = (this.behaviour.busySets ?? 0) - 1;
          this.#send(session, this.#nack(replySeqId, NACK_BUSY));
          return;
        }
        const accepted = !this.behaviour.rejectSet && this.#applySet(message, params);
        this.#send(session, accepted ? this.#reply(replySeqId, 'AckMsg') : this.#nack(replySeqId, NACK_INVALID_PARAMETERS));
        if (accepted) this.#broadcastState();
        return;
      }
      default:
        this.#send(session, this.#nack(seqId, NACK_UNKNOWN));
    }
  }

  #applySet(message: XOpenMessage, params: ReadonlyMap<string, string>): boolean {
    if (message.params.some((group) => [...group.keys()].some((key) => !SET_PARAMS.has(key)))) return false;
    const mode = params.get('mode') ?? '';
    const fn = params.get('function') ?? '';
    if (!(MODES as readonly string[]).includes(mode) || !(FUNCTIONS as readonly string[]).includes(fn)) return false;
    const update: Record<string, string> = { mode, function: fn };
    switch (mode) {
      case 'MANUAL': {
        const setpoint = Number(params.get('setpoint') ?? '');
        if (!isValidSetpoint(setpoint)) return false;
        update['setpoint'] = setpoint.toFixed(5);
        break;
      }
      case 'BOOST': {
        // The duration travels only as the validity window, never as boostTime.
        if (params.get('use_date_and_time_validity') !== 'TRUE') return false;
        const start = Date.parse(params.get('init_date_and_time_validity') ?? '');
        const end = Date.parse(params.get('end_date_and_time_validity') ?? '');
        if (!BOOST_MINUTES.some((minutes) => minutes * 60_000 === end - start)) return false;
        break;
      }
      case 'PROTECTION':
        // The 7 °C sent with it is ignored: the device holds its own protection temperature.
        update['setpoint'] = this.#protectionSetpoint;
        break;
      case 'AUTOMATIC':
        update['setpoint'] = this.#programSetpoint;
        break;
    }
    const programNumber = params.get('program_number');
    if (programNumber !== undefined) update['program_number'] = programNumber;
    for (const [name, value] of Object.entries(update)) this.#params.set(name, value);
    const inUse = params.get('use_date_and_time_validity') === 'TRUE';
    this.#setValidity(
      inUse ? 'TRUE' : 'FALSE',
      inUse ? (params.get('init_date_and_time_validity') ?? '') : '',
      inUse ? (params.get('end_date_and_time_validity') ?? '') : '',
    );
    this.#updateLoad();
    return true;
  }

  #setValidity(inUse: 'TRUE' | 'FALSE', start: string, end: string): void {
    this.#params.set('use_date_and_time_validity', inUse);
    if (inUse === 'TRUE') {
      this.#params.set('end_date_and_time_validity', end);
      this.#params.set('init_date_and_time_validity', start);
    } else {
      // The device drops both times when no window is in use.
      this.#params.delete('end_date_and_time_validity');
      this.#params.delete('init_date_and_time_validity');
    }
  }

  /** Drives the load as the device does: always during a boost, else by setpoint. */
  #updateLoad(): void {
    const mode = this.#params.get('mode');
    const setpoint = Number(this.#params.get('setpoint'));
    const ambient = Number(this.#params.get('ambient_temperature_value'));
    const heating = this.#params.get('function') === 'HEATING';
    const demand = mode === 'BOOST' || (mode !== 'OFF' && (heating ? setpoint > ambient : setpoint < ambient));
    this.#params.set('heating_thermoregulation_load_state', heating && demand ? 'ACTIVE' : 'INACTIVE');
    this.#params.set('cooling_thermoregulation_load_state', !heating && demand ? 'ACTIVE' : 'INACTIVE');
  }

  #file(name: string): string | undefined {
    if (name === 'device_configuration.xml') return syntheticConfiguration(Number(this.#protectionSetpoint));
    const match = /^device_program_profile_([0-9]|10)\.xml$/.exec(name);
    const number = Number(match?.[1]);
    return match && this.#programs.has(number) ? syntheticProgram(number) : undefined;
  }

  #programList(): Record<string, string>[] {
    return Array.from({ length: PROGRAM_SLOTS }, (_, slot) =>
      this.#programs.has(slot)
        ? { [`program_${slot}_present`]: 'TRUE', timestamp: slot === 0 ? '' : '2026-01-01T08:00:00+01:00' }
        : { [`program_${slot}_present`]: 'FALSE' },
    );
  }

  #broadcastState(): void {
    const copies = this.behaviour.duplicateEvents ? 2 : 1;
    for (const session of this.#sessions) {
      if (session.step !== 'ready') continue;
      for (let copy = 0; copy < copies; copy++) {
        this.#send(session, this.#stateMessage('EVT', randomUUID().toUpperCase()));
      }
    }
  }

  #stateMessage(service: 'RSP' | 'EVT', seqId: string): OutgoingMessage {
    this.#params.set('timestamp', deviceTimestamp(new Date(), this.#utcOffsetMinutes));
    const params: Record<string, string>[] = [];
    const emitted = new Set<readonly string[]>();
    for (const [key, value] of this.#params) {
      const group = PARAM_GROUPS.find((candidate) => candidate.includes(key));
      if (!group) {
        params.push({ [key]: value });
      } else if (!emitted.has(group)) {
        emitted.add(group);
        const entry: Record<string, string> = {};
        for (const name of group) {
          const member = this.#params.get(name);
          if (member !== undefined) entry[name] = member;
        }
        params.push(entry);
      }
    }
    const progress = service === 'RSP' ? 2 : 0;
    return { style: 'command', service, seqId, progress, actionId: 'device_state', who: '4', params };
  }

  #reply(seqId: string, actionId: string, params?: Record<string, string>[]): OutgoingMessage {
    return { style: 'command', service: 'RSP', seqId, progress: 2, actionId, who: '4', ...(params ? { params } : {}) };
  }

  #nack(seqId: string, code: string): OutgoingMessage {
    return this.#reply(seqId, 'NackMsg', [{ Code: code }]);
  }

  #handshake(service: 'SET' | 'RSP', seqId: string, actionId: string, params?: Record<string, string>): OutgoingMessage {
    return {
      style: 'handshake',
      service,
      seqId,
      progress: HANDSHAKE_PROGRESS,
      actionId,
      ...(params ? { params: [params] } : {}),
    };
  }

  #later(action: () => void): void {
    const delay = this.behaviour.responseDelayMs ?? 0;
    if (delay > 0) setTimeout(action, delay);
    else action();
  }

  #send(session: Session, message: OutgoingMessage): void {
    this.#sendText(session, encodeMessage(message));
  }

  #sendText(session: Session, text: string): void {
    if (!session.socket.destroyed) session.socket.write(text);
  }
}

/**
 * A `device_file` answer as the device sends it: `WHO` 4, the file name with
 * its path on the device, and the file as CDATA in a `Params` without attributes.
 */
function fileMessage(seqId: string, name: string, text: string, badChecksum = false): string {
  const checksum = createHash('sha256')
    .update(badChecksum ? `${text}\n` : text, 'utf8')
    .digest('hex');
  return (
    '<OWNMsg Profile="V3" Version="Official"><Payload><Service TYPE="RSP"/>' +
    `<SeqID ID="${escapeXml(seqId)}" Progress="2"/><Address WHO="4" WHERE=""/><ActionID>device_file</ActionID>` +
    `<ParamList><Params file_name="/micro_fs/${escapeXml(name)}" sha256sum="${checksum}"/>` +
    `<Params><file_data encoded=""><![CDATA[${text}]]></file_data></Params></ParamList></Payload></OWNMsg>`
  );
}

/** Local time with its UTC offset, as in the device's `timestamp`. */
function deviceTimestamp(date: Date, utcOffsetMinutes?: number): string {
  const offset = utcOffsetMinutes ?? -date.getTimezoneOffset();
  const pad = (value: number) => String(Math.trunc(Math.abs(value))).padStart(2, '0');
  const local = new Date(date.getTime() + offset * 60_000).toISOString().slice(0, 19);
  return `${local}${offset < 0 ? '-' : '+'}${pad(offset / 60)}:${pad(offset % 60)}`;
}

function safeDigestCheck(check: () => boolean): boolean {
  try {
    return check();
  } catch {
    return false;
  }
}
