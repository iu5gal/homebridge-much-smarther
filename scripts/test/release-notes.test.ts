import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { releaseNotes } from '../release-notes.mjs';

const CHANGELOG = [
  '# Changelog',
  '',
  '## [Unreleased]',
  '',
  '## [0.2.0] - 2027-01-10',
  '',
  '### Fixed',
  '',
  '- Something.',
  '',
  '## [0.1.0] - 2026-12-01',
  '',
  '- First release.',
  '',
  '## [0.0.9] - 2026-11-01',
  '',
].join('\n');

describe('releaseNotes', () => {
  it('returns the body of one version, up to the next heading', () => {
    expect(releaseNotes(CHANGELOG, '0.2.0')).toBe('### Fixed\n\n- Something.\n');
    expect(releaseNotes(CHANGELOG, '0.1.0')).toBe('- First release.\n');
  });

  it('refuses a missing or empty section', () => {
    expect(() => releaseNotes(CHANGELOG, '0.3.0')).toThrow(/no section/);
    expect(() => releaseNotes(CHANGELOG, '0.0.9')).toThrow(/empty/);
    expect(() => releaseNotes(CHANGELOG, '0.1')).toThrow(/no section/);
  });

  it('has notes in the project changelog for the plugin version', () => {
    const changelog = readFileSync(resolve(import.meta.dirname, '../../CHANGELOG.md'), 'utf8');
    const plugin = JSON.parse(readFileSync(resolve(import.meta.dirname, '../../packages/homebridge-plugin/package.json'), 'utf8')) as {
      version: string;
    };
    expect(releaseNotes(changelog, plugin.version)).toMatch(/### (Added|Changed|Fixed)/);
  });
});
