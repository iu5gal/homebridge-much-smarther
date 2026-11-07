# Setup and pairing

After the [installation](installation.md), the plugin needs the thermostat's address and its local password. Everything is done on the plugin's setup page in the Homebridge UI.

## 1. Open the setup page

In the Homebridge UI, open **Plugins**, find **Much Smarther** and open its settings from the menu on its card. The page appears in the language chosen in the plugin settings, English by default.

## 2. Address and language

1. In **Plugin settings**, enter the **Thermostat address**: its IP address on your network, for example `192.0.2.10`. It should be fixed on your router.
2. Choose the **Language** for the setup page and for the names in the Home app.
3. Optionally change the **Name in the Home app** (default `Smarther`).
4. Press **Save** at the bottom of the window. Homebridge restarts.

## 3. Connect the thermostat

The thermostat has a local password, called PswOpen, created when it was first set up with the BTicino app. Almost nobody knows it: it is stored in your BTicino account. Reopen the setup page and, under **Connect the thermostat**, choose one of two ways.

### Sign in with your BTicino account (recommended)

1. Enter the e-mail and password you use in the BTicino Thermostat app.
2. Press **Sign in and retrieve**.
3. If the account has more than one thermostat, choose yours with **Use this thermostat**. The page shows the end of each thermostat's MAC address to tell them apart.

The page reads the password once, saves it on the Homebridge machine and connects. Your e-mail and account password are used only for that request and are never saved. The request goes to an **unofficial** BTicino service, which may change; if it stops working, use the other way.

Possible answers:

| Message | What to do |
| --- | --- |
| Login rejected | Check the e-mail and password, as used in the BTicino app. |
| Account temporarily locked | Wait the time shown before trying again. Attempts in the meantime may extend the lock. |
| Password expired / account needs attention | Open the BTicino app first and follow what it asks. |
| No thermostat with a password was found | The account does not own a thermostat of this kind, or the cloud has no password for it. Use the account that set up the thermostat. |
| The BTicino cloud cannot be reached | Check the internet connection of the Homebridge machine, or try later. |

### Enter the password by hand

If you already know the password, open **I already have the local password**, type it and press **Save**.

### When the password changes

A reset of the thermostat creates a new password. The plugin then cannot connect, and the setup page and the log say that the thermostat rejected the password. Sign in again to retrieve the new one.

## 4. Options

Two groups on the setup page, **In the Home app** and **Advanced**. Changes apply when you press **Save** at the bottom of the window; Homebridge then restarts.

| Option | Default | Meaning |
| --- | --- | --- |
| Weekly program in the Home app | as the "Auto" mode | The weekly program is the Home app's "Auto" mode, or a separate "Schedule" switch. |
| A temperature set in the Home app lasts | until the next change of the program | As the BTicino app proposes: until the active program next changes level. Or until changed, or for a fixed time (15 minutes to 24 hours). |
| Allow changing the season from the Home app | off | Lets the Home app switch between heating and cooling. **Only for systems that heat and cool through this thermostat**: on a boiler-only system, cooling would run the boiler. |
| Show a separate humidity sensor | on | The humidity is also inside the thermostat; the sensor makes it visible on its own tile. |
| Boost switches | 30, 60, 90 | Which boost switches to show. |
| Program switches | none | A switch for each weekly program you choose, named as in the BTicino app. The list appears once the plugin has read the programs from the thermostat. |
| An "Off until the next change" switch | off | Off until the program next changes level, as the BTicino app proposes. |
| Port | 40000 | Leave it empty unless your thermostat uses another one. |

The same options exist in the Homebridge settings form and in `config.json`; see the [plugin README](../packages/homebridge-plugin/README.md#configuration) for the keys.

## 5. Pair with the Home app

Add the Homebridge bridge to the Home app. The thermostat comes with it.

### Pair

1. On the iPhone or iPad, be on the same network as the Homebridge machine.
2. In the Homebridge UI, the **Status** page shows a QR code and an eight-digit setup code.
3. In the Home app, tap **+**, then **Add Accessory**, and scan the QR code. Without a camera, choose **More options…** and type the code.
4. The Home app warns that the accessory is not certified: choose **Add Anyway**. Homebridge bridges are never certified by Apple.
5. Choose a room for the bridge and for the thermostat, and confirm the names.

The setup code works only while the bridge is not paired. Keep it private anyway: it is in Homebridge backups and in its log.

### What you get

One accessory, named as you set it in the plugin settings, with these services:

- **Thermostat**: room temperature and humidity, target temperature, and the modes Off, Heat (or Cool) and Auto. See [features](features.md) for what each mode does on the thermostat.
- **Humidity**: a separate sensor, unless you turned it off.
- **Boost 30 / 60 / 90 min**: switches, unless you turned them off.
- Optional switches, if you chose them: **Schedule**, one per weekly program, **Off until next change**.

The names come in the language chosen in the plugin settings. For Hindi and Thai the Home app gets the English names, because HomeKit does not accept the vowel signs of those scripts; you can rename the services in the Home app.

If after pairing a service shows a generic name such as "Switch 2", restart Homebridge: the plugin puts its names back at every start.

### Away from home

The Home app reaches Homebridge only on the home network, unless you have an Apple home hub (Apple TV or HomePod), which relays it through Apple's encrypted service. This project adds no remote access of its own. Away from home without a hub, use the BTicino app.

### Replacing a bridge

If you move Homebridge to another machine, or set it up again from scratch, first remove the old bridge from the Home app (in the Home app, open the bridge's settings and choose **Remove Bridge**), then pair the new one. Otherwise the Home app shows a second, unreachable thermostat.

To pair the same bridge again, for example after removing it by mistake, reset its pairing in the Homebridge UI settings first.

## 6. The rest of the setup page

Once connected, the page also works as a small control panel, with the same choices as the BTicino app:

- **Thermostat**: room temperature and humidity, mode and its end, target temperature, whether the heating is running, the next change of level.
- **Commands**: manual temperature until a chosen day and time (up to 10 days ahead) or until changed; boost for 30, 60 or 90 minutes; off, or off until a chosen time; back to the program; the season, with a confirmation.
- **Programs**: the temperature levels, the weekly programs, and the choice of the active one. See below.
- **Settings**: temperature levels, protection temperatures, hysteresis, calibration, panel options, firmware and diagnostics, read only. They are changed in the BTicino app or on the thermostat.

### Weekly programs

The program in use opens by itself; **Edit** opens any other, and several can be open at once. Each one shows its week as seven coloured bars.

- **Choose a day**, then set its lines. Each line means "from this time on, use this level", until the next line. The first line is always at 00:00.
- **A time**: touch it, then choose the hour and the minutes, in quarter hours.
- **A level**: touch one of the four coloured buttons. Their temperatures are the thermostat's levels, shown at the top, and they change in the BTicino app or on the panel.
- **Copy this day** to another day, to the working days, or to every day.
- **The name**: the pencil next to it changes it. Up to 32 characters. Accents and the signs `& < > " '` are removed when saving, and the page shows the result first. Two programs cannot have the same name.
- **Save on the thermostat**: the plugin first keeps a copy of what it replaces, then writes the program, reads it back and compares it. A saved program does not become active by itself: use **Use this**.

**Saving the program in use takes effect at once**, so the heating may start or stop. If the program was changed elsewhere after you opened it, in the BTicino app for example, the plugin does not overwrite it: open it again.

**Previous versions**, at the bottom of the tab, bring back the last 10 versions of each program, deleted ones too. They are in `much-smarther/program-backups` in the Homebridge storage directory, with a copy of every program as it was before the first change. Homebridge backups include them.

An open BTicino app may need to be opened again to show a change.
