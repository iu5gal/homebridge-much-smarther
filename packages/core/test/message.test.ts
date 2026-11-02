import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { decodeDocument, encodeMessage, flattenParams, ProtocolError, type XOpenMessage } from '../src/index.js';

function decode(xml: string): XOpenMessage {
  const document = decodeDocument(xml);
  if (document.kind !== 'v3') throw new Error('expected a V3 message');
  return document.message;
}

const RESPONSE =
  '<OWNMsg xmlns="http://www.bticino.it/xopen/v1" Profile="V3" Version="Official"><Payload>' +
  '<Service TYPE="RSP" /><SeqID ID="abc-1" Progress="3" Marker="0" IsLast="TRUE" />' +
  '<Address WHO="4" WHERE="" /><ActionID> device_state </ActionID>' +
  '<ParamList><Params mode="MANUAL" /><Params /><Params setpoint="21.5" mode="OFF" /></ParamList>' +
  '<Unknown /></Payload></OWNMsg>';

const fileParams = (text: string) => `<Params><file_data encoded=""><![CDATA[${text}]]></file_data></Params>`;
const FILE = fileParams('<configuration><x>1</x></configuration>');

describe('decodeDocument', () => {
  it('decodes a V3 message, ignoring namespaces and unknown elements', () => {
    const message = decode(RESPONSE);
    expect(message).toMatchObject({
      service: 'RSP',
      seqId: 'abc-1',
      progress: 3,
      who: '4',
      where: '',
      actionId: 'device_state',
    });
    expect(message.params).toHaveLength(2);
    expect([...flattenParams(message)]).toEqual([
      ['mode', 'MANUAL'],
      ['setpoint', '21.5'],
    ]);
  });

  it('treats an empty SeqID as missing', () => {
    const xml = '<OWNMsg><Payload><Service TYPE="RSP"/><SeqID ID=""/><ActionID>AckMsg</ActionID></Payload></OWNMsg>';
    expect(decode(xml).seqId).toBeUndefined();
  });

  it('recognises legacy OWNxml documents', () => {
    expect(decodeDocument('<OWNxml><Hdr/></OWNxml>')).toEqual({ kind: 'legacy' });
  });

  const wrap = (payload: string, root = '<OWNMsg Profile="V3">') => `${root}<Payload>${payload}</Payload></OWNMsg>`;
  const OK_SERVICE = '<Service TYPE="RSP"/>';
  const OK_ACTION = '<ActionID>AckMsg</ActionID>';

  it.each([
    ['unknown root', '<Other/>'],
    ['other profile', wrap(OK_SERVICE + OK_ACTION, '<OWNMsg Profile="V1">')],
    ['missing payload', '<OWNMsg/>'],
    ['two payloads', '<OWNMsg><Payload/><Payload/></OWNMsg>'],
    ['missing service', wrap(OK_ACTION)],
    ['bad service', wrap('<Service TYPE="rsp"/>' + OK_ACTION)],
    ['missing ActionID', wrap(OK_SERVICE)],
    ['bad ActionID', wrap(OK_SERVICE + '<ActionID>a b</ActionID>')],
    ['bad SeqID', wrap(OK_SERVICE + OK_ACTION + '<SeqID ID="a b"/>')],
    ['bad Progress', wrap(OK_SERVICE + OK_ACTION + '<SeqID ID="a" Progress="-1"/>')],
    ['bad WHO', wrap(OK_SERVICE + OK_ACTION + '<Address WHO="&lt;x&gt;"/>')],
    ['bad parameter name', wrap(OK_SERVICE + OK_ACTION + '<ParamList><Params a:b="1"/></ParamList>')],
    ['oversized parameter', wrap(OK_SERVICE + OK_ACTION + `<ParamList><Params a="${'x'.repeat(1025)}"/></ParamList>`)],
    ['two files', wrap(OK_SERVICE + OK_ACTION + `<ParamList>${FILE}${FILE}</ParamList>`)],
    ['oversized file', wrap(OK_SERVICE + OK_ACTION + `<ParamList>${fileParams('x'.repeat(48 * 1024 + 1))}</ParamList>`)],
    ['bad file encoding', wrap(OK_SERVICE + OK_ACTION + '<ParamList><Params><file_data encoded="a b"/></Params></ParamList>')],
  ])('rejects %s', (_name, xml) => {
    expect(() => decodeDocument(xml)).toThrow(ProtocolError);
  });

  it('extracts a file carried in a Params element without attributes', () => {
    const message = decode(
      wrap(
        '<Service TYPE="RSP"/><ActionID>device_file</ActionID><ParamList>' +
          '<Params file_name="device_configuration.xml" sha256sum="ab" />' +
          `${FILE}</ParamList>`,
      ),
    );
    expect(message.fileData).toEqual({ encoding: '', text: '<configuration><x>1</x></configuration>' });
    expect([...flattenParams(message)]).toEqual([
      ['file_name', 'device_configuration.xml'],
      ['sha256sum', 'ab'],
    ]);
  });

  it('rejects CDATA outside file_data', () => {
    expect(() => decodeDocument(wrap(OK_SERVICE + '<ActionID><![CDATA[AckMsg]]></ActionID>'))).toThrow();
  });
});

describe('encodeMessage', () => {
  it('produces the command layout', () => {
    expect(
      encodeMessage({ style: 'command', service: 'GET', seqId: 's1', progress: 0, actionId: 'device_state', who: '4' }),
    ).toBe(
      '<OWNMsg Profile="V3" Version="Official"><Payload><Service TYPE="GET" />' +
        '<SeqID ID="s1" Progress="0" Marker="0" IsLast="TRUE" /><Address WHO="4" WHERE="" />' +
        '<ActionID>device_state</ActionID><ParamList><Params /></ParamList></Payload></OWNMsg>',
    );
  });

  it('produces the handshake layout', () => {
    expect(encodeMessage({ style: 'handshake', service: 'RSP', seqId: 's1', progress: 2, actionId: 'AckMsg' })).toBe(
      '<OWNMsg Profile="V3"><Payload><Service TYPE="RSP" /><SeqID ID="s1" Progress="2" />' +
        '<Address></Address><ActionID>AckMsg</ActionID><ParamList /></Payload></OWNMsg>',
    );
  });

  it('escapes parameter values', () => {
    const xml = encodeMessage({
      style: 'command',
      service: 'SET',
      seqId: 's',
      progress: 0,
      actionId: 'x',
      params: [{ v: '"><Injected/>' }],
    });
    expect(xml).toContain('v="&quot;&gt;&lt;Injected/&gt;"');
    expect(flattenParams(decode(xml)).get('v')).toBe('"><Injected/>');
  });

  it.each([
    ['ActionID', { actionId: 'a"b' }],
    ['SeqID', { seqId: 'a"b' }],
    ['Progress', { progress: -1 }],
    ['parameter name', { params: [{ 'a b': '1' }] }],
  ])('rejects an invalid %s', (_name, override) => {
    expect(() =>
      encodeMessage({ style: 'command', service: 'GET', seqId: 's', progress: 0, actionId: 'a', ...override }),
    ).toThrow(ProtocolError);
  });

  it('round-trips through decodeDocument', () => {
    const key = fc.stringMatching(/^[A-Za-z_][A-Za-z0-9_]{0,10}$/);
    fc.assert(
      fc.property(
        fc.constantFrom('GET', 'SET', 'RSP', 'EVT' as const),
        fc.stringMatching(/^[A-Za-z0-9-]{1,36}$/),
        fc.stringMatching(/^[A-Za-z][A-Za-z0-9_]{0,20}$/),
        fc.array(fc.dictionary(key, fc.string({ maxLength: 20 }), { minKeys: 1, maxKeys: 3 }), { maxLength: 5 }),
        (service, seqId, actionId, params) => {
          const message = decode(encodeMessage({ style: 'command', service, seqId, progress: 0, actionId, params }));
          expect(message).toMatchObject({ service, seqId, actionId });
          expect(message.params.map((group) => Object.fromEntries(group))).toEqual(params);
        },
      ),
    );
  });
});
