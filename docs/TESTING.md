# Manual end-to-end checks

These checks run against a **real** X8000 and are never part of CI. The automated tests (`npm run check`) prove that the code follows [PROTOCOL.md](PROTOCOL.md); only these checks prove that PROTOCOL.md matches the device.

The checklist grows with each phase. Record the outcome of every run (date, firmware if known, result) in the protocol notes, tagged **[OBS]**, and move the matching **[ASM]** statements accordingly.

## Ground rules

- **Who runs them.** The owner, or someone with the owner's approval. Tools that need the PswOpen are run in the owner's own terminal; the PswOpen never goes through a chat, a log or a file.
- **What may change.** Read-only checks never change the thermostat state. Every check that sends a `SET` is marked **(changes state)** and needs the owner's approval for that session.
- **Captures.** Raw logs stay in `captures/` (gitignored, mode 0600). Anything committed is sanitized first: placeholders from RFC 5737 (`192.0.2.x`), fake PINs, no installation names, MAC addresses, network names or coordinates.
- **Afterwards.** Leave the thermostat as it was found: same mode, setpoint and program.

## 1. Read-only session

- [ ] The bridge authenticates and reads the state.
- [ ] Changes made on the panel and in the app arrive as events within a few seconds.
- [ ] Keep-alives are answered; the session stays up for at least 30 minutes.
- [ ] A wrong PswOpen fails with an authentication error and no fast retries.
- [ ] `npm run files -- <thermostat-address>` reads the diagnostics, the configuration file and every program file (PROTOCOL.md §5.2), then offers to add the values that identify the installation to the personal denylist. Record:
  - whether each request is answered, and how (one frame or several, `Marker` and `IsLast`, trailing `AckMsg`);
  - whether the file structure in the capture matches §5.2, and which fields are unknown;
  - whether the values match the app: temperature levels, protection temperatures, hysteresis, calibration, program names and time slots.

## 2. Coexistence with the BTicino app

- [ ] With the bridge connected, the app (phone on the home Wi-Fi, with internet) reads the state and changes the setpoint. The bridge receives the change.
- [ ] Two read-only sessions of the bridge at the same time (`npm run session` in two terminals). Record whether both authenticate, whether the second one drops the first, and whether a change made on the panel or in the app reaches both. This shows directly whether the thermostat accepts two local sessions.
- [ ] With the bridge connected, internet blocked **for the thermostat** on the router, and the phone online on the home Wi-Fi. Keep the block for at least 5 minutes, so that the thermostat's cloud connection is surely gone, then close the app completely and open it again. Change the setpoint from the app. Record whether the app shows the thermostat as reachable, whether the command arrives, whether the app shows the new state, and whether the bridge session survives. This shows whether the app falls back to a local session and whether the thermostat accepts two local sessions at once.
- [ ] After the previous check, internet access is restored and both sides work again.
- [ ] "Off" is only a protection temperature: change the heating protection temperature in the app (for example from 7 to 8 °C), switch "Off" from the app and record the setpoint the device reports (it should be the protection temperature, not 7). Then restore the original value.

## 3. Commands (changes state)

One session, with the owner, for the open questions of PROTOCOL.md §9. Each step uses `npm run command -- <thermostat-address> …` (`tools/command.mjs`): it shows the exact message, sends it only after confirmation, prints the answer (`AckMsg`, or `NackMsg` with its `Code`) and the events that follow, and offers to return to the weekly program at the end. No other session may be open at the time: the thermostat accepts one.

To keep the boiler off, use setpoints **below** the room temperature, except where noted.

- [ ] `state`: the starting point. Note mode, program and setpoint.
- [ ] `manual <below room> --watch 1`: `MANUAL` without an end time. Check that the window is not in use, then return to the program and check that the program number is unchanged.
- [ ] `manual <below room> until <tomorrow, 07:00> --watch 1`: check the window the device reports, and that its times are those sent (time zone).
- [ ] `manual <below room> for 5 --watch 7`: the natural end of a `MANUAL` window. What does the device do, and how long after the end time?
- [ ] `boost 30 --watch 1`: a boost sent without `boostTime`. Is it accepted, and does the device report 30 minutes? Then return to the program (cancels the boost). The boiler runs during the boost.
- [ ] Optional: `boost 30 --watch 33`, the natural end of a boost. The boiler runs for 30 minutes.
- [ ] `off --watch 1`: "Off" forever. The setpoint reported should be the protection temperature.
- [ ] `off for 5 --watch 7`: "Off" with an end time; about 4 s after the end the device should return to the program by itself.
- [ ] Optional, if the heating protection temperature is raised above 7 °C in the app first: `manual <between 7 and the protection temperature>`. What does the device do with a setpoint below its protection temperature? Restore the protection temperature afterwards.
- [ ] With `npm run session` open instead: open the app's manual screen while in `AUTOMATIC`, note the end it proposes, change only the temperature and confirm. Compare the end of the window with the time slots of the active program (`npm run files` beforehand): it should be the next change of level, not the next slot boundary.

## 4. Resilience (Phase 4 onwards)

- [ ] Restart of the thermostat (power cycle): the bridge reconnects by itself.
- [ ] Restart of Homebridge and of the Raspberry Pi.
- [ ] Wi-Fi drop of the thermostat for a few minutes.
- [ ] Other services on the Pi keep working.

## 5. Apple Home (Phase 3 trial, then Phase 5)

With a temporary Homebridge on the development machine first (Phase 3), then on the Pi (Phase 5). The checks of §2 and §3 must not run at the same time: the plugin holds the only local session.

- [ ] Pairing: the bridge appears in the Home app and the thermostat accessory comes with its services, named in the configured language.
- [ ] Room temperature, humidity and "heating" follow the thermostat within a few seconds of a change on the panel or in the app.
- [ ] Moving the target temperature slider sends one command only, after the slider stops; the BTicino app shows "manual" with the end it would have proposed itself.
- [ ] "Off" switches the thermostat off as the app does; "Heat" from "Off" brings back the last temperature.
- [ ] Prototype A (`automaticMode: "auto"`): "Auto" returns to the program, and shows as such when the program is resumed in the app.
- [ ] Prototype B (`automaticMode: "switch"`): the "Schedule" switch does the same. (Compared in Phase 3: "Auto" was chosen, see FEATURES.md; B stays an option.)
- [ ] Boost switches: one at a time; switching the active one off returns to the program; a boost started on the panel shows on the right switch.
- [ ] Program switches (`programSwitches`): one per chosen program, named as in the app; turning one on runs it; a program chosen in the app shows on the right switch.
- [ ] "Off until next change" switch (`offSwitch`): the app shows off until the time it would propose; switching it off returns to the program.
- [ ] Names: after a restart, every service shows the plugin's name, not "Switch".
- [ ] Give the plugin an address where nothing answers (for example 192.0.2.10) for over a minute: the Home app shows "No response"; with the right address back, it recovers. Do not switch the thermostat's Wi-Fi off from its panel: the thermostat then has to be set up again.
- [ ] On the Pi: restart the router. The Home app shows "No response" while the network is down and recovers by itself.
- [ ] The setup page: status, commands, programs, settings and diagnostics match the app; the password can be saved and the plugin reconnects.
- [ ] Memory: note the resident memory of the Homebridge process with the plugin, after an hour.
- [ ] Windows, when a Windows computer or the CI is available: the setup page reaches the plugin over its named pipe, saves the password and sends commands.

## Recorded runs

### Phase 4 and 5, 2026-11-01 and 2026-11-02

Raspberry Pi 3 (1 GB, 64-bit Raspberry Pi OS, Debian 13) with other services running; Homebridge 2.5.0 from the Debian package (bundled Node.js 24), main bridge; plugin 0.1.0-beta.1 from a package file; one X8000 in heating.

- **§4 Resilience.**
  - Homebridge restart: authenticated again about 15 s after the restart command.
  - Raspberry Pi reboot: authenticated again about 86 s after the reboot command; the other services came back by themselves and were unaffected.
  - Router restart: the loss was detected after 10 s (keep-alive timeout); reconnection attempts after about 2, 4, 8 and 14 s; one refusal (`connection closed by the thermostat`) while the device still held the old session; authenticated about 33 s after the loss was detected.
  - Thermostat power cycle: not run.
- **§5 Apple Home**, on the Pi: pairing, sync from the app and the panel within seconds, the slider (one command after it stops: manual until the next change of level), Off and Heat, Auto, Boost switches, names in the configured language, the setup page: all as expected. The Home app shows the thermostat's manual mode as "Heat", which is the only choice HomeKit offers.
- **Memory.** Available memory: 714 MiB before Homebridge, about 590 MiB with Homebridge alone, 575–581 MiB with the plugin, unchanged after 23 hours. Resident memory: Homebridge with the plugin about 105 MB, the Homebridge UI service about 155 MB (both include shared memory). The setup page, while open, adds a process of about 70 MB.
