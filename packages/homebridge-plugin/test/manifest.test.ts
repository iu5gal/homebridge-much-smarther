import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (file: string) => JSON.parse(readFileSync(new URL(`../${file}`, import.meta.url), 'utf8')) as unknown;

/** Every `required` in a JSON Schema, with its path: it must be an array at object level. */
function requiredEntries(node: unknown, path = '$'): [string, unknown][] {
  if (node === null || typeof node !== 'object') return [];
  return Object.entries(node).flatMap(([key, value]) =>
    key === 'required' ? [[path, value] as [string, unknown]] : requiredEntries(value, `${path}.${key}`),
  );
}

// The checks the Homebridge verification bot runs on package.json and config.schema.json.
describe('plugin manifest', () => {
  it('declares HAP as its only transport', () => {
    const { keywords } = read('package.json') as { keywords: string[] };
    expect(keywords).toContain('homebridge-plugin');
    expect(keywords).toContain('supports-hap');
    expect(keywords).not.toContain('supports-matter');
  });

  it('lists required settings as an array at object level only', () => {
    const { schema } = read('config.schema.json') as { schema: { properties: Record<string, unknown> } };
    expect(requiredEntries(schema)).toEqual([['$', ['name', 'host']]]);
    expect(Object.keys(schema.properties)).toEqual(expect.arrayContaining(['name', 'host']));
  });
});
