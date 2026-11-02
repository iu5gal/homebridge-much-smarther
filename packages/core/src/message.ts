import { ProtocolError } from './errors.js';
import { escapeXml, parseXml, type XmlElement } from './xml.js';

/** Service types of PROTOCOL.md §3. Others are accepted but have no meaning to us. */
export type ServiceType = 'GET' | 'SET' | 'RSP' | 'EVT';

export type Params = ReadonlyMap<string, string>;

/** A file carried by a message, as `<Params><file_data encoded="…">…</file_data></Params>`. */
export interface FileData {
  /** The `encoded` attribute; empty for plain text. */
  readonly encoding: string;
  readonly text: string;
}

/** A decoded V3 message. */
export interface XOpenMessage {
  readonly service: string;
  readonly seqId: string | undefined;
  readonly progress: number | undefined;
  readonly who: string | undefined;
  readonly where: string | undefined;
  readonly actionId: string;
  /** One entry per `<Params>` element that has attributes, in order. */
  readonly params: readonly Params[];
  /** The file in the message, if any (PROTOCOL.md §5.2). */
  readonly fileData?: FileData;
}

export type DecodedDocument =
  | { readonly kind: 'v3'; readonly message: XOpenMessage }
  | { readonly kind: 'legacy' };

const SERVICE = /^[A-Z]{1,16}$/;
const ACTION_ID = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const PARAM_KEY = /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/;
const SEQ_ID = /^[A-Za-z0-9._:-]{0,128}$/;
const PROGRESS = /^[0-9]{1,9}$/;
const ADDRESS = /^[0-9A-Za-z#*.-]{0,32}$/;
const MAX_PARAM_VALUE_LENGTH = 1024;
const MAX_FILE_DATA_LENGTH = 48 * 1024;
const ENCODING = /^[A-Za-z0-9_-]{0,16}$/;
const XML_OPTIONS = { cdataIn: new Set(['file_data']) };

function child(element: XmlElement, name: string): XmlElement | undefined {
  const matches = element.children.filter((candidate) => candidate.name === name);
  if (matches.length > 1) throw new ProtocolError(`more than one <${name}>`);
  return matches[0];
}

function checked(value: string | undefined, pattern: RegExp, what: string): string | undefined {
  if (value === undefined) return undefined;
  if (!pattern.test(value)) throw new ProtocolError(`invalid ${what}`);
  return value;
}

/** Decodes one XML frame. Throws `XmlError` or `ProtocolError`. */
export function decodeDocument(xml: string): DecodedDocument {
  const root = parseXml(xml, undefined, XML_OPTIONS);
  if (root.name === 'OWNxml') return { kind: 'legacy' };
  if (root.name !== 'OWNMsg') throw new ProtocolError(`unexpected root <${root.name}>`);
  const profile = root.attributes.get('Profile');
  if (profile !== undefined && profile !== 'V3') throw new ProtocolError('unsupported profile');

  const payload = child(root, 'Payload');
  if (!payload) throw new ProtocolError('missing <Payload>');

  const service = checked(child(payload, 'Service')?.attributes.get('TYPE'), SERVICE, 'service type');
  if (service === undefined) throw new ProtocolError('missing service type');

  const actionElement = child(payload, 'ActionID');
  const actionId = checked(actionElement?.text.trim(), ACTION_ID, 'ActionID');
  if (actionId === undefined) throw new ProtocolError('missing ActionID');

  const seq = child(payload, 'SeqID');
  const seqId = checked(seq?.attributes.get('ID'), SEQ_ID, 'SeqID');
  const progressText = checked(seq?.attributes.get('Progress'), PROGRESS, 'Progress');
  const address = child(payload, 'Address');

  const params: Params[] = [];
  let fileData: FileData | undefined;
  for (const element of child(payload, 'ParamList')?.children ?? []) {
    if (element.name !== 'Params') continue;
    const file = child(element, 'file_data');
    if (file) {
      if (fileData) throw new ProtocolError('more than one file in a message');
      if (file.text.length > MAX_FILE_DATA_LENGTH) throw new ProtocolError('file too large');
      const encoding = checked(file.attributes.get('encoded') ?? '', ENCODING, 'file encoding') ?? '';
      fileData = { encoding, text: file.text };
    }
    if (element.attributes.size === 0) continue;
    for (const [key, value] of element.attributes) {
      if (!PARAM_KEY.test(key)) throw new ProtocolError('invalid parameter name');
      if (value.length > MAX_PARAM_VALUE_LENGTH) throw new ProtocolError(`parameter ${key} too long`);
    }
    params.push(element.attributes);
  }

  return {
    kind: 'v3',
    message: {
      service,
      seqId: seqId === '' ? undefined : seqId,
      progress: progressText === undefined ? undefined : Number(progressText),
      who: checked(address?.attributes.get('WHO'), ADDRESS, 'WHO'),
      where: checked(address?.attributes.get('WHERE'), ADDRESS, 'WHERE'),
      actionId,
      params,
      ...(fileData ? { fileData } : {}),
    },
  };
}

/** All parameters of a message in one map; the first occurrence of a key wins. */
export function flattenParams(message: XOpenMessage): Map<string, string> {
  const result = new Map<string, string>();
  for (const group of message.params) {
    for (const [key, value] of group) if (!result.has(key)) result.set(key, value);
  }
  return result;
}

/**
 * An outgoing message. `style` reproduces the two layouts in PROTOCOL.md:
 * `command` for regular commands, `handshake` for session setup messages.
 */
export interface OutgoingMessage {
  readonly style: 'command' | 'handshake';
  readonly service: ServiceType;
  readonly seqId: string;
  readonly progress: number;
  readonly actionId: string;
  readonly params?: readonly Readonly<Record<string, string>>[];
  /** Only for `command` style; `WHERE` is empty. */
  readonly who?: string;
}

/** Serialises a message to its single-line wire form. */
export function encodeMessage(message: OutgoingMessage): string {
  if (!ACTION_ID.test(message.actionId)) throw new ProtocolError('invalid ActionID');
  if (!SEQ_ID.test(message.seqId)) throw new ProtocolError('invalid SeqID');
  if (!Number.isSafeInteger(message.progress) || message.progress < 0) {
    throw new ProtocolError('invalid Progress');
  }
  const command = message.style === 'command';
  const seqId = escapeXml(message.seqId);
  const params = (message.params ?? [])
    .map((group) => {
      const attributes = Object.entries(group).map(([key, value]) => {
        if (!PARAM_KEY.test(key)) throw new ProtocolError('invalid parameter name');
        return ` ${key}="${escapeXml(value)}"`;
      });
      return `<Params${attributes.join('')} />`;
    })
    .join('');

  let paramList: string;
  if (params !== '') paramList = `<ParamList>${params}</ParamList>`;
  else paramList = command ? '<ParamList><Params /></ParamList>' : '<ParamList />';

  return (
    (command ? '<OWNMsg Profile="V3" Version="Official">' : '<OWNMsg Profile="V3">') +
    '<Payload>' +
    `<Service TYPE="${message.service}" />` +
    (command
      ? `<SeqID ID="${seqId}" Progress="${message.progress}" Marker="0" IsLast="TRUE" />`
      : `<SeqID ID="${seqId}" Progress="${message.progress}" />`) +
    (command ? `<Address WHO="${escapeXml(message.who ?? '')}" WHERE="" />` : '<Address></Address>') +
    `<ActionID>${message.actionId}</ActionID>` +
    paramList +
    '</Payload>' +
    '</OWNMsg>'
  );
}
