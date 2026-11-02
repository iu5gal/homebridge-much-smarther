#!/usr/bin/env node
// Sends ONE command to a real thermostat, after showing it and asking for
// confirmation, then listens for the events that follow. For the commands
// session of docs/TESTING.md §3: it CHANGES THE THERMOSTAT STATE.
//
// - Only the commands of tools/lib/command-args.mjs exist, validated by the
//   core like every other request. The function (heating or cooling) is
//   always the thermostat's current one: this tool never changes the season.
// - The PswOpen is read from the macOS Keychain (tools/lib/keychain.mjs) or
//   typed without echo. This tool never stores it.
// - Every frame is logged to captures/ (gitignored, mode 0600), redacted.
// - At the end it offers to return to the weekly program, if that is where
//   the thermostat was.
//
// Usage: see tools/lib/command-args.mjs, or run it without arguments.

import { closeSync, mkdirSync, openSync, writeSync } from 'node:fs';
import { buildSetDeviceState, CommandRejectedError, validateDeviceStateRequest, XOpenClient } from '@much-smarther/core';
import { parseCommand, USAGE, UsageError } from './lib/command-args.mjs';
import { readPswOpenFromKeychain } from './lib/keychain.mjs';
import { summarise } from './lib/summary.mjs';
import { out, readHidden, readLine, requireTerminal } from './lib/terminal.mjs';

const TARGET = /^([A-Za-z0-9.-]{1,253})(?::([0-9]{1,5}))?$/;
const READY_TIMEOUT_MS = 20_000;

const time = () => new Date().toLocaleTimeString();

/** @param {unknown} error */
const describe = (error) => (error instanceof Error ? `${error.name}: ${error.message}` : String(error));

/** @param {string} prompt */
const confirm = async (prompt) => /^y(es)?$/i.test((await readLine(prompt)).trim());

/**
 * Resolves with the first state once the client is ready.
 * @param {XOpenClient} client
 * @returns {Promise<import('@much-smarther/core').ThermostatState>}
 */
function firstState(client) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('the thermostat did not answer in time')), READY_TIMEOUT_MS);
    client.once('state', (state) => {
      clearTimeout(timer);
      resolve(state);
    });
    client.once('authenticationFailed', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

/**
 * Prints the state events for `minutes`, or until Ctrl+C.
 * @param {XOpenClient} client
 * @param {number} minutes
 */
function watch(client, minutes) {
  if (minutes === 0) return Promise.resolve();
  out(`\nListening for events for ${minutes} minute(s). Ctrl+C to stop listening.`);
  return new Promise((resolve) => {
    /** @param {import('@much-smarther/core').ThermostatState} state */
    const onState = (state) => out(`[${time()}] state: ${summarise(state)}`);
    /** @param {Error} reason */
    const onDisconnected = (reason) => out(`[${time()}] disconnected: ${describe(reason)}`);
    const finish = () => {
      clearTimeout(timer);
      client.off('state', onState);
      client.off('disconnected', onDisconnected);
      process.off('SIGINT', finish);
      resolve(undefined);
    };
    const timer = setTimeout(finish, minutes * 60_000);
    client.on('state', onState);
    client.on('disconnected', onDisconnected);
    process.on('SIGINT', finish);
  });
}

async function main() {
  requireTerminal();
  const [target = '', ...words] = process.argv.slice(2);
  const match = TARGET.exec(target);
  let command;
  try {
    if (!match) throw new UsageError('missing thermostat address');
    command = parseCommand(words, new Date());
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    out(`${error.message}\n\n${USAGE}`);
    process.exitCode = 2;
    return;
  }
  const host = match[1] ?? '';
  const port = match[2] === undefined ? undefined : Number(match[2]);

  mkdirSync('captures', { recursive: true, mode: 0o700 });
  const capture = `captures/command-${new Date().toISOString().replace(/[:.]/g, '-')}.log`;
  const file = openSync(capture, 'a', 0o600);
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
  try {
    const initial = firstState(client);
    client.start();
    const before = await initial;
    out(`[${time()}] state: ${summarise(before)}`);
    if (command.kind === 'state') return;
    if (before.function === undefined) throw new Error('the thermostat did not report its function');

    const request = validateDeviceStateRequest(command.build(before.function), new Date());
    out(`\nCommand: ${JSON.stringify(request)}`);
    out(`About to send (time window and program filled in at sending):`);
    out(`  ${buildSetDeviceState('preview', request, new Date(), before.utcOffsetMinutes)}`);
    if (!(await confirm('Send it to the thermostat? [y/N] '))) {
      out('Not sent.');
      return;
    }
    write('INFO', `sending ${JSON.stringify(request)}`);
    try {
      await client.setDeviceState(request);
      out(`[${time()}] answer: AckMsg`);
    } catch (error) {
      out(`[${time()}] answer: ${error instanceof CommandRejectedError ? `NackMsg, code ${error.code ?? 'none'}` : describe(error)}`);
    }
    await watch(client, command.watchMinutes);

    const after = client.state;
    if (before.mode === 'AUTOMATIC' && after?.mode !== 'AUTOMATIC') {
      const program = before.programNumber;
      if (await confirm(`\nReturn to the weekly program${program === undefined ? '' : ` ${program}`}? [y/N] `)) {
        await client.setDeviceState({
          mode: 'AUTOMATIC',
          function: before.function,
          ...(program === undefined ? {} : { programNumber: program }),
        });
        await new Promise((resolve) => setTimeout(resolve, 3_000)); // the confirming event
        out(`[${time()}] state: ${client.state ? summarise(client.state) : '?'}`);
      }
    } else if (after?.mode !== before.mode) {
      out(`\nThe thermostat was in ${before.mode ?? '?'} before: restore it from the app or the panel if needed.`);
    }
  } finally {
    client.stop();
    write('INFO', 'command session ended');
    closeSync(file);
    out(`\nCapture: ${capture}`);
  }
}

main().catch((error) => {
  process.stderr.write(`\nError: ${describe(error)}\n`);
  process.exitCode = 1;
});
