# Security

## Running it safely

What you should know to run the plugin safely. The full threat model, for developers and reviewers, is in [docs/SECURITY-MODEL.md](docs/SECURITY-MODEL.md).

### What the plugin protects

- **The thermostat's password (PswOpen)** is stored in `<Homebridge storage>/much-smarther/pswopen`, readable only by the Homebridge user (mode 0600, directory 0700). It is not in `config.json` and is never written to the log.
- **Your BTicino e-mail and password** are used for one request, when you ask the setup page to retrieve the thermostat's password. They are never saved and never logged.
- **No network port.** The plugin talks to the thermostat on your LAN, and the setup page talks to the plugin through a local socket protected by an access key.
- **Only safe commands.** The plugin sends a fixed set of commands with checked values: temperature 7–40 °C, boost 30, 60 or 90 minutes, off, program, season. It also writes the weekly programs you edit on the setup page: only programs 1–10, built field by field from checked values and read back after writing, with a copy kept of what they replace. Nothing else can be sent to the thermostat through it.

### What you should do

1. **Protect the Homebridge UI.** On the first visit, create an administrator account with a strong password. If your version starts with `admin` / `admin`, change it at once.
2. **Never expose Homebridge to the internet.** No port forwarding, no publishing the UI. Away from home, use the BTicino app.
3. **Give the thermostat a fixed address** on your router, so the plugin always finds it.
4. **Keep backups private.** A Homebridge backup contains the thermostat's password, the HomeKit pairing keys and the setup code. Store it like a password.
5. **Review debug logs before sharing them.** Secrets are masked, but debug logs (`-D`) show the protocol traffic and details of your installation.
6. **Install only plugins you trust.** All Homebridge plugins run in the same process and can read each other's files.

### Limits you cannot fix from here

- **The thermostat's protocol is not encrypted** after the login. A device on your network could read the state or inject commands. Keep the thermostat on a trusted network; guests and untrusted devices belong on a guest network.
- **The Homebridge UI uses plain HTTP by default.** Your Homebridge login, and the password you type in the setup page, cross the network unencrypted. Use it from your home network, or enable HTTPS in the Homebridge UI settings with your own certificate.
- **The password retrieval uses an unofficial BTicino service.** It may stop working. Typing the password by hand always remains possible.
- **One local client at a time.** The thermostat accepts a single local session, and the plugin keeps it. Without internet, the BTicino app cannot reach the thermostat while Homebridge runs.

## Supported versions

Only the latest released version receives security fixes.

## Reporting a vulnerability

Please **do not open a public issue** for a vulnerability.

Report it privately through GitHub: on the repository page, open **Security → Report a vulnerability**. This uses GitHub's private vulnerability reporting, so only the maintainers see the report.

Please include:

- the affected version, and your Homebridge and Node.js versions;
- what an attacker can do, and under which conditions (for example "on the same LAN");
- the steps to reproduce, ideally against the simulator (`npm run simulator`) rather than a real thermostat.

**Never include real secrets or personal data:** no thermostat password (PswOpen), BTicino credentials, HomeKit setup codes, network captures, IP or MAC addresses of your installation. Use placeholders.

What to expect:

- an acknowledgement within 7 days;
- an assessment, and a plan or a fix, as soon as possible; this is a volunteer project;
- credit in the release notes, if you wish.

## Scope

In scope: this repository's code, that is the Homebridge plugin, its setup page, the core library and the tools.

Out of scope, but welcome as information:

- the thermostat's own protocol, which is not encrypted after the handshake, and the BTicino app and cloud: report those to BTicino / Legrand;
- Homebridge and its UI: report those to the Homebridge project.

The threat model, with the known residual risks, is in [docs/SECURITY-MODEL.md](docs/SECURITY-MODEL.md).
