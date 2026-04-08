/**
 * Tests for ConfigManager.
 * @covers src/core/config-manager.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { App } from 'obsidian';
import { createMockApp } from 'obsidian';
import type { ConfigEntry, Credential, SharedServices } from '../../src/types';
import { DEFAULT_CONFIG_ENTRY } from '../../src/types';
import { ConfigManager } from '../../src/core/config-manager';
import { ConfigInstance } from '../../src/core/config-instance';
import { FieldCache } from '../../src/services/field-cache';
import { FrontmatterParser } from '../../src/file-operations/frontmatter-parser';

vi.mock('../../src/core/config-instance');

function createConfig(overrides: Partial<ConfigEntry> = {}): ConfigEntry {
  return {
    ...DEFAULT_CONFIG_ENTRY,
    id: 'cfg-1',
    name: 'Test Config',
    credentialId: 'cred-1',
    ...overrides,
  };
}

function createCredential(overrides: Partial<Credential> = {}): Credential {
  return {
    id: 'cred-1',
    name: 'Test Credential',
    type: 'airtable',
    apiKey: 'pat-test-key',
    ...overrides,
  };
}

function createSharedServices(): SharedServices {
  return {
    rateLimiters: new Map(),
    fieldCache: new FieldCache(),
    frontmatterParser: new FrontmatterParser({} as App),
    statusBarFactory: vi.fn(() => document.createElement('div')),
    getDebugMode: vi.fn(() => false),
  };
}

describe('ConfigManager', () => {
  let mockApp: ReturnType<typeof createMockApp>;
  let shared: SharedServices;
  let manager: ConfigManager;

  beforeEach(() => {
    vi.clearAllMocks();
    mockApp = createMockApp();
    shared = createSharedServices();
    manager = new ConfigManager(mockApp as unknown as App, shared);
  });

  describe('initialize', () => {
    it('should create instances for enabled configs', () => {
      const configs = [
        createConfig({ id: 'cfg-1', enabled: true, credentialId: 'cred-1' }),
        createConfig({ id: 'cfg-2', enabled: true, credentialId: 'cred-1' }),
      ];
      const credentials = [createCredential({ id: 'cred-1' })];

      manager.initialize(configs, credentials);

      expect(ConfigInstance).toHaveBeenCalledTimes(2);
      expect(manager.getAllEnabled()).toHaveLength(2);
    });

    it('should skip disabled configs', () => {
      const configs = [
        createConfig({ id: 'cfg-1', enabled: true, credentialId: 'cred-1' }),
        createConfig({ id: 'cfg-2', enabled: false, credentialId: 'cred-1' }),
        createConfig({ id: 'cfg-3', enabled: true, credentialId: 'cred-1' }),
      ];
      const credentials = [createCredential({ id: 'cred-1' })];

      manager.initialize(configs, credentials);

      expect(ConfigInstance).toHaveBeenCalledTimes(2);
      expect(manager.getAllEnabled()).toHaveLength(2);
    });

    it('should skip configs with missing credentials', () => {
      const configs = [
        createConfig({ id: 'cfg-1', enabled: true, credentialId: 'cred-missing' }),
      ];
      const credentials = [createCredential({ id: 'cred-1' })];

      manager.initialize(configs, credentials);

      expect(ConfigInstance).toHaveBeenCalledTimes(0);
      expect(manager.getAllEnabled()).toHaveLength(0);
    });
  });

  describe('addConfig', () => {
    it('should create a new ConfigInstance and return it', () => {
      const config = createConfig();
      const credential = createCredential();

      const instance = manager.addConfig(config, credential);

      expect(ConfigInstance).toHaveBeenCalledTimes(1);
      expect(instance).toBeDefined();
      expect(manager.getInstance('cfg-1')).toBe(instance);
    });
  });

  describe('removeConfig', () => {
    it('should call destroy on the instance and remove it', () => {
      const config = createConfig({ id: 'cfg-1' });
      const credential = createCredential();

      manager.addConfig(config, credential);
      const instance = vi.mocked(ConfigInstance).mock.instances[0];

      manager.removeConfig('cfg-1');

      expect(instance.destroy).toHaveBeenCalledTimes(1);
      expect(manager.getInstance('cfg-1')).toBeUndefined();
    });

    it('should do nothing for non-existent config', () => {
      // Should not throw
      manager.removeConfig('non-existent');
      expect(manager.getAllEnabled()).toHaveLength(0);
    });
  });

  describe('getInstance', () => {
    it('should return instance by ID', () => {
      const config = createConfig({ id: 'cfg-1' });
      const credential = createCredential();

      const instance = manager.addConfig(config, credential);

      expect(manager.getInstance('cfg-1')).toBe(instance);
    });

    it('should return undefined for unknown ID', () => {
      expect(manager.getInstance('unknown')).toBeUndefined();
    });
  });

  describe('getAllEnabled', () => {
    it('should return all active instances', () => {
      const credential = createCredential();
      manager.addConfig(createConfig({ id: 'cfg-1' }), credential);
      manager.addConfig(createConfig({ id: 'cfg-2' }), credential);

      const all = manager.getAllEnabled();

      expect(all).toHaveLength(2);
    });

    it('should return empty array when no instances exist', () => {
      expect(manager.getAllEnabled()).toHaveLength(0);
    });
  });

  describe('updateConfig', () => {
    it('should call updateSettings when instance exists and config is enabled', () => {
      const config = createConfig({ id: 'cfg-1', enabled: true });
      const credential = createCredential();

      manager.addConfig(config, credential);
      const instance = vi.mocked(ConfigInstance).mock.instances[0];

      const updatedConfig = createConfig({ id: 'cfg-1', enabled: true, folderPath: 'Updated' });
      manager.updateConfig('cfg-1', updatedConfig, credential);

      expect(instance.updateSettings).toHaveBeenCalledWith(updatedConfig, credential);
    });

    it('should remove instance when config is disabled', () => {
      const config = createConfig({ id: 'cfg-1', enabled: true });
      const credential = createCredential();

      manager.addConfig(config, credential);
      const instance = vi.mocked(ConfigInstance).mock.instances[0];

      const disabledConfig = createConfig({ id: 'cfg-1', enabled: false });
      manager.updateConfig('cfg-1', disabledConfig, credential);

      expect(instance.destroy).toHaveBeenCalledTimes(1);
      expect(manager.getInstance('cfg-1')).toBeUndefined();
    });

    it('should add instance when previously disabled config is enabled', () => {
      const config = createConfig({ id: 'cfg-1', enabled: true });
      const credential = createCredential();

      // No instance exists for cfg-1
      expect(manager.getInstance('cfg-1')).toBeUndefined();

      manager.updateConfig('cfg-1', config, credential);

      expect(ConfigInstance).toHaveBeenCalledTimes(1);
      expect(manager.getInstance('cfg-1')).toBeDefined();
    });

    it('should do nothing when no instance and config is disabled', () => {
      const disabledConfig = createConfig({ id: 'cfg-1', enabled: false });
      const credential = createCredential();

      manager.updateConfig('cfg-1', disabledConfig, credential);

      expect(ConfigInstance).not.toHaveBeenCalled();
      expect(manager.getInstance('cfg-1')).toBeUndefined();
    });
  });

  describe('destroy', () => {
    it('should destroy all instances and clear the map', () => {
      const credential = createCredential();
      manager.addConfig(createConfig({ id: 'cfg-1' }), credential);
      manager.addConfig(createConfig({ id: 'cfg-2' }), credential);

      const instances = vi.mocked(ConfigInstance).mock.instances;
      expect(instances).toHaveLength(2);

      manager.destroy();

      expect(instances[0].destroy).toHaveBeenCalled();
      expect(instances[1].destroy).toHaveBeenCalled();
      expect(manager.getAllEnabled()).toHaveLength(0);
    });

    it('should handle empty manager gracefully', () => {
      // Should not throw
      manager.destroy();
      expect(manager.getAllEnabled()).toHaveLength(0);
    });
  });
});
