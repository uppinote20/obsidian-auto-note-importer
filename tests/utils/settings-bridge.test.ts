/**
 * Tests for settings-bridge utility.
 * @covers src/utils/settings-bridge.ts
 */

import { describe, it, expect } from 'vitest';
import { buildLegacySettings } from '../../src/utils/settings-bridge';
import type { ConfigEntry, Credential, AirtableCredential } from '../../src/types';
import { DEFAULT_CONFIG_ENTRY } from '../../src/types';

function createConfig(overrides: Partial<ConfigEntry> = {}): ConfigEntry {
  return {
    ...DEFAULT_CONFIG_ENTRY,
    id: 'cfg-1',
    name: 'Test Config',
    credentialId: 'cred-1',
    baseId: 'appTest',
    tableId: 'tblTest',
    folderPath: 'Notes',
    ...overrides,
  };
}

function createAirtableCredential(overrides: Partial<AirtableCredential> = {}): AirtableCredential {
  return {
    id: 'cred-1',
    name: 'Airtable',
    type: 'airtable',
    apiKey: 'pat-test-key',
    ...overrides,
  };
}

describe('buildLegacySettings', () => {
  describe('airtable credential', () => {
    it('should extract apiKey from credential', () => {
      const result = buildLegacySettings(createConfig(), createAirtableCredential(), false);
      expect(result.apiKey).toBe('pat-test-key');
    });

    it('should pass through all ConfigEntry fields', () => {
      const config = createConfig({
        baseId: 'appCustom',
        tableId: 'tblCustom',
        viewId: 'viwCustom',
        folderPath: 'Custom/Folder',
        bidirectionalSync: true,
        conflictResolution: 'manual',
      });
      const result = buildLegacySettings(config, createAirtableCredential(), false);

      expect(result.baseId).toBe('appCustom');
      expect(result.tableId).toBe('tblCustom');
      expect(result.viewId).toBe('viwCustom');
      expect(result.folderPath).toBe('Custom/Folder');
      expect(result.bidirectionalSync).toBe(true);
      expect(result.conflictResolution).toBe('manual');
    });

    it('should apply debugMode flag', () => {
      const enabled = buildLegacySettings(createConfig(), createAirtableCredential(), true);
      expect(enabled.debugMode).toBe(true);

      const disabled = buildLegacySettings(createConfig(), createAirtableCredential(), false);
      expect(disabled.debugMode).toBe(false);
    });

    it('should preserve empty apiKey on credential', () => {
      const cred = createAirtableCredential({ apiKey: '' });
      const result = buildLegacySettings(createConfig(), cred, false);
      expect(result.apiKey).toBe('');
    });
  });

  describe('non-airtable credentials — apiKey fallback', () => {
    it('should return empty apiKey for seatable credential', () => {
      const cred: Credential = {
        id: 'cred-2',
        name: 'SeaTable',
        type: 'seatable',
        apiToken: 'st-token',
        serverUrl: 'https://cloud.seatable.io',
      };
      const result = buildLegacySettings(createConfig(), cred, false);
      expect(result.apiKey).toBe('');
    });

    it('should return empty apiKey for supabase credential', () => {
      const cred: Credential = {
        id: 'cred-3',
        name: 'Supabase',
        type: 'supabase',
        projectUrl: 'https://xyz.supabase.co',
        apiKey: 'anon-key-should-be-ignored',
      };
      const result = buildLegacySettings(createConfig(), cred, false);
      // Legacy bridge's `apiKey` is Airtable-only; Supabase providers read
      // from their credential variant directly.
      expect(result.apiKey).toBe('');
    });

    it('should return empty apiKey for notion credential', () => {
      const cred: Credential = {
        id: 'cred-4',
        name: 'Notion',
        type: 'notion',
        integrationToken: 'secret-token',
      };
      const result = buildLegacySettings(createConfig(), cred, false);
      expect(result.apiKey).toBe('');
    });

    it('should return empty apiKey for custom-api credential', () => {
      const cred: Credential = {
        id: 'cred-5',
        name: 'Custom',
        type: 'custom-api',
        baseUrl: 'https://api.example.com',
        authHeader: 'X-API-Key',
        authValue: 'secret',
      };
      const result = buildLegacySettings(createConfig(), cred, false);
      expect(result.apiKey).toBe('');
    });

    it('should still pass through config fields for non-airtable credentials', () => {
      const cred: Credential = {
        id: 'cred-2',
        name: 'SeaTable',
        type: 'seatable',
        apiToken: 'st-token',
        serverUrl: 'https://cloud.seatable.io',
      };
      const config = createConfig({
        folderPath: 'SeaTable/Notes',
        bidirectionalSync: true,
      });
      const result = buildLegacySettings(config, cred, true);

      expect(result.folderPath).toBe('SeaTable/Notes');
      expect(result.bidirectionalSync).toBe(true);
      expect(result.debugMode).toBe(true);
    });
  });

  describe('shape invariants', () => {
    it('should not mutate the input config', () => {
      const config = createConfig();
      const snapshot = JSON.stringify(config);
      buildLegacySettings(config, createAirtableCredential(), true);
      expect(JSON.stringify(config)).toBe(snapshot);
    });

    it('should prefer config fields over credential fields with the same name', () => {
      // Credential has id='cred-1', name='Secret Name'; config has id='cfg-1',
      // name='Test Config'. LegacySettings inherits from ConfigEntry, so config
      // values must win — credential id/name must not bleed through.
      const cred = createAirtableCredential({ name: 'Secret Name' });
      const result = buildLegacySettings(createConfig(), cred, false) as Record<string, unknown>;

      expect(result['id']).toBe('cfg-1');
      expect(result['name']).toBe('Test Config');
    });
  });
});
