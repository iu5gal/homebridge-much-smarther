# Features and limitations

What the thermostat does when you use the Home app, what the setup page adds, and what is not possible. The protocol behind it is described in [PROTOCOL.md](PROTOCOL.md).

## The Home app and the thermostat

The Home app's thermostat has only four modes, Off, Heat, Cool and Auto, and no notion of "until". The plugin maps them onto the thermostat's own modes like this:

| In the Home app | On the thermostat | Notes |
| --- | --- | --- |
| **Auto** | The weekly program (`AUTOMATIC`) | Back to the active program. With the option "as a separate Schedule switch", Auto is not offered and the **Schedule** switch does this instead. |
| **Heat** (in winter) or **Cool** (in summer) | A manual temperature (`MANUAL`) | Heat is how the Home app shows the thermostat's manual mode: the app has no "manual". Choosing Heat from Off brings back the last temperature you set, or the "Home" level. Choosing it during the program keeps the current temperature as a manual one. |
| **Off** | Off, at the protection temperature (`PROTECTION`) | As the BTicino app's "Off": the thermostat holds its frost protection temperature, 7 °C by default. |
| Moving the **target temperature** | A manual temperature, until the next change of level of the program | As the BTicino app proposes. The plugin waits until you stop moving the slider, then sends one command. Options: until changed, or for a fixed time. |
| **Boost 30 / 60 / 90 min** switches | `BOOST` for that time | The heating runs regardless of the temperature. One switch at a time; switching the active one off goes back to the program. A boost started on the panel or in the app turns the matching switch on. |
| A **program** switch | That weekly program | Optional. One is on at a time, like radio buttons. |
| **Off until next change** switch | Off until the program next changes level | Optional. Switching it off goes back to the program. |

The Home app also shows:

- the room temperature, and a fault if the thermostat reports its measurement as not valid;
- the humidity, inside the thermostat and on its own sensor tile;
- whether the heating (or cooling) is running right now.

Changes made on the panel or in the BTicino app show up in the Home app within a few seconds: the thermostat announces them, and the plugin does not need to poll.

### Seasons

The Home app offers only the current season: Heat in winter, Cool in summer. The season itself is changed on the setup page, in the BTicino app or on the panel. Allowing it from the Home app is an option, off by default, and meant only for systems that heat and cool through this thermostat: on a boiler-only system, cooling would run the boiler.

## The setup page

The setup page in the Homebridge UI adds what the Home app cannot show:

- manual temperature **until a chosen day and time**, up to 10 days ahead, or until changed;
- **off until** a chosen day and time;
- the remaining time of the current mode, and the next change of level of the program;
- the **choice of the active program**, with the names from the BTicino app;
- the **season**, with a confirmation;
- the thermostat's **settings**, read only: temperature levels, protection temperatures, hysteresis, calibration, panel options, firmware and diagnostics.

See the [setup guide](setup.md#6-the-rest-of-the-setup-page).

## Living with the BTicino app

- **The BTicino app keeps working** through the BTicino cloud, as usual, also away from home. Changes made there reach the Home app within seconds, and the other way round.
- **One local client at a time.** The thermostat accepts a single session on the local network, and the plugin keeps it. So, **without internet**, the BTicino app cannot reach the thermostat while Homebridge runs; only the Home app can. Other local tools are refused too.

## Limitations

- **The weekly programs cannot be edited** from the Home app or the setup page: create and change them in the BTicino app. The setup page only chooses which one is active.
- **Settings are read only**: temperature levels, protection temperatures, hysteresis, calibration and panel options are changed in the BTicino app or on the panel.
- **One thermostat per Homebridge instance** in this version.
- **Cooling** is supported but has only been tried with the simulator, not on a real cooling system.
- **"Away"** (the Away level until a chosen time) is not offered: the app did not offer it on the installation used for testing.
- **Remote access** is not part of this project: away from home, use the BTicino app, or an Apple home hub for the Home app.
- **App and cloud features** stay in the BTicino app: weather, location-based suggestions, firmware updates, Wi-Fi setup, several homes and home-wide commands, voice assistants.
- **Hindi and Thai** get English names in the Home app (the setup page stays translated).

## Not yet observed

These do not affect normal use, but have not been seen on a real device yet:

- the natural end of a boost, when its time runs out (the plugin follows whatever the thermostat reports);
- when, if ever, the thermostat reports its `OFF` mode instead of `PROTECTION`;
- what the thermostat does with a manual temperature below its protection temperature.
