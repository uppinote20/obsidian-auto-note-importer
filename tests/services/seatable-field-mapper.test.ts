/**
 * Tests for SeaTableFieldMapper.
 * @covers src/services/seatable-field-mapper.ts
 */

import { describe, it, expect } from 'vitest';
import { seatableFieldMapper } from '../../src/services/seatable-field-mapper';

describe('seatableFieldMapper', () => {
  describe('mapToStandardType', () => {
    it('should map text-like types to "text"', () => {
      expect(seatableFieldMapper.mapToStandardType('text')).toBe('text');
      expect(seatableFieldMapper.mapToStandardType('long-text')).toBe('text');
      expect(seatableFieldMapper.mapToStandardType('email')).toBe('text');
      expect(seatableFieldMapper.mapToStandardType('url')).toBe('text');
      expect(seatableFieldMapper.mapToStandardType('geolocation')).toBe('text');
    });

    it('should map numeric types to "number"', () => {
      expect(seatableFieldMapper.mapToStandardType('number')).toBe('number');
      expect(seatableFieldMapper.mapToStandardType('duration')).toBe('number');
      expect(seatableFieldMapper.mapToStandardType('rate')).toBe('number');
    });

    it('should map date to "date"', () => {
      expect(seatableFieldMapper.mapToStandardType('date')).toBe('date');
    });

    it('should map checkbox to "boolean"', () => {
      expect(seatableFieldMapper.mapToStandardType('checkbox')).toBe('boolean');
    });

    it('should map select variants correctly', () => {
      expect(seatableFieldMapper.mapToStandardType('single-select')).toBe('single-select');
      expect(seatableFieldMapper.mapToStandardType('multiple-select')).toBe('multi-select');
      expect(seatableFieldMapper.mapToStandardType('department-single-select')).toBe('single-select');
      expect(seatableFieldMapper.mapToStandardType('collaborator')).toBe('multi-select');
    });

    it('should map attachments to "attachment"', () => {
      expect(seatableFieldMapper.mapToStandardType('image')).toBe('attachment');
      expect(seatableFieldMapper.mapToStandardType('file')).toBe('attachment');
      expect(seatableFieldMapper.mapToStandardType('digital-sign')).toBe('attachment');
    });

    it('should map link to "link"', () => {
      expect(seatableFieldMapper.mapToStandardType('link')).toBe('link');
    });

    it('should map computed types to "computed"', () => {
      expect(seatableFieldMapper.mapToStandardType('formula')).toBe('computed');
      expect(seatableFieldMapper.mapToStandardType('link-formula')).toBe('computed');
      expect(seatableFieldMapper.mapToStandardType('button')).toBe('computed');
    });

    it('should map system metadata to "system"', () => {
      expect(seatableFieldMapper.mapToStandardType('ctime')).toBe('system');
      expect(seatableFieldMapper.mapToStandardType('mtime')).toBe('system');
      expect(seatableFieldMapper.mapToStandardType('creator')).toBe('system');
      expect(seatableFieldMapper.mapToStandardType('last-modifier')).toBe('system');
      expect(seatableFieldMapper.mapToStandardType('auto-number')).toBe('system');
    });

    it('should return "unknown" for unrecognized types', () => {
      expect(seatableFieldMapper.mapToStandardType('bogusType')).toBe('unknown');
      expect(seatableFieldMapper.mapToStandardType('')).toBe('unknown');
    });
  });

  describe('isReadOnly', () => {
    it('should return true for computed types', () => {
      expect(seatableFieldMapper.isReadOnly('formula')).toBe(true);
      expect(seatableFieldMapper.isReadOnly('link-formula')).toBe(true);
      expect(seatableFieldMapper.isReadOnly('button')).toBe(true);
    });

    it('should return true for system metadata types', () => {
      expect(seatableFieldMapper.isReadOnly('ctime')).toBe(true);
      expect(seatableFieldMapper.isReadOnly('mtime')).toBe(true);
      expect(seatableFieldMapper.isReadOnly('creator')).toBe(true);
      expect(seatableFieldMapper.isReadOnly('last-modifier')).toBe(true);
      expect(seatableFieldMapper.isReadOnly('auto-number')).toBe(true);
    });

    it('should return false for writable types', () => {
      expect(seatableFieldMapper.isReadOnly('text')).toBe(false);
      expect(seatableFieldMapper.isReadOnly('long-text')).toBe(false);
      expect(seatableFieldMapper.isReadOnly('checkbox')).toBe(false);
      expect(seatableFieldMapper.isReadOnly('single-select')).toBe(false);
      expect(seatableFieldMapper.isReadOnly('multiple-select')).toBe(false);
      expect(seatableFieldMapper.isReadOnly('date')).toBe(false);
      expect(seatableFieldMapper.isReadOnly('number')).toBe(false);
      expect(seatableFieldMapper.isReadOnly('image')).toBe(false);
      expect(seatableFieldMapper.isReadOnly('file')).toBe(false);
      expect(seatableFieldMapper.isReadOnly('link')).toBe(false);
    });

    it('should fail closed: treat unknown types as read-only', () => {
      expect(seatableFieldMapper.isReadOnly('bogusType')).toBe(true);
      expect(seatableFieldMapper.isReadOnly('')).toBe(true);
      expect(seatableFieldMapper.isReadOnly('someNewSeaTableType')).toBe(true);
    });

    it('should fail closed on prototype-chain names (no in-operator leak)', () => {
      for (const t of ['toString', 'constructor', 'hasOwnProperty', 'valueOf', '__proto__']) {
        expect(seatableFieldMapper.isReadOnly(t)).toBe(true);
      }
    });
  });

  describe('isPushable', () => {
    it('should return true for writable scalar types', () => {
      for (const t of [
        'text',
        'long-text',
        'email',
        'url',
        'number',
        'duration',
        'rate',
        'date',
        'checkbox',
        'single-select',
        'multiple-select',
        'department-single-select',
      ]) {
        expect(seatableFieldMapper.isPushable(t)).toBe(true);
      }
    });

    it('should return false for read-only types', () => {
      for (const t of seatableFieldMapper.getReadOnlyTypes()) {
        expect(seatableFieldMapper.isPushable(t)).toBe(false);
      }
    });

    it('should return false for object-shaped writable types', () => {
      expect(seatableFieldMapper.isReadOnly('collaborator')).toBe(false);
      expect(seatableFieldMapper.isReadOnly('geolocation')).toBe(false);

      expect(seatableFieldMapper.isPushable('collaborator')).toBe(false);
      expect(seatableFieldMapper.isPushable('geolocation')).toBe(false);
    });

    it('should fail closed for unknown and prototype-chain names', () => {
      for (const t of ['bogusType', '', 'toString', 'constructor', 'hasOwnProperty', 'valueOf', '__proto__']) {
        expect(seatableFieldMapper.isPushable(t)).toBe(false);
      }
    });
  });

  describe('isSubfolderSafe', () => {
    it('should return true for stringifiable known SeaTable types', () => {
      // Excludes OBJECT_SHAPED_TYPES (collaborator / geolocation / button) —
      // covered by a separate test below.
      const stringifiable = [
        'text', 'long-text', 'email', 'url',
        'number', 'duration', 'rate',
        'date',
        'checkbox',
        'single-select', 'multiple-select', 'department-single-select',
        'formula', 'link-formula',
        'ctime', 'mtime', 'creator', 'last-modifier', 'auto-number',
      ];
      for (const t of stringifiable) {
        expect(seatableFieldMapper.isSubfolderSafe(t)).toBe(true);
      }
    });

    it('should return false for attachment + link types (no sensible string)', () => {
      expect(seatableFieldMapper.isSubfolderSafe('image')).toBe(false);
      expect(seatableFieldMapper.isSubfolderSafe('file')).toBe(false);
      expect(seatableFieldMapper.isSubfolderSafe('digital-sign')).toBe(false);
      expect(seatableFieldMapper.isSubfolderSafe('link')).toBe(false);
    });

    // Issue #98 deep-fix: object-shaped types whose API value is {…} or
    // array of {…}, not a scalar. Standard-type filter misses these.
    it('should return false for object-shaped types (collaborator / geolocation / button)', () => {
      expect(seatableFieldMapper.isSubfolderSafe('collaborator')).toBe(false);
      expect(seatableFieldMapper.isSubfolderSafe('geolocation')).toBe(false);
      expect(seatableFieldMapper.isSubfolderSafe('button')).toBe(false);
    });

    it('should return false for unknown types', () => {
      expect(seatableFieldMapper.isSubfolderSafe('bogusType')).toBe(false);
      expect(seatableFieldMapper.isSubfolderSafe('')).toBe(false);
    });

    it('should return false for JS prototype-chain names (no in-operator leak)', () => {
      for (const t of ['toString', 'constructor', 'hasOwnProperty', 'valueOf', '__proto__']) {
        expect(seatableFieldMapper.isSubfolderSafe(t)).toBe(false);
      }
    });

    it('should be a superset of isFilenameSafe', () => {
      for (const t of seatableFieldMapper.getFilenameSafeTypes()) {
        expect(seatableFieldMapper.isSubfolderSafe(t)).toBe(true);
      }
    });
  });

  describe('getSubfolderSafeTypes', () => {
    it('should include stringifiable types but exclude attachment/link', () => {
      const types = seatableFieldMapper.getSubfolderSafeTypes();
      expect(types).toContain('date');
      expect(types).toContain('multiple-select');
      expect(types).toContain('checkbox');
      expect(types).toContain('text');
      expect(types).not.toContain('image');
      expect(types).not.toContain('file');
      expect(types).not.toContain('link');
    });

    it('should be sorted for stable enumeration', () => {
      const types = seatableFieldMapper.getSubfolderSafeTypes();
      expect([...types]).toEqual([...types].sort());
    });

    it('should have exact expected cardinality (drift guard)', () => {
      expect(seatableFieldMapper.getSubfolderSafeTypes()).toHaveLength(19);
    });
  });

  describe('isFilenameSafe', () => {
    it('should return true for types producing safe filename output', () => {
      expect(seatableFieldMapper.isFilenameSafe('text')).toBe(true);
      expect(seatableFieldMapper.isFilenameSafe('single-select')).toBe(true);
      expect(seatableFieldMapper.isFilenameSafe('number')).toBe(true);
      expect(seatableFieldMapper.isFilenameSafe('auto-number')).toBe(true);
      expect(seatableFieldMapper.isFilenameSafe('formula')).toBe(true);
    });

    it('should return false for types with unsafe or complex output', () => {
      expect(seatableFieldMapper.isFilenameSafe('long-text')).toBe(false);
      expect(seatableFieldMapper.isFilenameSafe('checkbox')).toBe(false);
      expect(seatableFieldMapper.isFilenameSafe('multiple-select')).toBe(false);
      expect(seatableFieldMapper.isFilenameSafe('image')).toBe(false);
      expect(seatableFieldMapper.isFilenameSafe('file')).toBe(false);
      expect(seatableFieldMapper.isFilenameSafe('link')).toBe(false);
      expect(seatableFieldMapper.isFilenameSafe('date')).toBe(false);
      expect(seatableFieldMapper.isFilenameSafe('collaborator')).toBe(false);
    });

    it('should return false for unknown types', () => {
      expect(seatableFieldMapper.isFilenameSafe('bogusType')).toBe(false);
      expect(seatableFieldMapper.isFilenameSafe('')).toBe(false);
    });
  });

  describe('getFilenameSafeTypes', () => {
    it('should return exactly the 5 filename-safe types', () => {
      const types = seatableFieldMapper.getFilenameSafeTypes();
      expect(types).toEqual([
        'text',
        'single-select',
        'number',
        'auto-number',
        'formula',
      ]);
    });

    it('should be consistent with isFilenameSafe', () => {
      for (const type of seatableFieldMapper.getFilenameSafeTypes()) {
        expect(seatableFieldMapper.isFilenameSafe(type)).toBe(true);
      }
    });
  });

  describe('getReadOnlyTypes', () => {
    it('should return all 8 read-only types', () => {
      const types = seatableFieldMapper.getReadOnlyTypes();
      expect(types).toHaveLength(8);
      expect(types).toEqual(expect.arrayContaining([
        'formula', 'link-formula', 'button',
        'ctime', 'mtime', 'creator', 'last-modifier', 'auto-number',
      ]));
    });

    it('should be consistent with isReadOnly', () => {
      for (const type of seatableFieldMapper.getReadOnlyTypes()) {
        expect(seatableFieldMapper.isReadOnly(type)).toBe(true);
      }
    });
  });

  describe('invariant: read-only computed types are not writable', () => {
    it('should classify formula as both computed and read-only', () => {
      expect(seatableFieldMapper.mapToStandardType('formula')).toBe('computed');
      expect(seatableFieldMapper.isReadOnly('formula')).toBe(true);
    });

    it('should classify ctime as both system and read-only', () => {
      expect(seatableFieldMapper.mapToStandardType('ctime')).toBe('system');
      expect(seatableFieldMapper.isReadOnly('ctime')).toBe(true);
    });
  });
});
