/**
 * Tests for yaml-formatter utility functions.
 */

import { describe, it, expect } from 'vitest';
import {
  formatYamlValue,
  formatFieldForBases
} from '../../src/utils/yaml-formatter';

describe('formatYamlValue', () => {
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

  it('should format arrays with objects as quoted comma-separated', () => {
    expect(formatFieldForBases('items', [{ name: 'test' }, 'simple'])).toBe('"[Object], simple"');
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

  it('should extract date portion from ISO date strings', () => {
    expect(formatFieldForBases('date', '2024-01-15T10:30:00.000Z')).toBe('"2024-01-15"');
  });

  it('should handle date-only strings', () => {
    expect(formatFieldForBases('date', '2024-01-15')).toBe('"2024-01-15"');
  });

  it('should format objects with key preview', () => {
    const obj = { name: 'test', value: 123, extra: 'data', more: 'stuff' };
    expect(formatFieldForBases('data', obj)).toBe('"[Object: name, value, extra]"');
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
