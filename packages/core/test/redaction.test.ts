import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import { redact, redactingLogger, Secret, toSecret, ValidationError, type Logger } from '../src/index.js';

describe('Secret', () => {
  const secret = new Secret('fake-pin-4321');

  it('reveals the value only on request', () => {
    expect(secret.reveal()).toBe('fake-pin-4321');
  });

  it('does not leak through string conversion, JSON or inspect', () => {
    expect(String(secret)).not.toContain('4321');
    expect(`${secret}`).not.toContain('4321');
    expect(JSON.stringify({ secret })).not.toContain('4321');
    expect(inspect({ secret })).not.toContain('4321');
  });

  it('rejects empty values and wraps strings once', () => {
    expect(() => new Secret('')).toThrow(ValidationError);
    expect(toSecret(secret)).toBe(secret);
    expect(toSecret('x').reveal()).toBe('x');
  });
});

describe('redact', () => {
  it.each([
    ['<Params Random="0102" />', '<Params Random="[redacted]" />'],
    ['<Params Digest="0304" />', '<Params Digest="[redacted]" />'],
    ['{"username":"u","pwd":"hunter2"}', '{"username":"u","pwd":"[redacted]"}'],
    ['"PswOpen": "9999"', '"PswOpen": "[redacted]"'],
    ['auth_token: abc.def', 'auth_token: [redacted]'],
    [
      'RX <Params><file_data encoded=""><![CDATA[<password>wifi-secret</password>]]></file_data></Params>',
      'RX <Params><file_data encoded="">[redacted]</file_data></Params>',
    ],
    ['<file_data encoded="base64">c2VjcmV0</file_data>', '<file_data encoded="base64">[redacted]</file_data>'],
    ['cut <file_data><![CDATA[<ssid>home', 'cut <file_data>[redacted]'],
    ['<x><![CDATA[anything]]></x>', '<x><![CDATA[[redacted]]]></x>'],
    ['<x><![CDATA[cut off', '<x><![CDATA[[redacted]]]>'],
  ])('redacts %s', (input, expected) => {
    expect(redact(input)).toBe(expected);
  });

  it('redacts known secret values anywhere', () => {
    expect(redact('pin is fake-pin-4321!', ['fake-pin-4321'])).toBe('pin is [redacted]!');
  });

  it('leaves ordinary text alone', () => {
    expect(redact('Digest verification failed', [''])).toBe('Digest verification failed');
  });
});

describe('redactingLogger', () => {
  it('redacts at every level', () => {
    const lines: string[] = [];
    const sink: Logger = {
      debug: (m) => lines.push(m),
      info: (m) => lines.push(m),
      warn: (m) => lines.push(m),
      error: (m) => lines.push(m),
    };
    const logger = redactingLogger(sink, ['s3cr3t']);
    logger.debug('a s3cr3t');
    logger.info('b s3cr3t');
    logger.warn('c s3cr3t');
    logger.error('d s3cr3t');
    expect(lines).toEqual(['a [redacted]', 'b [redacted]', 'c [redacted]', 'd [redacted]']);
  });
});
