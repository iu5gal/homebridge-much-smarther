# Native features of the Smarther X8000

This is the inventory of everything the thermostat and the BTicino Thermostat app can do. It comes before any HomeKit mapping is designed: each entry records the native behaviour, the protocol messages involved, how it could appear in Apple Home, notes for Matter and SmartThings later, and its limitations.

**Status: draft.** The native behaviour comes from the official documents and from the owner's use of the app. The protocol entries come from observation sessions in Phase 1, with changes made from the app and the panel while the bridge listened. The HomeKit column records the choices made so far for Phase 3.

## Sources and tags

| Tag | Source |
| --- | --- |
| **[MAN]** | BTicino user manual for Smarther X8000 (document RA00158AF, Italian edition), from the BTicino catalogue. |
| **[TS]** | BTicino technical sheet for X8000 (document ST_00000276, Italian edition). |
| **[OBS]** | Observed on a real device by this project (see `PROTOCOL.md`). |
| **[PA]** | Prior art (see `PROTOCOL.md`). |
| **?** | Not known yet. |

The manuals are not copied into this repository; this file describes them in our own words.

Columns:

- **Protocol**: the `device_state` fields or other messages involved (`PROTOCOL.md`).
- **HomeKit**: proposed representation, to be confirmed in Phase 5. "Plugin UI" means the Homebridge setup page; "—" means not exposed.
- **Matter / ST**: notes for a later Matter or SmartThings version.

## 1. Control: modes and temperatures

| Feature | Native behaviour | Protocol | HomeKit | Matter / ST | Limitations |
| --- | --- | --- | --- | --- | --- |
| Weekly program (`AUTOMATIC`) | Follows the active program; the setpoint changes at each slot. **[MAN]** | `mode=AUTOMATIC`, `program_number`; `setpoint` is the slot target, validity `FALSE`. **[OBS]** | Target state "Auto" (`automaticMode: "auto"`, the default). Chosen after trying both in the Home app: "Auto" sits in the thermostat's own mode menu, next to Off and Heat, and the program switches already offer a one-tap way back to a given program, so a separate switch adds little. The "Schedule" switch (`"switch"`) stays as an option. | Thermostat `SystemMode` Auto / schedule. | HomeKit "Auto" means a heat–cool range, not a schedule. |
| Set temperature (`MANUAL`) | From the panel: until the next program change. From the app: without a time limit, or until a chosen date and time. **[MAN]** In the app's manual screen the user picks the temperature, then the end day (today, tomorrow, … up to 10 days ahead, or "forever"), then the end time. The app fills in the end by itself with the next change of level in the active program, and most users keep it. It starts from the room temperature and moves in steps of 0.5. **[OBS]** | `mode=MANUAL`, `setpoint` (0.1 °C resolution), validity window set to the end time. A duration chosen in the app gives an end time rounded down to the quarter hour. Cancelling returns to `AUTOMATIC` at once. **[OBS]** A `SET` with a validity window, up to 10 days ahead, does the same; the device sets the start to its own clock and keeps the end. At the end it returns to `AUTOMATIC` by itself, about 10 s later. **[OBS]** | Target temperature; changing it switches to `MANUAL` until the next change of level, computed from the active program like the app does (fallback: until changed). "Until changed" and a fixed duration are plugin options. The plugin UI offers the app's choice of end day and time. | Setpoint + hold. | HomeKit has no "until" concept. The next program change is computed from the active program file (§3). |
| Setpoint range | 5–40 °C on the panel in steps of 0.5 **[TS]**; the app's manual picker goes from 7 to 40 °C in steps of 0.1 **[OBS]**. Bounded by the protection temperatures. **[MAN]** | `setpoint`. This library sends 7–40 °C in steps of 0.1. | Target temperature 7–40 °C, step 0.1, as in the app. | — | The protection temperature is the floor, and it is a user setting (7 °C by default, higher on some installations) that is not reported unless `PROTECTION` is active. The bridge can learn it from the setpoint the first time it sees `PROTECTION`. **[OBS]** Behaviour of a `SET` below it: **?** |
| Boost | Forces the system on for 30, 60 or 90 minutes regardless of temperature. On the panel each press moves 30 → 60 → 90 → cancel. **[MAN]** **[OBS]** At the end it returns to the program; a thermostat never connected to the app returns to its previous mode instead. **[MAN]** | `mode=BOOST`, validity window = start..end; `setpoint` unchanged; `boostTime` not reported. **[OBS]** `SET` with the validity window only, without `boostTime`: accepted; the device recomputes the end from its own clock. **[OBS]** | Switches "Boost 30/60/90", mutually exclusive, with the remaining time in the plugin UI. | No Matter equivalent; a switch. | The natural end of a boost has not been observed yet. |
| Off ("Spegni Smarther") | The system is held at the protection temperature, without a time limit or until a date and time. The panel shows the off symbol; also reached by lowering the setpoint to the protection value. **[MAN]** **[TS]** | `mode=PROTECTION` with `setpoint` = the heating protection temperature. "Forever": validity `FALSE`. "Until": validity window up to the chosen time; about 4 s after it ends, the device returns to `AUTOMATIC` with the program setpoint. **[OBS]** `mode=OFF` was never seen. The library sends `PROTECTION` like the app: setpoint 7, with an optional end time up to 10 days ahead. The device ignores that 7 and holds its own protection temperature. **[OBS]** | Target state "Off" = `PROTECTION`, like the app. Optional switch "Off until next change" (`offSwitch`): `PROTECTION` until the next change of level of the active program, on while the thermostat is off with an end time. "Off until" another day and time: plugin UI. | `SystemMode` Off. | When the device uses `OFF`, if ever: **?** |
| Protection (`PROTECTION`) | Frost protection in heating (default 7 °C), overheat protection in cooling (default 35 °C). **[MAN]** **[TS]** | `mode=PROTECTION`: this is what the app calls "Off". **[OBS]** | Same as "Off": no separate switch needed. | — | — |
| Away ("Fuori casa") | Applies the "Away" temperature level of the active program until a chosen date and time, then goes back to the program. Also available for all thermostats of a home at once. **[MAN]** | Not offered by the app on the observed installation, whose home commands are only Off, Boost and Set temperature. **[OBS]** Perhaps it depends on the app version or on having several thermostats. **[ASM]** | — unless it turns up. | Matter "Away" preset. | Multi-thermostat commands are an app feature. |
| Season (heating / cooling) | Switches the system between heating and cooling. Default heating. **[MAN]** | `function=HEATING` / `COOLING`. **[PA]** | Plugin UI setting only; the Home app offers no Cool. | `SystemMode` Heat / Cool. | Cooling has not been tested on a real system yet. |

## 2. State and measurements

| Feature | Native behaviour | Protocol | HomeKit | Matter / ST | Limitations |
| --- | --- | --- | --- | --- | --- |
| Room temperature | Shown on the panel. Operating range 5–40 °C. **[TS]** | `ambient_temperature_value`, `is_ambient_temperature_valid`. **[OBS]** A value flagged `FALSE` is ignored. **[ASM]** | Current temperature; a fault status while the measurement is not valid. | `LocalTemperature`. | Reported with the calibration applied. A change of calibration reaches the reported value gradually, over about a minute, and the reported humidity moves with it. **[OBS]** |
| Humidity | Third page on the panel; home page of the app. **[MAN]** | `ambient_relative_humidity_value`, `is_ambient_relative_humidity_valid`. **[OBS]** A value flagged `FALSE` is ignored. **[ASM]** | Current relative humidity (Thermostat) and a Humidity Sensor service. | Humidity sensor cluster. | — |
| Load state | The icon shows heating or cooling running. **[MAN]** | `heating_thermoregulation_load_state`, `cooling_thermoregulation_load_state`: `ACTIVE` / `INACTIVE`. **[OBS]** | Current heating/cooling state. | `ThermostatRunningState`. | — |
| End time of the current mode | Shown in the app as remaining time. **[MAN]** | Validity window. **[OBS]** | Plugin UI. | — | — |
| External sensors | — | `is_external_temperature_from_sensor_valid`, `is_external_temperature_from_remote_valid`, `FALSE` here. **[OBS]** | — | — | Unknown hardware; ignored. |
| Device clock, address | — | `is_device_date_and_time_valid`, `timestamp` (with the device's UTC offset), `ip`. **[OBS]** The offset is used to write time windows in the device's zone. **[ASM]** | Plugin UI (diagnostics). | — | — |

## 3. Programs and temperature levels

| Feature | Native behaviour | Protocol | HomeKit | Matter / ST | Limitations |
| --- | --- | --- | --- | --- | --- |
| Programs | Up to 10 daily or weekly programs per thermostat, created in the app with time slots. **[MAN]** | `GET device_program_number_list`: 11 slots (`0`–`10`), present or not, with a change timestamp, without names. **[OBS]** Slot `0` is a system program the user cannot edit (observed: `PROTECTION` all day) **[OBS]**; `1`–`10` are the user programs. Names, type and time slots are read from the program files. **[OBS]** | Plugin UI: choose the active program among the user programs `1`–`10` (`program_number` with `AUTOMATIC`); the system program `0` is not listed. Optional (`programSwitches`): a switch for each chosen user program, named as in the app, on while it runs; turning one on sends `AUTOMATIC` with that `program_number`. Changing the program in the app produces an event with the new `program_number`. **[OBS]** | Matter schedules: later. | Editing programs is out of scope for v1. |
| Temperature levels "Away", "Home", "Night" | Named levels used by the programs, separate for heating and cooling; also used by "Away". **[MAN]** | Changing a level produces no event. **[OBS]** Read from the configuration file: `heating_day_temperature` ("Home"), `_night_`, `_away_`, and the same for cooling. **[OBS]** | Plugin UI (read only). Also needed to compute the next program change and its temperature. | Matter presets. | Reread periodically, since changes are not announced. |

## 4. Settings and calibration

From the app's advanced settings and the panel menu. **[MAN]**

None of these settings appears in the local events: changing hysteresis, heating protection temperature, key beep or temperature levels produced no message at all. **[OBS]** They are all readable from the configuration file (`PROTOCOL.md` §5.2) **[OBS]**, so the plugin reads it at start and again from time to time. Writing them is out of scope for v1.

| Setting | Default | Native behaviour | Protocol | Plugin | Limitations |
| --- | --- | --- | --- | --- | --- |
| System hysteresis | 0.1 °C | How far the temperature moves around the setpoint before the system switches. 0.1 °C for slow systems (the default), 1 °C for fast ones. | `heating_regulation_band`, `cooling_regulation_band`. **[OBS]** | Plugin UI, read only. | Changing it from the bridge only if the protocol supports it cleanly. |
| Heating protection temperature | 7 °C | Frost protection; manual and programmed temperatures cannot go below it. The app accepts 3–18 °C in steps of 0.1. **[OBS]** | `heating_protection_temperature`; also the `setpoint` while `PROTECTION` is active. **[OBS]** | Plugin UI, read only. | — |
| Cooling protection temperature | 35 °C | Overheat protection; temperatures cannot go above it. The app accepts 28–40 °C in steps of 0.1. **[OBS]** | `cooling_protection_temperature`. **[OBS]** | Same. | — |
| Temperature calibration | 0 | Offset added to the measured temperature; the app shows both values. | `ambient_temperature_calibration` (offset, °C); already applied to `ambient_temperature_value`. **[OBS]** | Plugin UI, read only. | — |
| Unit °C / °F | °C | Display unit. | `temperature_format`. **[OBS]** | Fixed to °C on the wire; HomeKit converts for display. | — |
| Key beep, vibration | Off | Feedback when touching the keys. | `buzzer_enable`, `haptic_enable` (`ON` / `OFF`). **[OBS]** | Plugin UI, read only. | — |
| Touch interface enabled | On | Locks the touch panel (child lock). | `key_user_interface_enable`. **[OBS]** | Plugin UI, read only; a "Lock" switch would need writing the file, later. | — |
| Display brightness | Automatic with switch-off | Off, automatic with switch-off, automatic without, or custom. | `stand_by_brightness`: `STAND_BY_BRIGHTNESS_OFF`, `_AUTOMATIC_WITH_OFF`, `_AUTOMATIC_WITHOUT_OFF`, `_1` … `_10`. **[OBS]** for the automatic value. | Plugin UI, read only. | — |

## 5. App and cloud only

These run in the BTicino app or cloud. The bridge does not reproduce them.

| Feature | Notes |
| --- | --- |
| Location services and suggestions | Notifications from the app based on the phone's position. **[MAN]** |
| Weather | Shown in the app. **[MAN]** |
| Firmware update | Through the app. **[MAN]** |
| Multiple homes and thermostats, home commands | Up to 4 homes with up to 4 thermostats each; Away, Off and Boost for a whole home. **[MAN]** The bridge exposes one accessory per thermostat; HomeKit scenes cover the rest. |
| Wi-Fi setup, send log to support, reset | On the device and in the app. **[MAN]** A reset changes the PswOpen (see the setup guide). |
| Local control from the app | The app goes through the BTicino cloud. The thermostat keeps one local session at a time and the bridge holds it, so the app cannot fall back to the home network while the bridge is connected: without internet, only the bridge (and so Apple Home) controls the thermostat. **[OBS]** |
| Voice assistants (Google Home, Alexa) | Through the BTicino cloud. **[MAN]** Out of scope. |

## 6. Open points

- What happens at the natural end of `BOOST`.
- When, if ever, the device reports `mode=OFF`.
- What a `SET` does with a validity window, and with a setpoint below the protection temperature.
- Whether the program setpoint changes at once when the active program changes. In the observed case it stayed the same, perhaps because both programs had the same level at that hour.
