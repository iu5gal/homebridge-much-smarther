import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { homeKitNamesValid, isHomeKitName, LANGUAGE_INFO, LANGUAGES, MESSAGES, translator } from '../src/i18n.js';

const placeholders = (text: string) => [...text.matchAll(/\{([a-z]+)\}/g)].map((match) => match[1]).sort();
const reference = Object.keys(MESSAGES.en).sort();
const serviceKeys = reference.filter((key) => key.startsWith('service.')) as (keyof typeof MESSAGES.en)[];

/** Languages whose script needs combining marks: HomeKit gets English names. */
const ENGLISH_HOMEKIT_NAMES = ['hi', 'th'];

describe('translations', () => {
  it.each(LANGUAGES)('%s has exactly the English keys, all filled in', (language) => {
    const messages = MESSAGES[language];
    expect(Object.keys(messages).sort()).toEqual(reference);
    for (const [key, text] of Object.entries(messages)) expect(text.trim(), key).not.toBe('');
  });

  it.each(LANGUAGES)('%s uses the same placeholders as English', (language) => {
    for (const key of reference) {
      const english = MESSAGES.en[key as keyof typeof MESSAGES.en];
      expect(placeholders(MESSAGES[language][key as keyof typeof MESSAGES.en]), key).toEqual(placeholders(english));
    }
  });

  it.each(LANGUAGES)('%s is in Unicode normal form C, without stray spaces', (language) => {
    for (const [key, text] of Object.entries(MESSAGES[language])) {
      expect(text, key).toBe(text.normalize('NFC'));
      expect(text, key).toBe(text.trim());
      expect(text, key).not.toMatch(/ {2}/);
    }
  });

  it('is complete for the setup page: every language has a name, a locale and a known direction', () => {
    expect(LANGUAGES).toHaveLength(43);
    for (const language of LANGUAGES) {
      const info: { name: string; locale: string; rtl?: true } = LANGUAGE_INFO[language];
      expect(info.name.trim()).not.toBe('');
      expect(Intl.DateTimeFormat.supportedLocalesOf([info.locale]), language).toEqual([info.locale]);
    }
    expect(LANGUAGES.filter((language) => (LANGUAGE_INFO[language] as { rtl?: true }).rtl)).toEqual(['ar', 'fa', 'he']);
  });

  it('offers the same languages in config.schema.json', () => {
    const schema = JSON.parse(readFileSync(new URL('../config.schema.json', import.meta.url), 'utf8')) as {
      schema: { properties: { language: { oneOf: { title: string; enum: string[] }[] } } };
    };
    const choices = schema.schema.properties.language.oneOf;
    expect(choices.map((choice) => choice.enum[0])).toEqual([...LANGUAGES]);
    expect(choices.map((choice) => choice.title)).toEqual(LANGUAGES.map((language) => LANGUAGE_INFO[language].name));
  });

  it('fills placeholders and leaves unknown ones', () => {
    expect(translator('it')('service.boost', { minutes: 30 })).toBe('Boost 30 min');
    expect(translator('en')('ui.status.until')).toBe('until {time}');
    expect(translator('it')('service.schedule')).toBe('Programma');
    expect(translator('ja')('ui.status.until', { time: '06:15' })).toBe('06:15まで');
  });
});

describe('HomeKit names', () => {
  it.each(LANGUAGES)('%s gives the Home app names that follow Apple’s rule', (language) => {
    const t = translator(language);
    for (const key of serviceKeys) expect(isHomeKitName(t(key, { minutes: 90, number: 10 })), key).toBe(true);
  });

  it('uses English names in the Home app only where the script needs combining marks', () => {
    expect(LANGUAGES.filter((language) => !homeKitNamesValid(MESSAGES[language]))).toEqual(ENGLISH_HOMEKIT_NAMES);
    expect(translator('th')('service.humidity')).toBe('Humidity');
    expect(translator('th')('service.schedule')).toBe('Schedule');
    expect(translator('hi')('service.boost', { minutes: 30 })).toBe('Boost 30 min');
    // The setup page still shows them in the language.
    expect(translator('th')('ui.status.humidity')).toBe(MESSAGES.th['ui.status.humidity']);
  });

  it('follows the rule as HAP-NodeJS checks it', () => {
    expect(isHomeKitName('Boost 30 min')).toBe(true);
    expect(isHomeKitName('Турбо 30 мин')).toBe(true);
    expect(isHomeKitName('强力运行 30 分钟')).toBe(true);
    expect(isHomeKitName('Boost 30 Min.')).toBe(false);
    expect(isHomeKitName('ความชื้น')).toBe(false);
    expect(isHomeKitName('زمان‌بندی')).toBe(false);
  });
});
