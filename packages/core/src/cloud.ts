import { CloudError } from './errors.js';
import { Secret, toSecret, type SecretInput } from './secret.js';

/**
 * Optional, one-time retrieval of the PswOpen from the BTicino cloud
 * (PROTOCOL.md §8). It uses an UNOFFICIAL endpoint that may change or
 * disappear; entering the PswOpen by hand must always remain possible.
 *
 * Credentials are used for the two requests and never stored or logged.
 * TLS certificate verification is the platform default and is never relaxed.
 */

const BASE_URL = 'https://www.myhomeweb.com';
const LOGIN_PATH = '/eliot/users/sign_in';
const PLANTS_PATH = '/eliot/plants/all';
const PROJECT_HEADER = { prj_name: 'CRO' } as const;
const APP_VERSION = 'legacy-1.3.10';
const BRAND = 'Bticino';
const MAX_RESPONSE_BYTES = 1024 * 1024;
const PSW_OPEN = /^[\x21-\x7e]{1,64}$/;
/** Login answers with a meaning of their own (PROTOCOL.md §8). */
const LOGIN_PASSWORD_EXPIRED = 209;
const LOGIN_CONTRACT_EXPIRED = 211;
const LOGIN_WRONG_PASSWORD = 432;
const LOGIN_LOCKED = 434;
const MAX_LOCK_MINUTES = 7 * 24 * 60;

export interface GatewayCredential {
  readonly plantName: string;
  readonly gatewayId: string;
  readonly description: string;
  readonly macAddress: string;
  readonly pswOpen: Secret;
}

export interface CloudOptions {
  /** Injected for tests; defaults to the global `fetch`. */
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
}

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The cloud returns either a list or a single object in several places. */
function records(value: unknown): JsonRecord[] {
  if (Array.isArray(value)) return value.filter(isRecord);
  return isRecord(value) ? [value] : [];
}

function text(record: JsonRecord, ...keys: string[]): string {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string') return value;
    if (typeof value === 'number') return String(value);
  }
  return '';
}

/** Extracts one credential per gateway from the `plants/all` response. */
export function extractGatewayCredentials(plants: unknown): GatewayCredential[] {
  if (!Array.isArray(plants)) throw new CloudError('unexpected plants response');
  const results: GatewayCredential[] = [];
  for (const plant of records(plants)) {
    const plantName = text(plant, 'PlantName', 'plantName', 'Name', 'name');
    for (const info of records(plant['PlantInfo'] ?? plant['plantInfo'])) {
      for (const gateway of records(info['gatewayList'] ?? info['GatewayList'])) {
        const gatewayId = text(gateway, 'GatewayID', 'gatewayId');
        const gatewayInfos = records(gateway['GatewayInfo'] ?? gateway['gatewayInfo']);
        for (const details of gatewayInfos.length > 0 ? gatewayInfos : [{}]) {
          const pswOpen = text(details, 'PswOpen') || text(gateway, 'PswOpen');
          if (!PSW_OPEN.test(pswOpen)) continue;
          results.push({
            plantName,
            gatewayId,
            description: text(details, 'Description') || gatewayId,
            macAddress: text(details, 'MacAddress'),
            pswOpen: new Secret(pswOpen),
          });
        }
      }
    }
  }
  return results;
}

async function readJson(response: Response): Promise<unknown> {
  const length = Number(response.headers.get('content-length') ?? '0');
  if (length > MAX_RESPONSE_BYTES) throw new CloudError('response too large');
  const body = await response.text();
  if (body.length > MAX_RESPONSE_BYTES) throw new CloudError('response too large');
  try {
    return JSON.parse(body);
  } catch {
    throw new CloudError('malformed response');
  }
}

/**
 * Turns a refused login into a `CloudError`. A locked account must not be
 * retried: repeated attempts are what locks it.
 */
async function checkLogin(login: Response): Promise<void> {
  switch (login.status) {
    case 401:
    case 403:
    case LOGIN_WRONG_PASSWORD:
      throw new CloudError('login rejected: check e-mail and password', 'credentials');
    case LOGIN_LOCKED: {
      const minutes = await remainingMinutes(login);
      const wait = minutes === undefined ? 'later' : `in ${minutes} minutes`;
      throw new CloudError(`account temporarily locked by BTicino: try again ${wait}, not before`, 'locked', minutes);
    }
    case LOGIN_PASSWORD_EXPIRED:
      throw new CloudError('the BTicino password has expired: change it in the BTicino app first', 'password-expired');
    case LOGIN_CONTRACT_EXPIRED:
      throw new CloudError('the BTicino account needs attention: open the BTicino app first', 'contract-expired');
  }
  if (!login.ok) throw new CloudError(`login failed (HTTP ${login.status})`);
}

/** `RemainingMinutes` of a locked-account answer, if present and plausible. */
async function remainingMinutes(response: Response): Promise<number | undefined> {
  try {
    const body = await readJson(response);
    const minutes = isRecord(body) ? body['RemainingMinutes'] : undefined;
    return typeof minutes === 'number' && Number.isInteger(minutes) && minutes >= 0 && minutes <= MAX_LOCK_MINUTES
      ? minutes
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Logs in with the BTicino account and returns the PswOpen of every
 * thermostat on it. Errors carry only the HTTP status, never response
 * bodies, credentials or tokens.
 */
export async function retrievePswOpen(
  username: string,
  password: SecretInput,
  options: CloudOptions = {},
): Promise<GatewayCredential[]> {
  const doFetch = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? 15_000;
  const secret = toSecret(password);
  if (username.trim() === '') throw new CloudError('username is required');

  const request = async (path: string, init: RequestInit): Promise<Response> => {
    try {
      return await doFetch(BASE_URL + path, {
        ...init,
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw new CloudError(`cannot reach the BTicino cloud (${path})`, 'unreachable');
    }
  };

  const login = await request(LOGIN_PATH, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...PROJECT_HEADER },
    body: JSON.stringify({
      username,
      pwd: secret.reveal(),
      appVersion: APP_VERSION,
      brand: BRAND,
      registrationId: '',
    }),
  });
  await checkLogin(login);
  const token = login.headers.get('auth_token');
  if (!token) throw new CloudError('login succeeded but no session token was returned');

  const plants = await request(PLANTS_PATH, {
    method: 'GET',
    headers: { 'Content-Type': 'application/json', auth_token: token, ...PROJECT_HEADER },
  });
  if (!plants.ok) throw new CloudError(`plant list failed (HTTP ${plants.status})`);
  return extractGatewayCredentials(await readJson(plants));
}
