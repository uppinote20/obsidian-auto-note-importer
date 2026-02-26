/**
 * Tests for system-fields constants and functions.
 */

import { describe, it, expect } from 'vitest';
import {
  SYSTEM_FIELDS,
  isSystemField
} from '../../src/constants/system-fields';

describe('SYSTEM_FIELDS', () => {
  it('should include primaryField', () => {
    expect(SYSTEM_FIELDS).toContain('primaryField');
  });

  it('should include position', () => {
    expect(SYSTEM_FIELDS).toContain('position');
  });

  it('should have exactly 2 fields', () => {
    expect(SYSTEM_FIELDS.length).toBe(2);
  });
});

describe('isSystemField', () => {
  it('should return true for primaryField', () => {
    expect(isSystemField('primaryField')).toBe(true);
  });

  it('should return true for position', () => {
    expect(isSystemField('position')).toBe(true);
  });

  it('should return false for regular field names', () => {
    expect(isSystemField('name')).toBe(false);
    expect(isSystemField('status')).toBe(false);
    expect(isSystemField('created')).toBe(false);
  });

  it('should return false for empty string', () => {
    expect(isSystemField('')).toBe(false);
  });

  it('should be case-sensitive', () => {
    expect(isSystemField('PrimaryField')).toBe(false);
    expect(isSystemField('PRIMARYFIELD')).toBe(false);
    expect(isSystemField('Position')).toBe(false);
  });

  it('should return false for similar but different names', () => {
    expect(isSystemField('primary_field')).toBe(false);
    expect(isSystemField('primary-field')).toBe(false);
    expect(isSystemField('primaryFieldValue')).toBe(false);
  });
});
