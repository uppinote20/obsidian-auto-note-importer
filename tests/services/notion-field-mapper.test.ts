/**
 * Tests for NotionFieldMapper.
 * @covers src/services/notion-field-mapper.ts
 */

import { describe, it, expect } from 'vitest';
import { notionFieldMapper } from '../../src/services/notion-field-mapper';

describe('notionFieldMapper', () => {
  describe('mapToStandardType', () => {
    it('should map text-like types to "text"', () => {
      expect(notionFieldMapper.mapToStandardType('title')).toBe('text');
      expect(notionFieldMapper.mapToStandardType('rich_text')).toBe('text');
      expect(notionFieldMapper.mapToStandardType('url')).toBe('text');
      expect(notionFieldMapper.mapToStandardType('email')).toBe('text');
      expect(notionFieldMapper.mapToStandardType('phone_number')).toBe('text');
    });

    it('should map number to "number"', () => {
      expect(notionFieldMapper.mapToStandardType('number')).toBe('number');
    });

    it('should map date to "date"', () => {
      expect(notionFieldMapper.mapToStandardType('date')).toBe('date');
    });

    it('should map checkbox to "boolean"', () => {
      expect(notionFieldMapper.mapToStandardType('checkbox')).toBe('boolean');
    });

    it('should map select variants correctly', () => {
      expect(notionFieldMapper.mapToStandardType('select')).toBe('single-select');
      expect(notionFieldMapper.mapToStandardType('status')).toBe('single-select');
      expect(notionFieldMapper.mapToStandardType('multi_select')).toBe('multi-select');
    });

    it('should map people to "multi-select" (Airtable collaborator precedent)', () => {
      expect(notionFieldMapper.mapToStandardType('people')).toBe('multi-select');
    });

    it('should map files to "attachment"', () => {
      expect(notionFieldMapper.mapToStandardType('files')).toBe('attachment');
    });

    it('should map relation to "link"', () => {
      expect(notionFieldMapper.mapToStandardType('relation')).toBe('link');
    });

    it('should map computed types to "computed"', () => {
      expect(notionFieldMapper.mapToStandardType('formula')).toBe('computed');
      expect(notionFieldMapper.mapToStandardType('rollup')).toBe('computed');
      expect(notionFieldMapper.mapToStandardType('button')).toBe('computed');
    });

    it('should map system metadata to "system"', () => {
      expect(notionFieldMapper.mapToStandardType('created_time')).toBe('system');
      expect(notionFieldMapper.mapToStandardType('created_by')).toBe('system');
      expect(notionFieldMapper.mapToStandardType('last_edited_time')).toBe('system');
      expect(notionFieldMapper.mapToStandardType('last_edited_by')).toBe('system');
      expect(notionFieldMapper.mapToStandardType('unique_id')).toBe('system');
    });

    it('should return "unknown" for unrecognized/omitted types (e.g. verification, bogus)', () => {
      expect(notionFieldMapper.mapToStandardType('verification')).toBe('unknown');
      expect(notionFieldMapper.mapToStandardType('bogusType')).toBe('unknown');
      expect(notionFieldMapper.mapToStandardType('')).toBe('unknown');
    });
  });

  describe('isReadOnly', () => {
    it('should return true for computed types', () => {
      expect(notionFieldMapper.isReadOnly('formula')).toBe(true);
      expect(notionFieldMapper.isReadOnly('rollup')).toBe(true);
      expect(notionFieldMapper.isReadOnly('button')).toBe(true);
    });

    it('should return true for system metadata types', () => {
      expect(notionFieldMapper.isReadOnly('created_time')).toBe(true);
      expect(notionFieldMapper.isReadOnly('created_by')).toBe(true);
      expect(notionFieldMapper.isReadOnly('last_edited_time')).toBe(true);
      expect(notionFieldMapper.isReadOnly('last_edited_by')).toBe(true);
      expect(notionFieldMapper.isReadOnly('unique_id')).toBe(true);
    });

    it('should return false for writable types', () => {
      for (const t of [
        'title', 'rich_text', 'number', 'checkbox',
        'select', 'status', 'multi_select', 'date',
        'url', 'email', 'phone_number', 'people', 'files', 'relation',
      ]) {
        expect(notionFieldMapper.isReadOnly(t)).toBe(false);
      }
    });

    it('should fail closed: treat unknown types (incl. verification) as read-only', () => {
      expect(notionFieldMapper.isReadOnly('verification')).toBe(true);
      expect(notionFieldMapper.isReadOnly('bogusType')).toBe(true);
      expect(notionFieldMapper.isReadOnly('')).toBe(true);
    });

    it('should fail closed on prototype-chain names (no in-operator leak)', () => {
      for (const t of ['toString', 'constructor', 'hasOwnProperty', 'valueOf', '__proto__']) {
        expect(notionFieldMapper.isReadOnly(t)).toBe(true);
      }
    });
  });

  describe('isPushable', () => {
    it('should return true for writable scalar types', () => {
      for (const t of [
        'title', 'rich_text', 'number', 'checkbox',
        'select', 'status', 'multi_select', 'date',
        'url', 'email', 'phone_number',
      ]) {
        expect(notionFieldMapper.isPushable(t)).toBe(true);
      }
    });

    it('should return false for object-shaped writable types (people/files/relation)', () => {
      expect(notionFieldMapper.isReadOnly('people')).toBe(false);
      expect(notionFieldMapper.isReadOnly('files')).toBe(false);
      expect(notionFieldMapper.isReadOnly('relation')).toBe(false);

      expect(notionFieldMapper.isPushable('people')).toBe(false);
      expect(notionFieldMapper.isPushable('files')).toBe(false);
      expect(notionFieldMapper.isPushable('relation')).toBe(false);
    });

    it('should return false for read-only types', () => {
      for (const t of notionFieldMapper.getReadOnlyTypes()) {
        expect(notionFieldMapper.isPushable(t)).toBe(false);
      }
    });

    it('should fail closed for unknown, verification, and prototype-chain names', () => {
      for (const t of ['verification', 'bogusType', '', 'toString', 'constructor', 'hasOwnProperty', 'valueOf', '__proto__']) {
        expect(notionFieldMapper.isPushable(t)).toBe(false);
      }
    });
  });

  describe('isFilenameSafe', () => {
    it('should return true for the designated filename-safe types', () => {
      for (const t of ['title', 'select', 'status', 'number', 'email', 'phone_number', 'unique_id']) {
        expect(notionFieldMapper.isFilenameSafe(t)).toBe(true);
      }
    });

    it('should return false for types with unsafe or complex output', () => {
      for (const t of ['rich_text', 'checkbox', 'multi_select', 'files', 'relation', 'date', 'people']) {
        expect(notionFieldMapper.isFilenameSafe(t)).toBe(false);
      }
    });

    it('should return false for unknown types', () => {
      expect(notionFieldMapper.isFilenameSafe('bogusType')).toBe(false);
      expect(notionFieldMapper.isFilenameSafe('')).toBe(false);
    });
  });

  describe('getFilenameSafeTypes', () => {
    it('should return exactly the 7 filename-safe types, sorted', () => {
      expect(notionFieldMapper.getFilenameSafeTypes()).toEqual([
        'email',
        'number',
        'phone_number',
        'select',
        'status',
        'title',
        'unique_id',
      ]);
    });

    it('should be consistent with isFilenameSafe', () => {
      for (const type of notionFieldMapper.getFilenameSafeTypes()) {
        expect(notionFieldMapper.isFilenameSafe(type)).toBe(true);
      }
    });
  });

  describe('isSubfolderSafe / getSubfolderSafeTypes', () => {
    it('should exclude attachment/link/unknown standard types and object-shaped types', () => {
      const types = notionFieldMapper.getSubfolderSafeTypes();
      expect(types).not.toContain('files');
      expect(types).not.toContain('relation');
      expect(types).not.toContain('people');
      expect(types).not.toContain('verification');
    });

    it('should include stringifiable scalar types', () => {
      const types = notionFieldMapper.getSubfolderSafeTypes();
      for (const t of ['title', 'rich_text', 'number', 'checkbox', 'select', 'status', 'multi_select', 'date', 'url', 'email', 'phone_number']) {
        expect(types).toContain(t);
      }
    });

    it('should be sorted for stable enumeration', () => {
      const types = notionFieldMapper.getSubfolderSafeTypes();
      expect([...types]).toEqual([...types].sort());
    });

    it('should be a superset of getFilenameSafeTypes', () => {
      for (const t of notionFieldMapper.getFilenameSafeTypes()) {
        expect(notionFieldMapper.isSubfolderSafe(t)).toBe(true);
      }
    });

    it('should return false for JS prototype-chain names', () => {
      for (const t of ['toString', 'constructor', 'hasOwnProperty', 'valueOf', '__proto__']) {
        expect(notionFieldMapper.isSubfolderSafe(t)).toBe(false);
      }
    });
  });

  describe('getReadOnlyTypes', () => {
    it('should return all 8 read-only types', () => {
      const types = notionFieldMapper.getReadOnlyTypes();
      expect(types).toHaveLength(8);
      expect(types).toEqual(expect.arrayContaining([
        'formula', 'rollup', 'created_time', 'created_by',
        'last_edited_time', 'last_edited_by', 'unique_id', 'button',
      ]));
    });

    it('should be consistent with isReadOnly', () => {
      for (const type of notionFieldMapper.getReadOnlyTypes()) {
        expect(notionFieldMapper.isReadOnly(type)).toBe(true);
      }
    });
  });

  describe('cardinality drift-guard', () => {
    it('TYPE_TO_STANDARD via mapToStandardType covers the expected 20 known provider types', () => {
      const knownTypes = [
        'title', 'rich_text', 'url', 'email', 'phone_number',
        'number',
        'date',
        'checkbox',
        'select', 'status',
        'multi_select',
        'people',
        'files',
        'relation',
        'formula', 'rollup', 'button',
        'created_time', 'created_by', 'last_edited_time', 'last_edited_by', 'unique_id',
      ];
      expect(knownTypes).toHaveLength(22);
      for (const t of knownTypes) {
        expect(notionFieldMapper.mapToStandardType(t)).not.toBe('unknown');
      }
    });

    it('verification is deliberately absent from the known-type map (fail-closed)', () => {
      expect(notionFieldMapper.mapToStandardType('verification')).toBe('unknown');
      expect(notionFieldMapper.isReadOnly('verification')).toBe(true);
      expect(notionFieldMapper.isPushable('verification')).toBe(false);
    });
  });
});
