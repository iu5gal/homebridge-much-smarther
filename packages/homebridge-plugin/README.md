# homebridge-much-smarther

> **Only for the first-generation Smarther, model X8000.** The later Smarther2 with Netatmo is a different product and is not supported.

Homebridge plugin for the **first-generation** BTicino Smarther thermostat, model **X8000**, over its local protocol: no cloud at runtime. It uses the client in [`@much-smarther/core`](https://github.com/iu5gal/much-smarther-bridge/blob/main/packages/core/README.md).

> **Status: first release, 0.1.0.** Verified against a real X8000 in heating, for every command it sends, and with Homebridge 2.5 on a Raspberry Pi 3, including restarts and network drops. Cooling is supported but has only been tried with the simulator. Not affiliated with or endorsed by BTicino or Legrand.

Requires Node.js 22, 24 or 26 and Homebridge 1.8 or later (tried with 1.11 and 2.x). Tried on Linux and macOS. **Windows: everything still has to be tried**; the code supports it and the automated tests run there, but it has never been used with Homebridge on Windows. Reports and contributions are welcome.

User guides: [installation](https://github.com/iu5gal/much-smarther-bridge/blob/main/docs/installation.md), [setup and pairing](https://github.com/iu5gal/much-smarther-bridge/blob/main/docs/setup.md), [features and limitations](https://github.com/iu5gal/much-smarther-bridge/blob/main/docs/features.md), [troubleshooting](https://github.com/iu5gal/much-smarther-bridge/blob/main/docs/troubleshooting.md), [security](https://github.com/iu5gal/much-smarther-bridge/blob/main/SECURITY.md).

| Commands | Thermostat settings |
| --- | --- |
| ![Setup page, Commands tab](https://raw.githubusercontent.com/iu5gal/much-smarther-bridge/main/docs/images/setup-commands.png) | ![Setup page, Thermostat tab](https://raw.githubusercontent.com/iu5gal/much-smarther-bridge/main/docs/images/setup-thermostat.png) |

*The setup page, with the simulator.*

## What appears in the Home app

One accessory, with names in the configured language:

| Service | Behaviour |
| --- | --- |
| Thermostat | Room temperature and humidity, target temperature 7–40 °C in steps of 0.1, heating (or cooling) running or idle. |
| Mode "Off" | The BTicino app's "Off": the thermostat holds its protection temperature. |
| Mode "Heat" (or "Cool") | A manual temperature, in the current season. From "Off" it uses the last temperature set, or the "Home" level. |
| Mode "Auto" | The weekly program (with `automaticMode: "auto"`, the default). |
| Switch "Schedule" | The weekly program, instead of "Auto" (with `automaticMode: "switch"`). |
| Switches "Boost 30/60/90 min" | Start a boost; switching off the active one returns to the program (`boostSwitches`, all three by default). |
| A switch per weekly program | Optional (`programSwitches`), for the programs you choose. Named as in the BTicino app; turning one on runs that program. One is on at a time, like radio buttons. |
| Switch "Off until next change" | Optional (`offSwitch`). Off until the program's next change of level, as the app proposes; switching it off returns to the program. |
| Humidity sensor | Optional (`humiditySensor`). |

A temperature set from the Home app lasts, by default, until the next change of level of the active program, which is what the BTicino app proposes for a manual change. The Home app offers only the current season (heating or cooling); the season is changed on the setup page, in the BTicino app or on the panel.

When the thermostat cannot be reached for more than a minute, or the password is missing or rejected, the Home app shows "No response".
The same happens when the settings are not valid: the accessory stays, with its room, names and automations, and the Homebridge log says what to fix. Until the thermostat address is entered, the plugin only logs that it is not configured yet.

## Configuration

Set it on the plugin's settings page in the Homebridge UI. The equivalent `config.json` block:

```json
{
  "platform": "MuchSmarther",
  "name": "Smarther",
  "host": "192.0.2.10",
  "language": "en"
}
```

| Setting | Default | Meaning |
| --- | --- | --- |
| `host` | required | The thermostat's address on your network. Give it a fixed address on the router. |
| `port` | 40000 | Only if your thermostat uses another one. |
| `name` | `Smarther` | Name of the accessory. |
| `language` | `en` | Names in the Home app and the setup page: one of the [43 languages](#languages), by code (`en`, `it`, `de`, `fr`, `zh-Hans`…). |
| `automaticMode` | `auto` | `auto`: the program is the "Auto" mode. `switch`: a separate "Schedule" switch. |
| `manualEnd` | `nextChange` | How long a temperature set from the Home app lasts: `nextChange`, `forever` (until changed) or `duration`. |
| `manualMinutes` | 120 | With `manualEnd: "duration"`: 15 to 1440, in steps of 15. |
| `seasonFromHome` | `false` | Let the Home app switch between heating and cooling. Only for systems that heat **and** cool through this thermostat: on a boiler-only system, cooling would run the boiler. |
| `humiditySensor` | `true` | Show a separate humidity sensor. |
| `boostSwitches` | `[30, 60, 90]` | The boost switches to show, by minutes; `[]` for none. |
| `programSwitches` | `[]` | The programs (1–10) with a switch. `true`: every program, also those created later. |
| `offSwitch` | `false` | Show an "Off until next change" switch. |

The plugin names its services, and puts the names back at every start: when pairing, the Home app sometimes replaces them with its own defaults ("Switch 2").

The thermostat's **password** (PswOpen) is not part of `config.json`. Set it on the settings page, typed by hand or retrieved once from the BTicino cloud. The page uses your BTicino account for that one request, through an unofficial service, and never saves the e-mail or the account password.

## Setup page

Besides the settings and the password, the page shows the state of the thermostat and offers what the BTicino app does: manual temperature until a chosen day and time (up to 10 days ahead) or until changed, boost, off or off until, back to the program, the choice of program, and the season. Settings of the thermostat (temperature levels, protection temperatures, hysteresis, calibration, panel options) and diagnostics are shown read-only.

## Languages

The setup page and the names in the Home app come in 43 languages: the 24 official languages of the European Union, Catalan, Icelandic, Norwegian (Bokmål), Russian, Serbian (Cyrillic), Turkish and Ukrainian, and Arabic, Chinese (Simplified and Traditional), Hindi, Hebrew, Indonesian, Japanese, Korean, Malay, Persian, Thai and Vietnamese. The language menu shows each one by its own name; Arabic, Hebrew and Persian lay the page out right to left.

- **Translations made with AI assistance**, checked for consistency but not by native speakers of every language. Corrections are welcome: each language is one file in `src/locales/`, and the tests check that it has every text and the same `{placeholders}` as English.
- **Hindi and Thai:** HomeKit only accepts names made of letters, numbers and a little punctuation, and these scripts need vowel signs that do not count as letters. The Home app gets the English names; the setup page stays in the language. You can rename the services in the Home app.
- The Homebridge settings form (`config.schema.json`) stays in English, because Homebridge does not translate plugin forms; the setup page shows the same settings translated.

## Limitations

- **One local client.** The thermostat accepts a single local session, and the plugin keeps it. While Homebridge runs, the BTicino app works through the BTicino cloud as usual, but cannot fall back to the home network: without internet, only Homebridge controls the thermostat. Other local tools are refused too.
- **One thermostat per Homebridge instance** in this version.
- **Settings are read-only.** Temperature levels, protection temperatures and the weekly programs are changed in the BTicino app.
- **Cooling** has only been tried with the simulator.

## Security

- The password is stored in `<Homebridge storage>/much-smarther/pswopen`, in a directory with mode 0700 and a file with mode 0600, and is never logged. **Homebridge backups contain it.**
- The setup page talks to the plugin through a Unix socket in the same directory, mode 0600, or on Windows through a named pipe: no network port is opened. Every request must carry an access key that the plugin writes at each start into `much-smarther/control-key` (mode 0600), so other users of the computer cannot send commands even where they can open the pipe. It accepts a fixed list of requests, with validated values.
- On Windows the files have no Unix modes: they are protected by the access rights of the Homebridge storage directory, which is normally in the user's profile.
- The thermostat's own protocol is not encrypted: see [docs/PROTOCOL.md](https://github.com/iu5gal/much-smarther-bridge/blob/main/docs/PROTOCOL.md) §4.3.
- The Homebridge UI uses plain HTTP unless configured otherwise, so a password typed on the setup page crosses the LAN unencrypted. Use it from a trusted network, or enable HTTPS in the Homebridge UI.
- Threats, mitigations and residual risks: [docs/SECURITY-MODEL.md](https://github.com/iu5gal/much-smarther-bridge/blob/main/docs/SECURITY-MODEL.md).

## Development

```sh
npm run simulator          # a fake thermostat on 127.0.0.1:40001, password fake-pin-0000
npm test                   # every test, the plugin's included
npm run pack:plugin        # pack/homebridge-much-smarther-<version>.tgz, with the core inside
```

The package is a single tarball: `scripts/pack-plugin.mjs` copies the compiled core into the plugin's `node_modules` and lists it in `bundleDependencies`, because npm does not bundle workspace packages by itself. It has no install scripts. Install it with `npm install <tarball>` in the Homebridge plugin directory, or from the Homebridge UI once it is published.

The plugin's tests use HAP-NodeJS and the simulator: mapping tables, the accessory, the control socket, the setup page requests and the platform from start to shutdown.

## Support

If the plugin is useful to you, you can support its development on [Ko-fi](https://ko-fi.com/iu5gal).

## Credits and license

Thanks to [Mirmanero](https://github.com/Mirmanero), whose [ha-bticino-x8000](https://github.com/Mirmanero/ha-bticino-x8000) inspired this project. Built with the support of Claude, Anthropic's AI assistant, under the maintainer's direction and review, and verified on a real thermostat. Contributions are welcome: see the [contributing guide](https://github.com/iu5gal/much-smarther-bridge/blob/main/CONTRIBUTING.md).

MIT. Copyright (c) 2026 iu5gal and contributors.
