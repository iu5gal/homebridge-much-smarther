# Much Smarther Bridge

A local bridge that brings the BTicino Smarther **X8000** thermostat (first generation, non-Netatmo) into Apple Home. It runs on a Raspberry Pi and needs no cloud at runtime.

> **Privacy rule.** Installation-specific details (IP addresses, hostnames, network layout, the owner's preferences) live in `CLAUDE.local.md`, which is gitignored.
> - Never copy anything from that file into tracked files, commits, issues, logs, test fixtures, docs or screenshots.
> - Always use placeholders.

## Goals

1. **Local control.** Control the X8000 over its LAN protocol and expose it to Apple Home (HomeKit). The behaviour must be as faithful as possible to the native BTicino Thermostat app.
2. **Small footprint.** Run 24/7 on a Raspberry Pi with 1 GB of RAM that already hosts other critical services, without disturbing them.
3. **Open-source release, only after verification.** Once the tool is built, tested and verified on the real device, publish it on GitHub with:
   - bilingual documentation and UI (English and Italian);
   - automated tests;
   - strict security and privacy hygiene.
4. **No paid services.** Everything must work without subscriptions, paid APIs or paid cloud services, both for the owner and for anyone who uses the project.

### Out of scope for v1

- **Matter.** Homebridge 2.x can expose devices over Matter, but plugins must implement it explicitly. Consider it after v1: it would help users of Google Home, Alexa, Home Assistant or a SmartThings hub.
- **SmartThings.** Without a SmartThings hub, the only routes are cloud-based:
  - an ST Schema connector, which needs an OAuth 2.0 server and an internet-reachable HTTPS endpoint;
  - a virtual device driven through the SmartThings API.

  Samsung is moving SmartThings API access to a paid plan for individual developers (announced for October 2026), which conflicts with the no-paid-services goal. Out of scope.
- **Editing weekly programs.** Out of scope unless the protocol turns out to support it cleanly.
- **Remote access.** No VPN, tunnel or port forwarding in v1. The Homebridge UI must never be reachable from the internet; away from home, users control the thermostat through the BTicino app.

## Known facts about the device

- **Protocol.** "XOpen v3": XML messages (`<OWNMsg>`, OpenWebNet family) over TCP port 40000.
  - HMAC-SHA256 authentication.
  - Push events (EVT), responses (RSP), keep-alive.
- **Local password (PswOpen).**
  - Generated at commissioning and stored in the BTicino cloud.
  - Can be retrieved once by logging in with the Thermostat app account. This uses an unofficial endpoint.
  - Resetting the thermostat changes it.
- **Modes.**
  - `AUTOMATIC`: weekly program.
  - `MANUAL`: fixed setpoint. Setting a temperature switches to `MANUAL`.
  - `BOOST`: 30, 60 or 90 min.
  - `PROTECTION`.
  - `OFF`.
- **Seasonal function.** `HEATING` / `COOLING`.
- **Cloud API.** Legrand's cloud API for this model (Smarther v2.0) exposes the same state model, so it is useful for cross-checking semantics. Fields:
  - function, mode, setpoint, program number;
  - activation time (until when the current mode is kept);
  - load state, measured temperature and humidity.
- **Prior art.** https://github.com/Mirmanero/ha-bticino-x8000, a Home Assistant integration in Python. **It declares no license**: see "Licensing and legal".

## Architecture (default)

- **Language.** TypeScript on a Node.js LTS version supported by Homebridge.
- **Suggested layout.** Monorepo with npm workspaces:
  - `packages/core`: the XOpen client.
    - Connection, authentication, framing and parsing, command builders.
    - State model, keep-alive, reconnection with backoff.
    - No Homebridge dependency.
  - `packages/homebridge-plugin`: the Homebridge plugin.
    - The npm name must start with `homebridge-`.
    - Maps the core state to HomeKit services.
    - Includes a custom setup UI in English and Italian.
  - `packages/simulator`: a fake thermostat implementing the protocol subset, used by the integration tests.
- **Runtime.** Homebridge hosts the plugin.
  - Install it from the official Debian packages on the existing OS.
  - Homebridge already provides web UI, authentication, logs, backups and service management. This keeps our own attack surface small.
- **Alternatives.** If there are strong reasons for a standalone daemon (HAP-NodeJS directly), present the trade-offs and ask before switching.

## Native fidelity

The thermostat must feel native in Apple Home and behave like the BTicino app.

1. **Inventory first.** Before designing any mapping, write `docs/FEATURES.md`. List every native function: device panel, Thermostat app, manuals, cloud API fields. For each one, record:
   - native behaviour;
   - protocol messages involved;
   - HomeKit representation;
   - notes for Matter and SmartThings later;
   - limitations.
2. **Observe real behaviour.** Perform actions in the native app and on the device, with the owner's help, and record the resulting events. Examples:
   - what happens to setpoint and mode when the temperature is changed during `AUTOMATIC`;
   - how `BOOST` ends;
   - what activation time does.
3. **HomeKit baseline.**
   - Thermostat service: current and target temperature (7–40 °C, step 0.1), current and target heating/cooling state, current humidity.
   - Humidity Sensor service.
   - Extra switches only where needed (Boost 30/60/90, Protection, Schedule).
   - All grouped in one accessory, with names in the configured language.
4. **Representing `AUTOMATIC`.** Choose on evidence between HomeKit "Auto" and a separate "Schedule" switch.
   - Prototype both and test them in the Home app.
   - Document the choice and the rationale.
5. **Functions with no good HomeKit equivalent** go in the plugin UI when useful, and are always listed in the docs.

## Security and privacy

### Repository hygiene (from the very first commit)

- **Local only until verified.** Development uses a local git repository. No remote repository (GitHub or other) is created until the owner confirms that the tool is built, tested and verified on the real device.
- **`.gitignore` first.** Create it before `git init` produces any commit.
  - It must include `CLAUDE.local.md`, `reference/`, `captures/`, local config, secrets, Homebridge storage and `.env*`.
  - Also add `CLAUDE.local.md` to the global git ignore file as a second safety net.
- **Personal denylist.**
  - Values that must never appear in the repo live in `.git/info/personal-denylist`. This sits inside `.git` and is never committed. Examples: IP addresses, MAC, serial numbers, plant or gateway names, e-mail addresses.
  - A committed pre-commit hook, containing no personal values, blocks commits that contain any denylisted value.
  - The same hook runs gitleaks, or an equivalent, on staged changes.
- **Git identity.** Commits use the owner's GitHub noreply e-mail, never a personal address.
- **Placeholders only.**
  - Docs and examples use IPs from RFC 5737 (192.0.2.0/24), `example.com` and fake PINs.
  - Test fixtures are synthetic or sanitized captures.
  - Screenshots are checked before committing.
- **Before publishing.** Scan the full history with gitleaks and the denylist, commit by commit. Preferred: publish from a fresh repository with a clean history.

### Secrets handling

- **BTicino credentials.** Asked for interactively and used only for the one-time PIN retrieval. Kept in memory only: never stored, never logged.
- **PswOpen.**
  - Stored in the plugin's storage directory with mode 0600, not in Homebridge `config.json`.
  - Masked in the UI after setup.
  - Never logged: the logger redacts it, and tests prove it.
- **Cloud login.** TLS certificate verification stays on. If it cannot work with verification, stop and discuss.
- **Backups.** Homebridge backups contain secrets: document it.

### Code-level

- **XML parsing.** No DTD, no external entities, no entity expansion. Size limits on messages and buffers. Strict validation of every field.
- **Allowed commands.** Only whitelisted operations reach the thermostat. Validate ranges: setpoint 7–40 in steps of 0.1, boost 30/60/90.
- **No passthrough.** No arbitrary command passthrough from the UI or the config.
- **Command flow.** Rate-limit and debounce commands, because sliders in the Home app fire many updates.
- **Dependencies.**
  - Keep them minimal and commit the lockfile.
  - `npm audit` in the local checks; Dependabot once published.
  - GitHub Actions pinned by commit SHA.
  - npm publish with provenance.

### Deployment

- Change the default Homebridge UI credentials (admin/admin) on first run, and say so in the installation guide.
- Never forward ports or publish the Homebridge UI on the internet.
- Run the plugin in the main bridge unless isolation is needed: each child bridge is another process and costs RAM on a 1 GB Pi.

### Threat model

- Write `docs/SECURITY-MODEL.md`:
  - **Assets:** PswOpen, HomeKit pairing keys, BTicino credentials, the owner's privacy.
  - **Adversaries:** LAN attacker, spoofed device responses, data leaked through the repo, supply chain.
  - **Mitigations.**
  - **Residual risks:** the device's own protocol security is outside our control.
- Add `SECURITY.md` with a vulnerability reporting policy. Enable GitHub private vulnerability reporting at publication.

## Testing

- **Unit tests.**
  - Framing and parsing.
  - HMAC authentication, with test vectors that use fake keys.
  - Command builders.
  - State ↔ HomeKit mapping, table-driven.
  - i18n completeness: every language has exactly the English keys and placeholders, and valid HomeKit names.
- **Property-based / fuzz tests for the parser.**
  - Malformed, truncated and oversized messages.
  - XXE and entity-expansion payloads must be rejected.
- **Integration tests against the simulator.**
  - Authentication failure, disconnects, keep-alive failures.
  - Slow or missing responses, out-of-order events.
  - Reconnection.
- **Plugin tests.** Characteristic get/set behaviour and event propagation.
- **Security tests.** Secrets never appear in logs. Config validation rejects bad values.
- **Coverage.** At least 80 % for `packages/core`.
- **Manual end-to-end checklist** against the real device, in `docs/TESTING.md`. Never run it in CI. Include coexistence with the native app.
- **Checks.** Lint, typecheck, tests, coverage, gitleaks, audit.
  - Until publication they run locally, with a single command (for example `npm run check`).
  - The GitHub Actions workflow is written early but runs only once the repository is published.

## Documentation and UI languages

- **Documentation languages.** English is primary; Italian is maintained in parallel.
  - `README.md` and `README.it.md`.
  - `docs/en/` and `docs/it/`: the user guides, with the same file names in both.
  - Developer references stay in `docs/` in English only: `PROTOCOL.md`, `FEATURES.md`, `TESTING.md`, `SECURITY-MODEL.md`. `docs/it/protocol.md` summarises the protocol in Italian.
- **UI languages.** The setup page and HomeKit service names come from translation files in `packages/homebridge-plugin/src/locales/`, one per language. The language is selectable in the config.
  - 43 languages: all European Union languages, the main other European ones, and the main Asian and Middle Eastern ones.
  - English is the reference; every language has the same keys and placeholders (tested).
  - Translations are AI-assisted, and the README says so and asks for corrections from native speakers.
  - HomeKit names must follow Apple's naming rule; a language that cannot (Hindi, Thai) uses English names in the Home app only.
- **Required docs.**
  - Installation on a Raspberry Pi with Homebridge from the Debian packages.
  - Setup: PIN retrieval or manual entry.
  - Pairing.
  - Features and limitations, from `FEATURES.md`.
  - Troubleshooting.
  - Protocol notes.
  - Security model.
  - Contributing guide and changelog.

## Licensing and legal

- **Prior art has no license, so do not copy its code.**
  - Write `docs/PROTOCOL.md` in our own words, from observed behaviour and study.
  - Implement from that spec.
  - Keep the prior art in `reference/` (gitignored) and do not open it during implementation sessions.
- **Upstream credit.** The owner will ask the prior-art author to add an open-source license. Credit them in the README regardless.
- **Project license.** MIT, chosen by the owner on 2026-11-02: `LICENSE`, "Copyright (c) 2026 iu5gal and contributors". No real name in the copyright line or in `author` fields. The pack script copies `LICENSE` into the plugin and the bundled core.
- **README disclaimer.** Unofficial, not affiliated with or endorsed by BTicino or Legrand. "BTicino", "Smarther", "Apple Home", "HomeKit" and other names are trademarks of their owners, used only to describe compatibility.
- **Cloud PIN-retrieval helper.** It uses an unofficial endpoint. Keep it optional, isolated and clearly documented. Manual PIN entry must always remain possible.

## Phases

0. **Bootstrap (local only).**
   - `.gitignore` first, then the global ignore, git identity, denylist and pre-commit hook.
   - Local repository skeleton and the local check command.
   - No remote repository.
   - No code from `reference/`.
1. **Discovery.**
   - Read-only connection test against the real device.
   - Write `docs/PROTOCOL.md` and `docs/FEATURES.md`.
   - Capture and sanitize sample messages. Raw captures stay in `captures/`, which is gitignored.
2. **Core, simulator and tests.**
3. **Homebridge plugin, setup UI (EN/IT) and tests.** Try it on the development machine with a temporary Homebridge instance.
4. **Deploy on the Pi.**
   - Homebridge from the official Debian packages; the plugin from a local package.
   - Measure memory use.
   - Verify that the other services on the Pi are untouched.
5. **Pairing and fidelity.** Pair with Apple Home, then iterate on fidelity against the native app.
6. **Hardening and docs.** Threat model, `SECURITY.md`, bilingual docs, all local checks green.
7. **Publication, only after the owner confirms the tool is built, tested and verified.**
   - History and secret audit.
   - Create the GitHub repository at this point, fresh, from a clean history.
   - GitHub settings: secret scanning with push protection, Dependabot, branch protection, private vulnerability reporting.
   - Release v0.1.0.
8. **Later (optional).** Matter via Homebridge 2.x; other ecosystems.

## Acceptance criteria (v1)

- **Apple Home.**
  - Current temperature and humidity, target temperature and off/heating all work.
  - The chosen representations of `AUTOMATIC`, `BOOST` and `PROTECTION` work.
- **Sync.** Changes made on the device or in the native app show up within a few seconds.
- **Resilience.** Survives restarts of the Pi, Homebridge and the thermostat, and Wi-Fi drops.
- **Native app.** The BTicino app keeps working. If the device allows only one local client at a time, document it.
- **Footprint.** Memory use is measured, documented and comfortable on a 1 GB Pi. Other services on the Pi are unaffected.
- **Privacy and quality.** No personal data in the repository or its history. All tests and security checks pass locally, and in CI once published.

## Working rules

- Before each phase, explain the plan briefly and wait for approval.
- Ask before:
  - any command that changes the thermostat state;
  - any `sudo`;
  - any install or change on the Pi;
  - creating a remote repository or pushing to one: never before the owner confirms the tool is verified (Phase 7);
  - any change of repository visibility.
- Never print, log or commit secrets or personal data.
- Small, descriptive commits. Tests before every deploy.
