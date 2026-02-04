/**
 * Tests for object-utils utility functions.
 */

import { describe, it, expect } from 'vitest';
import {
  getNestedValue,
  areValuesEqual,
  generateId
} from '../../src/utils/object-utils';

describe('getNestedValue', () => {
  it('should return undefined for empty path', () => {
    expect(getNestedValue({ a: 1 }, '')).toBeUndefined();
  });

  it('should return undefined for non-object input', () => {
    expect(getNestedValue('string', 'a')).toBeUndefined();
    expect(getNestedValue(123, 'a')).toBeUndefined();
    expect(getNestedValue(null, 'a')).toBeUndefined();
    expect(getNestedValue(undefined, 'a')).toBeUndefined();
  });

  it('should get top-level property', () => {
    expect(getNestedValue({ name: 'test' }, 'name')).toBe('test');
  });

  it('should get nested property', () => {
    const obj = { level1: { level2: { value: 'deep' } } };
    expect(getNestedValue(obj, 'level1.level2.value')).toBe('deep');
  });

  it('should return undefined for non-existent top-level property', () => {
    expect(getNestedValue({ a: 1 }, 'b')).toBeUndefined();
  });

  it('should return undefined for non-existent nested property', () => {
    expect(getNestedValue({ a: { b: 1 } }, 'a.c')).toBeUndefined();
  });

  it('should return undefined when intermediate property is not an object', () => {
    expect(getNestedValue({ a: 'string' }, 'a.b')).toBeUndefined();
  });

  it('should handle array index access', () => {
    const obj = { items: ['a', 'b', 'c'] };
    expect(getNestedValue(obj, 'items.0')).toBe('a');
    expect(getNestedValue(obj, 'items.1')).toBe('b');
  });

  it('should handle nested array access', () => {
    const obj = { data: { items: [{ name: 'first' }, { name: 'second' }] } };
    expect(getNestedValue(obj, 'data.items.0.name')).toBe('first');
  });
});

describe('areValuesEqual', () => {
  describe('null/undefined handling', () => {
    it('should return true for both null', () => {
      expect(areValuesEqual(null, null)).toBe(true);
    });

    it('should return true for both undefined', () => {
      expect(areValuesEqual(undefined, undefined)).toBe(true);
    });

    it('should return true for null and undefined', () => {
      expect(areValuesEqual(null, undefined)).toBe(true);
    });

    it('should return false for null and value', () => {
      expect(areValuesEqual(null, 'value')).toBe(false);
    });

    it('should return false for undefined and value', () => {
      expect(areValuesEqual(undefined, 'value')).toBe(false);
    });
  });

  describe('primitive values', () => {
    it('should return true for equal strings', () => {
      expect(areValuesEqual('test', 'test')).toBe(true);
    });

    it('should return false for different strings', () => {
      expect(areValuesEqual('test', 'other')).toBe(false);
    });

    it('should return true for equal numbers', () => {
      expect(areValuesEqual(42, 42)).toBe(true);
    });

    it('should return false for different numbers', () => {
      expect(areValuesEqual(42, 43)).toBe(false);
    });

    it('should return true for equal booleans', () => {
      expect(areValuesEqual(true, true)).toBe(true);
    });

    it('should return false for different booleans', () => {
      expect(areValuesEqual(true, false)).toBe(false);
    });

    it('should trim strings before comparison', () => {
      expect(areValuesEqual('  test  ', 'test')).toBe(true);
    });

    it('should convert numbers to strings for comparison', () => {
      expect(areValuesEqual(42, '42')).toBe(true);
    });
  });

  describe('array handling', () => {
    it('should return true for equal arrays', () => {
      expect(areValuesEqual([1, 2, 3], [1, 2, 3])).toBe(true);
    });

    it('should return false for arrays with different length', () => {
      expect(areValuesEqual([1, 2], [1, 2, 3])).toBe(false);
    });

    it('should return false for arrays with different elements', () => {
      expect(areValuesEqual([1, 2, 3], [1, 2, 4])).toBe(false);
    });

    it('should compare nested arrays', () => {
      expect(areValuesEqual([[1, 2], [3, 4]], [[1, 2], [3, 4]])).toBe(true);
      expect(areValuesEqual([[1, 2], [3, 4]], [[1, 2], [3, 5]])).toBe(false);
    });

    it('should return true for empty arrays', () => {
      expect(areValuesEqual([], [])).toBe(true);
    });
  });

  describe('object handling', () => {
    it('should return true for equal objects', () => {
      expect(areValuesEqual({ a: 1, b: 2 }, { a: 1, b: 2 })).toBe(true);
    });

    it('should return false for objects with different keys', () => {
      expect(areValuesEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false);
    });

    it('should return false for objects with different values', () => {
      expect(areValuesEqual({ a: 1 }, { a: 2 })).toBe(false);
    });

    it('should compare nested objects', () => {
      const obj1 = { a: { b: { c: 1 } } };
      const obj2 = { a: { b: { c: 1 } } };
      expect(areValuesEqual(obj1, obj2)).toBe(true);
    });

    it('should return true for empty objects', () => {
      expect(areValuesEqual({}, {})).toBe(true);
    });
  });
});

describe('generateId', () => {
  it('should return a string', () => {
    expect(typeof generateId()).toBe('string');
  });

  it('should include timestamp', () => {
    const before = Date.now();
    const id = generateId();
    const after = Date.now();
    const timestamp = parseInt(id.split('-')[0], 10);
    expect(timestamp).toBeGreaterThanOrEqual(before);
    expect(timestamp).toBeLessThanOrEqual(after);
  });

  it('should generate unique ids', () => {
    const ids = new Set();
    for (let i = 0; i < 100; i++) {
      ids.add(generateId());
    }
    expect(ids.size).toBe(100);
  });

  it('should match expected format', () => {
    const id = generateId();
    expect(id).toMatch(/^\d+-[a-z0-9]+$/);
  });
});
