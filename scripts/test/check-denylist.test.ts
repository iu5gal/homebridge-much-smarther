import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseDenylist, scanPaths, scanText } from '../check-denylist.mjs';

// Synthetic values only (RFC 5737 addresses, invented names).
const FAKE_DENYLIST = [
  '# test denylist',
  'literal:192.0.2.55',
  'literal:AA:BB:CC:00:11:22',
  'exact:testhost',
  '',
].join('\n');

const ROOT = resolve(import.meta.dirname, '../..');

function hasGitleaks(): boolean {
  return spawnSync('gitleaks', ['version']).status === 0;
}

describe('parseDenylist', () => {
  it('skips comments and blank lines and keeps source line numbers', () => {
    const entries = parseDenylist(FAKE_DENYLIST);
    expect(entries.map((entry) => entry.line)).toEqual([2, 3, 4]);
  });

  it('rejects unknown entry kinds', () => {
    expect(() => parseDenylist('regex:.*')).toThrow(/line 1/);
  });
});

describe('scanText', () => {
  const entries = parseDenylist(FAKE_DENYLIST);

  it('matches literals case-insensitively', () => {
    expect(scanText('f', 'mac aa:bb:cc:00:11:22', entries)).toEqual([
      'f:1: matches denylist line 3',
    ]);
  });

  it('treats regex metacharacters in literals as plain text', () => {
    expect(scanText('f', '192a0b2c55', entries)).toEqual([]);
  });

  it('matches exact entries only at word boundaries that exclude "-" and "_"', () => {
    expect(scanText('f', 'ssh TestHost.local', entries)).toHaveLength(1);
    expect(scanText('f', 'testhost-config testhost_x mytesthost', entries)).toEqual([]);
  });

  it('never includes the matched value in findings', () => {
    const findings = scanText('f', 'line\nhost 192.0.2.55', entries);
    expect(findings).toEqual(['f:2: matches denylist line 2']);
    expect(findings.join()).not.toContain('192.0.2.55');
  });
});

describe('scanPaths', () => {
  const entries = parseDenylist(FAKE_DENYLIST);

  it.each([
    'CLAUDE.local.md',
    'docs/CLAUDE.local.md',
    'reference/x.py',
    'captures/a.xml',
    '.env',
    '.env.local',
    'packages/core/.homebridge/persist/x.json',
  ])('forbids %s', (path) => {
    expect(scanPaths([path], entries)).toEqual([`${path}: forbidden path`]);
  });

  it('allows ordinary paths', () => {
    expect(scanPaths(['CLAUDE.md', 'docs/reference.md', 'src/env.ts'], entries)).toEqual([]);
  });

  it('flags denylisted values in file names', () => {
    expect(scanPaths(['notes/testhost.txt'], entries)).toHaveLength(1);
  });
});

describe('git hooks (end to end)', () => {
  let repo: string;

  const git = (...args: string[]) =>
    spawnSync('git', args, { cwd: repo, encoding: 'utf8' });

  const commitFile = (path: string, content: string, message = 'test commit') => {
    writeFileSync(join(repo, path), content);
    execFileSync('git', ['add', '-f', path], { cwd: repo });
    return git('commit', '-q', '-m', message);
  };

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'denylist-test-'));
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
    for (const [key, value] of [
      ['user.name', 'Test'],
      ['user.email', 'test@example.com'],
      ['commit.gpgsign', 'false'],
      ['core.hooksPath', '.githooks'],
    ] as const) {
      execFileSync('git', ['config', key, value], { cwd: repo });
    }
    mkdirSync(join(repo, 'scripts'));
    mkdirSync(join(repo, '.githooks'));
    copyFileSync(join(ROOT, 'scripts/check-denylist.mjs'), join(repo, 'scripts/check-denylist.mjs'));
    for (const hook of ['pre-commit', 'commit-msg']) {
      copyFileSync(join(ROOT, '.githooks', hook), join(repo, '.githooks', hook));
      chmodSync(join(repo, '.githooks', hook), 0o755);
    }
    writeFileSync(join(repo, '.git/info/personal-denylist'), FAKE_DENYLIST);
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it.skipIf(!hasGitleaks())('allows a clean commit', () => {
    expect(commitFile('a.txt', 'run testhost-config\nhost 192.0.2.1\n').status).toBe(0);
  });

  it('blocks a denylisted value without echoing it', () => {
    const result = commitFile('a.txt', 'ip 192.0.2.55\n');
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('a.txt:1: matches denylist line 2');
    expect(result.stderr).not.toContain('192.0.2.55');
  });

  it('blocks forbidden paths even when force-added', () => {
    const result = commitFile('CLAUDE.local.md', 'private\n');
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('forbidden path');
  });

  it.skipIf(!hasGitleaks())('blocks denylisted values in the commit message', () => {
    const result = commitFile('a.txt', 'clean\n', 'deploy to testhost');
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('commit message:1: matches denylist line 4');
  });

  it('fails closed when the denylist is missing', () => {
    rmSync(join(repo, '.git/info/personal-denylist'));
    const result = commitFile('a.txt', 'clean\n');
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('personal denylist not found');
  });

  it.skipIf(!hasGitleaks())('blocks secrets detected by gitleaks', () => {
    // Built at runtime so that no token-shaped literal exists in this file.
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    const body = Array.from(randomBytes(36), (byte) => alphabet[byte % alphabet.length]).join('');
    const result = commitFile('config.ts', `const token = "ghp_${body}";\n`);
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).not.toContain(body);
  });
});
