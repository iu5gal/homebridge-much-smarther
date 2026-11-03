# Installation on a Raspberry Pi

This guide installs Homebridge from its official Debian packages, then the plugin. It was followed on a Raspberry Pi 3 with 1 GB of RAM and the 64-bit Raspberry Pi OS (Debian 13), with other services already running. Other Debian or Ubuntu machines work the same way.

Next step: [setup and pairing](setup.md).

## What you need

- A **first-generation** BTicino Smarther, model **X8000** (not the later Smarther2 with Netatmo), already set up with the BTicino Thermostat app and connected to your Wi-Fi.
- A Raspberry Pi, or another always-on Linux machine, on the same network.
- An iPhone or iPad with the Home app, on the same network.
- To retrieve the thermostat's password: the e-mail and password of the BTicino account the thermostat belongs to. Alternatively, the password itself, if you already have it.

## 1. Prepare the network

1. **Give the thermostat a fixed address** on your router (a DHCP reservation). The plugin connects to that address. Do the same for the Raspberry Pi.
2. **Let the devices see each other.** The Home app finds Homebridge through Bonjour (mDNS). On Wi-Fi access points, keep client isolation and multicast filtering off for the home network.
3. **Do not open any port** on the router: nothing here needs to be reachable from the internet.

## 2. Install Homebridge

Follow the official guide, [Install Homebridge on Debian or Ubuntu Linux](https://github.com/homebridge/homebridge/wiki/Install-Homebridge-on-Debian-or-Ubuntu-Linux). At the time of writing it comes down to:

```sh
sudo apt-get update
sudo apt-get install -y curl gpg
curl -sSfL https://repo.homebridge.io/KEY.gpg | sudo gpg --dearmor | sudo tee /usr/share/keyrings/homebridge.gpg > /dev/null
echo "deb [signed-by=/usr/share/keyrings/homebridge.gpg] https://repo.homebridge.io stable main" | sudo tee /etc/apt/sources.list.d/homebridge.list > /dev/null
sudo apt-get update
sudo apt-get install homebridge
```

The package:

- brings its own Node.js in `/opt/homebridge`, and leaves any other Node.js alone;
- runs Homebridge as the `homebridge` user, with the `homebridge` systemd service, started at boot;
- keeps its data in `/var/lib/homebridge`;
- serves the Homebridge UI on port 8581.

Then open `http://<pi-address>:8581` in a browser, for example `http://192.0.2.20:8581`.

**On the first visit, create the administrator account** with a strong password. If your version starts with the user `admin` and the password `admin`, change them at once.

## 3. Install the plugin

### From the Homebridge UI

In the Homebridge UI, open **Plugins**, search for `homebridge-much-smarther` and install it. Homebridge asks to restart.

### From a package file

Instead of the Homebridge UI, you can install the package attached to a release, for example to try a version by hand. Download `homebridge-much-smarther-<version>.tgz` from the [releases page](https://github.com/iu5gal/much-smarther-bridge/releases). Copy it to the Pi, for example with `scp`, then on the Pi:

```sh
sudo install -d -o homebridge -g homebridge /var/lib/homebridge/local-packages
sudo install -o homebridge -g homebridge -m 0644 homebridge-much-smarther-<version>.tgz /var/lib/homebridge/local-packages/
cd /var/lib/homebridge
sudo -u homebridge env PATH=/opt/homebridge/bin:/usr/bin:/bin HOME=/var/lib/homebridge \
  npm --prefix /var/lib/homebridge install --ignore-scripts ./local-packages/homebridge-much-smarther-<version>.tgz
sudo systemctl restart homebridge
```

- The file stays in `local-packages`: npm records its path, and later installs need it.
- `--ignore-scripts` is a precaution; the package has no install scripts.
- The command uses Homebridge's own Node.js and npm, as the `homebridge` user, so that the files belong to it.

### Main bridge or child bridge

Keep the plugin in the **main bridge**, which is the default. A child bridge is a separate process and costs extra memory, which matters on a 1 GB Pi.

## 4. Check

In the Homebridge UI, open **Logs**. After the restart you should see:

```text
[Smarther] not configured yet: enter the thermostat address in the plugin settings
```

That is expected: continue with the [setup](setup.md).

## Resources

Measured on a Raspberry Pi 3 (1 GB), Homebridge 2.5 from the Debian package, with this plugin only:

| What | Value |
| --- | --- |
| Memory taken by Homebridge and its UI | about 125 MiB of available memory |
| Memory added by the plugin | about 10–15 MiB more |
| Resident memory, once settled | Homebridge with the plugin about 105 MB, Homebridge UI service about 155 MB (both include shared memory) |
| While the setup page is open | one more process of about 70 MB, which ends when the page is closed |
| After 23 hours | unchanged: no growth |

| Event | Plugin connected again after |
| --- | --- |
| Homebridge restart | about 15 s |
| Raspberry Pi reboot | about 1.5 min from the reboot command |
| Router restart | about 30 s after the network came back |

The plugin notices a lost connection within 10 s. The Home app shows "No response" only if the thermostat stays unreachable for more than a minute.

## Updating

- From the Homebridge UI: **Plugins**, then update.
- From a package file: copy the new file and run the same `npm install` command with the new name, then restart Homebridge. You can delete the old file from `local-packages` afterwards.

## Uninstalling

1. Remove the bridge from the Home app, if you no longer use Homebridge.
2. Uninstall the plugin from the Homebridge UI, or with `npm --prefix /var/lib/homebridge uninstall homebridge-much-smarther` run like the install command above.
3. Delete `/var/lib/homebridge/much-smarther`, which holds the thermostat's password.

To remove Homebridge as well: `sudo apt-get remove homebridge`, then delete `/var/lib/homebridge`, which holds the pairing keys and the backups.
