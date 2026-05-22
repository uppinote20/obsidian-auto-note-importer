import { describe, it, expect } from 'vitest';
import { supabaseFieldMapper } from '../../src/services/supabase-field-mapper';

describe('supabaseFieldMapper.mapToStandardType', () => {
  it.each([
    ['string', 'text'],
    ['string:uuid', 'text'],
    ['string:date', 'date'],
    ['string:date-time', 'date'],
    ['integer', 'number'],
    ['integer:int64', 'number'],
    ['number', 'number'],
    ['boolean', 'boolean'],
    ['object', 'text'],
    ['array:string', 'multi-select'],
    ['array:integer', 'multi-select'],
    ['array:number', 'multi-select'],
    ['array:boolean', 'multi-select'],
    ['array:object', 'text'],
  ])('maps %s to %s', (input, expected) => {
    expect(supabaseFieldMapper.mapToStandardType(input)).toBe(expected);
  });

  it('strips readonly suffix before lookup', () => {
    expect(supabaseFieldMapper.mapToStandardType('string:date-time:readonly')).toBe('date');
    expect(supabaseFieldMapper.mapToStandardType('integer:readonly')).toBe('number');
  });

  it('falls back to unknown for unrecognized types', () => {
    expect(supabaseFieldMapper.mapToStandardType('something-weird')).toBe('unknown');
    expect(supabaseFieldMapper.mapToStandardType('')).toBe('unknown');
  });
});

describe('supabaseFieldMapper.isReadOnly', () => {
  it('returns true for types ending with readonly suffix', () => {
    expect(supabaseFieldMapper.isReadOnly('string:readonly')).toBe(true);
    expect(supabaseFieldMapper.isReadOnly('integer:int64:readonly')).toBe(true);
  });

  it('returns false for non-readonly types', () => {
    expect(supabaseFieldMapper.isReadOnly('string')).toBe(false);
    expect(supabaseFieldMapper.isReadOnly('integer')).toBe(false);
  });

  it('fail-closed: unknown providerType is read-only', () => {
    expect(supabaseFieldMapper.isReadOnly('totally-unknown-type')).toBe(true);
  });
});

describe('supabaseFieldMapper.isFilenameSafe', () => {
  it('accepts string, integer, and uuid (with optional readonly)', () => {
    for (const t of [
      'string', 'string:uuid', 'integer', 'integer:int64',
      'string:readonly', 'string:uuid:readonly', 'integer:readonly', 'integer:int64:readonly',
    ]) {
      expect(supabaseFieldMapper.isFilenameSafe(t)).toBe(true);
    }
  });

  it('rejects non-filename-safe types', () => {
    for (const t of ['boolean', 'string:date', 'object', 'array:string', 'number']) {
      expect(supabaseFieldMapper.isFilenameSafe(t)).toBe(false);
    }
  });
});

describe('supabaseFieldMapper enumerations', () => {
  it('getFilenameSafeTypes returns sorted with no duplicates', () => {
    const list = supabaseFieldMapper.getFilenameSafeTypes();
    expect(new Set(list).size).toBe(list.length);
    expect([...list]).toEqual([...list].sort());
  });

  it('getReadOnlyTypes contains expected entries', () => {
    const list = supabaseFieldMapper.getReadOnlyTypes();
    expect(list).toContain('string:readonly');
    expect(list).toContain('object:readonly');
  });
});
