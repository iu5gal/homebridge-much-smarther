import { randomBytes } from 'node:crypto';
import { CloudError, type Secret } from '@much-smarther/core';
import type { GatewayCredential } from '@much-smarther/core/cloud';
import { controlRequest, ControlUnavailableError, type ControlResponse } from './control-client.js';
import { LANGUAGE_INFO, LANGUAGES, MESSAGES, type Language, type MessageKey } from './i18n.js';
import { PIN_PATTERN, PinStore } from './pin-store.js';

/**
 * The requests of the setup UI (homebridge-ui/server.js), as plain functions
 * so that they can be tested. Thermostat commands go to the plugin through
 * its control socket; only the password retrieval talks to the cloud, and
 * only the password is kept from it.
 */

/** An error for the UI, with the message key to show. */
export class UiError extends Error {
  override name = 'UiError';

  constructor(
    readonly key: MessageKey,
    readonly details: Readonly<Record<string, string | number>> = {},
  ) {
    super(key);
  }
}

export interface UiDependencies {
  readonly storagePath: string;
  readonly retrievePswOpen: (username: string, password: string) => Promise<GatewayCredential[]>;
  readonly request?: typeof controlRequest;
  readonly now?: () => number;
}

type Handler = (payload: unknown) => Promise<unknown>;

/** How long a thermostat found in the cloud can be chosen. */
export const CHOICE_TTL_MS = 5 * 60_000;
const COMMANDS = new Set(['manual', 'boost', 'off', 'auto', 'season', 'refresh', 'reload']);
/**
 * Saving a program can take a while: a first copy of all programs, the write, and
 * reading it back. It must not be reported as failed while it may still succeed.
 */
const PROGRAM_EDIT_TIMEOUT_MS = 60_000;
const MAX_CREDENTIAL_LENGTH = 256;

function record(payload: unknown): Record<string, unknown> {
  return typeof payload === 'object' && payload !== null && !Array.isArray(payload)
    ? (payload as Record<string, unknown>)
    : {};
}

function text(value: unknown, max: number): string {
  if (typeof value !== 'string' || value.trim() === '' || value.length > max) throw new UiError('ui.error.invalid');
  return value;
}

/** Only the end of a MAC address, enough to tell two thermostats apart. */
function maskMac(mac: string): string {
  return mac.length > 5 ? `…${mac.slice(-5)}` : mac;
}

function errorFromControl(response: ControlResponse): UiError {
  switch (response.body['error']) {
    case 'not-connected':
      return new UiError('ui.error.not-connected');
    case 'rejected':
      return new UiError('ui.error.rejected', typeof response.body['code'] === 'number' ? { code: response.body['code'] } : {});
    case 'invalid':
      return new UiError('ui.error.invalid');
    case 'conflict':
      return new UiError('ui.error.program-conflict');
    case 'full':
      return new UiError('ui.error.program-full');
    case 'in-use':
      return new UiError('ui.error.program-in-use');
    case 'name-taken':
      return new UiError('ui.error.program-name-taken');
    case 'no-version':
      return new UiError('ui.error.program-no-version');
    case 'program-write':
      return new UiError('ui.error.program-write');
    default:
      return new UiError('ui.error.failed');
  }
}

export function createUiHandlers(deps: UiDependencies): Record<string, Handler> {
  const store = new PinStore(deps.storagePath);
  const send = deps.request ?? controlRequest;
  const now = deps.now ?? Date.now;
  /** Thermostats found in the cloud, waiting for the user's choice. Kept in memory only. */
  let choices = new Map<string, { pin: Secret; expires: number }>();

  const control = async (method: 'GET' | 'POST', path: string, body?: Record<string, unknown>, timeoutMs?: number) => {
    try {
      const key = store.readControlKey();
      if (key === undefined) throw new ControlUnavailableError('plugin not running');
      const response = await send({ socketPath: store.socketPath, key }, method, path, body, timeoutMs);
      if (response.status !== 200) throw errorFromControl(response);
      return response.body;
    } catch (error) {
      if (error instanceof ControlUnavailableError) throw new UiError('ui.error.not-running');
      throw error;
    }
  };

  /** Saves the password and asks the plugin to use it, if it is running. */
  const usePin = async (pin: string) => {
    store.write(pin);
    try {
      await control('POST', '/v1/reload', {});
      return { ok: true, running: true };
    } catch (error) {
      if (error instanceof UiError && error.key === 'ui.error.not-running') return { ok: true, running: false };
      throw error;
    }
  };

  return {
    '/i18n': async (payload) => {
      const wanted = record(payload)['language'];
      const language: Language = (LANGUAGES as readonly unknown[]).includes(wanted) ? (wanted as Language) : 'en';
      const info: { readonly locale: string; readonly rtl?: true } = LANGUAGE_INFO[language];
      return {
        messages: MESSAGES[language],
        locale: info.locale,
        rtl: info.rtl === true,
        languages: LANGUAGES.map((code) => ({ code, name: LANGUAGE_INFO[code].name })),
      };
    },

    '/status': async () => {
      const pinSet = store.has();
      try {
        return { running: true, pinSet, snapshot: await control('GET', '/v1/status') };
      } catch (error) {
        if (error instanceof UiError && error.key === 'ui.error.not-running') return { running: false, pinSet };
        throw error;
      }
    },

    '/pin/save': async (payload) => {
      const pin = record(payload)['pin'];
      if (typeof pin !== 'string' || !PIN_PATTERN.test(pin.trim())) throw new UiError('ui.error.invalid');
      return usePin(pin);
    },

    '/cloud/retrieve': async (payload) => {
      const body = record(payload);
      const email = text(body['email'], MAX_CREDENTIAL_LENGTH);
      const password = text(body['password'], MAX_CREDENTIAL_LENGTH);
      let gateways: GatewayCredential[];
      try {
        gateways = await deps.retrievePswOpen(email.trim(), password);
      } catch (error) {
        if (error instanceof CloudError) {
          if (error.reason === 'locked') {
            throw error.retryAfterMinutes === undefined
              ? new UiError('ui.error.locked-unknown')
              : new UiError('ui.error.locked', { minutes: error.retryAfterMinutes });
          }
          throw new UiError(`ui.error.${error.reason}` as MessageKey);
        }
        throw new UiError('ui.error.failed');
      }
      choices = new Map();
      return gateways.map((gateway) => {
        const id = randomBytes(12).toString('hex');
        choices.set(id, { pin: gateway.pswOpen, expires: now() + CHOICE_TTL_MS });
        return { id, description: gateway.description, mac: maskMac(gateway.macAddress) };
      });
    },

    '/cloud/choose': async (payload) => {
      const id = record(payload)['id'];
      const choice = typeof id === 'string' ? choices.get(id) : undefined;
      choices = new Map(); // one use, whatever happens
      if (!choice || choice.expires < now()) throw new UiError('ui.error.expired');
      return usePin(choice.pin.reveal());
    },

    '/command': async (payload) => {
      const { action, ...args } = record(payload);
      if (typeof action !== 'string' || !COMMANDS.has(action)) throw new UiError('ui.error.invalid');
      return control('POST', `/v1/${action}`, args);
    },

    '/programs': () => control('GET', '/v1/programs'),
    '/program/read': (payload) => control('POST', '/v1/program/read', record(payload)),
    '/program/save': (payload) => control('POST', '/v1/program/save', record(payload), PROGRAM_EDIT_TIMEOUT_MS),
    '/program/delete': (payload) => control('POST', '/v1/program/delete', record(payload), PROGRAM_EDIT_TIMEOUT_MS),
    '/program/restore': (payload) => control('POST', '/v1/program/restore', record(payload), PROGRAM_EDIT_TIMEOUT_MS),
  };
}
