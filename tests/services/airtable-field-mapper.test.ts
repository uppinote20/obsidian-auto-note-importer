/**
 * Tests for AirtableFieldMapper.
 * @covers src/services/airtable-field-mapper.ts
 */

import { describe, it, expect } from 'vitest';
import { airtableFieldMapper } from '../../src/services/airtable-field-mapper';

describe('airtableFieldMapper', () => {
  describe('mapToStandardType', () => {
    it('should map text-like types to "text"', () => {
      expect(airtableFieldMapper.mapToStandardType('singleLineText')).toBe('text');
      expect(airtableFieldMapper.mapToStandardType('multilineText')).toBe('text');
      expect(airtableFieldMapper.mapToStandardType('richText')).toBe('text');
      expect(airtableFieldMapper.mapToStandardType('email')).toBe('text');
      expect(airtableFieldMapper.mapToStandardType('phoneNumber')).toBe('text');
      expect(airtableFieldMapper.mapToStandardType('url')).toBe('text');
      expect(airtableFieldMapper.mapToStandardType('barcode')).toBe('text');
    });

    it('should map numeric types to "number"', () => {
      expect(airtableFieldMapper.mapToStandardType('number')).toBe('number');
      expect(airtableFieldMapper.mapToStandardType('currency')).toBe('number');
      expect(airtableFieldMapper.mapToStandardType('percent')).toBe('number');
      expect(airtableFieldMapper.mapToStandardType('rating')).toBe('number');
      expect(airtableFieldMapper.mapToStandardType('duration')).toBe('number');
    });

    it('should map date types to "date"', () => {
      expect(airtableFieldMapper.mapToStandardType('date')).toBe('date');
      expect(airtableFieldMapper.mapToStandardType('dateTime')).toBe('date');
    });

    it('should map checkbox to "boolean"', () => {
      expect(airtableFieldMapper.mapToStandardType('checkbox')).toBe('boolean');
    });

    it('should map select variants correctly', () => {
      expect(airtableFieldMapper.mapToStandardType('singleSelect')).toBe('single-select');
      expect(airtableFieldMapper.mapToStandardType('multipleSelects')).toBe('multi-select');
      expect(airtableFieldMapper.mapToStandardType('singleCollaborator')).toBe('single-select');
      expect(airtableFieldMapper.mapToStandardType('multipleCollaborators')).toBe('multi-select');
    });

    it('should map attachments to "attachment"', () => {
      expect(airtableFieldMapper.mapToStandardType('multipleAttachments')).toBe('attachment');
    });

    it('should map linked records to "link"', () => {
      expect(airtableFieldMapper.mapToStandardType('multipleRecordLinks')).toBe('link');
    });

    it('should map computed types to "computed"', () => {
      expect(airtableFieldMapper.mapToStandardType('formula')).toBe('computed');
      expect(airtableFieldMapper.mapToStandardType('rollup')).toBe('computed');
      expect(airtableFieldMapper.mapToStandardType('count')).toBe('computed');
      expect(airtableFieldMapper.mapToStandardType('lookup')).toBe('computed');
      expect(airtableFieldMapper.mapToStandardType('externalSyncSource')).toBe('computed');
      expect(airtableFieldMapper.mapToStandardType('aiText')).toBe('computed');
      expect(airtableFieldMapper.mapToStandardType('button')).toBe('computed');
    });

    it('should map system metadata to "system"', () => {
      expect(airtableFieldMapper.mapToStandardType('createdTime')).toBe('system');
      expect(airtableFieldMapper.mapToStandardType('lastModifiedTime')).toBe('system');
      expect(airtableFieldMapper.mapToStandardType('createdBy')).toBe('system');
      expect(airtableFieldMapper.mapToStandardType('lastModifiedBy')).toBe('system');
      expect(airtableFieldMapper.mapToStandardType('autoNumber')).toBe('system');
    });

    it('should return "unknown" for unrecognized types', () => {
      expect(airtableFieldMapper.mapToStandardType('bogusType')).toBe('unknown');
      expect(airtableFieldMapper.mapToStandardType('')).toBe('unknown');
    });
  });

  describe('isReadOnly', () => {
    it('should return true for computed types', () => {
      expect(airtableFieldMapper.isReadOnly('formula')).toBe(true);
      expect(airtableFieldMapper.isReadOnly('rollup')).toBe(true);
      expect(airtableFieldMapper.isReadOnly('count')).toBe(true);
      expect(airtableFieldMapper.isReadOnly('lookup')).toBe(true);
      expect(airtableFieldMapper.isReadOnly('externalSyncSource')).toBe(true);
      expect(airtableFieldMapper.isReadOnly('aiText')).toBe(true);
      expect(airtableFieldMapper.isReadOnly('button')).toBe(true);
    });

    it('should return true for system metadata types', () => {
      expect(airtableFieldMapper.isReadOnly('createdTime')).toBe(true);
      expect(airtableFieldMapper.isReadOnly('lastModifiedTime')).toBe(true);
      expect(airtableFieldMapper.isReadOnly('createdBy')).toBe(true);
      expect(airtableFieldMapper.isReadOnly('lastModifiedBy')).toBe(true);
      expect(airtableFieldMapper.isReadOnly('autoNumber')).toBe(true);
    });

    it('should return false for writable types', () => {
      expect(airtableFieldMapper.isReadOnly('singleLineText')).toBe(false);
      expect(airtableFieldMapper.isReadOnly('multilineText')).toBe(false);
      expect(airtableFieldMapper.isReadOnly('checkbox')).toBe(false);
      expect(airtableFieldMapper.isReadOnly('singleSelect')).toBe(false);
      expect(airtableFieldMapper.isReadOnly('multipleSelects')).toBe(false);
      expect(airtableFieldMapper.isReadOnly('date')).toBe(false);
      expect(airtableFieldMapper.isReadOnly('number')).toBe(false);
      expect(airtableFieldMapper.isReadOnly('multipleAttachments')).toBe(false);
    });

    it('should fail closed: treat unknown types as read-only', () => {
      // Airtable introduces new field types periodically. Defaulting unknown
      // types to read-only prevents silent 422 failures when pushing to fields
      // the mapper hasn't been taught about yet.
      expect(airtableFieldMapper.isReadOnly('bogusType')).toBe(true);
      expect(airtableFieldMapper.isReadOnly('')).toBe(true);
      expect(airtableFieldMapper.isReadOnly('someNewAirtableType')).toBe(true);
    });
  });

  describe('isSubfolderSafe', () => {
    // Issue #98: subfolder allows a broad set of types — sanitizeSubfolderValue
    // handles any stringifiable input. Filename rules are stricter (OS rules).
    // Attachment / link types are excluded because their stringified shape is
    // [object Object] / record-id JSON — produces garbage folder names.
    it('should return true for stringifiable known types (text / number / date / select / formula / system)', () => {
      const stringifiable = [
        'singleLineText', 'multilineText', 'richText', 'email', 'phoneNumber', 'url', 'barcode',
        'number', 'currency', 'percent', 'rating', 'duration',
        'date', 'dateTime',
        'checkbox',
        'singleSelect', 'multipleSelects', 'multipleCollaborators', 'singleCollaborator',
        'formula', 'rollup', 'count', 'lookup', 'externalSyncSource', 'aiText', 'button',
        'createdTime', 'lastModifiedTime', 'createdBy', 'lastModifiedBy', 'autoNumber',
      ];
      for (const t of stringifiable) {
        expect(airtableFieldMapper.isSubfolderSafe(t)).toBe(true);
      }
    });

    it('should return false for attachment and link types (no sensible string)', () => {
      expect(airtableFieldMapper.isSubfolderSafe('multipleAttachments')).toBe(false);
      expect(airtableFieldMapper.isSubfolderSafe('multipleRecordLinks')).toBe(false);
    });

    it('should return false for unknown types (fail-closed)', () => {
      expect(airtableFieldMapper.isSubfolderSafe('bogusType')).toBe(false);
      expect(airtableFieldMapper.isSubfolderSafe('')).toBe(false);
      expect(airtableFieldMapper.isSubfolderSafe('someNewAirtableType')).toBe(false);
    });

    // Regression guard: the `in` operator walks Object.prototype so a naive
    // implementation would accept inherited method names. Must use a safe
    // membership check (.includes on a literal array, or hasOwnProperty).
    it('should return false for JS prototype-chain names (no in-operator leak)', () => {
      const inheritedNames = [
        'toString', 'constructor', 'hasOwnProperty', 'valueOf', '__proto__',
        'isPrototypeOf', 'propertyIsEnumerable', 'toLocaleString',
      ];
      for (const t of inheritedNames) {
        expect(airtableFieldMapper.isSubfolderSafe(t)).toBe(false);
      }
    });

    it('should return a superset of isFilenameSafe (every filename-safe type is also subfolder-safe)', () => {
      for (const t of airtableFieldMapper.getFilenameSafeTypes()) {
        expect(airtableFieldMapper.isSubfolderSafe(t)).toBe(true);
      }
    });
  });

  describe('getSubfolderSafeTypes', () => {
    it('should include stringifiable known types but exclude attachment/link', () => {
      const types = airtableFieldMapper.getSubfolderSafeTypes();
      expect(types).toContain('date');
      expect(types).toContain('multipleSelects');
      expect(types).toContain('checkbox');
      expect(types).toContain('singleLineText');
      expect(types).toContain('formula');
      expect(types).not.toContain('multipleAttachments');
      expect(types).not.toContain('multipleRecordLinks');
    });

    it('should be sorted for stable enumeration', () => {
      const types = airtableFieldMapper.getSubfolderSafeTypes();
      expect([...types]).toEqual([...types].sort());
    });

    it('should be a superset of getFilenameSafeTypes', () => {
      const subset = new Set(airtableFieldMapper.getFilenameSafeTypes());
      const superset = new Set(airtableFieldMapper.getSubfolderSafeTypes());
      for (const t of subset) expect(superset.has(t)).toBe(true);
    });
  });

  describe('isFilenameSafe', () => {
    it('should return true for types producing safe filename output', () => {
      expect(airtableFieldMapper.isFilenameSafe('singleLineText')).toBe(true);
      expect(airtableFieldMapper.isFilenameSafe('singleSelect')).toBe(true);
      expect(airtableFieldMapper.isFilenameSafe('number')).toBe(true);
      expect(airtableFieldMapper.isFilenameSafe('formula')).toBe(true);
    });

    it('should return false for types with unsafe or complex output', () => {
      expect(airtableFieldMapper.isFilenameSafe('multilineText')).toBe(false);
      expect(airtableFieldMapper.isFilenameSafe('checkbox')).toBe(false);
      expect(airtableFieldMapper.isFilenameSafe('multipleSelects')).toBe(false);
      expect(airtableFieldMapper.isFilenameSafe('multipleAttachments')).toBe(false);
      expect(airtableFieldMapper.isFilenameSafe('multipleRecordLinks')).toBe(false);
      expect(airtableFieldMapper.isFilenameSafe('date')).toBe(false);
    });

    it('should return false for unknown types', () => {
      expect(airtableFieldMapper.isFilenameSafe('bogusType')).toBe(false);
      expect(airtableFieldMapper.isFilenameSafe('')).toBe(false);
    });
  });

  describe('getFilenameSafeTypes', () => {
    it('should return exactly the 4 filename-safe types', () => {
      const types = airtableFieldMapper.getFilenameSafeTypes();
      expect(types).toEqual([
        'singleLineText',
        'singleSelect',
        'number',
        'formula',
      ]);
    });

    it('should be consistent with isFilenameSafe', () => {
      for (const type of airtableFieldMapper.getFilenameSafeTypes()) {
        expect(airtableFieldMapper.isFilenameSafe(type)).toBe(true);
      }
    });
  });

  describe('getReadOnlyTypes', () => {
    it('should return all 12 read-only types (9 legacy + 3 newer)', () => {
      const types = airtableFieldMapper.getReadOnlyTypes();
      expect(types).toHaveLength(12);
      expect(types).toEqual(expect.arrayContaining([
        'formula', 'rollup', 'count', 'lookup',
        'createdTime', 'lastModifiedTime',
        'createdBy', 'lastModifiedBy',
        'autoNumber',
        'externalSyncSource', 'aiText', 'button',
      ]));
    });

    it('should be consistent with isReadOnly', () => {
      for (const type of airtableFieldMapper.getReadOnlyTypes()) {
        expect(airtableFieldMapper.isReadOnly(type)).toBe(true);
      }
    });
  });

  describe('invariant: read-only computed types are not writable', () => {
    it('should classify formula as both computed and read-only', () => {
      expect(airtableFieldMapper.mapToStandardType('formula')).toBe('computed');
      expect(airtableFieldMapper.isReadOnly('formula')).toBe(true);
    });

    it('should classify createdTime as both system and read-only', () => {
      expect(airtableFieldMapper.mapToStandardType('createdTime')).toBe('system');
      expect(airtableFieldMapper.isReadOnly('createdTime')).toBe(true);
    });
  });
});
