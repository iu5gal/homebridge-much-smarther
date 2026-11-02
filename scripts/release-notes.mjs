#!/usr/bin/env node
// Prints the CHANGELOG.md section of one version, for the GitHub release
// notes. Fails when the section is missing or empty, so that a release
// cannot go out without notes.
//
// Usage: release-notes.mjs <version>   (for example 0.1.0, without the "v")

import { readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The body of the `## [version]` section, without its heading.
 * @param {string} changelog
 * @param {string} version
 */
export function releaseNotes(changelog, version) {
  const lines = changelog.split('\n');
  const start = lines.findIndex((line) => line.startsWith(`## [${version}]`));
  if (start === -1) throw new Error(`CHANGELOG.md has no section for ${version}`);
  const end = lines.findIndex((line, index) => index > start && line.startsWith('## '));
  const body = lines
    .slice(start + 1, end === -1 ? undefined : end)
    .join('\n')
    .trim();
  if (body === '') throw new Error(`the CHANGELOG.md section for ${version} is empty`);
  return `${body}\n`;
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  const version = process.argv[2] ?? '';
  const changelog = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'CHANGELOG.md'), 'utf8');
  try {
    process.stdout.write(releaseNotes(changelog, version));
  } catch (error) {
    console.error(`release-notes: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
