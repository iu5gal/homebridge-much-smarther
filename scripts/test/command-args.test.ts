import { describe, expect, it } from 'vitest';
import { validateDeviceStateRequest } from '@much-smarther/core';
import { parseCommand, UsageError } from '../../tools/lib/command-args.mjs';

const NOW = new Date(2026, 9, 30, 21, 40, 15);

const build = (words: string[]) => {
  const command = parseCommand(words, NOW);
  if (command.kind !== 'set') throw new Error('expected a command that sets the state');
  return command.build('HEATING');
};

describe('parseCommand', () => {
  it('reads the state', () => {
    expect(parseCommand(['state'], NOW)).toEqual({ kind: 'state', watchMinutes: 2 });
  });

  it.each<[string[], object]>([
    [['manual', '20.5'], { mode: 'MANUAL', function: 'HEATING', setpoint: 20.5 }],
    [['manual', '21', 'for', '15'], { mode: 'MANUAL', setpoint: 21, until: new Date(2026, 9, 30, 21, 55, 15) }],
    [['manual', '21', 'until', '22:30'], { until: new Date(2026, 9, 30, 22, 30, 0) }],
    [['manual', '21', 'until', '07:00'], { until: new Date(2026, 9, 31, 7, 0, 0) }],
    [['manual', '21', 'until', '2026-11-01T08:15'], { until: new Date(2026, 10, 1, 8, 15, 0) }],
    [['boost', '60'], { mode: 'BOOST', function: 'HEATING', minutes: 60 }],
    [['off'], { mode: 'PROTECTION', function: 'HEATING' }],
    [['off', 'for', '5'], { mode: 'PROTECTION', until: new Date(2026, 9, 30, 21, 45, 15) }],
    [['auto'], { mode: 'AUTOMATIC', function: 'HEATING' }],
    [['auto', '2'], { mode: 'AUTOMATIC', programNumber: 2 }],
  ])('builds %j', (words, expected) => {
    const request = build(words);
    expect(request).toMatchObject(expected);
    expect(() => validateDeviceStateRequest(request, NOW)).not.toThrow();
  });

  it('keeps the function it is given', () => {
    const command = parseCommand(['boost', '30'], NOW);
    expect(command.kind === 'set' && command.build('COOLING').function).toBe('COOLING');
  });

  it('reads --watch anywhere', () => {
    expect(parseCommand(['--watch', '35', 'boost', '30'], NOW).watchMinutes).toBe(35);
    expect(parseCommand(['off', '--watch', '0'], NOW).watchMinutes).toBe(0);
  });

  it.each([
    [[]],
    [['heat']],
    [['state', 'now']],
    [['manual']],
    [['manual', '20,5']],
    [['manual', '20.25']],
    [['manual', '21', 'until']],
    [['manual', '21', 'until', '25:00']],
    [['manual', '21', 'until', '2026-02-30T08:00']],
    [['manual', '21', 'for', 'ten']],
    [['manual', '21', 'until', '22:00', 'please']],
    [['boost', '45']],
    [['boost']],
    [['off', 'tomorrow']],
    [['auto', '11']],
    [['auto', '1', '2']],
    [['boost', '30', '--watch', '121']],
    [['boost', '30', '--watch']],
  ])('rejects %j', (words) => {
    expect(() => parseCommand(words, NOW)).toThrow(UsageError);
  });

  it('leaves range checks to the core', () => {
    expect(() => validateDeviceStateRequest(build(['manual', '45']), NOW)).toThrow();
    expect(() => validateDeviceStateRequest(build(['off', 'for', '20000']), NOW)).toThrow();
  });
});
