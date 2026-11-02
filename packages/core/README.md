# @much-smarther/core

TypeScript client for the local XOpen v3 protocol of the BTicino Smarther **X8000** thermostat. It has no Homebridge dependency and no runtime dependencies besides Node.js (22, 24 or 26).

The protocol itself is described in [docs/PROTOCOL.md](https://github.com/iu5gal/much-smarther-bridge/blob/main/docs/PROTOCOL.md); section numbers below (§) refer to it.

> **Partly verified on a real device.** Authentication, reading the state, events, keep-alive, the program list, diagnostics and device files have been checked against a real X8000, and so has every `SET` this library builds (manual, timed manual, boost, off, timed off, back to the program). Heating only: cooling has not been tried. Points marked **[PA]** or **[ASM]** in PROTOCOL.md may still turn out wrong.

## Quick start

```ts
import { XOpenClient } from '@much-smarther/core';

const client = new XOpenClient({
  host: '192.0.2.10',  // the thermostat's LAN address
  password: pswOpen,    // string or Secret; never logged
  logger: myLogger,     // optional; every line is redacted
});

client.on('state', (state) => console.log(state.mode, state.setpoint, state.ambientTemperature));
client.on('authenticationFailed', (error) => console.error(error.message));
client.start();

// Later, once client.status === 'ready':
await client.setDeviceState({ mode: 'MANUAL', function: 'HEATING', setpoint: 21.5 });
await client.setDeviceState({ mode: 'BOOST', function: 'HEATING', minutes: 60 });
await client.setDeviceState({ mode: 'AUTOMATIC', function: 'HEATING' });

client.stop();
```

## `XOpenClient`

One instance per thermostat. `start()` opens the connection and keeps it alive until `stop()`.

### Options

| Option | Default | Meaning |
| --- | --- | --- |
| `host` | required | Thermostat address. |
| `port` | `40000` | TCP port (§1). |
| `password` | required | The PswOpen, as a `string` or a `Secret`. |
| `logger` | silent | `{ debug, info, warn, error }(message)`. Every line goes through `redact()` first (see "Security"). |
| `connectTimeoutMs` | 6000 | TCP connection timeout. |
| `handshakeTimeoutMs` | 10000 | Time allowed from TCP connect to authenticated session. |
| `commandTimeoutMs` | 10000 | Time allowed for each answer. A timeout **drops the session** (see "Commands"). |
| `keepAliveIntervalMs` | 10000 | Interval between keep-alives (§7). |
| `busyRetryDelayMs` | 1000 | Wait before the single retry of a command the thermostat rejects as busy. |
| `minCommandIntervalMs` | 250 | Minimum gap between two commands on the wire. |
| `maxQueuedCommands` | 16 | Commands waiting beyond this are rejected immediately. |
| `reconnectBaseDelayMs` | 2000 | First reconnection delay; doubles on each failure. |
| `reconnectMaxDelayMs` | 60000 | Upper bound for the delay. |
| `createSocket`, `randomBytes`, `now` | Node defaults | Test hooks. |

### Status and events

`client.status` is one of:

| Status | Meaning |
| --- | --- |
| `stopped` | Initial status, and after `stop()`. |
| `connecting` | TCP connection and handshake in progress. |
| `ready` | Authenticated; commands are accepted. |
| `waiting` | Disconnected, waiting before the next attempt. |

Events (typed `EventEmitter`):

| Event | Payload | When |
| --- | --- | --- |
| `status` | `ClientStatus` | Every status change. |
| `ready` | none | After each successful authentication. The client then reads the state by itself. |
| `state` | `ThermostatState` | Every state report: the answer to a read, or a pushed event (§6). |
| `disconnected` | `Error` | A session ended for any reason other than `stop()`. |
| `authenticationFailed` | `AuthenticationError` | The password was rejected, or the thermostat could not prove it knows it. Also followed by `disconnected`. |

`client.state` holds the last `ThermostatState`, or `undefined` before the first report.

### Commands

| Method | Sends | Resolves with |
| --- | --- | --- |
| `refreshState()` | `GET device_state` | the new `ThermostatState` (also emitted as `state`) |
| `setDeviceState(request)` | `SET device_state` (§5.1) | nothing; the new state arrives as a `state` event |
| `getProgramList()` | `GET device_program_number_list` | one `ProgramSlot` per slot (`number`, `present`, `changedAt?`), sorted |
| `getDiagnostic()` | `GET device_diagnostic` (§5.2) | `{ value: DeviceDiagnostic, issues }`: versions, model, sensor health |
| `getConfiguration()` | `GET device_file` for `device_configuration.xml` (§5.2) | `{ value: DeviceConfiguration, issues }`: temperature levels, protection temperatures, hysteresis, calibration, panel settings |
| `getProgram(number)` | `GET device_file` for `device_program_profile_N.xml`, `N` 0–10 | `{ value: ProgramProfile, issues }`: name, type and time slots of each day |
| `readDeviceFile(name)` | `GET device_file` | `{ text, sha256sum?, checksum }` for the two kinds of file above only; `checksum` is `match`, `mismatch` or `absent` |

There is no generic "send": these methods and the keep-alive are the only messages the client can produce.

The file parsers read a fixed list of fields and leave everything else out. The configuration file also holds the Wi-Fi network name and password and data about the installation: none of it is ever read, logged or returned. `getProgram()` rejects a file whose `sha256sum` does not match. `getConfiguration()` does not check it: the device rewrites that file itself and keeps an older checksum (§5.2), so each value is validated instead, and temperatures are rounded to 0.1 °C. `readDeviceFile` returns the whole text with the result of that check; use the parsed methods instead unless the raw text is really needed, and never log or store it. Values outside the ranges the BTicino app allows (for example a heating protection temperature outside 3–18 °C) are reported in `issues` and left out.

Behaviour that every command shares:

- **Not ready.** If the client is not `ready`, the command is rejected at once with `NotConnectedError`. It is not kept for later, so callers (for example HomeKit) can report "no response" quickly.
- **One at a time.** Commands are queued and sent one at a time, at least `minCommandIntervalMs` apart. A command is sent only after the previous one has been answered. This is also what makes answers without a `SeqID` safe to match (§5).
- **Rejection.** A `NackMsg` answer rejects the command with `CommandRejectedError`, whose `code` holds the `Code` of the answer if there was one (`NACK_REASONS` lists the known ones). The session stays open.
- **Busy.** A `NackMsg` with code 486 ("interface busy") is retried once, after `busyRetryDelayMs`; a second 486 rejects the command.
- **Timeout.** No answer within `commandTimeoutMs` rejects the command with `TimeoutError` and **drops the session**. A late answer without a `SeqID` could otherwise be matched to the next command. The client then reconnects.
- **Lost connection.** If the connection is lost, the command in flight and every queued one are rejected with the reason.

`DeviceStateRequest` is one of:

```ts
{ mode: 'AUTOMATIC', function, programNumber? }   // 0 (system program) to 10; default: the current one
{ mode: 'MANUAL',    function, setpoint, until? } // 7–40 °C, steps of 0.1
{ mode: 'BOOST',     function, minutes }          // 30 | 60 | 90
{ mode: 'PROTECTION', function, until? }          // the app's "Off"; sent with setpoint 7, as the app does
{ mode: 'OFF',        function }
// function: 'HEATING' | 'COOLING'
// until: a Date after now and at most 10 days ahead; without it the mode lasts until changed
```

A boost, and a `MANUAL` or `PROTECTION` with `until`, are sent with a validity window that starts now. The device returns to `AUTOMATIC` by itself when the window ends (§6.1). The window is written in the thermostat's local time, using the UTC offset of its last report (`utcOffsetMinutes`). If that is unknown, or the thermostat says its clock is not valid, the client uses the local time of this machine and logs a warning.

Requests are validated by `validateDeviceStateRequest()` before they are queued, and again by the message builder. Unknown fields, wrong types and out-of-range values throw `ValidationError`, and nothing is sent.

### Keep-alive and reconnection

- **Keep-alive.** While `ready`, the client sends `GET device_keep_alive` every `keepAliveIntervalMs`, unless a command is already queued or in flight (that traffic proves liveness anyway). Any answer, even a `NackMsg`, proves the thermostat is alive. Only a missing answer drops the session, through `commandTimeoutMs`.
- **Backoff.** After a disconnection the client waits `min(max, base × 2^attempt)`, reduced by a random 0–25 %, then reconnects and authenticates again. The attempt counter resets when a session becomes `ready`.
- **Wrong password.** After an `AuthenticationError` the client waits the maximum delay. A wrong password will not fix itself, and retrying fast could look like an attack to the device.

### `ThermostatState`

Parsed strictly from the `device_state` parameters (§6). A field is present only if the thermostat sent a valid value.

| Field | From | Type |
| --- | --- | --- |
| `function` | `function` | `'HEATING' \| 'COOLING'` |
| `mode` | `mode` | `'AUTOMATIC' \| 'MANUAL' \| 'BOOST' \| 'PROTECTION' \| 'OFF'` |
| `setpoint` | `setpoint` | number, °C |
| `programNumber` | `program_number` | integer 0–10 |
| `ambientTemperature` | `ambient_temperature_value` | number, °C; left out when `ambientTemperatureValid` is `false` |
| `ambientTemperatureValid` | `is_ambient_temperature_valid` | boolean |
| `measuredTemperature` | `measured_temperature` | number, °C; not sent by the observed device |
| `humidity` | `ambient_relative_humidity_value` | number, %; left out when `humidityValid` is `false` |
| `humidityValid` | `is_ambient_relative_humidity_valid` | boolean |
| `heatingActive`, `coolingActive` | `*_thermoregulation_load_state` | boolean (`ACTIVE`/`ON`/`TRUE`/`1` or `INACTIVE`/`OFF`/`FALSE`/`0`) |
| `validity` | `use/init/end_date_and_time_validity` | `{ start?, end? }` local time, only when in use |
| `boostMinutes` | `boostTime`, or the length of the validity window | `30 \| 60 \| 90` |
| `deviceClockValid` | `is_device_date_and_time_valid` | boolean |
| `timestamp` | `timestamp` | string |
| `utcOffsetMinutes` | the offset at the end of `timestamp` | integer minutes, for example `60` for `+01:00` |
| `raw` | every parameter | `ReadonlyMap<string, string>` |

Further details:

- **Merging.** Reports are merged at parameter level: a parameter missing from an event keeps its previous value. This assumes events may be partial **[ASM]**.
- **Invalid values.** These are left out of the state and logged as warnings.
- **Personal data in `raw`.** `raw` also holds parameters that are not mapped, including `ip`. Do not log or display it as a whole.

## Weekly program

Pure functions on a `ProgramProfile` (from `getProgram()`), following the BTicino app (§6.1):

- `activePreset(program, now, { utcOffsetMinutes })`: the preset in force now.
- `nextLevelChange(program, now, { utcOffsetMinutes, levels })`: `{ at, preset, temperature? }` for the next slot with a **different** preset, which is what the app proposes as the end of a manual change, or `undefined` when the program never changes level ("forever"). A day without slots keeps the preset of the day before; the search wraps around the week.
- `levelTemperature(levels, preset)`: the temperature of a preset in the levels of `getConfiguration()`.

Times are the thermostat's wall clock: pass the `utcOffsetMinutes` of the state, and format the result with the same offset (`formatLocalDateTime`) to get the exact slot time.

## Retrieving the PswOpen (optional)

```ts
import { retrievePswOpen } from '@much-smarther/core/cloud';

const gateways = await retrievePswOpen(email, accountPassword);
// [{ plantName, gatewayId, description, macAddress, pswOpen: Secret }]
```

It is a separate entry point because it is optional and uses an **unofficial** cloud endpoint (§8). Entering the PswOpen by hand must always remain possible.

- **What it sends.** Two HTTPS requests to the BTicino cloud. TLS verification is Node's default and is never relaxed, and redirects are refused.
- **Credentials.** They are used for those two requests only. The library does not store them.
- **Errors.** They are `CloudError` and carry only the HTTP status, never response bodies, credentials or the session token. `reason` says why, for a translated message: `credentials` (401, 403, 432), `locked` (434, with `retryAfterMinutes` when the cloud gives it), `password-expired` (209), `contract-expired` (211), `unreachable`, or `failed`.
- **Locked account.** After a `locked` error, do not offer an immediate retry: repeated attempts are what locks the account.
- **Response handling.** The response is limited to 1 MiB and parsed defensively. Passwords with unexpected characters are skipped.
- **Personal data.** The result contains personal data (installation names, MAC addresses). Treat it like the PswOpen.

## Security

- **XML.** XML is parsed by a small strict parser (`parseXml`):
  - no DTDs, entity declarations, external entities, comments, CDATA or processing instructions, with one exception: CDATA as the text of a `file_data` element, kept verbatim;
  - only the five predefined entities and numeric references;
  - limits on document size (64 KiB), depth, element count and attribute count.

  Fuzz tests check that arbitrary input only ever raises `XmlError`.
- **Framing.** Any byte that does not belong to a known frame drops the session (`FramingError`), as does a frame over 64 KiB.
- **Message validation.** Every field of every message is checked against a pattern: service type, `SeqID`, `Progress`, address, `ActionID`, parameter names and value lengths.
- **Passwords.** The PswOpen is kept in a `Secret`, whose `toString`, `toJSON` and `inspect` all print `[redacted]`.
- **Log redaction.** The logger wrapper removes:
  - the PswOpen value itself;
  - the content of every file the thermostat sends (`file_data` elements and CDATA sections);
  - the values of `Random`, `Digest`, `PswOpen`, `pwd`, `password` and `auth_token`, in XML, JSON or header form.

  Tests check that a full session, including a failed login, logs none of them.
- **Outside our control.** The handshake does not protect the session afterwards, and a captured handshake allows offline guessing of the PswOpen (§4.3).

## Lower-level API

The building blocks are exported for tests and tools:

- `Framer`: splits a byte stream into frames.
- `decodeDocument` and `encodeMessage`: XML ↔ `XOpenMessage`.
- `flattenParams`: merges the `Params` of a message.
- The `build*` functions: every message the client sends.
- `bytesToDecimalText`, `decimalTextToHex`, `clientDigest`, `serverDigest`, `digestsEqual`: the handshake (§4).
- `parseDeviceState`: the state parser.
- `Secret`, `redact`, `redactingLogger`.

## Simulator

`@much-smarther/simulator` (`FakeThermostat`) implements the same protocol subset on a local port for integration tests:
- handshake, `device_state` read and write, push events, keep-alive, the program list, diagnostics and the configuration and program files (synthetic, with fake personal values in `FAKE_PERSONAL_VALUES` so tests can prove they never leak);
- what was observed on the real device: grouped parameters, setpoints with five decimals, an `AckMsg` after every data response, "Off" as `PROTECTION` at the protection temperature, boosts without `boostTime`, and optionally duplicate events; `expireWindow()` ends a boost or timed mode as if its time had run out;
- `NackMsg` answers with a `Code`: 430 for a `SET` with unknown parameters or invalid values, 404 for an unknown command;
- switches for faulty behaviour: no `SeqID` on `SET` answers, ignored or rejected keep-alives, slow answers, a wrong server digest, rejected or busy (486) `SET`s, a silent device, dropped connections and raw garbage.

It shows that the client follows PROTOCOL.md. Agreement with the real device comes from the observations behind it, and from the sanitized device messages in `test/fixtures/x8000/`.

## Development

```sh
npm test                 # unit, property-based and integration tests
npm run test:coverage    # with the 80 % threshold for this package
npm run check            # everything, including lint, secrets scan and audit
```

The audit fails on any advisory in the packages the plugin ships with. For development tools (ESLint, Vitest and their dependencies) it fails on high and critical advisories only: they run on the developer's machine, against this repository's own files.
