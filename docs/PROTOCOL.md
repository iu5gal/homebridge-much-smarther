# XOpen v3 protocol notes (BTicino Smarther X8000)

This document describes the local protocol spoken by the BTicino Smarther X8000 thermostat, as far as this project understands it. It is written in our own words. The library in `packages/core` is implemented from this document; its API and behaviour are described in [packages/core/README.md](../packages/core/README.md).

## Status and provenance

Every statement below is tagged with where it comes from:

| Tag | Meaning |
| --- | --- |
| **[PA]** | Learned by studying prior art (an existing Home Assistant integration, see the README credits). Not yet observed by us. |
| **[OBS]** | Observed on a real device by this project. |
| **[ASM]** | Our assumption. The library is written to tolerate it being wrong. |

**[OBS]** tags replace **[PA]** and **[ASM]** as observations come in. Observations so far come from one X8000 (first generation).

## 1. Transport

- TCP, port **40000**, on the thermostat's LAN address. **[OBS]**
- No TLS. Integrity of the session relies only on the handshake described in §4. **[PA]**
- The connection is meant to stay open: the thermostat pushes state changes over it (§6). **[PA]**
- **One local session at a time.** While a session is open, the thermostat accepts a further TCP connection and closes it within about 20 ms, before sending anything. The open session is not disturbed, and the refused client can try again later. **[OBS]** (two sessions from the same computer, 2026-10-30). Whether a client from another address is treated the same way is not known, but likely. **[ASM]**
- The BTicino app talks to the thermostat through the BTicino cloud, even on the home network **[OBS]**, and may open a local session when the cloud is not available **[ASM]**. While the bridge is connected, that local session would be refused: without internet, the app cannot control the thermostat, but the bridge (and so Apple Home) still can.

## 2. Framing

The byte stream carries two kinds of frames, back to back, with no length prefix:

1. **OpenWebNet text frames**: ASCII, start with `*` and end with `##`. The thermostat sends `*#*1##` (OpenWebNet "ACK") about 0.5 s after the TCP connection opens, and then nothing more until the client speaks. **[OBS]**
2. **XML documents**: a root element `<OWNMsg …>…</OWNMsg>` (profile V3). **[PA]** An older format with root `<OWNxml>`, optionally preceded by an XML declaration, may also appear. **[PA]** This project does not use it and skips it.

Messages are UTF-8 (in practice ASCII). **[ASM]** A frame ends at the first closing tag of its root element; root elements are never nested. Whitespace between frames is ignored. **[ASM]**

## 3. V3 message format

```xml
<OWNMsg Profile="V3" Version="Official">
  <Payload>
    <Service TYPE="GET" />
    <SeqID ID="5c1e…" Progress="0" Marker="0" IsLast="TRUE" />
    <Address WHO="4" WHERE="" />
    <ActionID>device_state</ActionID>
    <ParamList>
      <Params mode="MANUAL" />
      <Params setpoint="21.5" />
    </ParamList>
  </Payload>
</OWNMsg>
```

(Indentation added for readability. On the wire everything is on one line.)

| Element | Meaning |
| --- | --- |
| `Service/@TYPE` | `GET` (read), `SET` (write), `RSP` (response), `EVT` (unsolicited push event). **[PA]** |
| `SeqID/@ID` | Correlation id chosen by the requester; a response carries the same id. Any string; a UUID works. **[PA]** |
| `SeqID/@Progress` | Step counter inside a multi-step exchange (used by the handshake). **[PA]** |
| `SeqID/@Marker`, `@IsLast` | Sent as `0` and `TRUE` on commands. Presumably for multi-part responses. **[PA]** Meaning **[ASM]**. |
| `Address/@WHO` | OpenWebNet "who": `4` is thermoregulation. **[PA]** |
| `Address/@WHERE` | Empty for the thermostat itself. **[PA]** |
| `ActionID` | The operation, for example `device_state`. **[PA]** |
| `ParamList/Params` | Zero or more `Params` elements. Each carries one or more attributes as key/value pairs. An empty list is sent as a single `<Params />`. **[PA]** |

Further details:

- Commands carry `Version="Official"` on the root; handshake messages do not. **[PA]**
- The thermostat may put an XML namespace on its messages (`http://www.bticino.it/xopen/v1`). Clients should match element names without the namespace. **[PA]**
- Parameter values are plain strings: numbers in decimal with a dot (`21.5`), booleans as `TRUE` / `FALSE`, date-times as local time `YYYY-MM-DDTHH:MM:SS` without a time zone. **[PA]**
- The thermostat pads the setpoint to five decimals (`19.80000`) but sends measurements with one (`20.2`, `78.0`). The report `timestamp` carries a UTC offset (`2026-01-02T18:36:47+01:00`); the validity times do not. **[OBS]**
- Messages from the thermostat always carry `Version="Official"` and write empty elements in the short form (`<Address/>`). **[OBS]**

## 4. Session setup and authentication

The handshake happens right after the TCP connection opens. `sid` is a session id chosen by the client, `p` a progress number chosen by the thermostat.

```
thermostat → client   *#*1##
client → thermostat   SET OWNSetProtocol      SeqID(sid, 0)   Version=3 Command=1 Monitor=1 ConnAlwaysOn=1
thermostat → client   RandomStringHMAC        SeqID(sid', p)  Random=<Ra>
client → thermostat   SET ClientHandshakeHMAC SeqID(sid', p+1) Random=<Rb> Digest=<Dc>
thermostat → client   ServerHandshakeHMAC     Digest=<Ds>       (or NackMsg if Dc is wrong)
client → thermostat   RSP AckMsg              SeqID(sid', p)
```

- The negotiation parameters ask for protocol version 3, permission to send commands (`Command`), to receive events (`Monitor`) and a persistent connection (`ConnAlwaysOn`). Each one is a separate `Params` element. **[PA]**
- `sid'` and `p` are taken from the `RandomStringHMAC` message and reused in the next two client messages. The final `AckMsg` carries `p`, not `p+1`. **[PA]**
- The `Address` element is empty (`<Address></Address>`) in handshake messages. **[PA]**
- The thermostat sends `RandomStringHMAC` and `ServerHandshakeHMAC` with `Service TYPE="SET"`, with its own `sid'` (an uppercase UUID) and `p = 0`, so `ServerHandshakeHMAC` carries `Progress="2"`. **[OBS]** Clients should not rely on these values.
- The whole handshake takes about 0.2 s on the LAN. **[OBS]**
- A wrong password makes the thermostat answer `NackMsg` instead of `ServerHandshakeHMAC`. **[PA]**

### 4.1 Decimal-text encoding

Binary values (`Ra`, `Rb`, digests) travel as **decimal text**. Every byte is split into its two hex nibbles (high first), and every nibble is written as a two-digit decimal number from `00` to `15`. **[PA]**

| Bytes | Hex | Decimal text |
| --- | --- | --- |
| `0xA3 0x0F` | `a30f` | `10030015` |

Decoding reverses this: read the digits in pairs, each pair must be `00`–`15`, and each becomes one hex digit.

### 4.2 Digest computation

Let `H(s)` be SHA-256 of the UTF-8 bytes of the **string** `s`, written as 64 lowercase hex characters. Note that the inputs are hex *text*, not decoded bytes. **[PA]**

- `ra` = `Ra` decoded to lowercase hex text.
- `rb` = 32 random bytes from a CSPRNG, as lowercase hex text; sent as `Rb` in decimal text.
- `kp` = `H(PswOpen)`.
- Two fixed strings: `A = "736F70653E"` and `B = "636F70653E"` (uppercase hex as written; they spell `sope>` and `cope>` in ASCII). **[PA]**

Then:

- Client digest: `Dc = SHA-256(ra + rb + A + B + kp)`, sent in decimal text.
- Expected server digest: `Ds = SHA-256(ra + rb + kp)`, received in decimal text.

The client must check `Ds` before sending the final `AckMsg`. If it does not match, the peer does not know the password and the client must drop the connection.

Despite the message names, this is not HMAC (RFC 2104). It is a plain hash over a concatenation.

### 4.3 Security properties

- The password never travels on the wire, but `Ra`, `Rb` and `Dc` together allow an **offline guessing attack** on the PswOpen by anyone who captures a handshake. Captures must be treated as secret.
- After the handshake nothing is signed or encrypted: a LAN attacker can read and inject messages. This is a property of the device and outside our control.

## 5. Commands

All commands use `WHO="4"`, an empty `WHERE`, a fresh `SeqID` and `Progress="0"`. **[PA]**

| ActionID | Service | Parameters | Response |
| --- | --- | --- | --- |
| `device_state` | `GET` | none | `RSP device_state` with the state (§6) **[PA]** |
| `device_keep_alive` | `GET` | none | `RSP AckMsg` with the same `SeqID`, in about 40 ms. **[OBS]** Any answer, even `NackMsg`, shows that the thermostat is alive. **[ASM]** |
| `device_program_number_list` | `GET` | none | `RSP` with eleven `Params`, one per slot `0`–`10`: `program_N_present="TRUE"` plus a `timestamp` (last change, sometimes empty), or `program_N_present="FALSE"`. No program names. **[OBS]** An empty slot still has a file that can be read (§5.2). **[OBS]** Slot `0` is a system program that the app does not let the user edit or delete; `1`–`10` are the user programs. **[ASM]** |
| `device_state` | `SET` | see §5.1 | `RSP AckMsg` with the same `SeqID`, in about 120 ms, followed by an `EVT device_state` about 50 ms later. **[OBS]** `RSP NackMsg` on refusal **[PA]**; no refusal seen yet. |
| `device_file` | `SET` | see §5.3 | `RSP AckMsg`, in 150–550 ms, followed by an `EVT device_program_number_list`. **[OBS]** |

Responses to `SET` sometimes come **without a `SeqID`** **[PA]**; the observed device always sent it **[OBS]**. A client that keeps only one command in flight can match them unambiguously either way.

A `NackMsg` may carry a `Code` parameter **[ASM]**:

| Code | Meaning |
| --- | --- |
| `400` | malformed message |
| `404` | unknown error |
| `430` | invalid parameters |
| `486` | interface busy: the command can be tried again |

This library reports the code with the error and retries a `486` once, after about a second.

A `GET` that returns data is answered with **two** messages: the `RSP` with the data (`Progress="2"`), then, about 15 ms later, a separate `RSP AckMsg` with the same `SeqID` and an empty `Address`. **[OBS]** The data `RSP` completes the request; the trailing `AckMsg` can be ignored. Because it carries the `SeqID` of the finished request, it cannot be mistaken for the answer to the next one.

### 5.1 `SET device_state`

Parameters, each in its own `Params` element unless noted. **[PA]** This library sends them in the order below **[ASM]**, and only those that apply to the mode.

| Parameter | Values |
| --- | --- |
| `temperature_format` | `CELSIUS` |
| `function` | `HEATING` or `COOLING` |
| `mode` | `AUTOMATIC`, `MANUAL`, `BOOST`, `PROTECTION`, `OFF` |
| validity (one `Params` with three attributes) | `use_date_and_time_validity`, `end_date_and_time_validity`, `init_date_and_time_validity` |
| `setpoint` | `MANUAL`: °C, 7.0–40.0 in steps of 0.1, written with five decimals as the device writes it (`21.50000`). The prior art uses steps of 0.5 **[PA]**; the app sets steps of 0.1, from 7 to 40 °C **[OBS]**. |
| `program_number` | `AUTOMATIC` only: the weekly program to follow, `0`–`10`. This library always sends it, using the current program when the caller does not choose one. **[ASM]** |

There is **no `boostTime` parameter**: the prior art sends one **[PA]**, but the device never reports it, and a boost sent with the validity window only is accepted and reported with the right duration **[OBS]**. This library does not send it.

Every `SET` shape this library builds was accepted by the device on 2026-10-30: `MANUAL` with and without an end time (also on the next day), `BOOST` 30 minutes, `PROTECTION` with and without an end time, and `AUTOMATIC` with `program_number`. **[OBS]**

Validity:

- For `BOOST`: `TRUE`, start = now, end = now + 30, 60 or 90 minutes. **[PA]**
- For `MANUAL` and `PROTECTION` with an end time ("manual until…", "off until…"): `TRUE`, start = now, end = the chosen time. **[OBS]** The app offers end times up to 10 days ahead **[OBS]**; this library allows the same.
- The device replaces the start with **its own clock** at the moment it accepts the command, about a second after the time sent. It keeps the end of a `MANUAL` or `PROTECTION` window exactly as sent, but recomputes the end of a `BOOST` as its own start plus the duration. **[OBS]**
- For every other case: `FALSE` with both times empty, which for `MANUAL` and `PROTECTION` means "until changed". **[PA]**
- The times are in the **thermostat's local time**, because the device compares them with its own clock. **[OBS]** (an end time of 07:00 the next day was reported as 07:00). This library takes the UTC offset from the `timestamp` of the last report (§6). When that is missing, or `is_device_date_and_time_valid` is `FALSE`, it falls back to the local time of the machine it runs on.
- Setting a temperature means switching to `MANUAL` with that setpoint. **[PA]**
- `PROTECTION` is sent with `setpoint` 7, in heating and in cooling alike, as the app does for "Off" **[ASM]**. The device ignores that value and holds its own protection temperature **[OBS]** (§6.1), so the 7 is harmless in cooling too.

### 5.2 Device information and files

The thermostat can also report its diagnostics and hand out some of its files. Checked on the real device in a read-only session on 2026-10-30 **[OBS]**, except where marked.

Observed device: application firmware `1.1.105`, recovery firmware `1.1.62`, hardware version `1`, brand `bticino`, model `0`, device type `FLUSH_MOUNTED`. **[OBS]**

| ActionID | Service | `WHO` | Parameters | Response |
| --- | --- | --- | --- | --- |
| `device_diagnostic` | `GET` | `4` | none | `RSP device_diagnostic`: firmware, recovery firmware and hardware versions, brand, model, device type, and `TRUE`/`FALSE` flags for a firmware update available, recovery firmware running, capacitive sensor working, humidity and temperature sensor working, clock valid, external sensor valid. |
| `device_file` | `GET` | `1004` | `file_name` | `RSP device_file` with the file (below), in one message, then the usual trailing `AckMsg`. The answer carries `WHO="4"`, and `file_name` with the path on the device (`/micro_fs/device_configuration.xml`). |

A file travels in the `ParamList` as a `Params` element with the attributes `file_name` and `sha256sum` (64 lowercase hex characters), followed by a `Params` element **without attributes** that contains `<file_data encoded="">` with the file text in a CDATA section. An empty `encoded` means plain text. This is the only place where this project accepts CDATA.

For the program files, `sha256sum` is the SHA-256 of the UTF-8 file text. **[OBS]** For the configuration file it is **not**: no variant of the text (line ends, encodings, XML declaration, whitespace) matches it. **[OBS]** The text is plain ASCII with LF line ends, and its values have six decimals with float artefacts (`19.799999`, `7.000000`), unlike the five decimals the app writes. So the device rewrites the file itself, and the checksum is probably that of the last version the app wrote. **[ASM]** This project therefore checks the checksum of program files, but not of the configuration file, whose values it validates one by one instead.

Files this project reads (no other name can be requested):

- **`device_configuration.xml`**: root `<configuration>`, about 3 KB. **[OBS]** The fields used here:
  - `heating_and_cooling`: `heating_day_temperature`, `heating_night_temperature`, `heating_away_temperature`, `heating_protection_temperature`, `heating_regulation_band` (hysteresis), and the same five for `cooling_`. Values in °C with six decimals and float artefacts (`19.799999`); this project rounds them to 0.1 °C. The "day" level is the app's "Home". **[OBS]**
  - `ambient_temperature_calibration`, `external_sensor_temperature_calibration` (offsets, °C), `temperature_format`, `stand_by_brightness`, `buzzer_enable`, `haptic_enable`, `key_user_interface_enable`, `local_user_settings_enable` (`ON` / `OFF`), `firmware_version_of_last_saving`.
  - Also present and not used: `physical_quantity_to_display` (what the panel shows, external sensor function), `date_format`, and the groups below. **[OBS]**
  - **Personal data.** The same file holds the **Wi-Fi network name and password**, the installation identifier and name, the router's MAC address, the time zone and geographic coordinates. This project never reads those fields, never logs the file (log lines replace any `file_data` content with `[redacted]`) and never stores it.
- **`device_program_profile_N.xml`**, `N` = `0`–`10`: root `<program_profile>`.
  - `program_description`: `is_program_profile_valid` (`TRUE` / `FALSE`), `number`, `name` (typed by the user), `type` (`DAILY` / `WEEKLY`).
  - `weekday`: one element per day (`monday` … `sunday`), each with `<slot id="…" preset="…" time="HH:MM" />` elements. A slot means "from this time on, use this preset", until the next slot. Presets are `DAY`, `NIGHT`, `AWAY` and `PROTECTION`; their temperatures are the levels of the configuration file. A `DAILY` program still lists all seven days. **[OBS]**
  - Slot `0` on the observed device is a `WEEKLY` program with `PROTECTION` all day, every day, and the name `0`. **[OBS]**
  - An empty slot has a file too, of about 920 bytes: `is_program_profile_valid` `FALSE`, type `WEEKLY`, its number as the name, `is_creation_date_valid` `FALSE` and `PROTECTION` all week. **[OBS]**
  - Every program on the observed device has a slot at `00:00` on every day, and only times in quarter hours. **[OBS]**

### 5.3 Writing programs

Checked on the real device on 2026-11-06, on a slot that was empty and with test programs only **[OBS]**, except where marked.

The message has the same shape as a file in an answer (§5.2), with `WHO="1004"`:

```xml
<Service TYPE="SET" />
<SeqID ID="…" Progress="0" Marker="0" IsLast="TRUE" />
<Address WHO="1004" WHERE="" />
<ActionID>device_file</ActionID>
<ParamList>
  <Params file_name="device_program_profile_5.xml" sha256sum="…" />
  <Params><file_data encoded=""><![CDATA[…the file…]]></file_data></Params>
</ParamList>
```

`sha256sum` is the SHA-256 of the UTF-8 file text, as 64 lowercase hex characters.

- **Answer.** `RSP AckMsg` in about 150–270 ms for a message of up to 2.4 KB, and in about 530–550 ms for one of 4.3 KB, which is sent over several TCP segments. An `EVT device_program_number_list` follows; this project uses it only as a signal, and did not record its parameters. The list then shows the slot as present, with a timestamp.
- **Reading back.** The file comes back byte for byte as it was written, when it follows the layout below.
- **Layout.** LF line ends, tabs for indentation, no XML declaration, and elements in this order: `filename`, then `program_description` with `is_program_profile_valid`, `number`, `name`, `type`, `is_creation_date_valid`, `creation_date`, then `weekday` with the days from `sunday` to `saturday`, each with `<slot id="0" preset="DAY" time="00:00"/>` lines, numbered from `0` every day. The `creation_date` is `YYYY-MM-DDTHH:MM:SS`. `DAILY` is written for programs with the same seven days. The code in `program-file.ts` reproduces every user program of the observed device byte for byte.
- **A name of 64 characters comes back damaged.** The device accepted it, and reported the name with the file path right after it (`…/micro_fs/device_program_profile_10.xml`). So the device seems to build the file from its own fields, one of which has no room for a terminator. **[ASM]** This library allows 32 characters and did not look for the exact limit.
- **Name rule.** New names here have letters, digits and spaces only, as the app seems to allow. **[ASM]** A name on the observed device contains a `/`, so an existing name is accepted unchanged.
- **Other limits of the app**, followed here: times in quarter hours, at least one slot a day, and at most 10 slots a day (8 with `firmware_version_of_last_saving` 1.0.x). **[ASM]** The device accepted 10 slots on every day. **[OBS]**
- **Effect on the state.** Writing a program that is not active changes nothing in the state. Writing the active one during `AUTOMATIC` takes effect at once, with no other command: the first `GET device_state` after the answer already gave the setpoint of the new slot, with mode and program unchanged. During `MANUAL` or `BOOST` this has not been tried.
- **Activating.** `SET device_state` with `AUTOMATIC` and the `program_number` of a newly written slot works, and so does going back to the previous one.
- **Erasing.** The same message, with the word `ERASE` as the file text and its checksum. `RSP AckMsg` in about 210–250 ms, and the same event. The slot file is then byte for byte the original empty one, and the list shows it as not present.
- **With the BTicino app.** A program written over the local session appeared in the app when it was opened again, and left it after being erased. Whether an app left open follows at once is not known.

Not tried, on purpose: a wrong checksum, a malformed file, writing slot `0` or the configuration file, and erasing the active program. This library refuses all of them before sending anything, and does not send a write twice, except once more after a "busy" answer. Since an accepted write can still come back different, it reads every program back and compares it.

## 6. State and events

The thermostat sends `EVT device_state` whenever its state changes, with the same parameters as the `GET device_state` response. **[PA]** Observed **[OBS]**:

- Every report carries the full state, not just the changed fields.
- Changes of mode or setpoint usually produce **two identical events** about 60 ms apart, each with its own `SeqID`. Consumers must be idempotent.
- Events also arrive for changes of humidity, temperature and load state alone, every few minutes, so polling is not needed to stay current.
- No event was lost or reordered during a 50-minute session.

Known parameters (**[PA]** unless noted):

| Parameter | Meaning |
| --- | --- |
| `function` | `HEATING` / `COOLING` |
| `mode` | `AUTOMATIC`, `MANUAL`, `BOOST`, `PROTECTION`, `OFF` |
| `setpoint` | current target, °C. In `AUTOMATIC` it is the target of the current program slot, and it has a resolution of 0.1 °C (`19.80000`). It stays unchanged during `BOOST`. **[OBS]** |
| `program_number` | active weekly program, `0`–`10` |
| `temperature_format` | `CELSIUS` |
| `ambient_temperature_value` | measured room temperature, °C |
| `is_ambient_temperature_valid`, `is_ambient_relative_humidity_valid` | `TRUE` / `FALSE`, sent in the same `Params` as the value they qualify. **[OBS]** With `FALSE` the value is not a measurement, and this library ignores it. **[ASM]** |
| `is_external_temperature_from_sensor_valid`, `is_external_temperature_from_remote_valid` | `FALSE` on a thermostat without external probes; the matching value fields are then absent. **[OBS]** |
| `measured_temperature` | not sent by the observed device. **[OBS]** |
| `ambient_relative_humidity_value` | relative humidity, % |
| `heating_thermoregulation_load_state`, `cooling_thermoregulation_load_state` | whether the boiler / cooler is being driven: `ACTIVE` / `INACTIVE`. **[OBS]** |
| `use_date_and_time_validity`, `init_date_and_time_validity`, `end_date_and_time_validity` | time window of the current mode, in one `Params`. `FALSE` in `AUTOMATIC`. `TRUE` in `BOOST` and also in `MANUAL`. **[OBS]** |
| `boostTime` | not sent in reports: the boost duration shows only as the validity window. **[OBS]** |
| `is_device_date_and_time_valid` | whether the thermostat clock is set |
| `timestamp` | thermostat time of the report, with its UTC offset (`2026-01-02T18:36:47+01:00`). **[OBS]** The offset tells the thermostat's time zone, used for validity windows (§5.1). |
| `is_ipv4_valid`, `ip` | thermostat address, in one `Params`. Personal data: strip it from captures. **[OBS]** |

Unknown parameters may appear and must be ignored, not rejected.

Writing or erasing a program also produces an `EVT device_program_number_list` (§5.3). **[OBS]** Whether changes made from the app produce it too has not been checked yet.

### 6.1 Observed transitions

From one session on 2026-10-28, with changes made from outside the bridge while it was connected. **[OBS]**

- **Coexistence.** The BTicino app kept working while the bridge held its session, and the bridge received the changes made from the app and from the panel. The app needs internet for commands, so it probably goes through the cloud rather than a second local session. **[ASM]**
- **Thermostat without internet (session of 2026-10-30).** With internet blocked for the thermostat on the router and the phone online on the home Wi-Fi, a boost started from the app reached the thermostat. The bridge session stayed up (no disconnection) and received the events as usual. The app did not show the new state until internet was restored; after that it updated and could cancel the boost. **[OBS]** Since the thermostat keeps one local session at a time (§1), and the bridge held it, the app's command must have come through the cloud: the thermostat's cloud connection probably outlived the block for a while. **[ASM]**
- **Temperature change during `AUTOMATIC`, from the app.** The app's manual screen starts from the room temperature (20.2 °C), not from the program setpoint (19.8 °C), and one +0.5 step gave a setpoint of 20.7 °C. So the device accepts setpoints off the 0.5 grid. The mode becomes `MANUAL` with a validity window. The load turns `ACTIVE` at once when the new setpoint is above the room temperature.
- **End time proposed by the app's manual screen (session of 2026-10-30).** The app fills in the end day and time by itself, and the user may keep or change them. It proposes the **next change of level** in the active program, not the next slot boundary: on a Friday evening in a `NIGHT` slot, with the next slot at midnight (`NIGHT` again) and `DAY` from 06:15 on Saturday, it proposed "tomorrow, 06:15", and the window it sent ended at `06:15:00`. **[OBS]** Without any change of level in the program, it proposes "forever". **[ASM]** The app's "Off" screen fills in its end in the same way. **[ASM]**
- **Back to `AUTOMATIC`.** The validity goes back to `FALSE`, the setpoint to the program value, and the load follows within about a second.
- **"Off" from the app (session of 2026-10-29).** The app's "Spegni Smarther" sets `mode=PROTECTION`, not `OFF`, with `setpoint` equal to the heating protection temperature. "Forever" has no validity window. "Until" has a window ending at the chosen minute plus one second; about 4 s after the end the device returns to `AUTOMATIC` by itself and sends an event.
- **Manual with a duration from the app.** The end time is rounded down to a quarter hour (15 minutes from 22:00:39 gave 22:15:00). Cancelling returns to `AUTOMATIC` at once.
- **Program change from the app.** One event with the new `program_number`.
- **Settings.** Changing calibration, hysteresis, protection temperature, key beep or a temperature level produces **no message** on the local session. Calibration shows only indirectly: `ambient_temperature_value` (and the relative humidity) drift to the new value over about a minute.
- **`BOOST`, from the panel.** The setpoint does not change; the load is `ACTIVE`. Each press of the boost control restarts the window from now with the next duration: 30, then 60, then 90 minutes. The next press ends the boost and returns to `AUTOMATIC`; the load is re-evaluated about 0.1 s later.
- **Program slot change during `BOOST` (session of 2026-10-29).** A boost started before a program slot change kept reporting the setpoint it started with. When the boost was cancelled, the device returned to `AUTOMATIC` and reported the setpoint of the new slot at once. The load turned `INACTIVE` in a second event sent immediately after. The slot change itself produced no event while the boost was active. **[OBS]** The boost was cancelled from the app, and the owner confirmed that the program changes slot during that interval.
- **"Off" with a protection temperature other than 7 °C (session of 2026-10-30).** With the heating protection temperature set to 8 °C in the app, "Off until…" from the app made the device report `mode=PROTECTION` with `setpoint` 8. **[OBS]** So the device holds its own protection temperature, whatever setpoint comes with the command. When the owner set the protection temperature back to 7 °C in the app while "Off" was still active, an event followed with `setpoint` 7 and a window starting at that moment. **[OBS]** The app apparently sends "Off" again after the change. **[ASM]**
- **Manual until the next day.** A `MANUAL` window can end on a later day: the end time carried tomorrow's date. With the setpoint below the room temperature the load stays `INACTIVE`. **[OBS]**
- **Natural end of a window (commands session of 2026-10-30).** A `MANUAL` window returned to `AUTOMATIC` about 10 s after its end time, with the setpoint of the current slot. A `PROTECTION` window returned about 1 s after its end (about 4 s in an earlier session). Both sent the usual event, sometimes twice. **[OBS]** The device seems to check the window every few seconds. **[ASM]**
- **Not seen yet.** The natural end of a `BOOST` window.

## 7. Keep-alive and liveness

- The prior art sends `GET device_keep_alive` every 10 s and treats two consecutive failures (timeout or `NackMsg`) as a dead connection. **[PA]**
- This library also sends one every 10 s, but treats any answer, `NackMsg` included, as proof of life. Only a missing answer drops the session, through the command timeout. **[ASM]**
- With a keep-alive every 10 s, an authenticated session stayed up for 50 minutes without a disconnection. **[OBS]**
- An idle connection that has not sent anything (not even the negotiation) is still open after 10 s. **[OBS]** What happens over longer idle periods is unknown. **[ASM]**
- After a network drop of about half a minute (a router restart, 2026-11-02), the first new connection that reached the thermostat was closed at once, and the next one, about 15 s later, was accepted: the device still held the dropped session for a while. **[OBS]** A client should simply keep retrying with backoff.

## 8. Retrieving the PswOpen from the cloud

The PswOpen is generated when the thermostat is commissioned with the BTicino app, and stored in the BTicino cloud. It can be read back with the account that owns the thermostat. This uses an **unofficial** endpoint of the cloud behind the app; it may change or disappear. **[PA]**

1. `POST https://www.myhomeweb.com/eliot/users/sign_in`
   - Header `prj_name: CRO`.
   - JSON body `{"username", "pwd", "appVersion": "legacy-1.3.10", "brand": "Bticino", "registrationId": ""}`.
   - On success the session token is returned in the **`auth_token` response header**.
2. `GET https://www.myhomeweb.com/eliot/plants/all`
   - Headers `auth_token` and `prj_name: CRO`.
   - Returns a JSON array of plants (installations): `PlantName`, `PlantId`, and `PlantInfo[].gatewayList[]`.
   - Each gateway (one per thermostat) has a `GatewayID`, an optional `PswOpen`, and `GatewayInfo[]` with `Description`, `MacAddress` and possibly its own `PswOpen`.

Answers to the login with a meaning of their own **[ASM]**:

| Status | Meaning |
| --- | --- |
| `401`, `432` | wrong e-mail or password |
| `434` | account temporarily locked; the body may give `RemainingMinutes`. Retrying only makes it worse. |
| `209` | password expired: it must be changed in the BTicino app |
| `211` | contract expired: the account needs attention in the BTicino app |

Notes:

- The server presents a publicly trusted certificate, so normal TLS verification works. This project never disables it. **[OBS]**: checked on 2026-10-28 with a plain TLS handshake, without sending credentials.
- The response contains personal data (installation names, MAC addresses). Treat it like the PswOpen itself.
- The PswOpen is probably also what the thermostat and the app use towards the BTicino cloud **[ASM]**. A leaked PswOpen may therefore give more than LAN access: protect it accordingly.

## 9. Open questions

- Whether the checksum of the configuration file is really that of the last version the app wrote (§5.2).
- Length of `Ra` (not recorded: captures redact it).
- Which parameters a `SET` needs at least, and which `NackMsg` codes the device really sends: every command so far was accepted.
- How a `BOOST` window ends when it expires.
- When the device uses `mode=OFF`: the app's "Off" uses `PROTECTION`.
- What the device does with a `MANUAL` setpoint below its protection temperature.
- The setpoint step accepted by `SET`. The app sets values such as 20.7 °C, so 0.1 °C is likely. **[ASM]**
- State `OFF`, and the `COOLING` function. Cooling cannot be tried on the observed installation, whose relay drives a boiler.
- Does the thermostat send `OWNxml` (V1) messages during normal operation? None seen in 50 minutes.
- What writing the active program does during `MANUAL` or `BOOST` (§5.3).
- Whether an open BTicino app follows a program written locally, and whether a change made in the app produces `EVT device_program_number_list`.
