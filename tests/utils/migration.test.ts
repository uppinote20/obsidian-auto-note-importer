/**
 * Tests for settings migration utility.
 * @covers src/utils/migration.ts
 */

import { describe, it, expect } from 'vitest';
import { migrateSettings } from '../../src/utils/migration';

describe('migrateSettings', () => {
  it('should return null for v3 settings (already current)', () => {
    const data = { version: 3, credentials: [], configs: [], activeConfigId: '', debugMode: false };
    expect(migrateSettings(data)).toBeNull();
  });

  it('should return null for null/undefined data', () => {
    expect(migrateSettings(null)).toBeNull();
    expect(migrateSettings(undefined)).toBeNull();
  });

  describe('v1 (legacy flat) → v3', () => {
    it('should migrate legacy single-config settings to v3 with renamed fields', () => {
      const legacy = {
        apiKey: 'pat_xxx', baseId: 'app123', tableId: 'tbl456', viewId: 'viw789',
        folderPath: 'Notes/', templatePath: '', syncInterval: 300, allowOverwrite: true,
        filenameFieldName: 'Name', subfolderFieldName: '', bidirectionalSync: false,
        conflictResolution: 'obsidian-wins', watchForChanges: false, fileWatchDebounce: 2000,
        autoSyncFormulas: false, formulaSyncDelay: 3000, generateBasesFile: false,
        basesFileLocation: 'vault-root', basesCustomPath: '', basesRegenerateOnSync: false,
        debugMode: true,
      };

      const result = migrateSettings(legacy);
      expect(result).not.toBeNull();
      expect(result!.version).toBe(3);
      expect(result!.debugMode).toBe(true);
      expect(result!.credentials).toHaveLength(1);
      expect(result!.credentials[0].type).toBe('airtable');
      expect(result!.configs).toHaveLength(1);
      expect(result!.activeConfigId).toBe(result!.configs[0].id);
    });

    it('should handle empty apiKey', () => {
      const legacy = {
        apiKey: '', baseId: '', tableId: '', viewId: '', folderPath: '', templatePath: '',
        syncInterval: 0, allowOverwrite: true, filenameFieldName: '', subfolderFieldName: '',
        bidirectionalSync: false, conflictResolution: 'manual', watchForChanges: false,
        fileWatchDebounce: 2000, autoSyncFormulas: false, formulaSyncDelay: 3000,
        generateBasesFile: false, basesFileLocation: 'vault-root', basesCustomPath: '',
        basesRegenerateOnSync: false, debugMode: false,
      };
      const result = migrateSettings(legacy);
      expect(result).not.toBeNull();
      expect(result!.version).toBe(3);
    });

    it('should generate unique ids for credential and config', () => {
      const result = migrateSettings({ apiKey: 'key', baseId: 'base', tableId: 'tbl', viewId: '' });
      expect(result).not.toBeNull();
      expect(result!.credentials[0].id).toBeTruthy();
      expect(result!.configs[0].id).toBeTruthy();
      expect(result!.credentials[0].id).not.toBe(result!.configs[0].id);
    });

    it('should rename airtable-wins → remote-wins and autoSyncFormulas → autoSyncComputedFields', () => {
      const legacy = {
        apiKey: 'key', baseId: 'app_base', tableId: 'tbl_table', viewId: 'viw_view',
        folderPath: 'MyNotes', templatePath: 'Templates/note.md', syncInterval: 600,
        allowOverwrite: false, filenameFieldName: 'Title', subfolderFieldName: 'Category',
        bidirectionalSync: true, conflictResolution: 'airtable-wins',
        watchForChanges: true, fileWatchDebounce: 5000, autoSyncFormulas: true,
        formulaSyncDelay: 1500, generateBasesFile: true, basesFileLocation: 'custom',
        basesCustomPath: 'output/bases.md', basesRegenerateOnSync: true, debugMode: false,
      };

      const result = migrateSettings(legacy);
      expect(result).not.toBeNull();
      const config = result!.configs[0];
      expect(config.conflictResolution).toBe('remote-wins');
      expect(config.autoSyncComputedFields).toBe(true);
      expect((config as Record<string, unknown>)['autoSyncFormulas']).toBeUndefined();
      // sanity: other fields still mapped
      expect(config.baseId).toBe('app_base');
      expect(config.bidirectionalSync).toBe(true);
      expect(config.basesCustomPath).toBe('output/bases.md');
    });
  });

  describe('v2 → v3', () => {
    it('should rename per-config fields and bump version', () => {
      const v2 = {
        version: 2,
        credentials: [{ id: 'c1', name: 'AT', type: 'airtable', apiKey: 'k' }],
        configs: [{
          id: 'cfg1', name: 'Default', enabled: true, credentialId: 'c1',
          baseId: 'b', tableId: 't', viewId: '', folderPath: 'F', templatePath: '',
          filenameFieldName: '', subfolderFieldName: '', syncInterval: 0,
          allowOverwrite: true, bidirectionalSync: true,
          conflictResolution: 'airtable-wins',
          watchForChanges: true, fileWatchDebounce: 2000,
          autoSyncFormulas: true,
          formulaSyncDelay: 1500, generateBasesFile: false,
          basesFileLocation: 'vault-root', basesCustomPath: '', basesRegenerateOnSync: false,
        }],
        activeConfigId: 'cfg1',
        debugMode: true,
      };

      const result = migrateSettings(v2);
      expect(result).not.toBeNull();
      expect(result!.version).toBe(3);
      expect(result!.activeConfigId).toBe('cfg1');
      expect(result!.debugMode).toBe(true);
      expect(result!.credentials).toHaveLength(1);

      const cfg = result!.configs[0];
      expect(cfg.id).toBe('cfg1');
      expect(cfg.conflictResolution).toBe('remote-wins');
      expect(cfg.autoSyncComputedFields).toBe(true);
      expect((cfg as Record<string, unknown>)['autoSyncFormulas']).toBeUndefined();
      // unchanged fields preserved
      expect(cfg.bidirectionalSync).toBe(true);
      expect(cfg.formulaSyncDelay).toBe(1500);
    });

    it('preserves non-airtable-wins conflict modes unchanged', () => {
      for (const mode of ['obsidian-wins', 'manual'] as const) {
        const v2 = {
          version: 2,
          credentials: [],
          configs: [{ id: 'c', name: 'n', enabled: true, credentialId: '',
            baseId: '', tableId: '', viewId: '', folderPath: '', templatePath: '',
            filenameFieldName: '', subfolderFieldName: '', syncInterval: 0,
            allowOverwrite: true, bidirectionalSync: false,
            conflictResolution: mode,
            watchForChanges: false, fileWatchDebounce: 2000,
            autoSyncFormulas: false, formulaSyncDelay: 1500,
            generateBasesFile: false, basesFileLocation: 'vault-root',
            basesCustomPath: '', basesRegenerateOnSync: false }],
          activeConfigId: '', debugMode: false,
        };
        const result = migrateSettings(v2);
        expect(result!.configs[0].conflictResolution).toBe(mode);
      }
    });

    it('falls back to manual for unknown conflictResolution values', () => {
      const v2 = {
        version: 2, credentials: [], configs: [{ conflictResolution: 'garbage' }],
        activeConfigId: '', debugMode: false,
      };
      const result = migrateSettings(v2);
      expect(result!.configs[0].conflictResolution).toBe('manual');
    });

    it('treats malformed configs/credentials arrays as empty', () => {
      const v2 = {
        version: 2,
        credentials: null,
        configs: 'not-an-array',
        activeConfigId: '', debugMode: false,
      };
      const result = migrateSettings(v2);
      expect(result!.version).toBe(3);
      expect(result!.credentials).toEqual([]);
      expect(result!.configs).toEqual([]);
    });

    it('defaults autoSyncComputedFields to false when both v2 and v3 fields are absent', () => {
      const v2 = {
        version: 2, credentials: [],
        configs: [{ id: 'c', name: 'n', credentialId: '' }],
        activeConfigId: '', debugMode: false,
      };
      const result = migrateSettings(v2);
      expect(result!.configs[0].autoSyncComputedFields).toBe(false);
    });
  });

  describe('future-version safety', () => {
    it('returns null for version > current (refuses to downgrade)', () => {
      const v99 = { version: 99, credentials: [], configs: [], activeConfigId: '', debugMode: false };
      expect(migrateSettings(v99)).toBeNull();
    });
  });
});
