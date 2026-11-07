import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CloudError, Secret } from '@much-smarther/core';
import type { GatewayCredential } from '@much-smarther/core/cloud';
import { ControlUnavailableError, type ControlResponse } from '../src/control-client.js';
import { LANGUAGES, MESSAGES } from '../src/i18n.js';
import { PinStore } from '../src/pin-store.js';
import { CHOICE_TTL_MS, createUiHandlers, UiError } from '../src/ui-handlers.js';

const GATEWAYS: GatewayCredential[] = [
  { plantName: 'Example Home', gatewayId: 'gw-1', description: 'Ground floor', macAddress: '00:00:5E:00:53:01', pswOpen: new Secret('11111111') },
  { plantName: 'Example Home', gatewayId: 'gw-2', description: 'First floor', macAddress: '00:00:5E:00:53:02', pswOpen: new Secret('22222222') },
];

describe('setup UI handlers', () => {
  let storage: string;
  let calls: { method: string; path: string; body?: Record<string, unknown> }[];
  let key: string;
  let reply: (path: string) => ControlResponse | Error;
  let clock: number;
  let retrieve: (username: string, password: string) => Promise<GatewayCredential[]>;

  const handlers = () =>
    createUiHandlers({
      storagePath: storage,
      retrievePswOpen: (u, p) => retrieve(u, p),
      now: () => clock,
      request: async (endpoint, method, path, body) => {
        expect(endpoint).toEqual({ socketPath: new PinStore(storage).socketPath, key });
        calls.push({ method, path, ...(body ? { body } : {}) });
        const result = reply(path);
        if (result instanceof Error) throw result;
        return result;
      },
    });

  beforeEach(() => {
    storage = mkdtempSync(join(tmpdir(), 'ms-ui-'));
    key = new PinStore(storage).createControlKey();
    calls = [];
    reply = () => ({ status: 200, body: { ok: true } });
    clock = 1_000_000;
    retrieve = async () => GATEWAYS;
  });
  afterEach(() => rmSync(storage, { recursive: true, force: true }));

  const pin = () => new PinStore(storage).read()?.pin.reveal();

  it('serves the translations, English by default', async () => {
    const h = handlers();
    expect(await h['/i18n']?.({ language: 'it' })).toMatchObject({ messages: MESSAGES.it, locale: 'it-IT', rtl: false });
    expect(await h['/i18n']?.({ language: 'xx' })).toMatchObject({ messages: MESSAGES.en, locale: 'en-GB' });
    expect(await h['/i18n']?.({ language: 'ar' })).toMatchObject({ messages: MESSAGES.ar, rtl: true });
  });

  describe('programs', () => {
    it('passes each request to the plugin, as it is', async () => {
      const h = handlers();
      const program = { number: 2, version: 'v', name: 'Mine', days: {} };
      reply = () => ({ status: 200, body: { done: true } });
      await expect(h['/programs']?.(undefined)).resolves.toEqual({ done: true });
      await h['/program/read']?.({ number: 2 });
      await h['/program/save']?.(program);
      await h['/program/delete']?.({ number: 2 });
      await h['/program/restore']?.({ number: 2, id: 'x' });
      expect(calls).toEqual([
        { method: 'GET', path: '/v1/programs' },
        { method: 'POST', path: '/v1/program/read', body: { number: 2 } },
        { method: 'POST', path: '/v1/program/save', body: program },
        { method: 'POST', path: '/v1/program/delete', body: { number: 2 } },
        { method: 'POST', path: '/v1/program/restore', body: { number: 2, id: 'x' } },
      ]);
    });

    it.each([
      ['conflict', 'ui.error.program-conflict'],
      ['full', 'ui.error.program-full'],
      ['in-use', 'ui.error.program-in-use'],
      ['no-version', 'ui.error.program-no-version'],
      ['program-write', 'ui.error.program-write'],
      ['invalid', 'ui.error.invalid'],
      ['not-connected', 'ui.error.not-connected'],
      ['unavailable', 'ui.error.failed'],
    ])('turns %s into its message', async (error, key) => {
      reply = () => ({ status: 409, body: { error } });
      await expect(handlers()['/program/save']?.({})).rejects.toMatchObject({ key });
    });

    it('gives a write more time than other requests', async () => {
      const timeouts: (number | undefined)[] = [];
      const h = createUiHandlers({
        storagePath: storage,
        retrievePswOpen: (u, p) => retrieve(u, p),
        request: async (_endpoint, _method, _path, _body, timeoutMs) => {
          timeouts.push(timeoutMs);
          return { status: 200, body: {} };
        },
      });
      await h['/programs']?.(undefined);
      await h['/program/read']?.({ number: 2 });
      await h['/program/save']?.({});
      await h['/program/delete']?.({});
      await h['/program/restore']?.({});
      expect(timeouts).toEqual([undefined, undefined, 60_000, 60_000, 60_000]);
    });
  });

  it('lists every language by its own name, for the language menu', async () => {
    const { languages } = (await handlers()['/i18n']?.({})) as { languages: { code: string; name: string }[] };
    expect(languages.map((language) => language.code)).toEqual([...LANGUAGES]);
    expect(languages).toContainEqual({ code: 'de', name: 'Deutsch' });
    expect(languages).toContainEqual({ code: 'zh-Hant', name: '繁體中文' });
  });

  it('reports the status, and whether the plugin runs', async () => {
    const h = handlers();
    reply = () => ({ status: 200, body: { status: 'ready' } });
    expect(await h['/status']?.({})).toEqual({ running: true, pinSet: false, snapshot: { status: 'ready' } });
    reply = () => new ControlUnavailableError('plugin not running');
    expect(await h['/status']?.({})).toEqual({ running: false, pinSet: false });
  });

  it('saves a password typed by hand and asks the plugin to use it', async () => {
    const h = handlers();
    expect(await h['/pin/save']?.({ pin: ' fake-pin-1357 ' })).toEqual({ ok: true, running: true });
    expect(pin()).toBe('fake-pin-1357');
    expect(calls).toEqual([{ method: 'POST', path: '/v1/reload', body: {} }]);
    reply = () => new ControlUnavailableError('plugin not running');
    expect(await h['/pin/save']?.({ pin: 'fake-pin-2468' })).toEqual({ ok: true, running: false });
    await expect(h['/pin/save']?.({ pin: 'has space' })).rejects.toMatchObject({ key: 'ui.error.invalid' });
  });

  it('retrieves from the cloud, shows no password and saves the chosen one only', async () => {
    const h = handlers();
    const found = (await h['/cloud/retrieve']?.({ email: 'user@example.com', password: 'fake-account' })) as {
      id: string;
      description: string;
      mac: string;
    }[];
    expect(found.map(({ description, mac }) => ({ description, mac }))).toEqual([
      { description: 'Ground floor', mac: '…53:01' },
      { description: 'First floor', mac: '…53:02' },
    ]);
    expect(JSON.stringify(found)).not.toMatch(/11111111|22222222/);
    await h['/cloud/choose']?.({ id: found[1]?.id });
    expect(pin()).toBe('22222222');
    // A choice can be used once.
    await expect(h['/cloud/choose']?.({ id: found[0]?.id })).rejects.toMatchObject({ key: 'ui.error.expired' });
  });

  it('lets a choice expire', async () => {
    const h = handlers();
    const [first] = (await h['/cloud/retrieve']?.({ email: 'user@example.com', password: 'x' })) as { id: string }[];
    clock += CHOICE_TTL_MS + 1;
    await expect(h['/cloud/choose']?.({ id: first?.id })).rejects.toMatchObject({ key: 'ui.error.expired' });
    expect(pin()).toBeUndefined();
  });

  it.each<[CloudError | Error, string, Record<string, unknown>]>([
    [new CloudError('x', 'credentials'), 'ui.error.credentials', {}],
    [new CloudError('x', 'locked', 15), 'ui.error.locked', { minutes: 15 }],
    [new CloudError('x', 'locked'), 'ui.error.locked-unknown', {}],
    [new CloudError('x', 'password-expired'), 'ui.error.password-expired', {}],
    [new CloudError('x', 'unreachable'), 'ui.error.unreachable', {}],
    [new Error('boom'), 'ui.error.failed', {}],
  ])('turns %s into a message', async (error, key, details) => {
    retrieve = async () => {
      throw error;
    };
    const failure = await handlers()['/cloud/retrieve']?.({ email: 'user@example.com', password: 'x' }).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(UiError);
    expect(failure).toMatchObject({ key, details });
  });

  it.each([{}, { email: 'user@example.com' }, { email: '', password: 'x' }, { email: 'u', password: 'x'.repeat(257) }])(
    'refuses incomplete credentials %j',
    async (payload) => {
      await expect(handlers()['/cloud/retrieve']?.(payload)).rejects.toMatchObject({ key: 'ui.error.invalid' });
    },
  );

  it('forwards whitelisted commands and turns failures into messages', async () => {
    const h = handlers();
    await h['/command']?.({ action: 'boost', minutes: 30 });
    expect(calls).toEqual([{ method: 'POST', path: '/v1/boost', body: { minutes: 30 } }]);
    await expect(h['/command']?.({ action: 'send', raw: '<x/>' })).rejects.toMatchObject({ key: 'ui.error.invalid' });
    await expect(h['/command']?.({ action: '../v1/status' })).rejects.toMatchObject({ key: 'ui.error.invalid' });
    reply = () => ({ status: 502, body: { error: 'rejected', code: 430 } });
    await expect(h['/command']?.({ action: 'off' })).rejects.toMatchObject({ key: 'ui.error.rejected', details: { code: 430 } });
    reply = () => ({ status: 503, body: { error: 'not-connected' } });
    await expect(h['/command']?.({ action: 'off' })).rejects.toMatchObject({ key: 'ui.error.not-connected' });
    reply = () => new ControlUnavailableError('plugin not running');
    await expect(h['/command']?.({ action: 'off' })).rejects.toMatchObject({ key: 'ui.error.not-running' });
    new PinStore(storage).clearControlKey();
    const before = calls.length;
    await expect(h['/command']?.({ action: 'off' })).rejects.toMatchObject({ key: 'ui.error.not-running' });
    expect(calls).toHaveLength(before);
  });
});
