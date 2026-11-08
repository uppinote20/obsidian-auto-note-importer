/**
 * Tests for conflict-resolver service.
 * @covers src/core/conflict-resolver.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock obsidian Notice before importing ConflictResolver
vi.mock('obsidian', () => ({
  Notice: vi.fn()
}));

import { ConflictResolver, planPush, planPull } from '../../src/core/conflict-resolver';
import type { FieldVerdict } from '../../src/core/three-way-merge';
import { createMockDatabaseProvider, MockDatabaseProvider } from '../__mocks__/database-client.mock';
import type { LegacySettings, ConflictInfo, DatabaseProvider } from '../../src/types';
import { DEFAULT_LEGACY_SETTINGS } from '../../src/types';

describe('ConflictResolver', () => {
  let mockProvider: MockDatabaseProvider;
  let resolver: ConflictResolver;

  const createSettings = (conflictResolution: 'obsidian-wins' | 'remote-wins' | 'manual'): LegacySettings => ({
    ...DEFAULT_LEGACY_SETTINGS,
    apiKey: 'key',
    baseId: 'base123',
    tableId: 'tbl123',
    folderPath: 'notes',
    bidirectionalSync: true,
    conflictResolution,
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockProvider = createMockDatabaseProvider();
  });

  describe('shouldSkipConflictDetection', () => {
    it('should return true for obsidian-wins mode (CR-2.1)', () => {
      const settings = createSettings('obsidian-wins');
      resolver = new ConflictResolver(settings, mockProvider as unknown as DatabaseProvider);

      expect(resolver.shouldSkipConflictDetection()).toBe(true);
    });

    it('should return false for remote-wins mode (CR-2.2)', () => {
      const settings = createSettings('remote-wins');
      resolver = new ConflictResolver(settings, mockProvider as unknown as DatabaseProvider);

      expect(resolver.shouldSkipConflictDetection()).toBe(false);
    });

    it('should return false for manual mode', () => {
      const settings = createSettings('manual');
      resolver = new ConflictResolver(settings, mockProvider as unknown as DatabaseProvider);

      expect(resolver.shouldSkipConflictDetection()).toBe(false);
    });
  });

  describe('detectConflicts', () => {
    it('should return empty array when record not found', async () => {
      const settings = createSettings('remote-wins');
      resolver = new ConflictResolver(settings, mockProvider as unknown as DatabaseProvider);

      mockProvider.fetchRecord.mockResolvedValue(null);

      const conflicts = await resolver.detectConflicts(
        'rec123',
        { field1: 'value1' },
        'notes/test.md'
      );

      expect(conflicts).toEqual([]);
    });

    it('should detect conflicting field values', async () => {
      const settings = createSettings('remote-wins');
      resolver = new ConflictResolver(settings, mockProvider as unknown as DatabaseProvider);

      mockProvider.fetchRecord.mockResolvedValue({
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
        remoteValue: 'airtable-value',
        recordId: 'rec123',
        filePath: 'notes/test.md'
      });
    });

    it('should not detect conflict when values are equal', async () => {
      const settings = createSettings('remote-wins');
      resolver = new ConflictResolver(settings, mockProvider as unknown as DatabaseProvider);

      mockProvider.fetchRecord.mockResolvedValue({
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
      const settings = createSettings('remote-wins');
      resolver = new ConflictResolver(settings, mockProvider as unknown as DatabaseProvider);

      mockProvider.fetchRecord.mockResolvedValue({
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
      const settings = createSettings('remote-wins');
      resolver = new ConflictResolver(settings, mockProvider as unknown as DatabaseProvider);

      mockProvider.fetchRecord.mockRejectedValue(new Error('Network error'));

      await expect(
        resolver.detectConflicts('rec123', { field1: 'value' }, 'notes/test.md')
      ).rejects.toThrow('Network error');
    });
  });

  describe('resolve', () => {
    const createConflict = (field: string): ConflictInfo => ({
      field,
      obsidianValue: 'obsidian-value',
      remoteValue: 'airtable-value',
      recordId: 'rec123',
      filePath: 'notes/test.md'
    });

    describe('obsidian-wins mode (CR-1.1)', () => {
      it('should sync all fields, overwriting Airtable', async () => {
        const settings = createSettings('obsidian-wins');
        resolver = new ConflictResolver(settings, mockProvider as unknown as DatabaseProvider);

        const conflicts = [createConflict('field1')];
        const fieldsToSync = {
          field1: 'obsidian-value',
          field2: 'other-value'
        };

        mockProvider.updateRecord.mockResolvedValue({
          success: true,
          recordId: 'rec123',
          updatedFields: fieldsToSync
        });

        const result = await resolver.resolve(conflicts, fieldsToSync, 'rec123');

        expect(mockProvider.updateRecord).toHaveBeenCalledWith('rec123', fieldsToSync);
        expect(result.success).toBe(true);
      });
    });

    describe('remote-wins mode (CR-1.2)', () => {
      it('should skip conflicted fields and sync non-conflicted fields only', async () => {
        const settings = createSettings('remote-wins');
        resolver = new ConflictResolver(settings, mockProvider as unknown as DatabaseProvider);

        const conflicts = [createConflict('field1')];
        const fieldsToSync = {
          field1: 'obsidian-value',
          field2: 'non-conflicted-value'
        };

        mockProvider.updateRecord.mockResolvedValue({
          success: true,
          recordId: 'rec123',
          updatedFields: { field2: 'non-conflicted-value' }
        });

        const result = await resolver.resolve(conflicts, fieldsToSync, 'rec123');

        expect(mockProvider.updateRecord).toHaveBeenCalledWith('rec123', {
          field2: 'non-conflicted-value'
        });
        expect(result.success).toBe(true);
      });

      it('should return success without calling updateRecord if all fields conflicted', async () => {
        const settings = createSettings('remote-wins');
        resolver = new ConflictResolver(settings, mockProvider as unknown as DatabaseProvider);

        const conflicts = [createConflict('field1')];
        const fieldsToSync = { field1: 'obsidian-value' };

        const result = await resolver.resolve(conflicts, fieldsToSync, 'rec123');

        expect(mockProvider.updateRecord).not.toHaveBeenCalled();
        expect(result.success).toBe(true);
        expect(result.updatedFields).toEqual({});
      });
    });

    describe('manual mode (CR-1.3)', () => {
      it('should not sync and return error', async () => {
        const settings = createSettings('manual');
        resolver = new ConflictResolver(settings, mockProvider as unknown as DatabaseProvider);

        const conflicts = [createConflict('field1')];
        const fieldsToSync = { field1: 'obsidian-value' };

        const result = await resolver.resolve(conflicts, fieldsToSync, 'rec123');

        expect(mockProvider.updateRecord).not.toHaveBeenCalled();
        expect(result.success).toBe(false);
        expect(result.error).toContain('Conflicts detected');
      });
    });
  });

  describe('updateSettings', () => {
    it('should update internal settings reference', () => {
      const initialSettings = createSettings('obsidian-wins');
      resolver = new ConflictResolver(initialSettings, mockProvider as unknown as DatabaseProvider);

      expect(resolver.shouldSkipConflictDetection()).toBe(true);

      const newSettings = createSettings('remote-wins');
      resolver.updateSettings(newSettings);

      expect(resolver.shouldSkipConflictDetection()).toBe(false);
    });
  });
});

describe('planPush / planPull', () => {
  const verdicts: Record<string, FieldVerdict> = {
    u: 'unchanged',
    lo: 'local-only',
    ro: 'remote-only',
    bs: 'both-same',
    c: 'conflict',
    ro_field: 'conflict',
  };
  const local = { u: 1, lo: 2, ro: 3, bs: 4, c: 5, ro_field: 6, outside: 7 };
  const all = () => true;
  const notRo = (f: string) => f !== 'ro_field';

  describe('planPush', () => {
    it('obsidian-wins sends every writable verdict field with a local value', () => {
      const plan = planPush('obsidian-wins', verdicts, local, notRo);
      expect(plan.send).toEqual({ u: 1, lo: 2, ro: 3, bs: 4, c: 5 });
      expect(plan.overwroteRemote).toEqual(['ro', 'c']);
      expect(plan.enqueue).toEqual([]);
    });

    it('obsidian-wins skips fields with no local value', () => {
      const plan = planPush('obsidian-wins', { a: 'unchanged', b: 'conflict' }, { a: undefined }, all);
      expect(plan.send).toEqual({});
      expect(plan.overwroteRemote).toEqual([]);
    });

    it.each(['remote-wins', 'manual'] as const)('%s sends only writable local-only', (mode) => {
      const plan = planPush(mode, verdicts, local, notRo);
      expect(plan.send).toEqual({ lo: 2 });
      expect(plan.overwroteRemote).toEqual([]);
    });

    it('manual enqueues writable conflicts, remote-wins does not', () => {
      expect(planPush('manual', verdicts, local, notRo).enqueue).toEqual(['c']);
      expect(planPush('remote-wins', verdicts, local, notRo).enqueue).toEqual([]);
    });

    it.each(['obsidian-wins', 'remote-wins', 'manual'] as const)('%s never sends non-writable fields', (mode) => {
      const plan = planPush(mode, verdicts, local, () => false);
      expect(plan.send).toEqual({});
    });
  });

  describe('planPull', () => {
    it('obsidian-wins keeps local-only and conflict regardless of writability', () => {
      const plan = planPull('obsidian-wins', verdicts, notRo);
      expect(plan.keepLocal).toEqual(['lo', 'c', 'ro_field']);
      expect(plan.restoredRemote).toEqual([]);
      expect(plan.enqueue).toEqual([]);
    });

    it('remote-wins keeps writable local-only, restores conflicts and non-writable local-only', () => {
      const v: Record<string, FieldVerdict> = { lo: 'local-only', nlo: 'local-only', c: 'conflict' };
      const plan = planPull('remote-wins', v, (f) => f !== 'nlo');
      expect(plan.keepLocal).toEqual(['lo']);
      expect(plan.restoredRemote).toEqual(['nlo', 'c']);
      expect(plan.enqueue).toEqual([]);
    });

    it('manual keeps local-only + conflict, enqueues conflict + non-writable local-only', () => {
      const v: Record<string, FieldVerdict> = { lo: 'local-only', nlo: 'local-only', c: 'conflict' };
      const plan = planPull('manual', v, (f) => f !== 'nlo');
      expect(plan.keepLocal).toEqual(['lo', 'nlo', 'c']);
      expect(plan.enqueue).toEqual(['nlo', 'c']);
      expect(plan.restoredRemote).toEqual([]);
    });
  });
});
