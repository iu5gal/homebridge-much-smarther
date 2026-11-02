#!/usr/bin/env node
// Read-only probe of what the thermostat reports about itself: diagnostics,
// the configuration file and the program files (PROTOCOL.md §5.2).
//
// It authenticates, sends only GET requests and exits. It never sends SET
// commands, so the thermostat state is not changed.
//
// - The PswOpen is read from the macOS Keychain (tools/lib/keychain.mjs) or,
//   if it is not there, typed without echo. This tool never stores it.
// - The configuration file holds the Wi-Fi password. It is never printed,
//   logged or written: the capture in captures/ (gitignored, mode 0600) has
//   every frame with file contents redacted, plus the structure of each file
//   with the values of known, non-personal fields only.
// - At the end it shows, in this terminal only, the values that identify the
//   installation and offers to add each one to .git/info/personal-denylist.
//
// Usage: npm run files -- <thermostat-address[:port]>

import { execFileSync } from 'node:child_process';
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, writeSync } from 'node:fs';
import { XOpenClient } from '@much-smarther/core';
import { denylistBlocks, denylistEntry, describeStructure } from './lib/file-report.mjs';
import { describe, runProbe } from './lib/probe.mjs';
import { readPswOpenFromKeychain } from './lib/keychain.mjs';
import { out, readHidden, readLine, requireTerminal } from './lib/terminal.mjs';

const TARGET = /^([A-Za-z0-9.-]{1,253})(?::([0-9]{1,5}))?$/;
const READY_TIMEOUT_MS = 20_000;

/** @param {XOpenClient} client */
function waitReady(client) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('the thermostat did not answer in time')), READY_TIMEOUT_MS);
    client.once('ready', () => {
      clearTimeout(timer);
      resolve(undefined);
    });
    client.once('authenticationFailed', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

/** @param {{ field: string, value: string }[] | undefined} candidates */
async function offerDenylist(candidates) {
  if (candidates === undefined) {
    out('\nDenylist: the configuration could not be read, so there are no values to offer.');
    return;
  }
  const path = execFileSync('git', ['rev-parse', '--git-path', 'info/personal-denylist'], { encoding: 'utf8' }).trim();
  if (!existsSync(path)) {
    out(`\nDenylist ${path} not found: nothing added.`);
    return;
  }
  const missing = candidates.filter(({ value }) => !denylistBlocks(readFileSync(path, 'utf8'), value));
  if (missing.length === 0) {
    out('\nDenylist: every installation value found is already blocked.');
    return;
  }
  out('\nValues that identify the installation and are not in the denylist yet (shown here only):');
  for (const { field, value } of missing) {
    const answer = await readLine(`  ${field}: ${value}\n    add to ${path}? [y/N] `);
    if (/^y(es)?$/i.test(answer.trim())) {
      appendFileSync(path, `${denylistEntry(value)}\n`);
      out('    added.');
    }
  }
}

async function main() {
  requireTerminal();
  const [target = ''] = process.argv.slice(2);
  const match = TARGET.exec(target);
  if (!match) throw new Error('usage: npm run files -- <thermostat-address[:port]>');
  const host = match[1] ?? '';
  const port = match[2] === undefined ? undefined : Number(match[2]);

  mkdirSync('captures', { recursive: true, mode: 0o700 });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const capture = `captures/files-${stamp}.log`;
  const file = openSync(capture, 'a', 0o600);
  /** @param {string} level @param {string} message */
  const write = (level, message) => writeSync(file, `${new Date().toISOString()} ${level} ${message}\n`);
  const logger = {
    /** @param {string} m */ debug: (m) => write('DEBUG', m),
    /** @param {string} m */ info: (m) => write('INFO', m),
    /** @param {string} m */ warn: (m) => write('WARN', m),
    /** @param {string} m */ error: (m) => write('ERROR', m),
  };
  /** @param {string} name @param {string} text */
  const recordStructure = (name, text) => {
    try {
      write('INFO', `structure of ${name}:\n${describeStructure(text).join('\n')}`);
    } catch (error) {
      write('WARN', `structure of ${name} not readable: ${describe(error)}`);
    }
  };

  const fromKeychain = readPswOpenFromKeychain();
  if (fromKeychain !== undefined) out('PswOpen: read from the macOS Keychain.');
  const password = fromKeychain ?? (await readHidden('PswOpen (hidden): '));
  if (password === '') throw new Error('the PswOpen is required');

  out(`Read-only probe. Capture (file contents redacted): ${capture}\n`);
  const client = new XOpenClient({ host, password, logger, ...(port === undefined ? {} : { port }) });
  let candidates;
  try {
    const ready = waitReady(client);
    client.start();
    await ready;
    out('Authenticated.\n');
    candidates = await runProbe(client, out, recordStructure);
  } finally {
    client.stop();
    write('INFO', 'probe ended');
    closeSync(file);
  }

  await offerDenylist(candidates);
  out(`\nDone. Capture: ${capture}`);
}

main().catch((error) => {
  process.stderr.write(`\nError: ${describe(error)}\n`);
  process.exitCode = 1;
});
