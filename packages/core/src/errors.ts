/** Base class of every error raised by this library. */
export class XOpenError extends Error {
  override name = 'XOpenError';
}

/** Malformed, oversized or forbidden XML (DTDs, entities, comments…). */
export class XmlError extends XOpenError {
  override name = 'XmlError';
}

/** The byte stream cannot be split into frames; the session must be dropped. */
export class FramingError extends XOpenError {
  override name = 'FramingError';
}

/** A well-formed message that violates the protocol. */
export class ProtocolError extends XOpenError {
  override name = 'ProtocolError';
}

/** The thermostat rejected the password, or failed to prove it knows it. */
export class AuthenticationError extends XOpenError {
  override name = 'AuthenticationError';
}

/** Meaning of the `Code` of a `NackMsg`, as far as known (PROTOCOL.md §5). */
export const NACK_REASONS: Readonly<Record<number, string>> = {
  400: 'malformed message',
  404: 'unknown error',
  430: 'invalid parameters',
  486: 'interface busy',
};

/** The thermostat answered a command with `NackMsg`. */
export class CommandRejectedError extends XOpenError {
  override name = 'CommandRejectedError';
  /** The `Code` of the `NackMsg`, if it had one. */
  readonly code: number | undefined;

  constructor(code?: number) {
    const reason = code === undefined ? '' : ` (code ${code}${NACK_REASONS[code] ? `: ${NACK_REASONS[code]}` : ''})`;
    super(`the thermostat rejected the command${reason}`);
    this.code = code;
  }
}

/** An operation did not complete in time. */
export class TimeoutError extends XOpenError {
  override name = 'TimeoutError';
}

/** The connection is not ready, or closed while an operation was pending. */
export class NotConnectedError extends XOpenError {
  override name = 'NotConnectedError';
}

/** An argument is outside the whitelisted values. */
export class ValidationError extends XOpenError {
  override name = 'ValidationError';
}

/** Why a cloud PswOpen retrieval failed, for a translated message in the UI. */
export type CloudErrorReason =
  | 'credentials'
  | 'locked'
  | 'password-expired'
  | 'contract-expired'
  | 'unreachable'
  | 'failed';

/** The cloud PswOpen retrieval failed. Never carries credentials or tokens. */
export class CloudError extends XOpenError {
  override name = 'CloudError';
  readonly reason: CloudErrorReason;
  /** With `locked`: minutes before the account accepts a new login, if the cloud said. */
  readonly retryAfterMinutes: number | undefined;

  constructor(message: string, reason: CloudErrorReason = 'failed', retryAfterMinutes?: number) {
    super(message);
    this.reason = reason;
    this.retryAfterMinutes = retryAfterMinutes;
  }
}
