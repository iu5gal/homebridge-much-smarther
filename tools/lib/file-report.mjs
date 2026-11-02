import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { parseXml } from '@much-smarther/core';

// Helpers for tools/read-files.mjs. They never return the Wi-Fi password.

export const HIDDEN = '«hidden»';

/** Paths whose values may appear in a capture. Anything else is hidden, unknown fields included. */
const VISIBLE_PATHS = new Set([
  'configuration/filename',
  'configuration/firmware_version_of_last_saving',
  'configuration/heating_and_cooling/heating_day_temperature',
  'configuration/heating_and_cooling/heating_night_temperature',
  'configuration/heating_and_cooling/heating_away_temperature',
  'configuration/heating_and_cooling/heating_protection_temperature',
  'configuration/heating_and_cooling/heating_regulation_band',
  'configuration/heating_and_cooling/cooling_day_temperature',
  'configuration/heating_and_cooling/cooling_night_temperature',
  'configuration/heating_and_cooling/cooling_away_temperature',
  'configuration/heating_and_cooling/cooling_protection_temperature',
  'configuration/heating_and_cooling/cooling_regulation_band',
  'configuration/ambient_temperature_calibration',
  'configuration/external_sensor_temperature_calibration',
  'configuration/temperature_format',
  'configuration/date_format',
  'configuration/stand_by_brightness',
  'configuration/buzzer_enable',
  'configuration/haptic_enable',
  'configuration/key_user_interface_enable',
  'configuration/local_user_settings_enable',
  'program_profile/filename',
  'program_profile/program_description/is_program_profile_valid',
  'program_profile/program_description/number',
  'program_profile/program_description/type',
  'program_profile/program_description/is_creation_date_valid',
  'program_profile/program_description/creation_date',
]);

/** Attributes whose values may appear, by element name. */
const VISIBLE_ATTRIBUTES = new Map([['slot', new Set(['id', 'preset', 'time'])]]);

/**
 * The structure of a device file, one line per element, with the values of
 * the visible paths only.
 * @param {string} text
 * @returns {string[]}
 */
export function describeStructure(text) {
  /** @type {string[]} */
  const lines = [];
  /**
   * @param {import('@much-smarther/core').XmlElement} element
   * @param {string} path
   * @param {number} depth
   */
  const visit = (element, path, depth) => {
    const visibleAttributes = VISIBLE_ATTRIBUTES.get(element.name);
    const attributes = [...element.attributes.keys()].map((name) =>
      visibleAttributes?.has(name) ? `${name}="${element.attributes.get(name)}"` : `${name}=${HIDDEN}`,
    );
    const text = element.text.trim();
    let line = '  '.repeat(depth) + element.name + (attributes.length ? ` [${attributes.join(' ')}]` : '');
    if (element.children.length === 0 && text !== '') line += ` = ${VISIBLE_PATHS.has(path) ? text : HIDDEN}`;
    lines.push(line);
    for (const child of element.children) visit(child, `${path}/${child.name}`, depth + 1);
  };
  const root = parseXml(text);
  visit(root, root.name, 0);
  return lines;
}

/** Fields of the configuration that identify the installation. The Wi-Fi password is deliberately not here. */
const PERSONAL_PATHS = [
  ['plant_id'],
  ['friendly_name'],
  ['router_mac_address'],
  ['network', 'wlan', 'ssid'],
  ['network', 'wlan', 'user_id'],
  ['geolocation', 'latitude'],
  ['geolocation', 'longitude'],
];

const PLACEHOLDER = /^[0.:-]*$/;

/**
 * Values of the configuration worth adding to the personal denylist.
 * @param {string} text
 * @returns {{ field: string, value: string }[]}
 */
export function personalCandidates(text) {
  const root = parseXml(text);
  /** @type {{ field: string, value: string }[]} */
  const candidates = [];
  for (const path of PERSONAL_PATHS) {
    let element = /** @type {import('@much-smarther/core').XmlElement | undefined} */ (root);
    for (const name of path) element = element?.children.find((child) => child.name === name);
    const value = element?.text.trim() ?? '';
    // Empty, zero coordinates and all-zero identifiers are defaults, not personal data.
    if (value !== '' && !PLACEHOLDER.test(value) && !/[\r\n]/.test(value)) {
      candidates.push({ field: path.join('/'), value });
    }
  }
  return candidates;
}

/**
 * Whether the denylist already blocks `value`.
 * @param {string} denylist
 * @param {string} value
 */
export function denylistBlocks(denylist, value) {
  const lower = value.toLowerCase();
  return denylist.split(/\r?\n/).some((line) => {
    const match = /^(literal|exact):(.+)$/.exec(line.trim());
    if (!match) return false;
    const entry = (match[2] ?? '').toLowerCase();
    return match[1] === 'literal' ? lower.includes(entry) : lower === entry;
  });
}

/**
 * A denylist line for `value`.
 * @param {string} value
 */
export function denylistEntry(value) {
  return `exact:${value}`;
}

/**
 * Why a checksum may not match: SHA-256 of variants of the text, compared
 * with `expected`. Only the variant names and facts about the text are
 * returned, never the text itself.
 * @param {string} text
 * @param {string} expected lowercase hex
 * @returns {{ facts: string[], matching: string[] }}
 */
export function checksumDiagnosis(text, expected) {
  /** @param {string | Buffer} data */
  const sha = (data) => createHash('sha256').update(data).digest('hex');
  const declaration = '<?xml version="1.0" encoding="utf-8"?>';
  /** @type {[string, string | Buffer][]} */
  const variants = [
    ['UTF-8 as received', Buffer.from(text, 'utf8')],
    ['Latin-1 bytes', Buffer.from(text, 'latin1')],
    ['UTF-16LE bytes', Buffer.from(text, 'utf16le')],
    ['LF line ends', text.replace(/\r\n/g, '\n')],
    ['CRLF line ends', text.replace(/\r?\n/g, '\r\n')],
    ['trimmed', text.trim()],
    ['with a final newline', `${text}\n`],
    ['without the final newline', text.replace(/\r?\n$/, '')],
    ['with an XML declaration', declaration + text],
    ['with an XML declaration and a newline', `${declaration}\n${text}`],
    ['inside the CDATA markers', `<![CDATA[${text}]]>`],
  ];
  const matching = variants.filter(([, data]) => sha(data) === expected).map(([name]) => name);
  const nonAscii = [...text].filter((character) => character.charCodeAt(0) > 0x7e).length;
  const facts = [
    `${text.length} characters, ${Buffer.byteLength(text, 'utf8')} UTF-8 bytes`,
    `${(text.match(/\n/g) ?? []).length} LF, ${(text.match(/\r/g) ?? []).length} CR`,
    `${nonAscii} non-ASCII characters`,
    `XML declaration: ${text.trimStart().startsWith('<?xml') ? 'yes' : 'no'}`,
    `whitespace at the start: ${/^\s/.test(text) ? 'yes' : 'no'}, at the end: ${/\s$/.test(text) ? 'yes' : 'no'}`,
  ];
  return { facts, matching };
}
