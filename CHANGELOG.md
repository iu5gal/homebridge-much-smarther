# Changelog

All notable changes to this project are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

Each released version gets a section `## [x.y.z] - YYYY-MM-DD`; the release workflow publishes that section as the GitHub release notes.

## [Unreleased]

### Changed

- The GitHub repository is now called `homebridge-much-smarther`, like the npm package. Old links keep working.

## [0.2.1] - 2026-11-08

### Changed

- The package page on npm shows the *Verified by Homebridge* badge, the Ko-fi button and the current status of the project. Documentation only: the plugin itself does not change.

## [0.2.0] - 2026-11-07

### Added

- **Weekly programs on the setup page:** create, edit, duplicate and delete them. One screen, with the whole week in view: choose a day, its times and levels, and copy it to other days. Several programs can be open at once, and the one in use opens by itself.
- **Safe writes:** before a change the plugin keeps a copy of what it replaces and of every program before the first change. Each program is read back and compared after writing. A program changed elsewhere meanwhile is not overwritten. The last 10 versions of each program can be restored from the page.
- The list of programs follows changes announced by the thermostat.

### Changed

- The Programs tab shows the temperature levels in the colours used by the programs.
- A saved program does not become active by itself, unlike in the BTicino app. Saving the program in use takes effect at once.

## [0.1.5] - 2026-11-04

### Fixed

- `config.schema.json` lists the required settings (`name`, `host`) as an array at object level, as JSON Schema requires, instead of `"required": true` on each field.
- The package declares the `supports-hap` keyword: it publishes its accessories over HomeKit (HAP) only, and does not register Matter accessories itself.

## [0.1.4] - 2026-11-03

The first version published to npm by the release workflow. Version 0.1.3 was tagged but never released: its workflow stopped before publishing anything.

### Added

- A project icon, also next to the README title.

### Fixed

- The release workflow passes the package file to `npm publish` as `./pack/…`: without `./`, npm read the path as a GitHub repository.

### Changed

- The plugin is on npm: install it from the Homebridge UI. From this version on, the release workflow publishes it to npm with provenance, through npm trusted publishing.
- The npm page shows the project image, and the package has the `homebridge` and `homekit` keywords.
- `@homebridge/plugin-ui-utils` 2.2.7.

### Security

- Development tools only: minimatch, used by eslint, is forced to 11.0.4 to fix a denial-of-service advisory (GHSA-g3hv-75wg-m249). The published package does not contain it and is not affected.

## [0.1.2] - 2026-11-02

The first version on npm, published by hand on 2026-11-03 from the package attached to this release (without provenance). Later versions are published by the release workflow, with provenance.

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
