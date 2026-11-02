# Security model

This document describes what Much Smarther Bridge protects, from whom, how, and what it cannot protect. It covers the Homebridge plugin, the core library and the development tools in this repository. To report a vulnerability, see [SECURITY.md](../SECURITY.md).

## 1. System overview

```text
 iPhone (Home app)                         Browser (Homebridge UI)
        │ HAP, encrypted                          │ HTTP or HTTPS, Homebridge login
        ▼                                         ▼
 ┌───────────────────────── Homebridge host (e.g. Raspberry Pi) ─────────────────────────┐
 │  Homebridge ── plugin (controller, accessory) ◄── Unix socket 0600 ── setup page      │
 │                    │                              + access key        server process   │
 │                    │                                                       │          │
 │   storage/much-smarther/ (0700): pswopen, control-key, control.sock (0600)  │          │
 └────────────────────┼───────────────────────────────────────────────────────┼──────────┘
                      │ XOpen v3, TCP 40000, LAN only                          │ HTTPS, once,
                      ▼ (HMAC handshake, then clear text)                      ▼ on request
               Smarther X8000                                      BTicino cloud (unofficial
                                                                   endpoint, PswOpen retrieval)
```

- At runtime the plugin talks only to the thermostat, on the local network. It opens no network port of its own.
- The BTicino cloud is contacted only when the user asks the setup page to retrieve the password, once.
- Away from home the user controls the thermostat through the BTicino app and cloud, not through this project.

## 2. Assets

| Asset | Where it lives | Why it matters |
| --- | --- | --- |
| **PswOpen**, the thermostat's local password | `<storage>/much-smarther/pswopen`, mode 0600, directory 0700; in memory while the plugin runs. Never in `config.json`. | It gives full local control of the thermostat. It is probably also what the thermostat uses towards the BTicino cloud. A thermostat reset changes it. |
| **HomeKit pairing keys** | Homebridge's `persist/` directory (managed by Homebridge). | Whoever has them can control every accessory of the bridge. |
| **HomeKit setup code** | Homebridge's `config.json`, shown in the Homebridge UI and log. | It allows pairing while the bridge is not paired. |
| **BTicino account credentials** | Typed by the user in the setup page; in memory for one request only. Never stored, never logged. | Access to the BTicino account: every thermostat of the account, remotely. |
| **Setup page access key** | `<storage>/much-smarther/control-key`, mode 0600, new at each start. | It authorises commands from the setup page server to the plugin. |
| **The owner's privacy** | Installation names, MAC addresses, network addresses, Wi-Fi data in the thermostat's configuration file, habits visible in programs and logs. | Personal data. It must not leak into logs, backups shared by mistake, or this repository. |
| **Correct heating** | The thermostat itself. | A wrong command can leave a home cold, or run a boiler when cooling was meant. |

## 3. Adversaries

| Adversary | Capabilities assumed |
| --- | --- |
| **A1. LAN attacker** | A device on the same network: it can sniff, inject, spoof the thermostat's address, and connect to any port of the Homebridge host. |
| **A2. Spoofed or faulty device** | Whatever answers on port 40000 at the configured address: it can send malformed, oversized or hostile XML, or valid messages with absurd values. |
| **A3. Other local users** | Other accounts or processes on the Homebridge host, without root and without the Homebridge user's rights. |
| **A4. Repository leak** | Personal data or secrets committed by mistake by a contributor, and so published forever in the history. |
| **A5. Supply chain** | A compromised npm dependency, GitHub Action or release process. |
| **A6. Internet attacker** | Only if the user exposes the Homebridge UI or host to the internet, which the documentation forbids. |

Out of scope: an attacker with root on the Homebridge host, physical access to the thermostat, and the security of the BTicino cloud and app.

## 4. Threats and mitigations

### 4.1 Thermostat connection (A1, A2)

| Threat | Mitigation |
| --- | --- |
| Password captured on the wire | The XOpen handshake never sends the PswOpen: it is a SHA-256 challenge and response, called HMAC by the device although it is a plain hash (`docs/PROTOCOL.md` §4). The client also checks the thermostat's answer, so a fake device that does not know the password is detected and dropped. |
| Malicious XML: entity expansion, external entities, DTDs | The core has its own small parser (`packages/core/src/xml.ts`). It rejects DOCTYPE and every `<!…>` construct, processing instructions, unknown entities, control characters and duplicate attributes. CDATA is accepted only inside the elements that carry files, and is never parsed. |
| Oversized or endless input | Limits everywhere: 64 KiB per frame and per XML document, depth 16, 1,024 elements, 32 attributes, 1 KiB per parameter, 48 KiB per file, 64 bytes per OpenWebNet frame. Over a limit, the connection is dropped. |
| Absurd or inconsistent values | Every field is validated; invalid values are ignored, reported as issues, and never reach HomeKit. A temperature flagged invalid by the device is shown as a fault. |
| A device that stops answering | Keep-alive every 10 s; any missing answer closes the session within 10 s. Reconnection with exponential backoff and jitter, capped at 60 s. After an authentication failure it waits the maximum delay, so that it does not hammer the device. |
| Command flooding | Commands are queued (16 at most), serialised, spaced by at least 250 ms, and the Home app's slider is debounced (1 s) so that only the last value is sent. |
| Commands outside the safe set | Only whitelisted operations exist in the code: manual temperature (7–40 °C, step 0.1, end up to 10 days ahead), boost 30/60/90 min, off, program, season. There is no passthrough of raw messages from HomeKit, the setup page or `config.json`. |
| Cooling on a heating-only system | Changing the season from the Home app is off by default (`seasonFromHome`), and the setup page asks for confirmation with a warning. |

### 4.2 The Homebridge host (A3)

| Threat | Mitigation |
| --- | --- |
| Reading the PswOpen | Stored with mode 0600 in a 0700 directory owned by the Homebridge user. A file found with wider permissions is tightened at start, and the log says so. |
| Commands from another local user | The setup page reaches the plugin through a Unix socket with mode 0600 (on Windows a named pipe), never a TCP port. Every request also carries an access key, rewritten at every start and compared in constant time. Requests are a fixed list; payloads are validated and size-limited. |
| A stale socket pointing elsewhere | At start the plugin removes a leftover socket only if the path really is a socket. |

### 4.3 Setup page and cloud retrieval (A1, A6)

| Threat | Mitigation |
| --- | --- |
| Using the setup page without permission | It is part of the Homebridge UI, behind the Homebridge login. |
| Leaking the BTicino credentials | Used for one request, kept in memory only, never stored and never logged. |
| A fake cloud server | HTTPS with the platform's normal certificate verification, which is never relaxed. Fixed host. Responses over 1 MiB are refused. |
| Leaking the cloud response | Only the PswOpen is kept, server side, for five minutes, while the user picks the thermostat. The browser gets only a masked MAC address and a description. Error messages from below are replaced by fixed message keys. |
| Locking the BTicino account | A "locked" answer is shown with the waiting time; the page does not retry by itself. |

### 4.4 Logs (A3, A4)

- Every line passes through a redacting logger: the PswOpen, file contents, CDATA sections and sensitive fields are replaced with `[redacted]`. Tests check that secrets never reach the log.
- Secrets are wrapped in a `Secret` type whose string, JSON and `inspect` forms are `[redacted]`.
- Even so, debug logs (`-D`) show protocol traffic and installation details: review them before sharing.

### 4.5 Repository and releases (A4, A5)

- `.gitignore` covers local notes, captures, prior art, Homebridge storage, keys and `.env` files.
- A committed pre-commit hook runs a personal denylist, kept outside the repository in `.git/info/personal-denylist`, and gitleaks on the staged changes. It refuses to commit when gitleaks is missing.
- Documentation and tests use only placeholders (RFC 5737 addresses, `example.com`, fake passwords); test fixtures are synthetic or sanitised.
- Before publication the full history is scanned, commit by commit, and the repository is published from a clean history.
- Dependencies: two runtime dependencies (`@homebridge/plugin-ui-utils` and the project's own core, bundled). The lockfile is committed. `npm audit` runs in the local checks; Dependabot once published.
- No install scripts in the package; it is installed with `--ignore-scripts`.
- GitHub Actions pinned by commit SHA, with minimal permissions. Releases are published by npm trusted publishing with provenance: no npm token is stored.

## 5. Residual risks

These are outside the project's control, or accepted for v1.

1. **The protocol is not encrypted after the handshake.** A LAN attacker can read the thermostat's state and inject commands into an open session. This is a property of the device. Keep the thermostat on a trusted network; untrusted devices belong on a guest network.
2. **Offline guessing of the PswOpen.** A captured handshake (`Ra`, `Rb`, `Dc`) allows an offline guessing attack on the password. Treat network captures as secrets.
3. **Homebridge UI over plain HTTP.** By default the Homebridge UI is served without TLS. The Homebridge login, a manually typed PswOpen and the BTicino credentials then cross the LAN in clear text. Use the setup page from a trusted network, or enable HTTPS in the Homebridge UI.
4. **Backups contain secrets.** A Homebridge backup includes the PswOpen, the pairing keys and the setup code. Store backups like passwords.
5. **One local session.** The plugin holds the thermostat's only local session. Whoever connects first wins, so a rogue client on the LAN could deny service to the plugin. Without internet, the BTicino app cannot reach the thermostat while the plugin is connected.
6. **Unofficial cloud endpoint.** The password retrieval uses an undocumented endpoint, which may change, disappear, or start behaving differently. Manual entry of the password always remains possible.
7. **Root and the Homebridge user.** Anyone with root, or with the Homebridge user's rights, can read every secret. So can every other Homebridge plugin, because plugins run in the same process: install only plugins you trust.
8. **Translations.** The texts in 43 languages were made with AI assistance. A wrong translation could mislead a user about a warning, for example the one about cooling.

## 6. Guidance for users

- Change the Homebridge UI password on first run, or create a strong one when the UI asks.
- Never forward ports to the Homebridge host, and never publish the Homebridge UI on the internet.
- Give the thermostat a fixed address on the router.
- After a thermostat reset, retrieve the new password from the setup page.
- Treat Homebridge backups and debug logs as private.

The same points, for users, are in [SECURITY.md](../SECURITY.md#running-it-safely).
