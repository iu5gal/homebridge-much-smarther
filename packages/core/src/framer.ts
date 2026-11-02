import { FramingError } from './errors.js';

/**
 * Splits the TCP byte stream into frames (PROTOCOL.md §2):
 * OpenWebNet text frames (`*…##`) and XML documents (`<OWNMsg>…</OWNMsg>`,
 * or legacy `<OWNxml>…</OWNxml>`). An XML declaration before a document is
 * discarded. Anything else is a framing error: the stream cannot be
 * resynchronised and the session must be dropped.
 */

export type Frame =
  | { readonly kind: 'own'; readonly text: string }
  | { readonly kind: 'xml'; readonly text: string };

export const DEFAULT_MAX_FRAME_BYTES = 64 * 1024;
const MAX_OWN_FRAME_BYTES = 64;
const MAX_DECLARATION_BYTES = 256;

const ROOTS = [
  { open: Buffer.from('<OWNMsg'), close: Buffer.from('</OWNMsg>') },
  { open: Buffer.from('<OWNxml'), close: Buffer.from('</OWNxml>') },
] as const;
const DECLARATION_OPEN = Buffer.from('<?xml');
const DECLARATION_CLOSE = Buffer.from('?>');
const OWN_CLOSE = Buffer.from('##');
const OWN_FRAME = /^\*[0-9*#]*##$/;

const decoder = new TextDecoder('utf-8', { fatal: true });

function isWhitespace(byte: number): boolean {
  return byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d;
}

/** True when `buffer` is a (possibly partial) prefix of `token`, or starts with it. */
function matchesPrefix(buffer: Buffer, token: Buffer): 'full' | 'partial' | 'no' {
  const length = Math.min(buffer.length, token.length);
  if (buffer.compare(token, 0, length, 0, length) !== 0) return 'no';
  return buffer.length >= token.length ? 'full' : 'partial';
}

export class Framer {
  #buffer: Buffer = Buffer.alloc(0);

  constructor(private readonly maxFrameBytes: number = DEFAULT_MAX_FRAME_BYTES) {}

  /** Appends bytes and returns every frame completed by them. */
  push(chunk: Uint8Array): Frame[] {
    this.#buffer = this.#buffer.length === 0 ? Buffer.from(chunk) : Buffer.concat([this.#buffer, chunk]);
    const frames: Frame[] = [];
    for (;;) {
      const frame = this.#next();
      if (frame === undefined) break;
      frames.push(frame);
    }
    if (this.#buffer.length > this.maxFrameBytes) throw new FramingError('frame too large');
    return frames;
  }

  /** Bytes received but not yet part of a complete frame. */
  get pendingBytes(): number {
    return this.#buffer.length;
  }

  reset(): void {
    this.#buffer = Buffer.alloc(0);
  }

  #next(): Frame | undefined {
    let start = 0;
    while (start < this.#buffer.length && isWhitespace(this.#buffer[start] ?? 0)) start++;
    this.#buffer = this.#buffer.subarray(start);
    if (this.#buffer.length === 0) return undefined;

    if (this.#buffer[0] === 0x2a /* '*' */) return this.#takeOwnFrame();

    const declaration = matchesPrefix(this.#buffer, DECLARATION_OPEN);
    if (declaration === 'partial') return undefined;
    if (declaration === 'full') {
      const end = this.#buffer.indexOf(DECLARATION_CLOSE);
      if (end === -1) {
        if (this.#buffer.length > MAX_DECLARATION_BYTES) throw new FramingError('XML declaration too long');
        return undefined;
      }
      this.#buffer = this.#buffer.subarray(end + DECLARATION_CLOSE.length);
      return this.#next();
    }

    for (const root of ROOTS) {
      const match = matchesPrefix(this.#buffer, root.open);
      if (match === 'partial') return undefined;
      if (match === 'full') return this.#takeDocument(root.open.length, root.close);
    }
    throw new FramingError('unexpected data between frames');
  }

  #takeOwnFrame(): Frame | undefined {
    const end = this.#buffer.indexOf(OWN_CLOSE, 1);
    if (end === -1) {
      if (this.#buffer.length > MAX_OWN_FRAME_BYTES) throw new FramingError('OpenWebNet frame too long');
      return undefined;
    }
    const text = this.#decode(end + OWN_CLOSE.length);
    if (!OWN_FRAME.test(text)) throw new FramingError('malformed OpenWebNet frame');
    return { kind: 'own', text };
  }

  #takeDocument(openLength: number, close: Buffer): Frame | undefined {
    // The byte after the root name must end the name, e.g. not `<OWNMsgX`.
    const after = this.#buffer[openLength];
    if (after === undefined) return undefined;
    if (!isWhitespace(after) && after !== 0x3e /* '>' */ && after !== 0x2f /* '/' */) {
      throw new FramingError('unexpected root element');
    }
    const end = this.#buffer.indexOf(close, openLength);
    if (end === -1) return undefined;
    return { kind: 'xml', text: this.#decode(end + close.length) };
  }

  #decode(length: number): string {
    const bytes = this.#buffer.subarray(0, length);
    this.#buffer = this.#buffer.subarray(length);
    try {
      return decoder.decode(bytes);
    } catch {
      throw new FramingError('frame is not valid UTF-8');
    }
  }
}
