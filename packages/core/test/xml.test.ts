import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { escapeXml, parseXml, XmlError } from '../src/index.js';

describe('parseXml with CDATA allowed in some elements', () => {
  const options = { cdataIn: new Set(['file_data']) };

  it('keeps the CDATA content verbatim', () => {
    const root = parseXml('<r><file_data encoded=""><![CDATA[<a b="&x;">]]></file_data></r>', undefined, options);
    expect(root.children[0]?.text).toBe('<a b="&x;">');
  });

  it('joins text and CDATA', () => {
    const root = parseXml('<file_data> <![CDATA[a]]><![CDATA[b]]></file_data>', undefined, options);
    expect(root.text).toBe(' ab');
  });

  it.each([
    ['CDATA in another element', '<r><other><![CDATA[x]]></other></r>'],
    ['CDATA in the parent', '<r><![CDATA[x]]><file_data/></r>'],
    ['unterminated CDATA', '<file_data><![CDATA[x</file_data>'],
    ['DOCTYPE inside the allowed element', '<file_data><!DOCTYPE x></file_data>'],
    ['comment inside the allowed element', '<file_data><!-- x --></file_data>'],
    ['control character in CDATA', '<file_data><![CDATA[\u0001]]></file_data>'],
  ])('still rejects %s', (_name, xml) => {
    expect(() => parseXml(xml, undefined, options)).toThrow(XmlError);
  });
});

describe('parseXml', () => {
  it('parses elements, attributes, text and namespaces', () => {
    const root = parseXml(
      `<?xml version="1.0" encoding="utf-8"?>\n<a:Root xmlns:a="urn:x" xmlns="urn:y" k='v'><B x="1"/>hi<C>t &amp; &lt;&#65;&#x42;&gt;</C></a:Root>`,
    );
    expect(root.name).toBe('Root');
    expect([...root.attributes]).toEqual([['k', 'v']]);
    expect(root.text).toBe('hi');
    expect(root.children.map((child) => child.name)).toEqual(['B', 'C']);
    expect(root.children[0]?.attributes.get('x')).toBe('1');
    expect(root.children[1]?.text).toBe('t & <AB>');
  });

  it('decodes entities in attribute values', () => {
    expect(parseXml('<a v="&quot;&apos;&amp;"/>').attributes.get('v')).toBe(`"'&`);
  });

  const XXE = `<?xml version="1.0"?><!DOCTYPE r [<!ENTITY x SYSTEM "file:///etc/passwd">]><r>&x;</r>`;
  const BILLION_LAUGHS = `<!DOCTYPE l [<!ENTITY a "aaaa"><!ENTITY b "&a;&a;&a;&a;">]><l>&b;</l>`;

  it.each([
    ['XXE', XXE],
    ['entity expansion', BILLION_LAUGHS],
    ['bare DOCTYPE', '<!DOCTYPE r><r/>'],
    ['undeclared entity', '<r>&x;</r>'],
    ['external entity reference in attribute', '<r a="&ext;"/>'],
    ['comment', '<r><!-- c --></r>'],
    ['CDATA', '<r><![CDATA[x]]></r>'],
    ['processing instruction', '<r><?pi x?></r>'],
    ['unterminated entity', '<r>&amp</r>'],
    ['bare ampersand', '<r>a & b</r>'],
    ['NUL character reference', '<r>&#0;</r>'],
    ['surrogate reference', '<r>&#xD800;</r>'],
    ['control character', '<r>\u0001</r>'],
    ['mismatched tag', '<a><b></a></b>'],
    ['unclosed element', '<a><b/>'],
    ['two roots', '<a/><b/>'],
    ['text before root', 'x<a/>'],
    ['duplicate attribute', '<a x="1" x="2"/>'],
    ['unquoted attribute', '<a x=1/>'],
    ['missing whitespace between attributes', '<a x="1"y="2"/>'],
    ['lt in attribute', '<a x="<"/>'],
    ['empty input', ''],
    ['CDATA terminator in text', '<a>]]></a>'],
  ])('rejects %s', (_name, input) => {
    expect(() => parseXml(input)).toThrow(XmlError);
  });

  it('enforces size, depth, element and attribute limits', () => {
    const limits = { maxLength: 100, maxDepth: 3, maxElements: 4, maxAttributes: 2 };
    expect(() => parseXml(`<a>${'x'.repeat(100)}</a>`, limits)).toThrow(/too large/);
    expect(() => parseXml('<a><b><c><d/></c></b></a>', limits)).toThrow(/nested/);
    expect(() => parseXml('<a><b/><b/><b/><b/></a>', limits)).toThrow(/elements/);
    expect(() => parseXml('<a x="1" y="2" z="3"/>', limits)).toThrow(/attributes/);
  });

  it('does not let attribute names reach the object prototype', () => {
    const root = parseXml('<a __proto__="x" constructor="y"/>');
    expect(root.attributes.get('__proto__')).toBe('x');
    expect(({} as Record<string, unknown>)['x']).toBeUndefined();
  });

  it('never throws anything but XmlError on arbitrary input', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 300 }), (input) => {
        try {
          parseXml(input);
        } catch (error) {
          expect(error).toBeInstanceOf(XmlError);
        }
      }),
      { numRuns: 2000 },
    );
  });

  it('never throws anything but XmlError on mutated messages', () => {
    const sample = '<OWNMsg Profile="V3"><Payload><Service TYPE="RSP" /><ActionID>x</ActionID></Payload></OWNMsg>';
    fc.assert(
      fc.property(fc.nat(sample.length), fc.nat(sample.length), fc.string({ maxLength: 8 }), (at, cut, insert) => {
        const mutated = sample.slice(0, at) + insert + sample.slice(Math.min(sample.length, at + (cut % 5)));
        try {
          parseXml(mutated);
        } catch (error) {
          expect(error).toBeInstanceOf(XmlError);
        }
      }),
      { numRuns: 2000 },
    );
  });

  it('round-trips escaped attribute values', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 100, unit: 'grapheme' }), (value) => {
        expect(parseXml(`<a v="${escapeXml(value)}"/>`).attributes.get('v')).toBe(value);
      }),
    );
  });
});
