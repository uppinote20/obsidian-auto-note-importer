/**
 * @covers src/services/supabase-field-mapper.ts
 */

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

describe('supabaseFieldMapper.isSubfolderSafe', () => {
  it('returns true for stringifiable known types and their :readonly variants', () => {
    const known = [
      'string', 'string:uuid', 'string:date', 'string:date-time',
      'string:jsonb', 'string:json',
      'integer', 'integer:int64', 'number',
      'boolean',
      'object',
      'array:string', 'array:integer', 'array:number', 'array:boolean', 'array:object',
    ];
    for (const t of known) {
      expect(supabaseFieldMapper.isSubfolderSafe(t)).toBe(true);
      expect(supabaseFieldMapper.isSubfolderSafe(`${t}:readonly`)).toBe(true);
    }
  });

  it('returns false for string:byte (maps to unknown — would produce garbage folders)', () => {
    expect(supabaseFieldMapper.isSubfolderSafe('string:byte')).toBe(false);
    expect(supabaseFieldMapper.isSubfolderSafe('string:byte:readonly')).toBe(false);
  });

  it('returns false for unknown types', () => {
    expect(supabaseFieldMapper.isSubfolderSafe('something-weird')).toBe(false);
    expect(supabaseFieldMapper.isSubfolderSafe('')).toBe(false);
  });

  it('is a superset of isFilenameSafe', () => {
    for (const t of supabaseFieldMapper.getFilenameSafeTypes()) {
      expect(supabaseFieldMapper.isSubfolderSafe(t)).toBe(true);
    }
  });
});

describe('supabaseFieldMapper enumerations', () => {
  it('getFilenameSafeTypes returns sorted with no duplicates', () => {
    const list = supabaseFieldMapper.getFilenameSafeTypes();
    expect(new Set(list).size).toBe(list.length);
    expect([...list]).toEqual([...list].sort());
  });

  it('getSubfolderSafeTypes is a superset of getFilenameSafeTypes', () => {
    const filename = new Set(supabaseFieldMapper.getFilenameSafeTypes());
    const subfolder = new Set(supabaseFieldMapper.getSubfolderSafeTypes());
    for (const t of filename) expect(subfolder.has(t)).toBe(true);
    expect(subfolder.size).toBeGreaterThan(filename.size);
  });

  it('getReadOnlyTypes contains expected entries', () => {
    const list = supabaseFieldMapper.getReadOnlyTypes();
    expect(list).toContain('string:readonly');
    expect(list).toContain('object:readonly');
  });

  // Drift protection: every FILENAME_SAFE_TYPES entry must have a corresponding
  // base type in TYPE_TO_STANDARD. Without this guard, adding a new safe type
  // (e.g. 'string:time') without registering it as a known type would silently
  // make it unfilterable (it would be returned as filename-safe but every other
  // mapper method would treat it as 'unknown').
  it('every filename-safe type has a TYPE_TO_STANDARD mapping (no silent drift)', () => {
    const safeTypes = supabaseFieldMapper.getFilenameSafeTypes();
    for (const t of safeTypes) {
      // Strip optional :readonly suffix before checking the base mapping.
      const base = t.endsWith(':readonly') ? t.slice(0, -':readonly'.length) : t;
      expect(
        supabaseFieldMapper.mapToStandardType(base),
        `filename-safe type "${t}" base "${base}" has no TYPE_TO_STANDARD entry`,
      ).not.toBe('unknown');
    }
  });
});
