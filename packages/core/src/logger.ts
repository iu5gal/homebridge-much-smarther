export interface Logger {
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export const silentLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

export const REDACTED = '[redacted]';

// Handshake material and credentials, in XML attributes, JSON or headers.
const SENSITIVE_FIELDS =
  /\b(Random|Digest|PswOpen|pwd|password|auth_token)(\s*=\s*"|"\s*:\s*"|:\s*)([^"\s]*)/gi;

// Files from the thermostat: its configuration holds the Wi-Fi password.
const FILE_DATA = /(<file_data\b[^>]*>)[\s\S]*?(<\/file_data>|$)/g;
const CDATA = /<!\[CDATA\[[\s\S]*?(?:\]\]>|$)/g;

/** Removes known secret values, sensitive fields and file contents from a log line. */
export function redact(text: string, secrets: readonly string[] = []): string {
  let result = text
    .replace(FILE_DATA, (_match, open: string, close: string) => `${open}${REDACTED}${close}`)
    .replace(CDATA, `<![CDATA[${REDACTED}]]>`)
    .replace(SENSITIVE_FIELDS, (_match, name: string, separator: string) => `${name}${separator}${REDACTED}`);
  for (const secret of secrets) {
    if (secret.length > 0) result = result.split(secret).join(REDACTED);
  }
  return result;
}

/** A logger that redacts every line before handing it to `target`. */
export function redactingLogger(target: Logger, secrets: readonly string[]): Logger {
  return {
    debug: (message) => target.debug(redact(message, secrets)),
    info: (message) => target.info(redact(message, secrets)),
    warn: (message) => target.warn(redact(message, secrets)),
    error: (message) => target.error(redact(message, secrets)),
  };
}
