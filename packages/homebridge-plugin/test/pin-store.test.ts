import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PinStore } from '../src/pin-store.js';
import { WINDOWS } from './helpers.js';

describe('PinStore', () => {
  let storage: string;
  let store: PinStore;

  beforeEach(() => {
    storage = mkdtempSync(join(tmpdir(), 'ms-pin-'));
    store = new PinStore(storage);
  });
  afterEach(() => rmSync(storage, { recursive: true, force: true }));

  const mode = (path: string) => statSync(path).mode & 0o777;

  it('saves the password with mode 0600 in a 0700 directory, without leftovers', () => {
    expect(store.has()).toBe(false);
    store.write('  fake-pin-1234 ');
    expect(store.has()).toBe(true);
    if (!WINDOWS) {
      expect(mode(store.directory)).toBe(0o700);
      expect(mode(join(store.directory, 'pswopen'))).toBe(0o600);
    }
    expect(readdirSync(store.directory)).toEqual(['pswopen']);
    expect(store.read()?.pin.reveal()).toBe('fake-pin-1234');
    expect(String(store.read()?.pin)).not.toContain('1234');
  });

  it('replaces the password and clears it', () => {
    store.write('fake-pin-1');
    store.write('fake-pin-2');
    expect(store.read()?.pin.reveal()).toBe('fake-pin-2');
    store.clear();
    expect(store.read()).toBeUndefined();
  });

  it.skipIf(WINDOWS)('tightens a file readable by others', () => {
    store.write('fake-pin-1234');
    const file = join(store.directory, 'pswopen');
    chmodSync(file, 0o644);
    expect(store.read()?.tightened).toBe(true);
    expect(mode(file)).toBe(0o600);
    expect(store.read()?.tightened).toBe(false);
  });

  it.each(['', 'with space', 'x'.repeat(65), 'tab\there', 'città'])('refuses to save %j', (value) => {
    expect(() => store.write(value)).toThrow(RangeError);
    expect(existsSync(join(store.directory, 'pswopen'))).toBe(false);
  });

  it('ignores a file with an invalid password', () => {
    store.ensureDirectory();
    writeFileSync(join(store.directory, 'pswopen'), 'bad value\n', { mode: 0o600 });
    expect(store.read()).toBeUndefined();
    expect(readFileSync(join(store.directory, 'pswopen'), 'utf8')).toBe('bad value\n');
  });

  it('puts the control socket next to it, or names a pipe after it on Windows', () => {
    expect(new PinStore(storage, 'linux').socketPath).toBe(join(storage, 'much-smarther', 'control.sock'));
    expect(store.socketPath).toBe(new PinStore(storage, process.platform).socketPath);
    const pipe = new PinStore(storage, 'win32').socketPath;
    expect(pipe).toMatch(/^\\\\\.\\pipe\\much-smarther-[0-9a-f]{16}$/);
    expect(new PinStore(storage, 'win32').socketPath).toBe(pipe);
    expect(new PinStore(join(storage, 'other'), 'win32').socketPath).not.toBe(pipe);
  });

  it('makes a new control key at each start, readable only by its user', () => {
    expect(store.readControlKey()).toBeUndefined();
    const first = store.createControlKey();
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(store.readControlKey()).toBe(first);
    if (!WINDOWS) expect(statSync(join(store.directory, 'control-key')).mode & 0o777).toBe(0o600);
    expect(store.createControlKey()).not.toBe(first);
    store.clearControlKey();
    expect(store.readControlKey()).toBeUndefined();
  });

  it('does not judge file modes on Windows, which has none', () => {
    store.write('fake-pin-1357');
    chmodSync(join(store.directory, 'pswopen'), 0o644);
    expect(new PinStore(storage, 'win32').read()?.tightened).toBe(false);
    if (!WINDOWS) expect(store.read()?.tightened).toBe(true);
  });
});
