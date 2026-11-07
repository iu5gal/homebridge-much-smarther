import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { syntheticProgram } from '@much-smarther/simulator';
import { ProgramBackups, VERSIONS_KEPT } from '../src/program-backups.js';
import { WINDOWS } from './helpers.js';

describe('program backups', () => {
  let root: string;
  let directory: string;
  let clock: number;
  let backups: ProgramBackups;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'ms-backups-'));
    directory = join(root, 'program-backups');
    clock = Date.UTC(2026, 10, 7, 10, 0, 0);
    backups = new ProgramBackups(directory, () => new Date((clock += 1_000)));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('keeps a version of a program, with its name and time', () => {
    backups.saveVersion(2, syntheticProgram(2));
    const [version] = backups.list();
    expect(version).toMatchObject({ number: 2, name: 'Program 2', savedAt: '2026-11-07T10:00:01.000Z' });
    expect(backups.read(2, version?.id ?? '')).toBe(syntheticProgram(2));
  });

  it('does not keep the same text twice in a row', () => {
    backups.saveVersion(2, syntheticProgram(2));
    backups.saveVersion(2, syntheticProgram(2));
    expect(backups.list()).toHaveLength(1);
    backups.saveVersion(2, syntheticProgram(3));
    backups.saveVersion(2, syntheticProgram(2));
    expect(backups.list()).toHaveLength(3);
  });

  it('keeps two versions saved in the same millisecond', () => {
    const still = new ProgramBackups(directory, () => new Date(clock));
    still.saveVersion(1, syntheticProgram(1));
    still.saveVersion(1, syntheticProgram(2));
    expect(new Set(still.list().map((version) => version.id)).size).toBe(2);
  });

  it(`keeps the last ${VERSIONS_KEPT} versions of each program, newest first`, () => {
    for (let index = 0; index < VERSIONS_KEPT + 3; index++) backups.saveVersion(1, `${syntheticProgram(1)}<!-- ${index} -->`);
    backups.saveVersion(2, syntheticProgram(2));
    const versions = backups.list();
    expect(versions.filter((version) => version.number === 1)).toHaveLength(VERSIONS_KEPT);
    expect(versions[0]?.number).toBe(2);
    expect(versions.map((version) => version.savedAt)).toEqual([...versions.map((version) => version.savedAt)].sort().reverse());
    const oldest = versions.filter((version) => version.number === 1).at(-1);
    expect(backups.read(1, oldest?.id ?? '')).toContain('<!-- 3 -->');
  });

  it('lists a version whose file cannot be read as a program, without a name', () => {
    backups.saveVersion(3, 'not a program');
    expect(backups.list()[0]).not.toHaveProperty('name');
  });

  it('only handles user programs', () => {
    expect(() => backups.saveVersion(0, 'x')).toThrow();
    expect(() => backups.saveVersion(11, 'x')).toThrow();
    expect(backups.read(0, '20261107T100001000Z')).toBeUndefined();
  });

  it.each([
    ['a path', '../../pswopen'],
    ['a path inside the name', '20261107T100001000Z/../x'],
    ['an absolute path', '/etc/passwd'],
    ['another file name', 'control-key'],
    ['nothing', ''],
  ])('reaches nothing else with %s as the id', (_name, id) => {
    writeFileSync(join(root, 'pswopen'), 'secret');
    backups.saveVersion(1, syntheticProgram(1));
    expect(backups.read(1, id)).toBeUndefined();
  });

  it('gives nothing for a version that does not exist', () => {
    expect(backups.read(1, '20261107T100001000Z')).toBeUndefined();
    expect(backups.list()).toEqual([]);
  });

  it('counts an initial copy only when it is complete', () => {
    expect(backups.hasInitialCopy).toBe(false);
    backups.saveInitialCopy(new Map([[0, 'zero'], [1, 'one']]));
    expect(backups.hasInitialCopy).toBe(true);
    expect(readdirSync(join(directory, 'initial')).sort()).toEqual(['device_program_profile_0.xml', 'device_program_profile_1.xml']);
    expect(existsSync(join(directory, 'initial.partial'))).toBe(false);
  });

  // Windows has no such modes.
  it.skipIf(WINDOWS)('keeps everything private to its user', () => {
    backups.saveVersion(1, syntheticProgram(1));
    backups.saveInitialCopy(new Map([[0, 'zero']]));
    const id = backups.list()[0]?.id ?? '';
    expect(statSync(join(directory, 'versions', '1', `${id}.xml`)).mode & 0o777).toBe(0o600);
    expect(statSync(join(directory, 'versions', '1')).mode & 0o777).toBe(0o700);
    expect(statSync(join(directory, 'initial', 'device_program_profile_0.xml')).mode & 0o777).toBe(0o600);
    expect(statSync(join(directory, 'initial')).mode & 0o777).toBe(0o700);
  });
});
