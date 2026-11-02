import { createHash, timingSafeEqual } from 'node:crypto';
import { ProtocolError } from './errors.js';
import type { Secret } from './secret.js';

/** Fixed strings mixed into the client digest (PROTOCOL.md §4.2). */
const CLIENT_CONSTANT_A = '736F70653E';
const CLIENT_CONSTANT_B = '636F70653E';

/** Size of the client random Rb, in bytes. */
export const CLIENT_RANDOM_BYTES = 32;

/** Upper bound on the decimal-text length of a challenge we accept. */
export const MAX_DECIMAL_TEXT_LENGTH = 1024;

const DECIMAL_TEXT = /^(?:0[0-9]|1[0-5])+$/;

/** Encodes bytes as decimal text: two digits (00–15) per hex nibble. */
export function bytesToDecimalText(bytes: Uint8Array): string {
  let result = '';
  for (const byte of bytes) {
    result += String(byte >> 4).padStart(2, '0') + String(byte & 0x0f).padStart(2, '0');
  }
  return result;
}

/** Decodes decimal text to lowercase hex text (one hex digit per digit pair). */
export function decimalTextToHex(text: string): string {
  if (text.length === 0 || text.length > MAX_DECIMAL_TEXT_LENGTH || text.length % 2 !== 0) {
    throw new ProtocolError('invalid decimal text length');
  }
  if (!DECIMAL_TEXT.test(text)) throw new ProtocolError('invalid decimal text');
  let hex = '';
  for (let i = 0; i < text.length; i += 2) hex += Number(text.slice(i, i + 2)).toString(16);
  return hex;
}

function sha256(text: string): Buffer {
  return createHash('sha256').update(text, 'utf8').digest();
}

function passwordKey(password: Secret): string {
  return sha256(password.reveal()).toString('hex');
}

/** Digest the client sends in `ClientHandshakeHMAC`, as decimal text. */
export function clientDigest(password: Secret, raDecimal: string, rbDecimal: string): string {
  const input =
    decimalTextToHex(raDecimal) +
    decimalTextToHex(rbDecimal) +
    CLIENT_CONSTANT_A +
    CLIENT_CONSTANT_B +
    passwordKey(password);
  return bytesToDecimalText(sha256(input));
}

/** Digest the thermostat sends in `ServerHandshakeHMAC`, as decimal text. */
export function serverDigest(password: Secret, raDecimal: string, rbDecimal: string): string {
  const input = decimalTextToHex(raDecimal) + decimalTextToHex(rbDecimal) + passwordKey(password);
  return bytesToDecimalText(sha256(input));
}

/** Constant-time comparison of two digests in decimal text. */
export function digestsEqual(expected: string, received: string): boolean {
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(received, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}
