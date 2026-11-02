# @much-smarther/core

TypeScript client for the local XOpen v3 protocol of the first-generation BTicino Smarther thermostat, model **X8000**. It has no Homebridge dependency and no runtime dependencies besides Node.js (22, 24 or 26).

The protocol itself is described in [docs/PROTOCOL.md](https://github.com/iu5gal/much-smarther-bridge/blob/main/docs/PROTOCOL.md); section numbers below (§) refer to it.

> **Partly verified on a real device.** Authentication, reading the state, events, keep-alive, the program list, diagnostics and device files have been checked against a real X8000, and so has every `SET` this library builds (manual, timed manual, boost, off, timed off, back to the program). Heating only: cooling has not been tried. Points marked **[PA]** or **[ASM]** in PROTOCOL.md may still turn out wrong.

## Quick start

```ts
import { XOpenClient } from '@much-smarther/core';

const client = new XOpenClient({
  host: '192.0.2.10',  // the thermostat's LAN address
  password: pswOpen,    // string or Secret; never logged
  logger: myLogger,     // optional; every line is redacted
});

client.on('state', (state) => console.log(state.mode, state.setpoint, state.ambientTemperature));
client.on('authenticationFailed', (error) => console.error(error.message));
client.start();

// Later, once client.status === 'ready':
await client.setDeviceState({ mode: 'MANUAL', function: 'HEATING', setpoint: 21.5 });
await client.setDeviceState({ mode: 'BOOST', function: 'HEATING', minutes: 60 });
await client.setDeviceState({ mode: 'AUTOMATIC', function: 'HEATING' });

client.stop();
```

## More

- It is bundled inside the Homebridge plugin and not published on its own.
- Every exported class and function is documented in the source (`src/`), and `test/` shows each one at work.
- Besides the client: `retrievePswOpen` (`@much-smarther/core/cloud`) reads the password from the BTicino account through an unofficial service; the program helpers compute the next change of level; a redacting logger and a `Secret` type keep the password out of logs.
- `npm run simulator` starts a fake thermostat (`packages/simulator`) to try it without the real device.
