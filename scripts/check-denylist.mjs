#!/usr/bin/env node
// Blocks personal values and private paths from entering the repository.
//
// The values live in `.git/info/personal-denylist`, which is never committed.
// This script contains no personal data. It fails closed: a missing or empty
// denylist is an error. Matches are reported by location and denylist line
// only, never by value.
//
// Usage:
//   check-denylist.mjs --staged          staged paths and blobs (pre-commit)
//   check-denylist.mjs --message <file>  commit message (commit-msg)
//   check-denylist.mjs --tracked         tracked and untracked, non-ignored files
//
// Denylist syntax, one entry per line:
//   literal:<text>  case-insensitive substring
//   exact:<text>    case-insensitive, not adjacent to [A-Za-z0-9_-]
//   # comment

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Paths that must never be committed, whatever the denylist says. */
const FORBIDDEN_PATHS = [
  /(^|\/)CLAUDE\.local\.md$/i,
  /^reference\//,
  /^captures\//,
  /(^|\/)\.env(\..*)?$/,
  /(^|\/)\.homebridge\//,
];

const EXIT_MATCH = 1;
const EXIT_SETUP = 2;

class SetupError extends Error {}

/** @param {string[]} args */
function git(args) {
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

/** @param {string[]} args */
function gitBuffer(args) {
  return execFileSync('git', args, { maxBuffer: 64 * 1024 * 1024 });
}

/** @param {string} text */
function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * @typedef {{ line: number, regex: RegExp }} Entry
 * @param {string} text
 * @returns {Entry[]}
 */
export function parseDenylist(text) {
  /** @type {Entry[]} */
  const entries = [];
  text.split(/\r?\n/).forEach((raw, index) => {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) return;
    const match = /^(literal|exact):(.+)$/.exec(line);
    if (!match) {
      throw new Error(`denylist line ${index + 1}: expected "literal:" or "exact:"`);
    }
    const [, kind, value = ''] = match;
    const escaped = escapeRegExp(value.trim());
    const source = kind === 'exact' ? `(?<![A-Za-z0-9_-])${escaped}(?![A-Za-z0-9_-])` : escaped;
    entries.push({ line: index + 1, regex: new RegExp(source, 'i') });
  });
  return entries;
}

/**
 * @param {string} label  where the text comes from, e.g. a path
 * @param {string} text
 * @param {Entry[]} entries
 * @returns {string[]}  findings, without the matched values
 */
export function scanText(label, text, entries) {
  /** @type {string[]} */
  const findings = [];
  text.split('\n').forEach((content, index) => {
    for (const entry of entries) {
      if (entry.regex.test(content)) {
        findings.push(`${label}:${index + 1}: matches denylist line ${entry.line}`);
      }
    }
  });
  return findings;
}

/**
 * @param {string[]} paths
 * @param {Entry[]} entries
 * @returns {string[]}
 */
export function scanPaths(paths, entries) {
  /** @type {string[]} */
  const findings = [];
  for (const path of paths) {
    if (FORBIDDEN_PATHS.some((pattern) => pattern.test(path))) {
      findings.push(`${path}: forbidden path`);
    }
    for (const entry of entries) {
      if (entry.regex.test(path)) {
        findings.push(`${path}: file name matches denylist line ${entry.line}`);
      }
    }
  }
  return findings;
}

/** @returns {Entry[]} */
function loadDenylist() {
  const path = git(['rev-parse', '--git-path', 'info/personal-denylist']).trim();
  if (!existsSync(path)) {
    throw new SetupError(`personal denylist not found at ${path}; create it (see CONTRIBUTING)`);
  }
  const entries = parseDenylist(readFileSync(path, 'utf8'));
  if (entries.length === 0) {
    throw new SetupError(`personal denylist at ${path} has no entries`);
  }
  return entries;
}

/** @param {string} output */
function splitNul(output) {
  return output.split('\0').filter((path) => path !== '');
}

/** @param {Entry[]} entries */
function checkStaged(entries) {
  const paths = splitNul(git(['diff', '--cached', '--name-only', '-z', '--diff-filter=ACMR']));
  const findings = scanPaths(paths, entries);
  for (const path of paths) {
    const blob = gitBuffer(['cat-file', 'blob', `:${path}`]).toString('utf8');
    findings.push(...scanText(path, blob, entries));
  }
  return findings;
}

/** @param {Entry[]} entries */
function checkTracked(entries) {
  const paths = splitNul(git(['ls-files', '-z', '--cached', '--others', '--exclude-standard']));
  const findings = scanPaths(paths, entries);
  for (const path of paths) {
    if (!existsSync(path)) continue;
    findings.push(...scanText(path, readFileSync(path, 'utf8'), entries));
  }
  return findings;
}

/**
 * @param {Entry[]} entries
 * @param {string | undefined} file
 */
function checkMessage(entries, file) {
  if (!file) throw new SetupError('--message needs a file');
  return scanText('commit message', readFileSync(file, 'utf8'), entries);
}

/** @param {string[]} argv */
function main(argv) {
  const [mode, arg] = argv;
  try {
    const entries = loadDenylist();
    let findings;
    if (mode === '--staged') findings = checkStaged(entries);
    else if (mode === '--tracked') findings = checkTracked(entries);
    else if (mode === '--message') findings = checkMessage(entries, arg);
    else throw new SetupError('usage: check-denylist.mjs --staged | --tracked | --message <file>');

    if (findings.length > 0) {
      console.error('check-denylist: blocked, personal data or private paths found:');
      for (const finding of findings) console.error(`  ${finding}`);
      return EXIT_MATCH;
    }
    return 0;
  } catch (error) {
    console.error(`check-denylist: ${error instanceof Error ? error.message : String(error)}`);
    return EXIT_SETUP;
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  process.exitCode = main(process.argv.slice(2));
}
