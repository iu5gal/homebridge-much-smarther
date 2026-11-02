/**
 * Every text the plugin shows: HomeKit service names and the setup UI, one
 * file per language in `locales/`. English is the reference; every language
 * must have exactly its keys (checked by the tests). `{name}` placeholders
 * are filled by `translate`.
 */
import { ar } from './locales/ar.js';
import { bg } from './locales/bg.js';
import { ca } from './locales/ca.js';
import { cs } from './locales/cs.js';
import { da } from './locales/da.js';
import { de } from './locales/de.js';
import { el } from './locales/el.js';
import { en } from './locales/en.js';
import { es } from './locales/es.js';
import { et } from './locales/et.js';
import { fa } from './locales/fa.js';
import { fi } from './locales/fi.js';
import { fr } from './locales/fr.js';
import { ga } from './locales/ga.js';
import { he } from './locales/he.js';
import { hi } from './locales/hi.js';
import { hr } from './locales/hr.js';
import { hu } from './locales/hu.js';
import { id } from './locales/id.js';
import { is } from './locales/is.js';
import { it } from './locales/it.js';
import { ja } from './locales/ja.js';
import { ko } from './locales/ko.js';
import { lt } from './locales/lt.js';
import { lv } from './locales/lv.js';
import { ms } from './locales/ms.js';
import { mt } from './locales/mt.js';
import { nb } from './locales/nb.js';
import { nl } from './locales/nl.js';
import { pl } from './locales/pl.js';
import { pt } from './locales/pt.js';
import { ro } from './locales/ro.js';
import { ru } from './locales/ru.js';
import { sk } from './locales/sk.js';
import { sl } from './locales/sl.js';
import { sr } from './locales/sr.js';
import { sv } from './locales/sv.js';
import { th } from './locales/th.js';
import { tr } from './locales/tr.js';
import { uk } from './locales/uk.js';
import { vi } from './locales/vi.js';
import { zhHans } from './locales/zh-Hans.js';
import { zhHant } from './locales/zh-Hant.js';

export type MessageKey = keyof typeof en;
export type Messages = Readonly<Record<MessageKey, string>>;

interface LanguageInfo {
  /** The language's name in itself, for the language menu. */
  readonly name: string;
  /** The locale for dates and numbers on the setup page. */
  readonly locale: string;
  readonly rtl?: true;
}

export const LANGUAGE_INFO = {
  ar: { name: 'العربية', locale: 'ar', rtl: true },
  bg: { name: 'Български', locale: 'bg' },
  ca: { name: 'Català', locale: 'ca' },
  cs: { name: 'Čeština', locale: 'cs' },
  da: { name: 'Dansk', locale: 'da' },
  de: { name: 'Deutsch', locale: 'de' },
  el: { name: 'Ελληνικά', locale: 'el' },
  en: { name: 'English', locale: 'en-GB' },
  es: { name: 'Español', locale: 'es-ES' },
  et: { name: 'Eesti', locale: 'et' },
  fa: { name: 'فارسی', locale: 'fa', rtl: true },
  fi: { name: 'Suomi', locale: 'fi' },
  fr: { name: 'Français', locale: 'fr-FR' },
  ga: { name: 'Gaeilge', locale: 'ga' },
  he: { name: 'עברית', locale: 'he', rtl: true },
  hi: { name: 'हिन्दी', locale: 'hi' },
  hr: { name: 'Hrvatski', locale: 'hr' },
  hu: { name: 'Magyar', locale: 'hu' },
  id: { name: 'Bahasa Indonesia', locale: 'id' },
  is: { name: 'Íslenska', locale: 'is' },
  it: { name: 'Italiano', locale: 'it-IT' },
  ja: { name: '日本語', locale: 'ja' },
  ko: { name: '한국어', locale: 'ko' },
  lt: { name: 'Lietuvių', locale: 'lt' },
  lv: { name: 'Latviešu', locale: 'lv' },
  ms: { name: 'Bahasa Melayu', locale: 'ms' },
  mt: { name: 'Malti', locale: 'mt' },
  nb: { name: 'Norsk bokmål', locale: 'nb' },
  nl: { name: 'Nederlands', locale: 'nl' },
  pl: { name: 'Polski', locale: 'pl' },
  pt: { name: 'Português', locale: 'pt-PT' },
  ro: { name: 'Română', locale: 'ro' },
  ru: { name: 'Русский', locale: 'ru' },
  sk: { name: 'Slovenčina', locale: 'sk' },
  sl: { name: 'Slovenščina', locale: 'sl' },
  sr: { name: 'Српски', locale: 'sr' },
  sv: { name: 'Svenska', locale: 'sv' },
  th: { name: 'ไทย', locale: 'th' },
  tr: { name: 'Türkçe', locale: 'tr' },
  uk: { name: 'Українська', locale: 'uk' },
  vi: { name: 'Tiếng Việt', locale: 'vi' },
  'zh-Hans': { name: '简体中文', locale: 'zh-CN' },
  'zh-Hant': { name: '繁體中文', locale: 'zh-TW' },
} as const satisfies Readonly<Record<string, LanguageInfo>>;

export type Language = keyof typeof LANGUAGE_INFO;
export const LANGUAGES = Object.keys(LANGUAGE_INFO) as readonly Language[];

export const MESSAGES: Readonly<Record<Language, Messages>> = {
  ar, bg, ca, cs, da, de, el, en, es, et, fa, fi, fr, ga, he, hi, hr, hu, id, is, it, ja, ko,
  lt, lv, ms, mt, nb, nl, pl, pt, ro, ru, sk, sl, sr, sv, th, tr, uk, vi,
  'zh-Hans': zhHans,
  'zh-Hant': zhHant,
};

/**
 * Apple's rule for names in the Home app, as HAP-NodeJS checks it: letters,
 * numbers, spaces and some punctuation, starting and ending with a letter or
 * a number. Combining marks (Devanagari and Thai vowel signs, for example)
 * are not letters.
 */
const HOMEKIT_NAME = /^[\p{L}\p{N}][\p{L}\p{N}\p{Zs}’'&!._:;()/,-]*[\p{L}\p{N}]$/u;

export const isHomeKitName = (name: string): boolean => HOMEKIT_NAME.test(name);

export type Translate = (key: MessageKey, values?: Readonly<Record<string, string | number>>) => string;

const fill = (text: string, values: Readonly<Record<string, string | number>>): string =>
  text.replace(/\{([a-z]+)\}/g, (match, name: string) => (Object.hasOwn(values, name) ? String(values[name]) : match));

const SERVICE_KEYS = (Object.keys(MESSAGES.en) as MessageKey[]).filter((key) => key.startsWith('service.'));

/** Whether every HomeKit service name of a language follows Apple's rule. */
export const homeKitNamesValid = (messages: Messages): boolean =>
  SERVICE_KEYS.every((key) => isHomeKitName(fill(messages[key], { minutes: 30, number: 1 })));

/**
 * A translator for `language`, filling `{name}` placeholders. A language
 * whose HomeKit service names (`service.*`) break Apple's rule gets them all
 * in English, so that the Home app does not mix two languages.
 */
export function translator(language: Language): Translate {
  const messages = MESSAGES[language];
  const names = homeKitNamesValid(messages) ? messages : MESSAGES.en;
  return (key, values = {}) => fill((key.startsWith('service.') ? names : messages)[key], values);
}
