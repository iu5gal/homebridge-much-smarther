#!/usr/bin/env node
// Read-only session with a real thermostat, for protocol discovery.
//
// It authenticates, reads the state and the program list, then only listens
// for events and sends keep-alives. It never sends SET commands, so the
// thermostat state is not changed.
//
// - The PswOpen is read from the macOS Keychain (tools/lib/keychain.mjs) or,
//   if it is not there, typed without echo. This tool never stores it.
// - Every frame is logged to captures/ (gitignored, mode 0600); the library
//   redacts the PswOpen and the handshake material.
// - The session ends at the first authentication failure, without retrying.
//
// Usage: npm run session -- <thermostat-address[:port]> [minutes]   (0 = until Ctrl+C)

import { closeSync, mkdirSync, openSync, writeSync } from 'node:fs';
import { XOpenClient } from '@much-smarther/core';
import { readPswOpenFromKeychain } from './lib/keychain.mjs';
import { summarise } from './lib/summary.mjs';
import { out, readHidden, requireTerminal } from './lib/terminal.mjs';

const TARGET = /^([A-Za-z0-9.-]{1,253})(?::([0-9]{1,5}))?$/;

async function main() {
  requireTerminal();
  const [target = '', minutesArg = '0'] = process.argv.slice(2);
  const match = TARGET.exec(target);
  const minutes = Number(minutesArg);
  if (!match || !Number.isInteger(minutes) || minutes < 0) {
    throw new Error('usage: npm run session -- <thermostat-address[:port]> [minutes]');
  }
  const host = match[1] ?? '';
  const port = match[2] === undefined ? undefined : Number(match[2]);

  mkdirSync('captures', { recursive: true, mode: 0o700 });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const path = `captures/session-${stamp}.log`;
  const file = openSync(path, 'a', 0o600);
  /** @param {string} level @param {string} message */
  const write = (level, message) => writeSync(file, `${new Date().toISOString()} ${level} ${message}\n`);
  const logger = {
    /** @param {string} m */ debug: (m) => write('DEBUG', m),
    /** @param {string} m */ info: (m) => write('INFO', m),
    /** @param {string} m */ warn: (m) => write('WARN', m),
    /** @param {string} m */ error: (m) => write('ERROR', m),
  };

  const fromKeychain = readPswOpenFromKeychain();
  if (fromKeychain !== undefined) out('PswOpen: read from the macOS Keychain.');
  const password = fromKeychain ?? (await readHidden('PswOpen (hidden): '));
  if (password === '') throw new Error('the PswOpen is required');

  const client = new XOpenClient({ host, password, logger, ...(port === undefined ? {} : { port }) });
  let states = 0;
  let disconnects = 0;
  let firstReady = true;
  /** @type {(code: number) => void} */
  let finish = () => {};
  const done = new Promise((resolve) => {
    finish = (code) => {
      client.stop();
      write('INFO', `session ended: ${states} state report(s), ${disconnects} disconnection(s)`);
      closeSync(file);
      out(`\nEnded: ${states} state report(s), ${disconnects} disconnection(s). Log: ${path}`);
      resolve(code);
    };
  });

  client.on('status', (status) => out(`[${new Date().toLocaleTimeString()}] status: ${status}`));
  client.on('state', (state) => {
    states++;
    out(`[${new Date().toLocaleTimeString()}] state: ${summarise(state)}`);
  });
  client.on('disconnected', (reason) => {
    disconnects++;
    out(`[${new Date().toLocaleTimeString()}] disconnected: ${reason.name}: ${reason.message}`);
  });
  client.on('authenticationFailed', (error) => {
    out(`Authentication failed: ${error.message}. Not retrying.`);
    finish(1);
  });
  client.on('ready', () => {
    if (!firstReady) return;
    firstReady = false;
    client.getProgramList().then(
      (programs) => {
        const present = programs.filter((slot) => slot.present).map((slot) => slot.number);
        out(`programs: ${present.length} of ${programs.length} slots in use (${present.join(', ') || 'none'})`);
      },
      (error) => out(`program list failed: ${error instanceof Error ? error.message : String(error)}`),
    );
  });

  process.on('SIGINT', () => finish(0));
  if (minutes > 0) setTimeout(() => finish(0), minutes * 60_000).unref();

  out(`Read-only session. Logging to ${path}. Press Ctrl+C to stop.\n`);
  client.start();
  process.exitCode = /** @type {number} */ (await done);
}

main().catch((error) => {
  process.stderr.write(`\nError: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
