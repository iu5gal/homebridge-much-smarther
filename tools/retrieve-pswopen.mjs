#!/usr/bin/env node
// One-time retrieval of the thermostat's PswOpen from the BTicino cloud,
// using an UNOFFICIAL endpoint (docs/PROTOCOL.md §8).
//
// - Credentials are typed interactively (the password without echo), used
//   for two HTTPS requests, and never stored or logged.
// - The PswOpen is shown once in this terminal and never written to disk:
//   keep it in your password manager.
// - Installation names, gateway descriptions and MAC addresses are offered,
//   one at a time, for the personal denylist in .git/info.
//
// Usage: npm run pswopen

import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { retrievePswOpen } from '@much-smarther/core/cloud';
import { out, readHidden, requireTerminal } from './lib/terminal.mjs';

/** @param {string} mac */
function macVariants(mac) {
  const hex = mac.replace(/[^0-9a-f]/gi, '');
  if (hex.length !== 12) return [mac];
  const pairs = hex.match(/../g) ?? [];
  return [pairs.join(':'), pairs.join('-'), hex, hex.match(/..../g)?.join('.') ?? hex];
}

async function main() {
  requireTerminal();

  out('Retrieve the PswOpen from the BTicino cloud (unofficial endpoint).');
  out('Your credentials are used once and never stored.\n');

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const username = (await rl.question('BTicino account e-mail: ')).trim();
  rl.close();
  const password = await readHidden('BTicino account password (hidden): ');

  const gateways = await retrievePswOpen(username, password);
  if (gateways.length === 0) {
    out('\nNo thermostat with a local password was found on this account.');
    return;
  }

  out(`\nFound ${gateways.length} thermostat(s):\n`);
  for (const [index, gateway] of gateways.entries()) {
    out(`  #${index + 1}  ${gateway.plantName} / ${gateway.description}`);
    out(`      gateway id: ${gateway.gatewayId || '-'}   MAC: ${gateway.macAddress || '-'}`);
    out(`      PswOpen:    ${gateway.pswOpen.reveal()}`);
  }
  out('\nSave the PswOpen in your password manager now: it is not written anywhere.\n');

  const denylist = execFileSync('git', ['rev-parse', '--git-path', 'info/personal-denylist'], {
    encoding: 'utf8',
  }).trim();
  if (!existsSync(denylist)) {
    out(`Personal denylist not found at ${denylist}; skipping.`);
    return;
  }
  const existing = new Set(readFileSync(denylist, 'utf8').split('\n').map((line) => line.trim().toLowerCase()));
  /** @type {Set<string>} */
  const candidates = new Set();
  for (const gateway of gateways) {
    for (const value of [gateway.plantName, gateway.description, gateway.gatewayId]) {
      if (value.trim().length >= 3) candidates.add(value.trim());
    }
    if (gateway.macAddress) for (const variant of macVariants(gateway.macAddress)) candidates.add(variant);
  }

  const ask = createInterface({ input: process.stdin, output: process.stdout });
  out('Add these values to the personal denylist? A common word (for example "Casa")');
  out('would block it everywhere in the repository, so answer "n" for those.\n');
  let added = 0;
  for (const value of candidates) {
    const entry = `literal:${value}`;
    if (existing.has(entry.toLowerCase())) continue;
    const answer = (await ask.question(`  ${JSON.stringify(value)}  add? [y/N] `)).trim().toLowerCase();
    if (answer === 'y' || answer === 'yes' || answer === 's' || answer === 'si') {
      appendFileSync(denylist, `${entry}\n`, { mode: 0o600 });
      added++;
    }
  }
  ask.close();
  out(`\n${added} value(s) added to the denylist.`);
}

main().catch((error) => {
  process.stderr.write(`\nError: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
