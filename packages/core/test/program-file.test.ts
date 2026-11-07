import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  buildEraseProgram,
  buildSetProgram,
  cleanProgramName,
  decodeDocument,
  draftFromProfile,
  encodeMessage,
  flattenParams,
  parseProgramProfile,
  programMatchesDraft,
  ProtocolError,
  serializeProgram,
  slotsPerDayLimit,
  validateProgramDraft,
  ValidationError,
  WEEKDAYS,
  withMidnightSlots,
  type ProgramDraft,
  type ProgramProfile,
  type TimeSlot,
  type Weekday,
} from '../src/index.js';

/** A program as read when the parser left some fields out. */
const without = (profile: ProgramProfile, ...fields: (keyof ProgramProfile)[]) =>
  Object.fromEntries(Object.entries(profile).filter(([key]) => !fields.includes(key as keyof ProgramProfile))) as unknown as ProgramProfile;

const WORK_DAY: readonly TimeSlot[] = [
  { time: '00:00', preset: 'NIGHT' },
  { time: '06:30', preset: 'DAY' },
  { time: '22:30', preset: 'NIGHT' },
];

const week = (slots: readonly TimeSlot[]) =>
  Object.fromEntries(WEEKDAYS.map((day) => [day, slots])) as Record<Weekday, readonly TimeSlot[]>;

const draft = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  number: 5,
  name: 'Work week',
  createdAt: '2026-01-02T03:04:05',
  days: week(WORK_DAY),
  ...overrides,
});

/** A file laid out as the observed device lays it out: this text is the point of the test. */
const CANONICAL =
  '<program_profile>\n' +
  '\t<filename>device_program_profile_5.xml</filename>\n' +
  '\t<program_description>\n' +
  '\t\t<is_program_profile_valid>TRUE</is_program_profile_valid>\n' +
  '\t\t<number>5</number>\n' +
  '\t\t<name>Mixed</name>\n' +
  '\t\t<type>WEEKLY</type>\n' +
  '\t\t<is_creation_date_valid>TRUE</is_creation_date_valid>\n' +
  '\t\t<creation_date>2026-01-02T03:04:05</creation_date>\n' +
  '\t</program_description>\n' +
  '\t<weekday>\n' +
  ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday']
    .map((day) => `\t\t<${day}>\n\t\t\t<slot id="0" preset="DAY" time="00:00"/>\n\t\t</${day}>\n`)
    .join('') +
  '\t\t<saturday>\n' +
  '\t\t\t<slot id="0" preset="AWAY" time="00:00"/>\n' +
  '\t\t\t<slot id="1" preset="PROTECTION" time="23:45"/>\n' +
  '\t\t</saturday>\n' +
  '\t</weekday>\n' +
  '</program_profile>\n';

describe('serializeProgram', () => {
  const mixed = validateProgramDraft({
    number: 5,
    name: 'Mixed',
    createdAt: '2026-01-02T03:04:05',
    days: {
      ...week([{ time: '00:00', preset: 'DAY' }]),
      saturday: [
        { time: '00:00', preset: 'AWAY' },
        { time: '23:45', preset: 'PROTECTION' },
      ],
    },
  });

  it('lays the file out exactly as the device does', () => {
    expect(serializeProgram(mixed)).toBe(CANONICAL);
  });

  it('gives back the same bytes after reading a file', () => {
    const read = parseProgramProfile(CANONICAL);
    expect(read.issues).toEqual([]);
    expect(serializeProgram(validateProgramDraft(draftFromProfile(read.value, 'unused')))).toBe(CANONICAL);
  });

  it('calls a program with the same day seven times DAILY, any other WEEKLY', () => {
    expect(serializeProgram(validateProgramDraft(draft()))).toContain('<type>DAILY</type>');
    expect(serializeProgram(mixed)).toContain('<type>WEEKLY</type>');
  });

  it('escapes a name already on the device', () => {
    const name = 'Tom & Jerry';
    const text = serializeProgram(validateProgramDraft(draft({ name }), { existingName: name }));
    expect(text).toContain('<name>Tom &amp; Jerry</name>');
    expect(parseProgramProfile(text).value.name).toBe(name);
  });
});

describe('validateProgramDraft', () => {
  it('accepts a good draft', () => {
    expect(validateProgramDraft(draft())).toMatchObject({ number: 5, name: 'Work week' });
  });

  it.each([
    ['the system program', { number: 0 }],
    ['a slot past the last', { number: 11 }],
    ['a number that is not whole', { number: 1.5 }],
    ['a number as text', { number: '5' }],
    ['an empty name', { name: '' }],
    ['a name of spaces', { name: '   ' }],
    ['a name starting with a space', { name: ' Work' }],
    ['a name ending with a space', { name: 'Work ' }],
    ['a name of 33 characters', { name: 'n'.repeat(33) }],
    ['a name of 64 characters, which comes back damaged', { name: 'n'.repeat(64) }],
    ['a name that is not text', { name: 5 }],
    ['a name with a slash', { name: 'Home/away' }],
    ['a name with an accent', { name: 'Caffè' }],
    ['a name ending a CDATA section', { name: 'a]]>b' }],
    ['a name with markup', { name: '<x>' }],
    ['a name with an entity', { name: '&amp;' }],
    ['a bad creation date', { createdAt: 'yesterday' }],
    ['no creation date', { createdAt: undefined }],
    ['no days', { days: undefined }],
    ['days that are not an object', { days: 'all' }],
    ['a missing day', { days: { monday: WORK_DAY } }],
    ['an unknown day', { days: { ...week(WORK_DAY), funday: WORK_DAY } }],
    ['an empty day', { days: { ...week(WORK_DAY), friday: [] } }],
    ['a day that is not a list', { days: { ...week(WORK_DAY), friday: 'x' } }],
    ['a day not starting at midnight', { days: { ...week(WORK_DAY), friday: [{ time: '06:00', preset: 'DAY' }] } }],
    ['a time off the quarter hour', { days: { ...week(WORK_DAY), friday: [{ time: '00:10', preset: 'DAY' }] } }],
    ['a time past the end of the day', { days: { ...week(WORK_DAY), friday: [{ time: '24:00', preset: 'DAY' }] } }],
    ['an unknown level', { days: { ...week(WORK_DAY), friday: [{ time: '00:00', preset: 'ECO' }] } }],
    ['a slot that is not an object', { days: { ...week(WORK_DAY), friday: ['00:00'] } }],
    ['a slot with an extra field', { days: { ...week(WORK_DAY), friday: [{ time: '00:00', preset: 'DAY', id: 3 }] } }],
    ['times out of order', { days: { ...week(WORK_DAY), friday: [WORK_DAY[0], WORK_DAY[2], WORK_DAY[1]] } }],
    ['the same time twice', { days: { ...week(WORK_DAY), friday: [WORK_DAY[0], WORK_DAY[1], WORK_DAY[1]] } }],
    ['an extra field', { valid: true }],
    ['raw file text', { file: '<program_profile/>' }],
  ])('rejects %s', (_name, overrides) => {
    expect(() => validateProgramDraft(draft(overrides))).toThrow(ValidationError);
  });

  it.each([[null], ['text'], [5], [undefined]])('rejects %s instead of a program', (input) => {
    expect(() => validateProgramDraft(input)).toThrow(ValidationError);
  });

  it('accepts an unchanged name that a new one could not be', () => {
    expect(validateProgramDraft(draft({ name: 'Home/away' }), { existingName: 'Home/away' }).name).toBe('Home/away');
    expect(() => validateProgramDraft(draft({ name: 'Home/awayy' }), { existingName: 'Home/away' })).toThrow(ValidationError);
  });

  it.each([
    ['too long', 'n'.repeat(64)],
    ['with markup', '<x>'],
    ['with a control character', 'a\tb'],
    ['blank', '  '],
  ])('rejects an existing name %s', (_name, existingName) => {
    expect(() => validateProgramDraft(draft({ name: existingName }), { existingName })).toThrow(ValidationError);
  });

  it('merges neighbouring slots with the same level', () => {
    const slots: TimeSlot[] = [
      { time: '00:00', preset: 'DAY' },
      { time: '08:00', preset: 'DAY' },
      { time: '09:00', preset: 'NIGHT' },
      { time: '10:00', preset: 'NIGHT' },
    ];
    expect(validateProgramDraft(draft({ days: week(slots) })).days.monday).toEqual([
      { time: '00:00', preset: 'DAY' },
      { time: '09:00', preset: 'NIGHT' },
    ]);
  });

  const alternating = (count: number): TimeSlot[] =>
    Array.from({ length: count }, (_, index) => ({
      time: `${String(index).padStart(2, '0')}:00`,
      preset: index % 2 === 0 ? 'DAY' : 'NIGHT',
    }));

  it('allows ten slots a day, or as many as the firmware takes', () => {
    expect(validateProgramDraft(draft({ days: week(alternating(10)) })).days.sunday).toHaveLength(10);
    expect(() => validateProgramDraft(draft({ days: week(alternating(11)) }))).toThrow(/at most 10/);
    expect(() => validateProgramDraft(draft({ days: week(alternating(9)) }), { maxSlotsPerDay: 8 })).toThrow(/at most 8/);
  });

  it('counts the slots after merging them, but refuses an absurd list', () => {
    const same: TimeSlot[] = Array.from({ length: 12 }, (_, index) => ({ time: `${String(index).padStart(2, '0')}:00`, preset: 'DAY' }));
    expect(validateProgramDraft(draft({ days: week(same) })).days.monday).toHaveLength(1);
    const huge: TimeSlot[] = Array.from({ length: 81 }, () => ({ time: '00:00', preset: 'DAY' }));
    expect(() => validateProgramDraft(draft({ days: week(huge) }))).toThrow(/too many/);
  });
});

describe('cleanProgramName', () => {
  it('gives a name that can always be written, or nothing', () => {
    for (const typed of ['Caffè', 'a/b', ' x  y ', 'n'.repeat(64), `${'n'.repeat(31)} x`, 'Città & Mare']) {
      expect(validateProgramDraft(draft({ name: cleanProgramName(typed) })).name).toBe(cleanProgramName(typed));
    }
    expect(cleanProgramName('日本語')).toBe('');
  });
});

describe('slotsPerDayLimit', () => {
  it.each([
    ['1.0.34', 8],
    ['1.1.105', 10],
    ['2.1.0', 10],
    ['1.10.0', 10],
    [undefined, 10],
  ])('for firmware %s is %s', (version, limit) => {
    expect(slotsPerDayLimit(version)).toBe(limit);
  });
});

describe('withMidnightSlots', () => {
  const none = week([]);

  it('writes out the level a day keeps from the day before', () => {
    const days = withMidnightSlots({
      ...none,
      monday: [{ time: '07:00', preset: 'DAY' }, { time: '22:00', preset: 'NIGHT' }],
      wednesday: [{ time: '00:00', preset: 'AWAY' }],
    });
    expect(days.tuesday).toEqual([{ time: '00:00', preset: 'NIGHT' }]);
    expect(days.wednesday).toEqual([{ time: '00:00', preset: 'AWAY' }]);
    expect(days.thursday).toEqual([{ time: '00:00', preset: 'AWAY' }]);
    expect(days.sunday).toEqual([{ time: '00:00', preset: 'AWAY' }]);
  });

  it('takes the level of Monday morning from the end of the week', () => {
    const days = withMidnightSlots({ ...none, monday: [{ time: '07:00', preset: 'DAY' }], sunday: [{ time: '21:00', preset: 'AWAY' }] });
    expect(days.monday).toEqual([
      { time: '00:00', preset: 'AWAY' },
      { time: '07:00', preset: 'DAY' },
    ]);
  });

  it('leaves a program without slots empty, for the validation to refuse', () => {
    expect(withMidnightSlots(none).monday).toEqual([]);
  });
});

describe('draftFromProfile', () => {
  const profile = parseProgramProfile(CANONICAL).value;

  it('keeps name and creation date', () => {
    expect(draftFromProfile(profile, '2030-01-01T00:00:00')).toMatchObject({ number: 5, name: 'Mixed', createdAt: '2026-01-02T03:04:05' });
  });

  it('falls back on the given date, and on an empty name', () => {
    expect(draftFromProfile(without(profile, 'createdAt', 'name'), '2030-01-01T00:00:00')).toMatchObject({ name: '', createdAt: '2030-01-01T00:00:00' });
  });

  it.each([[0], [undefined]])('refuses program %s', (number) => {
    const rest = without(profile, 'number');
    expect(() => draftFromProfile(number === undefined ? rest : { ...rest, number }, 'x')).toThrow(ValidationError);
  });
});

describe('the messages', () => {
  it('carries the file with its checksum, to the file service', () => {
    const decoded = decodeDocument(buildSetProgram('seq', draft()));
    if (decoded.kind !== 'v3') throw new Error('not a V3 message');
    const { message } = decoded;
    const text = message.fileData?.text ?? '';
    expect(message).toMatchObject({ service: 'SET', seqId: 'seq', who: '1004', actionId: 'device_file', fileData: { encoding: '' } });
    expect(flattenParams(message).get('file_name')).toBe('device_program_profile_5.xml');
    expect(flattenParams(message).get('sha256sum')).toBe(createHash('sha256').update(text, 'utf8').digest('hex'));
    expect(parseProgramProfile(text).value).toMatchObject({ number: 5, name: 'Work week', valid: true });
  });

  it('validates the program again', () => {
    expect(() => buildSetProgram('seq', draft({ number: 0 }))).toThrow(ValidationError);
  });

  it('erases with the word ERASE, and its checksum', () => {
    const decoded = decodeDocument(buildEraseProgram('seq', 10));
    if (decoded.kind !== 'v3') throw new Error('not a V3 message');
    expect(decoded.message.fileData?.text).toBe('ERASE');
    expect(flattenParams(decoded.message).get('file_name')).toBe('device_program_profile_10.xml');
    expect(flattenParams(decoded.message).get('sha256sum')).toBe(createHash('sha256').update('ERASE').digest('hex'));
  });

  it.each([[0], [11], [-1], [1.5], ['5'], [undefined]])('cannot erase %s', (number) => {
    expect(() => buildEraseProgram('seq', number)).toThrow(ValidationError);
  });

  it('cannot carry the end of a CDATA section', () => {
    expect(() =>
      encodeMessage({ style: 'command', service: 'SET', seqId: 's', progress: 0, actionId: 'device_file', file: 'a]]>b' }),
    ).toThrow(ProtocolError);
  });
});

describe('programMatchesDraft', () => {
  const written: ProgramDraft = validateProgramDraft(draft());
  const read = () => parseProgramProfile(serializeProgram(written)).value;

  it('recognises what was written', () => {
    expect(programMatchesDraft(read(), written)).toBe(true);
  });

  it.each([
    ['another name', { name: 'Other' }],
    ['another number', { number: 6 }],
    ['a program marked as not valid', { valid: false }],
    ['another type', { type: 'WEEKLY' as const }],
    ['another day', { days: { ...read().days, friday: [{ time: '00:00', preset: 'DAY' as const }] } }],
  ])('notices %s', (_name, change) => {
    expect(programMatchesDraft({ ...read(), ...change }, written)).toBe(false);
  });

  it('notices a name that was left out', () => {
    expect(programMatchesDraft(without(read(), 'name'), written)).toBe(false);
  });
});
