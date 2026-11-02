import { request } from 'node:http';

/** The control server is not there: the plugin is not running, or runs elsewhere. */
export class ControlUnavailableError extends Error {
  override name = 'ControlUnavailableError';
}

export interface ControlResponse {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

const TIMEOUT_MS = 20_000;
const MAX_RESPONSE_BYTES = 256 * 1024;

/** Where the plugin's control server listens, and the key it expects. */
export interface ControlEndpoint {
  readonly socketPath: string;
  readonly key: string;
}

/** One request to the plugin's control server (control-server.ts) over its socket or named pipe. */
export function controlRequest(
  endpoint: ControlEndpoint,
  method: 'GET' | 'POST',
  path: string,
  body?: Record<string, unknown>,
): Promise<ControlResponse> {
  const payload = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = request(
      {
        socketPath: endpoint.socketPath,
        method,
        path,
        timeout: TIMEOUT_MS,
        headers: {
          Authorization: `Bearer ${endpoint.key}`,
          ...(payload === undefined ? {} : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }),
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        let size = 0;
        response.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_RESPONSE_BYTES) req.destroy(new Error('response too large'));
          else chunks.push(chunk);
        });
        response.on('end', () => {
          try {
            const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
            const record = typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
            resolve({ status: response.statusCode ?? 500, body: record });
          } catch {
            reject(new Error('malformed response from the plugin'));
          }
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error('the plugin did not answer in time')));
    req.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT' || error.code === 'ECONNREFUSED') reject(new ControlUnavailableError('plugin not running'));
      else reject(error);
    });
    req.end(payload);
  });
}
