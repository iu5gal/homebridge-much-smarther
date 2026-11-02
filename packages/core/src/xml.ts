import { XmlError } from './errors.js';

/**
 * A deliberately small, strict XML parser for XOpen messages.
 *
 * Supported: elements, attributes (single or double quotes), text, the five
 * predefined entities, numeric character references, and an optional XML
 * declaration at the very start.
 *
 * Rejected: DOCTYPE and any other `<!…>` markup (so no DTDs, no entity
 * declarations, no external entities, no comments, no CDATA), processing
 * instructions, unknown entities, control characters, duplicate attributes,
 * and anything over the configured limits.
 *
 * The one exception: CDATA sections are allowed as the text of elements named
 * in `XmlOptions.cdataIn`, which is how the thermostat wraps a file in a
 * message. Their content is kept verbatim and never parsed here.
 */

export interface XmlElement {
  /** Local name, without any namespace prefix. */
  readonly name: string;
  /** Attributes by qualified name; `xmlns` declarations are dropped. */
  readonly attributes: ReadonlyMap<string, string>;
  readonly children: readonly XmlElement[];
  /** Concatenated text content of this element (not of its children). */
  readonly text: string;
}

export interface XmlLimits {
  readonly maxLength: number;
  readonly maxDepth: number;
  readonly maxElements: number;
  readonly maxAttributes: number;
}

export interface XmlOptions {
  /** Local names of the elements whose text may be a CDATA section. */
  readonly cdataIn?: ReadonlySet<string>;
}

export const DEFAULT_XML_LIMITS: XmlLimits = {
  maxLength: 64 * 1024,
  maxDepth: 16,
  maxElements: 1024,
  maxAttributes: 32,
};

const NAME = /[A-Za-z_][A-Za-z0-9_.-]*(?::[A-Za-z_][A-Za-z0-9_.-]*)?/y;
const WHITESPACE = /[ \t\r\n]*/y;
const XML_DECLARATION = /<\?xml(?:[ \t\r\n]+[^<>?]*)?\?>/y;
const CDATA_OPEN = '<![CDATA[';
const CDATA_CLOSE = ']]>';
// eslint-disable-next-line no-control-regex -- matching control characters is the point
const FORBIDDEN_CHARACTERS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/;
const PREDEFINED_ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

interface MutableElement {
  name: string;
  attributes: Map<string, string>;
  children: XmlElement[];
  text: string;
}

class Parser {
  #pos = 0;
  #elements = 0;

  constructor(
    private readonly input: string,
    private readonly limits: XmlLimits,
    private readonly cdataIn: ReadonlySet<string>,
  ) {}

  parseDocument(): XmlElement {
    this.#skipWhitespace();
    XML_DECLARATION.lastIndex = this.#pos;
    if (XML_DECLARATION.test(this.input)) this.#pos = XML_DECLARATION.lastIndex;
    this.#skipWhitespace();
    if (this.input[this.#pos] !== '<') this.#fail('expected root element');
    const root = this.#parseElement(1);
    this.#skipWhitespace();
    if (this.#pos !== this.input.length) this.#fail('content after root element');
    return root;
  }

  #parseElement(depth: number): XmlElement {
    if (depth > this.limits.maxDepth) this.#fail('too deeply nested');
    if (++this.#elements > this.limits.maxElements) this.#fail('too many elements');
    this.#expect('<');
    this.#rejectMarkup();
    const qualifiedName = this.#readName();
    const element: MutableElement = {
      name: localName(qualifiedName),
      attributes: new Map(),
      children: [],
      text: '',
    };
    const seen = new Set<string>();

    for (;;) {
      const hadWhitespace = this.#skipWhitespace();
      const next = this.input[this.#pos];
      if (next === '/') {
        this.#pos++;
        this.#expect('>');
        return element;
      }
      if (next === '>') {
        this.#pos++;
        break;
      }
      if (!hadWhitespace) this.#fail('expected whitespace before attribute');
      this.#parseAttribute(element, seen);
    }

    for (;;) {
      const lt = this.input.indexOf('<', this.#pos);
      if (lt === -1) this.#fail(`unclosed element <${qualifiedName}>`);
      element.text += decodeText(this.input.slice(this.#pos, lt));
      this.#pos = lt;
      if (this.input.startsWith(CDATA_OPEN, this.#pos) && this.cdataIn.has(element.name)) {
        const end = this.input.indexOf(CDATA_CLOSE, this.#pos + CDATA_OPEN.length);
        if (end === -1) this.#fail('unterminated CDATA section');
        element.text += this.input.slice(this.#pos + CDATA_OPEN.length, end);
        this.#pos = end + CDATA_CLOSE.length;
        continue;
      }
      if (this.input.startsWith('</', this.#pos)) {
        this.#pos += 2;
        const closing = this.#readName();
        if (closing !== qualifiedName) this.#fail(`mismatched closing tag </${closing}>`);
        this.#skipWhitespace();
        this.#expect('>');
        return element;
      }
      element.children.push(this.#parseElement(depth + 1));
    }
  }

  #parseAttribute(element: MutableElement, seen: Set<string>): void {
    const name = this.#readName();
    this.#skipWhitespace();
    this.#expect('=');
    this.#skipWhitespace();
    const quote = this.input[this.#pos];
    if (quote !== '"' && quote !== "'") this.#fail('expected quoted attribute value');
    const end = this.input.indexOf(quote, this.#pos + 1);
    if (end === -1) this.#fail('unterminated attribute value');
    const raw = this.input.slice(this.#pos + 1, end);
    if (raw.includes('<')) this.#fail('"<" in attribute value');
    this.#pos = end + 1;

    if (seen.has(name)) this.#fail(`duplicate attribute ${name}`);
    seen.add(name);
    if (seen.size > this.limits.maxAttributes) this.#fail('too many attributes');
    if (name === 'xmlns' || name.startsWith('xmlns:')) return;
    element.attributes.set(name, decodeText(raw));
  }

  #rejectMarkup(): void {
    const next = this.input[this.#pos];
    if (next === '!') this.#fail('DOCTYPE, comments and CDATA are not allowed');
    if (next === '?') this.#fail('processing instructions are not allowed');
  }

  #readName(): string {
    NAME.lastIndex = this.#pos;
    const match = NAME.exec(this.input);
    if (!match) this.#fail('expected a name');
    this.#pos = NAME.lastIndex;
    return match[0];
  }

  #skipWhitespace(): boolean {
    WHITESPACE.lastIndex = this.#pos;
    WHITESPACE.test(this.input);
    const moved = WHITESPACE.lastIndex > this.#pos;
    this.#pos = WHITESPACE.lastIndex;
    return moved;
  }

  #expect(character: string): void {
    if (this.input[this.#pos] !== character) this.#fail(`expected "${character}"`);
    this.#pos++;
  }

  #fail(reason: string): never {
    throw new XmlError(`${reason} at offset ${this.#pos}`);
  }
}

function localName(qualifiedName: string): string {
  const colon = qualifiedName.indexOf(':');
  return colon === -1 ? qualifiedName : qualifiedName.slice(colon + 1);
}

function decodeText(raw: string): string {
  if (raw.includes(']]>')) throw new XmlError('"]]>" in text');
  return raw.replace(/&([^;]{0,10});?/g, (match, body: string) => {
    if (!match.endsWith(';')) throw new XmlError('unterminated entity reference');
    if (Object.hasOwn(PREDEFINED_ENTITIES, body)) return PREDEFINED_ENTITIES[body] ?? '';
    const numeric = /^#(?:([0-9]{1,7})|x([0-9A-Fa-f]{1,6}))$/.exec(body);
    if (!numeric) throw new XmlError(`unknown entity &${body};`);
    const codePoint = numeric[1] !== undefined ? Number(numeric[1]) : parseInt(numeric[2] ?? '', 16);
    if (!isAllowedCodePoint(codePoint)) throw new XmlError('invalid character reference');
    return String.fromCodePoint(codePoint);
  });
}

function isAllowedCodePoint(codePoint: number): boolean {
  if (codePoint === 0x9 || codePoint === 0xa || codePoint === 0xd) return true;
  if (codePoint < 0x20 || codePoint > 0x10ffff) return false;
  if (codePoint >= 0xd800 && codePoint <= 0xdfff) return false;
  return codePoint !== 0xfffe && codePoint !== 0xffff;
}

export function parseXml(input: string, limits: XmlLimits = DEFAULT_XML_LIMITS, options: XmlOptions = {}): XmlElement {
  if (input.length > limits.maxLength) throw new XmlError('document too large');
  if (FORBIDDEN_CHARACTERS.test(input)) throw new XmlError('control characters are not allowed');
  return new Parser(input, limits, options.cdataIn ?? new Set()).parseDocument();
}

/** Escapes a string for use in XML text or a double-quoted attribute. */
export function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
