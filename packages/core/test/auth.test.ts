import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  bytesToDecimalText,
  clientDigest,
  decimalTextToHex,
  digestsEqual,
  ProtocolError,
  Secret,
  serverDigest,
} from '../src/index.js';

// Vectors computed by an independent Python implementation of PROTOCOL.md §4,
// with a fake password. Ra = bytes 0x00..0x1f, Rb = bytes 0xe0..0xff.
const PASSWORD = new Secret('fake-pin-0000');
const RA =
  '00000001000200030004000500060007000800090010001100120013001400150100010101020103010401050106010701080109011001110112011301140115';
const RB =
  '14001401140214031404140514061407140814091410141114121413141414151500150115021503150415051506150715081509151015111512151315141515';
const CLIENT_DIGEST =
  '14001515011515020912110401131515060915030905040302020114030700151413050812041502110605090910010800140604080200071011080009000401';
const SERVER_DIGEST =
  '05150813080903141409111103041304050511030908030711130902130914130009091113050505000009040601100115120011151401060102020911050310';

describe('decimal text', () => {
  it('encodes each nibble as two decimal digits', () => {
    expect(bytesToDecimalText(Uint8Array.of(0xa3, 0x0f))).toBe('10030015');
    expect(bytesToDecimalText(Uint8Array.from({ length: 32 }, (_, i) => i))).toBe(RA);
  });

  it('decodes to lowercase hex', () => {
    expect(decimalTextToHex('10030015')).toBe('a30f');
  });

  it.each(['', '1', '16', '0a', '1003001', '99'])('rejects %j', (text) => {
    expect(() => decimalTextToHex(text)).toThrow(ProtocolError);
  });

  it('rejects oversized input', () => {
    expect(() => decimalTextToHex('00'.repeat(600))).toThrow(ProtocolError);
  });

  it('round-trips any bytes', () => {
    fc.assert(
      fc.property(fc.uint8Array({ minLength: 1, maxLength: 128 }), (bytes) => {
        expect(decimalTextToHex(bytesToDecimalText(bytes))).toBe(Buffer.from(bytes).toString('hex'));
      }),
    );
  });
});

describe('handshake digests', () => {
  it('matches the independent client digest vector', () => {
    expect(clientDigest(PASSWORD, RA, RB)).toBe(CLIENT_DIGEST);
  });

  it('matches the independent server digest vector', () => {
    expect(serverDigest(PASSWORD, RA, RB)).toBe(SERVER_DIGEST);
  });

  it('depends on the password', () => {
    expect(clientDigest(new Secret('fake-pin-0001'), RA, RB)).not.toBe(CLIENT_DIGEST);
  });

  it('compares digests exactly', () => {
    expect(digestsEqual(SERVER_DIGEST, SERVER_DIGEST)).toBe(true);
    expect(digestsEqual(SERVER_DIGEST, CLIENT_DIGEST)).toBe(false);
    expect(digestsEqual(SERVER_DIGEST, SERVER_DIGEST.slice(2))).toBe(false);
    expect(digestsEqual(SERVER_DIGEST, '')).toBe(false);
  });
});
