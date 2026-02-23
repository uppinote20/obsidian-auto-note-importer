/**
 * Tests for conflict-resolver service.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock obsidian Notice before importing ConflictResolver
vi.mock('obsidian', () => ({
  Notice: vi.fn()
}));

import { ConflictResolver } from '../../src/core/conflict-resolver';
import { createMockAirtableClient, MockAirtableClient } from '../__mocks__/airtable-client.mock';
import type { AutoNoteImporterSettings, ConflictInfo } from '../../src/types';

describe('ConflictResolver', () => {
  let mockAirtableClient: MockAirtableClient;
  let resolver: ConflictResolver;

  const createSettings = (conflictResolution: 'obsidian-wins' | 'airtable-wins' | 'manual'): AutoNoteImporterSettings => ({
    apiKey: 'key',
    baseId: 'base123',
    tableId: 'tbl123',
    folderPath: 'notes',
    templatePath: '',
    syncInterval: 0,
    allowOverwrite: false,
    filenameFieldName: '',
    subfolderFieldName: '',
    bidirectionalSync: true,
    conflictResolution,
    watchForChanges: false,
    fileWatchDebounce: 2000,
    autoSyncFormulas: false,
    formulaSyncDelay: 1500,
    debugMode: false,
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockAirtableClient = createMockAirtableClient();
  });

  describe('shouldSkipConflictDetection', () => {
    it('should return true for obsidian-wins mode (CR-2.1)', () => {
      const settings = createSettings('obsidian-wins');
      resolver = new ConflictResolver(settings, mockAirtableClient as any);

      expect(resolver.shouldSkipConflictDetection()).toBe(true);
    });

    it('should return false for airtable-wins mode (CR-2.2)', () => {
      const settings = createSettings('airtable-wins');
      resolver = new ConflictResolver(settings, mockAirtableClient as any);

      expect(resolver.shouldSkipConflictDetection()).toBe(false);
    });

    it('should return false for manual mode', () => {
      const settings = createSettings('manual');
      resolver = new ConflictResolver(settings, mockAirtableClient as any);

      expect(resolver.shouldSkipConflictDetection()).toBe(false);
    });
  });

  describe('detectConflicts', () => {
    it('should return empty array when record not found', async () => {
      const settings = createSettings('airtable-wins');
      resolver = new ConflictResolver(settings, mockAirtableClient as any);

      mockAirtableClient.fetchRecord.mockResolvedValue(null);

      const conflicts = await resolver.detectConflicts(
        'rec123',
        { field1: 'value1' },
        'notes/test.md'
      );

      expect(conflicts).toEqual([]);
    });

    it('should detect conflicting field values', async () => {
      const settings = createSettings('airtable-wins');
      resolver = new ConflictResolver(settings, mockAirtableClient as any);

      mockAirtableClient.fetchRecord.mockResolvedValue({
        id: 'rec123',
        fields: {
          field1: 'airtable-value',
          field2: 'same-value'
        }
      });

      const conflicts = await resolver.detectConflicts(
        'rec123',
        {
          field1: 'obsidian-value',
          field2: 'same-value'
        },
        'notes/test.md'
      );

      expect(conflicts).toHaveLength(1);
      expect(conflicts[0]).toEqual({
        field: 'field1',
        obsidianValue: 'obsidian-value',
        airtableValue: 'airtable-value',
        recordId: 'rec123',
        filePath: 'notes/test.md'
      });
    });

    it('should not detect conflict when values are equal', async () => {
      const settings = createSettings('airtable-wins');
      resolver = new ConflictResolver(settings, mockAirtableClient as any);

      mockAirtableClient.fetchRecord.mockResolvedValue({
        id: 'rec123',
        fields: { field1: 'same-value' }
      });

      const conflicts = await resolver.detectConflicts(
        'rec123',
        { field1: 'same-value' },
        'notes/test.md'
      );

      expect(conflicts).toEqual([]);
    });

    it('should not detect conflict for new fields in obsidian', async () => {
      const settings = createSettings('airtable-wins');
      resolver = new ConflictResolver(settings, mockAirtableClient as any);

      mockAirtableClient.fetchRecord.mockResolvedValue({
        id: 'rec123',
        fields: {}
      });

      const conflicts = await resolver.detectConflicts(
        'rec123',
        { newField: 'new-value' },
        'notes/test.md'
      );

      expect(conflicts).toEqual([]);
    });

    it('should propagate fetch errors to caller', async () => {
      const settings = createSettings('airtable-wins');
      resolver = new ConflictResolver(settings, mockAirtableClient as any);

      mockAirtableClient.fetchRecord.mockRejectedValue(new Error('Network error'));

      await expect(
        resolver.detectConflicts('rec123', { field1: 'value' }, 'notes/test.md')
      ).rejects.toThrow('Network error');
    });
  });

  describe('resolve', () => {
    const createConflict = (field: string): ConflictInfo => ({
      field,
      obsidianValue: 'obsidian-value',
      airtableValue: 'airtable-value',
      recordId: 'rec123',
      filePath: 'notes/test.md'
    });

    describe('obsidian-wins mode (CR-1.1)', () => {
      it('should sync all fields, overwriting Airtable', async () => {
        const settings = createSettings('obsidian-wins');
        resolver = new ConflictResolver(settings, mockAirtableClient as any);

        const conflicts = [createConflict('field1')];
        const fieldsToSync = {
          field1: 'obsidian-value',
          field2: 'other-value'
        };

        mockAirtableClient.updateRecord.mockResolvedValue({
          success: true,
          recordId: 'rec123',
          updatedFields: fieldsToSync
        });

        const result = await resolver.resolve(conflicts, fieldsToSync, 'rec123');

        expect(mockAirtableClient.updateRecord).toHaveBeenCalledWith('rec123', fieldsToSync);
        expect(result.success).toBe(true);
      });
    });

    describe('airtable-wins mode (CR-1.2)', () => {
      it('should skip conflicted fields and sync non-conflicted fields only', async () => {
        const settings = createSettings('airtable-wins');
        resolver = new ConflictResolver(settings, mockAirtableClient as any);

        const conflicts = [createConflict('field1')];
        const fieldsToSync = {
          field1: 'obsidian-value',
          field2: 'non-conflicted-value'
        };

        mockAirtableClient.updateRecord.mockResolvedValue({
          success: true,
          recordId: 'rec123',
          updatedFields: { field2: 'non-conflicted-value' }
        });

        const result = await resolver.resolve(conflicts, fieldsToSync, 'rec123');

        expect(mockAirtableClient.updateRecord).toHaveBeenCalledWith('rec123', {
          field2: 'non-conflicted-value'
        });
        expect(result.success).toBe(true);
      });

      it('should return success without calling updateRecord if all fields conflicted', async () => {
        const settings = createSettings('airtable-wins');
        resolver = new ConflictResolver(settings, mockAirtableClient as any);

        const conflicts = [createConflict('field1')];
        const fieldsToSync = { field1: 'obsidian-value' };

        const result = await resolver.resolve(conflicts, fieldsToSync, 'rec123');

        expect(mockAirtableClient.updateRecord).not.toHaveBeenCalled();
        expect(result.success).toBe(true);
        expect(result.updatedFields).toEqual({});
      });
    });

    describe('manual mode (CR-1.3)', () => {
      it('should not sync and return error', async () => {
        const settings = createSettings('manual');
        resolver = new ConflictResolver(settings, mockAirtableClient as any);

        const conflicts = [createConflict('field1')];
        const fieldsToSync = { field1: 'obsidian-value' };

        const result = await resolver.resolve(conflicts, fieldsToSync, 'rec123');

        expect(mockAirtableClient.updateRecord).not.toHaveBeenCalled();
        expect(result.success).toBe(false);
        expect(result.error).toContain('Conflicts detected');
      });
    });
  });

  describe('updateSettings', () => {
    it('should update internal settings reference', () => {
      const initialSettings = createSettings('obsidian-wins');
      resolver = new ConflictResolver(initialSettings, mockAirtableClient as any);

      expect(resolver.shouldSkipConflictDetection()).toBe(true);

      const newSettings = createSettings('airtable-wins');
      resolver.updateSettings(newSettings);

      expect(resolver.shouldSkipConflictDetection()).toBe(false);
    });
  });
});
