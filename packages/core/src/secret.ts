import { inspect } from 'node:util';
import { ValidationError } from './errors.js';

const REDACTED = '[redacted]';

/**
 * Wraps a secret string so that it cannot leak through string conversion,
 * JSON serialisation or `console.log`. Only `reveal()` returns the value.
 */
export class Secret {
  readonly #value: string;

  constructor(value: string) {
    if (value.length === 0) throw new ValidationError('secret must not be empty');
    this.#value = value;
  }

  reveal(): string {
    return this.#value;
  }

  toString(): string {
    return REDACTED;
  }

  toJSON(): string {
    return REDACTED;
  }

  [inspect.custom](): string {
    return `Secret(${REDACTED})`;
  }
}

export type SecretInput = string | Secret;

export function toSecret(value: SecretInput): Secret {
  return value instanceof Secret ? value : new Secret(value);
}
