# Changelog

All notable changes to this project are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

Each released version gets a section `## [x.y.z] - YYYY-MM-DD`; the release workflow publishes that section as the GitHub release notes.

## [Unreleased]

## [0.1.3] - 2026-11-03

### Changed

- The plugin is on npm: install it from the Homebridge UI. From this version on, the release workflow publishes it to npm with provenance, through npm trusted publishing.
- The npm page shows the project image, and the package has the `homebridge` and `homekit` keywords.
- `@homebridge/plugin-ui-utils` 2.2.7.

### Security

- Development tools only: minimatch, used by eslint, is forced to 11.0.4 to fix a denial-of-service advisory (GHSA-g3hv-75wg-m249). The published package does not contain it and is not affected.

## [0.1.2] - 2026-11-02

The first version on npm, published by hand on 2026-11-03 from the package attached to this release (without provenance).

### Changed

- The setup page shows Ko-fi's own button, shipped with the plugin, instead of a text link that was hard to read on dark themes. Nothing is loaded from Ko-fi until it is clicked.

## [0.1.1] - 2026-11-02

Not published on npm yet: install the package attached to this release.

### Added

- A link to support the project on Ko-fi, on the setup page (in every language), in the READMEs and in the package metadata.

### Changed

- Documentation in English only, in fewer files: installation, setup and pairing, features, troubleshooting, and security in `SECURITY.md`.
- The documentation makes clear that only the first-generation Smarther (X8000) is supported.
- Tests run against Homebridge 2.5.0 and its hap-nodejs 2.3.0.

## [0.1.0] - 2026-11-02

First release. Verified on a real X8000 in heating, with Homebridge 2.5 on a Raspberry Pi 3. Not published on npm yet: install the package attached to this release.

### Added

- Local client for the XOpen v3 protocol of the BTicino Smarther X8000: authentication, state, events, commands, program and diagnostic files, reconnection.
- Homebridge plugin: a thermostat with Off, Heat and Auto (the weekly program), a humidity sensor, Boost 30/60/90 switches, and optional switches for each program and for "Off until the next change".
- Setup page and Home app names in 43 languages (European Union, other European, Asian and Middle Eastern languages; right to left for Arabic, Hebrew and Persian): password retrieval from the BTicino account or manual entry, status, commands, manual temperature until a chosen time, programs, season and the thermostat's settings.
- Fake thermostat (simulator) for tests and trials.
- User guides: installation on a Raspberry Pi, setup, pairing, features and limitations, troubleshooting, security; a threat model, a security policy and a contributing guide.
- Tests that run on Linux, macOS and Windows; continuous integration on Node.js 22, 24 and 26.
