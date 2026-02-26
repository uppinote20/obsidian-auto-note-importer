/**
 * Tests for field-types constants and functions.
 */

import { describe, it, expect } from 'vitest';
import {
  SUPPORTED_FIELD_TYPES,
  SYNCABLE_FIELD_TYPES,
  READ_ONLY_FIELD_TYPES,
  isFieldTypeSupported,
  isReadOnlyFieldType
} from '../../src/constants/field-types';

describe('SUPPORTED_FIELD_TYPES', () => {
  it('should include singleLineText', () => {
    expect(SUPPORTED_FIELD_TYPES).toContain('singleLineText');
  });

  it('should include singleSelect', () => {
    expect(SUPPORTED_FIELD_TYPES).toContain('singleSelect');
  });

  it('should include number', () => {
    expect(SUPPORTED_FIELD_TYPES).toContain('number');
  });

  it('should include formula', () => {
    expect(SUPPORTED_FIELD_TYPES).toContain('formula');
  });

  it('should have exactly 4 types', () => {
    expect(SUPPORTED_FIELD_TYPES.length).toBe(4);
  });
});

describe('READ_ONLY_FIELD_TYPES', () => {
  it('should include formula', () => {
    expect(READ_ONLY_FIELD_TYPES).toContain('formula');
  });

  it('should include rollup', () => {
    expect(READ_ONLY_FIELD_TYPES).toContain('rollup');
  });

  it('should include count', () => {
    expect(READ_ONLY_FIELD_TYPES).toContain('count');
  });

  it('should include lookup', () => {
    expect(READ_ONLY_FIELD_TYPES).toContain('lookup');
  });

  it('should include createdTime', () => {
    expect(READ_ONLY_FIELD_TYPES).toContain('createdTime');
  });

  it('should include lastModifiedTime', () => {
    expect(READ_ONLY_FIELD_TYPES).toContain('lastModifiedTime');
  });

  it('should include createdBy', () => {
    expect(READ_ONLY_FIELD_TYPES).toContain('createdBy');
  });

  it('should include lastModifiedBy', () => {
    expect(READ_ONLY_FIELD_TYPES).toContain('lastModifiedBy');
  });

  it('should include autoNumber', () => {
    expect(READ_ONLY_FIELD_TYPES).toContain('autoNumber');
  });

  it('should have exactly 9 types', () => {
    expect(READ_ONLY_FIELD_TYPES.length).toBe(9);
  });
});

describe('isFieldTypeSupported', () => {
  it('should return true for singleLineText', () => {
    expect(isFieldTypeSupported('singleLineText')).toBe(true);
  });

  it('should return true for singleSelect', () => {
    expect(isFieldTypeSupported('singleSelect')).toBe(true);
  });

  it('should return true for number', () => {
    expect(isFieldTypeSupported('number')).toBe(true);
  });

  it('should return true for formula', () => {
    expect(isFieldTypeSupported('formula')).toBe(true);
  });

  it('should return false for multilineText', () => {
    expect(isFieldTypeSupported('multilineText')).toBe(false);
  });

  it('should return false for checkbox', () => {
    expect(isFieldTypeSupported('checkbox')).toBe(false);
  });

  it('should return false for unknown type', () => {
    expect(isFieldTypeSupported('unknownType')).toBe(false);
  });

  it('should return false for empty string', () => {
    expect(isFieldTypeSupported('')).toBe(false);
  });
});

describe('isReadOnlyFieldType', () => {
  describe('read-only types should return true', () => {
    it('should return true for formula (FT-1.1)', () => {
      expect(isReadOnlyFieldType('formula')).toBe(true);
    });

    it('should return true for rollup (FT-1.2)', () => {
      expect(isReadOnlyFieldType('rollup')).toBe(true);
    });

    it('should return true for lookup (FT-1.3)', () => {
      expect(isReadOnlyFieldType('lookup')).toBe(true);
    });

    it('should return true for createdTime (FT-1.4)', () => {
      expect(isReadOnlyFieldType('createdTime')).toBe(true);
    });

    it('should return true for count', () => {
      expect(isReadOnlyFieldType('count')).toBe(true);
    });

    it('should return true for lastModifiedTime', () => {
      expect(isReadOnlyFieldType('lastModifiedTime')).toBe(true);
    });

    it('should return true for createdBy', () => {
      expect(isReadOnlyFieldType('createdBy')).toBe(true);
    });

    it('should return true for lastModifiedBy', () => {
      expect(isReadOnlyFieldType('lastModifiedBy')).toBe(true);
    });

    it('should return true for autoNumber', () => {
      expect(isReadOnlyFieldType('autoNumber')).toBe(true);
    });
  });

  describe('writable types should return false', () => {
    it('should return false for singleLineText (FT-1.5)', () => {
      expect(isReadOnlyFieldType('singleLineText')).toBe(false);
    });

    it('should return false for multilineText', () => {
      expect(isReadOnlyFieldType('multilineText')).toBe(false);
    });

    it('should return false for checkbox', () => {
      expect(isReadOnlyFieldType('checkbox')).toBe(false);
    });

    it('should return false for singleSelect', () => {
      expect(isReadOnlyFieldType('singleSelect')).toBe(false);
    });

    it('should return false for multipleSelects', () => {
      expect(isReadOnlyFieldType('multipleSelects')).toBe(false);
    });

    it('should return false for date', () => {
      expect(isReadOnlyFieldType('date')).toBe(false);
    });

    it('should return false for number', () => {
      expect(isReadOnlyFieldType('number')).toBe(false);
    });

    it('should return false for unknown type', () => {
      expect(isReadOnlyFieldType('unknownType')).toBe(false);
    });

    it('should return false for empty string', () => {
      expect(isReadOnlyFieldType('')).toBe(false);
    });
  });

  describe('all 9 read-only types (FT-2.1)', () => {
    it('should correctly identify all 9 read-only field types', () => {
      const readOnlyTypes = [
        'formula', 'rollup', 'count', 'lookup',
        'createdTime', 'lastModifiedTime',
        'createdBy', 'lastModifiedBy', 'autoNumber'
      ];

      readOnlyTypes.forEach(type => {
        expect(isReadOnlyFieldType(type)).toBe(true);
      });
    });
  });
});
