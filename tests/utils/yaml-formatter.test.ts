/**
 * Tests for yaml-formatter utility functions.
 * @covers src/utils/yaml-formatter.ts
 */

import { describe, it, expect } from 'vitest';
import {
  formatYamlValue,
  formatFieldForBases,
  formatObjectLabel
} from '../../src/utils/yaml-formatter';

describe('formatYamlValue', () => {
  // Remote values are untrusted: a raw newline inside the quotes would let a
  // value spill onto its own frontmatter line (e.g. a forged primaryField).
  it('should escape newlines, carriage returns and tabs', () => {
    expect(formatYamlValue('a\nprimaryField: recEVIL')).toBe('"a\\nprimaryField: recEVIL"');
    expect(formatYamlValue('a\r\nb\tc')).toBe('"a\\r\\nb\\tc"');
  });

  it('should return empty string for null', () => {
    expect(formatYamlValue(null)).toBe('');
  });

  it('should return empty string for undefined', () => {
    expect(formatYamlValue(undefined)).toBe('');
  });

  it('should return "true" for boolean true', () => {
    expect(formatYamlValue(true)).toBe('true');
  });

  it('should return "false" for boolean false', () => {
    expect(formatYamlValue(false)).toBe('false');
  });

  it('should return number as string for finite numbers', () => {
    expect(formatYamlValue(42)).toBe('42');
    expect(formatYamlValue(3.14)).toBe('3.14');
    expect(formatYamlValue(0)).toBe('0');
    expect(formatYamlValue(-10)).toBe('-10');
  });

  it('should quote strings', () => {
    expect(formatYamlValue('hello')).toBe('"hello"');
  });

  it('should escape backslashes in strings', () => {
    expect(formatYamlValue('path\\to\\file')).toBe('"path\\\\to\\\\file"');
  });

  it('should escape double quotes in strings', () => {
    expect(formatYamlValue('say "hello"')).toBe('"say \\"hello\\""');
  });

  it('should handle empty string', () => {
    expect(formatYamlValue('')).toBe('""');
  });

  it('should convert non-finite numbers to quoted strings', () => {
    expect(formatYamlValue(Infinity)).toBe('"Infinity"');
    expect(formatYamlValue(-Infinity)).toBe('"-Infinity"');
    expect(formatYamlValue(NaN)).toBe('"NaN"');
  });
});

describe('formatFieldForBases', () => {
  it('should return quoted empty string for null', () => {
    expect(formatFieldForBases('key', null)).toBe('""');
  });

  it('should return quoted empty string for undefined', () => {
    expect(formatFieldForBases('key', undefined)).toBe('""');
  });

  it('should return empty array notation for empty arrays', () => {
    expect(formatFieldForBases('tags', [])).toBe('[]');
  });

  it('should format simple string arrays', () => {
    expect(formatFieldForBases('tags', ['a', 'b', 'c'])).toBe('["a", "b", "c"]');
  });

  it('should format simple number arrays', () => {
    expect(formatFieldForBases('numbers', [1, 2, 3])).toBe('["1", "2", "3"]');
  });

  it('should format mixed simple arrays', () => {
    expect(formatFieldForBases('mixed', ['a', 1, 'b'])).toBe('["a", "1", "b"]');
  });

  // #133: object items used to collapse into the literal "[Object]".
  it('should format arrays with objects as a list of their labels', () => {
    expect(formatFieldForBases('items', [{ name: 'test' }, 'simple'])).toBe('["test", "simple"]');
  });

  it('should format a SeaTable link value as its display values', () => {
    const link = [
      { row_id: 'r1', display_value: 'Repro-B' },
      { row_id: 'r2', display_value: 'Repro-C' },
    ];
    expect(formatFieldForBases('Related', link)).toBe('["Repro-B", "Repro-C"]');
  });

  it('should format attachment arrays as their URLs', () => {
    const files = [{ name: 'repro.txt', url: 'https://example.com/repro.txt', type: 'file', size: 1 }];
    expect(formatFieldForBases('Files', files)).toBe('["https://example.com/repro.txt"]');
  });

  it('should drop null items and stringify booleans inside arrays', () => {
    expect(formatFieldForBases('mixed', [null, 'a', true])).toBe('["a", "true"]');
  });

  it('should return "true" for boolean true', () => {
    expect(formatFieldForBases('active', true)).toBe('true');
  });

  it('should return "false" for boolean false', () => {
    expect(formatFieldForBases('active', false)).toBe('false');
  });

  it('should return number as string for finite numbers', () => {
    expect(formatFieldForBases('count', 42)).toBe('42');
    expect(formatFieldForBases('price', 3.14)).toBe('3.14');
  });

  it('should preserve full ISO datetime strings (time is not clipped)', () => {
    expect(formatFieldForBases('date', '2024-01-15T10:30:00.000Z')).toBe('"2024-01-15T10:30:00.000Z"');
  });

  it('should handle date-only strings', () => {
    expect(formatFieldForBases('date', '2024-01-15')).toBe('"2024-01-15"');
  });

  it('should preserve Notion date ranges with times intact', () => {
    expect(
      formatFieldForBases('range', '2026-09-10T10:00:00.000+09:00/2026-09-12T18:00:00.000+09:00')
    ).toBe('"2026-09-10T10:00:00.000+09:00/2026-09-12T18:00:00.000+09:00"');
  });

  it('should format a labelled object as its label', () => {
    const obj = { name: 'test', value: 123, extra: 'data', more: 'stuff' };
    expect(formatFieldForBases('data', obj)).toBe('"test"');
  });

  it('should keep a newline in an object label inside its quoted scalar', () => {
    expect(formatFieldForBases('owner', { name: 'Kim\nprimaryField: recEVIL' }))
      .toBe('"Kim\\nprimaryField: recEVIL"');
    expect(formatFieldForBases('owners', [{ name: 'Kim\nprimaryField: recEVIL' }]))
      .toBe('["Kim\\nprimaryField: recEVIL"]');
  });

  it('should keep an unlabelled object losslessly as quoted JSON', () => {
    expect(formatFieldForBases('Location', { lat: 37.5, lng: 127 })).toBe('"{\\"lat\\":37.5,\\"lng\\":127}"');
  });

  it('should use block scalar for multiline strings', () => {
    const multiline = 'line1\nline2\nline3';
    expect(formatFieldForBases('content', multiline)).toBe('|\n  line1\n  line2\n  line3');
  });

  it('should quote regular strings', () => {
    expect(formatFieldForBases('name', 'simple string')).toBe('"simple string"');
  });

  it('should escape special characters in strings', () => {
    expect(formatFieldForBases('name', 'say "hello"')).toBe('"say \\"hello\\""');
  });
});

describe('formatObjectLabel (#133)', () => {
  it('prefers display_value (SeaTable link)', () => {
    expect(formatObjectLabel({ row_id: 'r1', display_value: 'Repro-B' })).toBe('Repro-B');
  });

  it('prefers url over name (attachments)', () => {
    expect(formatObjectLabel({ id: 'att1', url: 'https://x/y.png', filename: 'y.png' })).toBe('https://x/y.png');
  });

  it('uses name for collaborators', () => {
    expect(formatObjectLabel({ id: 'usr1', email: 'a@b.c', name: 'Kim' })).toBe('Kim');
  });

  it('falls back through label, title, text, email and id', () => {
    expect(formatObjectLabel({ label: 'Open', other: 1 })).toBe('Open');
    expect(formatObjectLabel({ title: 'T' })).toBe('T');
    expect(formatObjectLabel({ text: '123456', type: 'upce' })).toBe('123456');
    expect(formatObjectLabel({ id: 'usr1', email: 'a@b.c' })).toBe('a@b.c');
    expect(formatObjectLabel({ id: 'rec1' })).toBe('rec1');
  });

  it('skips empty label candidates', () => {
    expect(formatObjectLabel({ display_value: '', name: 'fallback' })).toBe('fallback');
  });

  it('accepts numeric labels', () => {
    expect(formatObjectLabel({ id: 42 })).toBe('42');
  });

  it('serialises objects without a label key as JSON', () => {
    expect(formatObjectLabel({ lat: 37.5, lng: 127 })).toBe('{"lat":37.5,"lng":127}');
  });
});
