# Pairing with the Home app

*[Italiano](../it/pairing.md)*

After the [setup](setup.md), add the Homebridge bridge to the Home app. The thermostat comes with it.

## Pair

1. On the iPhone or iPad, be on the same network as the Homebridge machine.
2. In the Homebridge UI, the **Status** page shows a QR code and an eight-digit setup code.
3. In the Home app, tap **+**, then **Add Accessory**, and scan the QR code. Without a camera, choose **More options…** and type the code.
4. The Home app warns that the accessory is not certified: choose **Add Anyway**. Homebridge bridges are never certified by Apple.
5. Choose a room for the bridge and for the thermostat, and confirm the names.

The setup code works only while the bridge is not paired. Keep it private anyway: it is in Homebridge backups and in its log.

## What you get

One accessory, named as you set it in the plugin settings, with these services:

- **Thermostat**: room temperature and humidity, target temperature, and the modes Off, Heat (or Cool) and Auto. See [features](features.md) for what each mode does on the thermostat.
- **Humidity**: a separate sensor, unless you turned it off.
- **Boost 30 / 60 / 90 min**: switches, unless you turned them off.
- Optional switches, if you chose them: **Schedule**, one per weekly program, **Off until next change**.

The names come in the language chosen in the plugin settings. For Hindi and Thai the Home app gets the English names, because HomeKit does not accept the vowel signs of those scripts; you can rename the services in the Home app.

If after pairing a service shows a generic name such as "Switch 2", restart Homebridge: the plugin puts its names back at every start.

## Away from home

The Home app reaches Homebridge only on the home network, unless you have an Apple home hub (Apple TV or HomePod), which relays it through Apple's encrypted service. This project adds no remote access of its own. Away from home without a hub, use the BTicino app.

## Replacing a bridge

If you move Homebridge to another machine, or set it up again from scratch, first remove the old bridge from the Home app (in the Home app, open the bridge's settings and choose **Remove Bridge**), then pair the new one. Otherwise the Home app shows a second, unreachable thermostat.

To pair the same bridge again, for example after removing it by mistake, reset its pairing in the Homebridge UI settings first.
