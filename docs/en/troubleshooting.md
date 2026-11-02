# Troubleshooting

*[Italiano](../it/troubleshooting.md)*

Start from the Homebridge log (**Logs** in the Homebridge UI). The plugin's lines begin with the accessory name, `[Smarther]` by default, and are in English.

## Messages in the log

| Log message | Meaning | What to do |
| --- | --- | --- |
| `not configured yet: enter the thermostat address in the plugin settings` | No address set. | Enter it on the setup page and save ([setup](setup.md)). |
| `invalid settings, the plugin is not started: …` | A setting in `config.json` is not valid; the message says which. | Fix it on the setup page. The accessory stays in the Home app, as "No response", until then. |
| `no thermostat password yet: set it in the plugin settings page` | The address is set, the password is not. | Retrieve it or type it on the setup page. |
| `the thermostat rejected the password. It was probably reset: …` | The password is wrong, usually because the thermostat was reset. | Retrieve the new password on the setup page. The plugin waits a minute between attempts so as not to stress the thermostat. |
| `connecting to …` then `authenticated` | Connected. | Nothing. |
| `disconnected: no response within 10000 ms` | The thermostat stopped answering: Wi-Fi drop, power cut, router restart. | Nothing: the plugin reconnects by itself, waiting a little longer each time, up to a minute. |
| `disconnected: socket error: connect EHOSTUNREACH …`, `ENETUNREACH`, `ETIMEDOUT` | The address cannot be reached. | If it lasts: check that the thermostat is on its Wi-Fi and that its address has not changed. Give it a fixed address on the router. |
| `disconnected: socket error: connect ECONNREFUSED …` | Something answers at that address, but not the thermostat. | Check the address and the port (usually 40000). |
| `disconnected: connection closed by the thermostat` | The thermostat refused the session, because another local client holds it, or because it still keeps the previous one after a network drop. | Usually it passes at the next attempt. If it lasts: another Homebridge instance or another tool is connected to the thermostat. Stop it: the thermostat accepts one local client. |
| `the thermostat is busy: retrying the command once` | The thermostat asked to wait. | Nothing, unless commands fail. |
| `command failed: …` | A command was not accepted, or the connection dropped while sending it. | Try again; check the state in the BTicino app. |
| `the thermostat reports its temperature as not valid` | The sensor reading is flagged as not valid by the thermostat. | The Home app shows a fault. If it lasts, check the thermostat. |
| `the password file was readable by others: its permissions are now 0600` | The password file had wider permissions, for example after a restore. | Nothing: fixed. |
| `the setup page cannot reach the plugin: …` | The local socket for the setup page could not be opened. | Restart Homebridge. If it persists, check that the Homebridge storage directory belongs to the Homebridge user. |

## In the Home app

**"No response".** The thermostat has been unreachable for more than a minute, or the password is missing or rejected, or the settings are not valid. The log says which.

**The bridge cannot be found when pairing.** The iPhone and Homebridge must be on the same network and see each other through Bonjour (mDNS). Turn off client isolation and multicast filtering on Wi-Fi access points. Check in the Homebridge UI that Homebridge is running.

**A service is called "Switch 2" or similar.** Restart Homebridge: the plugin puts its names back at every start.

**The temperature I set returns to the program later.** That is the default, as in the BTicino app: a manual temperature lasts until the next change of level of the program. You can choose "until changed" or a fixed time in the options.

**The Home app shows "Heat", not "manual".** That is how the Home app shows the thermostat's manual mode: it has no other choice. See [features](features.md).

**Two thermostats appear.** An old bridge is still paired. Remove it from the Home app ([pairing](pairing.md#replacing-a-bridge)).

## On the setup page

**"The plugin is not running."** Homebridge is stopped or still starting, or the plugin is disabled, or it runs in a child bridge that is stopped. Start Homebridge and reopen the page.

**"The thermostat is not connected."** Commands need the connection: see the log messages above.

**"This choice has expired."** The thermostats found on the BTicino account can be chosen for five minutes. Sign in again.

For the messages of the BTicino sign-in, see [setup](setup.md#sign-in-with-your-bticino-account-recommended).

## The BTicino app

**The BTicino app does not work at home without internet.** Expected: the thermostat accepts one local client, and the plugin holds it. With internet, the app works through the cloud as usual.

## Asking for help

When you open an issue, include the plugin, Homebridge and Node.js versions, and the plugin's lines from the log. A debug log (Homebridge debug mode, `-D`) helps, but **review it first**: secrets are masked, but it shows the protocol traffic and details of your installation. Never post the password, the BTicino credentials, the HomeKit setup code, or your network addresses; replace them with placeholders.
