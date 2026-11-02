import { describe, expect, it, vi } from 'vitest';
import { extractGatewayCredentials, retrievePswOpen } from '../src/cloud.js';
import { CloudError, Secret } from '../src/index.js';

// Synthetic response shaped like PROTOCOL.md §8.
const PLANTS = [
  {
    PlantName: 'Example Home',
    PlantId: 10,
    PlantInfo: [
      {
        gatewayList: [
          {
            GatewayID: 'gw-1',
            GatewayInfo: [{ Description: 'Ground floor', MacAddress: '00:00:5E:00:53:01', PswOpen: '11111111' }],
          },
          { GatewayID: 'gw-2', PswOpen: '22222222' },
          { GatewayID: 'gw-3', GatewayInfo: { Description: 'No password' } },
        ],
      },
    ],
  },
  { PlantName: 'Empty', PlantInfo: {} },
];

const USERNAME = 'user@example.com';
const PASSWORD = 'fake-account-password';
const TOKEN = 'fake-session-token';

type FetchArgs = Parameters<typeof fetch>;

function mockFetch(responses: Response[]) {
  const queue = [...responses];
  return vi.fn<(...args: FetchArgs) => Promise<Response>>(() => {
    const next = queue.shift();
    return next ? Promise.resolve(next) : Promise.reject(new TypeError('no more responses'));
  });
}

const loginOk = () => new Response('{}', { status: 200, headers: { auth_token: TOKEN } });
const plantsOk = (body: unknown = PLANTS) => new Response(JSON.stringify(body), { status: 200 });

describe('extractGatewayCredentials', () => {
  it('returns one credential per gateway with a password', () => {
    const credentials = extractGatewayCredentials(PLANTS);
    expect(credentials.map(({ pswOpen, ...rest }) => ({ ...rest, pin: pswOpen.reveal() }))).toEqual([
      { plantName: 'Example Home', gatewayId: 'gw-1', description: 'Ground floor', macAddress: '00:00:5E:00:53:01', pin: '11111111' },
      { plantName: 'Example Home', gatewayId: 'gw-2', description: 'gw-2', macAddress: '', pin: '22222222' },
    ]);
    expect(credentials[0]?.pswOpen).toBeInstanceOf(Secret);
  });

  it('skips passwords with unexpected characters', () => {
    const plants = [{ PlantInfo: [{ gatewayList: [{ GatewayID: 'g', PswOpen: 'has space' }] }] }];
    expect(extractGatewayCredentials(plants)).toEqual([]);
  });

  it('rejects a response that is not a list', () => {
    expect(() => extractGatewayCredentials({ error: 'x' })).toThrow(CloudError);
  });
});

describe('retrievePswOpen', () => {
  it('logs in, then reads the plants with the session token', async () => {
    const fetchMock = mockFetch([loginOk(), plantsOk()]);
    const credentials = await retrievePswOpen(USERNAME, PASSWORD, { fetch: fetchMock });
    expect(credentials).toHaveLength(2);

    const [loginUrl, loginInit] = fetchMock.mock.calls[0] ?? [];
    expect(loginUrl).toBe('https://www.myhomeweb.com/eliot/users/sign_in');
    expect(loginInit).toMatchObject({ method: 'POST', redirect: 'error', headers: { prj_name: 'CRO' } });
    expect(JSON.parse(String(loginInit?.body))).toMatchObject({ username: USERNAME, pwd: PASSWORD, brand: 'Bticino' });

    const [plantsUrl, plantsInit] = fetchMock.mock.calls[1] ?? [];
    expect(plantsUrl).toBe('https://www.myhomeweb.com/eliot/plants/all');
    expect(plantsInit).toMatchObject({ method: 'GET', redirect: 'error', headers: { auth_token: TOKEN } });
  });

  const failures: [string, () => Response[], RegExp][] = [
    ['rejected login', () => [new Response(`bad ${PASSWORD}`, { status: 401 })], /login rejected/],
    ['wrong password', () => [new Response(`bad ${PASSWORD}`, { status: 432 })], /login rejected/],
    ['locked account', () => [new Response(`{"RemainingMinutes":15,"u":"${USERNAME}"}`, { status: 434 })], /in 15 minutes/],
    ['expired password', () => [new Response('{}', { status: 209, headers: { auth_token: TOKEN } })], /expired/],
    ['expired contract', () => [new Response('{}', { status: 211, headers: { auth_token: TOKEN } })], /BTicino app/],
    ['server error', () => [new Response('oops', { status: 500 })], /HTTP 500/],
    ['missing token', () => [new Response('{}', { status: 200 })], /no session token/],
    ['plants error', () => [loginOk(), new Response(TOKEN, { status: 403 })], /HTTP 403/],
    ['malformed plants', () => [loginOk(), new Response(`not json ${TOKEN}`, { status: 200 })], /malformed/],
    [
      'oversized plants',
      () => [loginOk(), new Response('[]', { status: 200, headers: { 'content-length': String(2 * 1024 * 1024) } })],
      /too large/,
    ],
    ['network failure', () => [], /cannot reach/],
  ];

  it.each(failures)('reports %s without leaking credentials or tokens', async (_name, responses, message) => {
    const error = await retrievePswOpen(USERNAME, PASSWORD, { fetch: mockFetch(responses()) }).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(CloudError);
    const text = `${String(error)} ${JSON.stringify(error)}`;
    expect(text).toMatch(message);
    for (const secret of [PASSWORD, TOKEN, USERNAME]) expect(text).not.toContain(secret);
  });

  it.each<[string, Response, Partial<CloudError>]>([
    ['432', new Response('', { status: 432 }), { reason: 'credentials' }],
    ['434', new Response('{"RemainingMinutes":15}', { status: 434 }), { reason: 'locked', retryAfterMinutes: 15 }],
    ['434 without a body', new Response('oops', { status: 434 }), { reason: 'locked', retryAfterMinutes: undefined }],
    ['434 with a bad wait', new Response('{"RemainingMinutes":-3}', { status: 434 }), { retryAfterMinutes: undefined }],
    ['209', new Response('{}', { status: 209 }), { reason: 'password-expired' }],
    ['211', new Response('{}', { status: 211 }), { reason: 'contract-expired' }],
    ['500', new Response('', { status: 500 }), { reason: 'failed' }],
  ])('gives login answer %s a reason', async (_name, response, expected) => {
    const fetchMock = mockFetch([response]);
    await expect(retrievePswOpen(USERNAME, PASSWORD, { fetch: fetchMock })).rejects.toMatchObject(expected);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('reports a network failure as unreachable', async () => {
    await expect(retrievePswOpen(USERNAME, PASSWORD, { fetch: mockFetch([]) })).rejects.toMatchObject({
      reason: 'unreachable',
    });
  });

  it('requires a username', async () => {
    await expect(retrievePswOpen(' ', PASSWORD, { fetch: mockFetch([]) })).rejects.toThrow(/username/);
  });
});
