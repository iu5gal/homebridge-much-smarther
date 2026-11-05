# Much Smarther Bridge

Homebridge plugin (`homebridge-much-smarther`) that brings the BTicino Smarther **X8000** thermostat into Apple Home over its local protocol, with no cloud at runtime. Only the first generation (X8000, non-Netatmo) is supported: say so clearly in the docs.

Published on GitHub and npm (MIT). This file holds rules only, so keep it short: details belong in the docs listed below.

> **Privacy rule.** Installation-specific details (IP addresses, hostnames, network layout, the owner's preferences) live in `CLAUDE.local.md`, which is gitignored. Never copy anything from it into tracked files, commits, issues, logs, test fixtures, docs or screenshots. Always use placeholders.

## Where things are

- `packages/core`: XOpen client, no Homebridge dependency. `packages/homebridge-plugin`: plugin, setup page, locales. `packages/simulator`: fake thermostat for the tests.
- [CONTRIBUTING.md](CONTRIBUTING.md): development setup, tools, tests, translations, commit format.
- [docs/PROTOCOL.md](docs/PROTOCOL.md): the protocol. [docs/features.md](docs/features.md): HomeKit mapping and limitations. [docs/SECURITY-MODEL.md](docs/SECURITY-MODEL.md): threat model. [docs/TESTING.md](docs/TESTING.md): manual checks on a real device.
- `notes/` (local only, excluded through `.git/info/exclude`): `FEATURES.md`, the full native features inventory; `TEST-RUNS.md`, the recorded manual runs; local plans.

## Constraints

- **No paid services**: no subscriptions, paid APIs or paid cloud services, for the owner or for users.
- **Small footprint**: runs 24/7 next to other critical services on a Raspberry Pi with 1 GB of RAM. Keep dependencies minimal and stay in the main bridge unless isolation is needed.
- **Native fidelity**: behave like the BTicino app. Check real behaviour on the device and record it, rather than assuming. Functions with no good HomeKit equivalent go on the setup page when useful, and are always listed in the docs.
- **"Verified by Homebridge"**: keep the plugin eligible.
  - Dynamic platform, no unhandled exceptions, runs on all Node LTS versions.
  - Does not start unless configured; configuration in the settings GUI; no TTY.
  - Files only in the Homebridge storage directory; no system changes (systemd units, users, groups, postinstall scripts).
  - No analytics or tracking.
- **Out of scope**: remote access (no VPN, tunnel or port forwarding; the Homebridge UI must never be reachable from the internet). Matter is a possible later addition.

## Security and privacy

- **Placeholders only**: IPs from RFC 5737 (192.0.2.0/24), `example.com`, fake PINs. Fixtures are synthetic or sanitized; raw captures stay in `captures/`. Check screenshots before committing.
- **Commit safeguards**: never bypass the hooks (`.githooks/`: personal denylist in `.git/info/personal-denylist`, gitleaks). Commits use the owner's GitHub noreply e-mail, never a personal address.
- **BTicino credentials**: asked for interactively, used only for the one-time PIN retrieval, kept in memory only. Never stored or logged.
- **PswOpen**: stored in the plugin's storage directory with mode 0600, never in Homebridge `config.json`. Masked in the UI, redacted by the logger, and tests prove it.
- **Cloud login**: TLS certificate verification stays on. If it cannot work with verification, stop and discuss. The cloud helper stays optional and isolated; manual PIN entry must always remain possible.
- **XML parsing**: no DTD, no external entities, no entity expansion. Size limits on messages and buffers, strict validation of every field. XXE and entity-expansion payloads must be rejected, with tests.
- **Commands**: only whitelisted operations reach the thermostat, with validated ranges (setpoint 7–40 in steps of 0.1, boost 30/60/90). No arbitrary passthrough from the UI or the config. Rate-limit and debounce, because Home app sliders fire many updates.
- **Supply chain**: commit the lockfile, pin GitHub Actions by commit SHA, publish to npm with provenance.

## Licensing

- **Prior art declares no license, so do not copy its code.** Implement from `docs/PROTOCOL.md`, written in our own words. Keep the prior art in `reference/` (gitignored) and do not open it during implementation. Credit it in the README.
- **Project license**: MIT, "Copyright (c) 2026 iu5gal and contributors". No real name in the copyright line or in `author` fields.
- **README disclaimer** stays: unofficial, not affiliated with BTicino or Legrand, trademarks used only to describe compatibility.

## Docs and languages

- Documentation in English only, in as few files as possible.
- UI in 43 languages, from `packages/homebridge-plugin/src/locales/`, with English as the reference. Rules are in CONTRIBUTING.md and enforced by tests.

## Testing

- `npm run check` (lint, typecheck, tests with coverage, secret scans, audit) must pass before every commit proposed.
- At least 80 % coverage for `packages/core`. Add tests with every change.
- Manual checks against the real device are in `docs/TESTING.md` and never run in CI. Include coexistence with the native app: the device accepts one local session at a time.

## Roadmap

Follows the GitHub milestones, in this order. Each one starts with a study and a plan, and waits for the owner's approval before any code.

1. **0.2.0 – Weekly programs from the plugin.** Only if the local protocol supports it cleanly. Back up every program before any write; test on an empty slot first.
2. **0.3.0 – Optional SmartThings module**, as a Direct Connected device (MQTT from the Homebridge host to the SmartThings cloud, no hub), off by default.
   - Go/no-go first: no paid plan or service, fits in the memory of a 1 GB Pi, never a second connection to the thermostat, Apple Home side unchanged, "Verified by Homebridge" still possible.
   - Ruled out: an ST Schema connector, or a virtual device through the SmartThings API. Since 2026-11-04 Samsung charges individual developers for OAuth cloud API calls.
   - Each user registers their own test device in the SmartThings Developer Center: document it as a limitation.
3. **0.4.0 – Full use without the BTicino cloud (study).** Find a local way to set up the thermostat, or to set or learn its password. Try nothing that could leave the thermostat unusable without a known way back.

## Working rules

- Before any significant work, explain the plan briefly and wait for approval.
- Ask before:
  - any command that changes the thermostat state;
  - any `sudo`;
  - any install or change on the Pi;
  - any external write: pushes, tags, releases, npm, issues, pull requests, repository settings or visibility.
- Never print, log or commit secrets or personal data.
- Small, descriptive commits. Tests before every deploy.
