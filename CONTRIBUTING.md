# Contributing

Contributions from anyone are gladly accepted: bug reports, tests on systems we could not try (**Windows above all, where everything still has to be tried**), fixes, new features within the project's scope, and corrections to the translations. This project was built with the support of Claude, Anthropic's AI assistant; contributions written with AI tools are welcome too, as long as you have reviewed and tested them and they follow the rules below.

Thank you for helping. This project controls heating in real homes, and it runs where people keep personal data, so it has a few firm rules. Please read them before your first change.

By contributing, you agree that your contribution is licensed under the [MIT License](LICENSE) of the project.

## Ground rules

1. **No personal data, ever.** No IP or MAC addresses of your installation, serial numbers, plant or gateway names, e-mail addresses, passwords, HomeKit setup codes or network captures, in code, tests, docs, commits, issues or screenshots. Use placeholders: addresses from 192.0.2.0/24 (RFC 5737), `example.com`, fake passwords such as `fake-pin-0000`.
2. **No code from other projects without a compatible license.** In particular, the Home Assistant integration credited in the README declares no license, so its code must not be copied. The protocol is implemented from [docs/PROTOCOL.md](docs/PROTOCOL.md), written in our own words. New protocol knowledge goes there first, with its source tag.
3. **Only safe commands reach the thermostat.** New commands are whitelisted operations with validated ranges. No raw message passthrough from HomeKit, the setup page or the configuration.
4. **Security issues are reported privately**: see [SECURITY.md](SECURITY.md).

## Development setup

You need Node.js 22, 24 or 26, and [gitleaks](https://github.com/gitleaks/gitleaks).

```sh
npm ci
npm run hooks:install
```

Then create your **personal denylist**, `.git/info/personal-denylist`. It lives inside `.git`, so it is never committed. The hooks refuse to commit without it. Put in it the values that must never leave your machine, one per line:

```text
# my installation
literal:192.0.2.
exact:my-pi-hostname
literal:AA:BB:CC:DD:EE:FF
```

- `literal:` matches anywhere, ignoring case.
- `exact:` matches a whole word only, so `exact:kitchen` does not block `kitchen-light`.

The pre-commit hook checks staged files and paths against it and runs gitleaks; the commit-msg hook checks the message.

## Checks

```sh
npm run check
```

It runs lint, type check, all tests with coverage (at least 80 % for `packages/core`), the secret scans (denylist on every tracked file, gitleaks on the history and the working tree) and `npm audit`. It must pass before every commit you propose. CI runs the same once the repository is public.

## Trying things

- `npm run simulator` starts a fake thermostat on `127.0.0.1:40001`, password `fake-pin-0000`. The integration and plugin tests use it too.
- Tools for a real thermostat, **only your own**, and only while Homebridge is stopped, because the thermostat accepts one local session:
  - `npm run session -- <address>`: read-only session that prints the state and events;
  - `npm run files -- <address>`: reads diagnostics, configuration and programs;
  - `npm run command -- <address> …`: sends one command, after showing it and asking for confirmation. **It changes the thermostat's state.**
  - `npm run pswopen`: retrieves the password from your BTicino account and shows it once in the terminal, without saving it.
  - The tools read the password from the macOS Keychain, or ask for it without echo. They never store it.
- Raw captures go in `captures/`, which is ignored by git. Fixtures in `packages/core/test/fixtures/` must be synthetic or sanitised by hand.
- `npm run pack:plugin` builds the installable package in `pack/`.

## Tests

Add tests with every change:

- core: framing, parsing (including property-based tests with fast-check for malformed input), authentication with fake keys, command builders, state;
- plugin: the state ↔ HomeKit mapping as tables, characteristic get/set, the setup page requests;
- security: secrets never appear in logs; invalid configuration is rejected.

The manual checks against a real device are in [docs/TESTING.md](docs/TESTING.md). They never run in CI.

## Translations

The setup page and the Home app names come from `packages/homebridge-plugin/src/locales/`, one file per language, with English (`en.ts`) as the reference. The translations were made with AI assistance: corrections from native speakers are very welcome.

- Keep every key and every `{placeholder}` of English; the tests check it.
- Names in the Home app (`service.*`) must follow Apple's rule: letters, numbers, spaces and a little punctuation, starting and ending with a letter or number. The tests check that too.
- A new language also needs an entry in `LANGUAGE_INFO` (`src/i18n.ts`) and in `config.schema.json`.

## Documentation

The documentation is in English: `README.md`, `docs/`, `SECURITY.md` and this guide. Keep it short and in step with the code.

## Commits and pull requests

- Small commits, each doing one thing, with messages in the form `type(scope): summary`, for example `fix(core): …`, `feat(plugin): …`, `docs: …`, `test: …`, `build: …`, `ci: …`.
- Add a line to the `[Unreleased]` section of [CHANGELOG.md](CHANGELOG.md) for anything a user would notice.
- Describe in the pull request what you tested, and on what: simulator, or a real thermostat with which firmware.
