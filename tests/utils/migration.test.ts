/**
 * Tests for settings migration utility.
 * @covers src/utils/migration.ts
 */

import { describe, it, expect } from 'vitest';
import { migrateSettings } from '../../src/utils/migration';

describe('migrateSettings', () => {
  it('should return null for v2 settings', () => {
    const data = { version: 2, credentials: [], configs: [], activeConfigId: '', debugMode: false };
    expect(migrateSettings(data)).toBeNull();
  });

  it('should return null for null/undefined data', () => {
    expect(migrateSettings(null)).toBeNull();
    expect(migrateSettings(undefined)).toBeNull();
  });

  it('should migrate legacy settings to v2', () => {
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
    expect(result!.version).toBe(2);
    expect(result!.debugMode).toBe(true);
    expect(result!.credentials).toHaveLength(1);
    expect(result!.credentials[0].type).toBe('airtable');
    expect(result!.credentials[0].apiKey).toBe('pat_xxx');
    expect(result!.configs).toHaveLength(1);
    expect(result!.configs[0].credentialId).toBe(result!.credentials[0].id);
    expect(result!.configs[0].baseId).toBe('app123');
    expect(result!.configs[0].enabled).toBe(true);
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
    expect(result!.credentials).toHaveLength(1);
  });

  it('should generate unique ids for credential and config', () => {
    const legacy = { apiKey: 'key', baseId: 'base', tableId: 'tbl', viewId: '' };
    const result = migrateSettings(legacy);
    expect(result).not.toBeNull();
    expect(result!.credentials[0].id).toBeTruthy();
    expect(result!.configs[0].id).toBeTruthy();
    expect(result!.credentials[0].id).not.toBe(result!.configs[0].id);
  });

  it('should correctly map all legacy config fields', () => {
    const legacy = {
      apiKey: 'key',
      baseId: 'app_base',
      tableId: 'tbl_table',
      viewId: 'viw_view',
      folderPath: 'MyNotes',
      templatePath: 'Templates/note.md',
      syncInterval: 600,
      allowOverwrite: false,
      filenameFieldName: 'Title',
      subfolderFieldName: 'Category',
      bidirectionalSync: true,
      conflictResolution: 'airtable-wins',
      watchForChanges: true,
      fileWatchDebounce: 5000,
      autoSyncFormulas: true,
      formulaSyncDelay: 1500,
      generateBasesFile: true,
      basesFileLocation: 'custom',
      basesCustomPath: 'output/bases.md',
      basesRegenerateOnSync: true,
      debugMode: false,
    };

    const result = migrateSettings(legacy);
    expect(result).not.toBeNull();
    const config = result!.configs[0];
    expect(config.baseId).toBe('app_base');
    expect(config.tableId).toBe('tbl_table');
    expect(config.viewId).toBe('viw_view');
    expect(config.folderPath).toBe('MyNotes');
    expect(config.templatePath).toBe('Templates/note.md');
    expect(config.syncInterval).toBe(600);
    expect(config.allowOverwrite).toBe(false);
    expect(config.filenameFieldName).toBe('Title');
    expect(config.subfolderFieldName).toBe('Category');
    expect(config.bidirectionalSync).toBe(true);
    expect(config.conflictResolution).toBe('airtable-wins');
    expect(config.watchForChanges).toBe(true);
    expect(config.fileWatchDebounce).toBe(5000);
    expect(config.autoSyncFormulas).toBe(true);
    expect(config.formulaSyncDelay).toBe(1500);
    expect(config.generateBasesFile).toBe(true);
    expect(config.basesFileLocation).toBe('custom');
    expect(config.basesCustomPath).toBe('output/bases.md');
    expect(config.basesRegenerateOnSync).toBe(true);
  });
});
