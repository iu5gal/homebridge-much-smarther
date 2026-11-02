#!/usr/bin/env node
// Runs the fake thermostat of packages/simulator on this computer, to try the
// Homebridge plugin without the real device. It answers like the observed
// X8000 (one session at a time, duplicate events, files and diagnostics) and
// accepts commands. Its password is fake and printed below.
//
// Usage: npm run simulator -- [port]   (default 40001)

import { clearInterval, setInterval } from 'node:timers';
import { FakeThermostat } from '@much-smarther/simulator';
import { out } from './lib/terminal.mjs';

const PASSWORD = 'fake-pin-0000';

async function main() {
  const port = Number(process.argv[2] ?? 40001);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('usage: npm run simulator -- [port]');
  const thermostat = new FakeThermostat({ password: PASSWORD, behaviour: { duplicateEvents: true } });
  await thermostat.start(port);
  out(`Fake thermostat on 127.0.0.1:${port}, password ${PASSWORD}. Ctrl+C to stop.`);
  out('Changes made by clients are printed below.');
  let last = '';
  const timer = setInterval(() => {
    const { params } = thermostat;
    const line = ['mode', 'function', 'setpoint', 'program_number', 'heating_thermoregulation_load_state']
      .map((key) => `${key}=${params.get(key) ?? '?'}`)
      .join(' ');
    if (line !== last) out(`[${new Date().toLocaleTimeString()}] ${line}`);
    last = line;
  }, 500);
  process.on('SIGINT', () => {
    clearInterval(timer);
    void thermostat.stop().then(() => out('\nStopped.'));
  });
}

main().catch((error) => {
  process.stderr.write(`\nError: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
