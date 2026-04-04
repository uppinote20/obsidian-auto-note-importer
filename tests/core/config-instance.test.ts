/**
 * Tests for ConfigInstance.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { App } from 'obsidian';
import { createMockApp } from 'obsidian';
import type { ConfigEntry, Credential, SharedServices } from '../../src/types';
import { DEFAULT_CONFIG_ENTRY } from '../../src/types';
import { ConfigInstance } from '../../src/core/config-instance';
import { AirtableClient } from '../../src/services/airtable-client';
import { RateLimiter } from '../../src/services/rate-limiter';
import { FileWatcher } from '../../src/file-operations/file-watcher';
import { SyncOrchestrator } from '../../src/core/sync-orchestrator';
import { SyncQueue } from '../../src/core/sync-queue';
import { ConflictResolver } from '../../src/core/conflict-resolver';
import { FieldCache } from '../../src/services/field-cache';
import { FrontmatterParser } from '../../src/file-operations/frontmatter-parser';

// Mock all service constructors
vi.mock('../../src/services/airtable-client');
vi.mock('../../src/file-operations/file-watcher');
vi.mock('../../src/core/sync-orchestrator');
vi.mock('../../src/core/sync-queue');
vi.mock('../../src/core/conflict-resolver');

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

function createSharedServices(overrides: Partial<SharedServices> = {}): SharedServices {
  return {
    rateLimiters: new Map(),
    fieldCache: new FieldCache(),
    frontmatterParser: new FrontmatterParser({} as App),
    statusBarFactory: vi.fn(() => {
      const el = document.createElement('div');
      el.textContent = '';
      return el;
    }),
    getDebugMode: vi.fn(() => false),
    ...overrides,
  };
}

describe('ConfigInstance', () => {
  let mockApp: ReturnType<typeof createMockApp>;
  let shared: SharedServices;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    mockApp = createMockApp();
    shared = createSharedServices();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('constructor — service creation', () => {
    it('should create all services on construction', () => {
      const config = createConfig();
      const credential = createCredential();

      const instance = new ConfigInstance(mockApp as unknown as App, config, credential, shared);

      expect(instance.configId).toBe('cfg-1');
      expect(AirtableClient).toHaveBeenCalledTimes(1);
      expect(ConflictResolver).toHaveBeenCalledTimes(1);
      expect(FileWatcher).toHaveBeenCalledTimes(1);
      expect(SyncOrchestrator).toHaveBeenCalledTimes(1);
      expect(SyncQueue).toHaveBeenCalledTimes(1);

      instance.destroy();
    });

    it('should call fileWatcher.setup() when config is enabled', () => {
      const config = createConfig({ enabled: true });
      const credential = createCredential();

      const instance = new ConfigInstance(mockApp as unknown as App, config, credential, shared);

      const fileWatcherInstance = vi.mocked(FileWatcher).mock.instances[0];
      expect(fileWatcherInstance.setup).toHaveBeenCalledTimes(1);

      instance.destroy();
    });

    it('should NOT call fileWatcher.setup() when config is disabled', () => {
      const config = createConfig({ enabled: false });
      const credential = createCredential();

      const instance = new ConfigInstance(mockApp as unknown as App, config, credential, shared);

      const fileWatcherInstance = vi.mocked(FileWatcher).mock.instances[0];
      expect(fileWatcherInstance.setup).not.toHaveBeenCalled();

      instance.destroy();
    });

    it('should pass merged settings with apiKey and debugMode to AirtableClient', () => {
      const config = createConfig({ baseId: 'appXYZ', tableId: 'tblABC' });
      const credential = createCredential({ apiKey: 'pat-my-key' });

      const instance = new ConfigInstance(mockApp as unknown as App, config, credential, shared);

      const settingsArg = vi.mocked(AirtableClient).mock.calls[0][0];
      expect(settingsArg.apiKey).toBe('pat-my-key');
      expect(settingsArg.debugMode).toBe(false);
      expect(settingsArg.baseId).toBe('appXYZ');
      expect(settingsArg.tableId).toBe('tblABC');

      instance.destroy();
    });
  });

  describe('scheduler', () => {
    it('should start scheduler when syncInterval > 0 and enabled', () => {
      const config = createConfig({ enabled: true, syncInterval: 5 });
      const credential = createCredential();

      const instance = new ConfigInstance(mockApp as unknown as App, config, credential, shared);

      expect(instance.isSchedulerActive()).toBe(true);

      instance.destroy();
    });

    it('should NOT start scheduler when syncInterval is 0', () => {
      const config = createConfig({ enabled: true, syncInterval: 0 });
      const credential = createCredential();

      const instance = new ConfigInstance(mockApp as unknown as App, config, credential, shared);

      expect(instance.isSchedulerActive()).toBe(false);

      instance.destroy();
    });

    it('should NOT start scheduler when config is disabled', () => {
      const config = createConfig({ enabled: false, syncInterval: 5 });
      const credential = createCredential();

      const instance = new ConfigInstance(mockApp as unknown as App, config, credential, shared);

      expect(instance.isSchedulerActive()).toBe(false);

      instance.destroy();
    });

    it('should enqueue from-airtable sync on scheduler tick', () => {
      const config = createConfig({ enabled: true, syncInterval: 1 });
      const credential = createCredential();

      const instance = new ConfigInstance(mockApp as unknown as App, config, credential, shared);
      const syncQueueInstance = vi.mocked(SyncQueue).mock.instances[0];

      vi.advanceTimersByTime(60_000);

      expect(syncQueueInstance.enqueue).toHaveBeenCalledWith('from-airtable', 'all');

      instance.destroy();
    });
  });

  describe('RateLimiter sharing', () => {
    it('should create new RateLimiter for new credential', () => {
      const config = createConfig();
      const credential = createCredential({ id: 'cred-new' });

      expect(shared.rateLimiters.size).toBe(0);

      const instance = new ConfigInstance(mockApp as unknown as App, config, credential, shared);

      expect(shared.rateLimiters.has('cred-new')).toBe(true);
      expect(shared.rateLimiters.size).toBe(1);

      instance.destroy();
    });

    it('should reuse existing RateLimiter for same credential', () => {
      const existingLimiter = new RateLimiter();
      shared.rateLimiters.set('cred-1', existingLimiter);

      const config = createConfig({ credentialId: 'cred-1' });
      const credential = createCredential({ id: 'cred-1' });

      const instance = new ConfigInstance(mockApp as unknown as App, config, credential, shared);

      // Should still be 1 entry — the existing one was reused
      expect(shared.rateLimiters.size).toBe(1);
      // AirtableClient should receive the existing limiter
      const rateLimiterArg = vi.mocked(AirtableClient).mock.calls[0][1];
      expect(rateLimiterArg).toBe(existingLimiter);

      instance.destroy();
    });

    it('should share RateLimiter between two configs with same credential', () => {
      const config1 = createConfig({ id: 'cfg-1', credentialId: 'cred-shared' });
      const config2 = createConfig({ id: 'cfg-2', credentialId: 'cred-shared' });
      const credential = createCredential({ id: 'cred-shared' });

      const instance1 = new ConfigInstance(mockApp as unknown as App, config1, credential, shared);
      const instance2 = new ConfigInstance(mockApp as unknown as App, config2, credential, shared);

      expect(shared.rateLimiters.size).toBe(1);

      const limiter1 = vi.mocked(AirtableClient).mock.calls[0][1];
      const limiter2 = vi.mocked(AirtableClient).mock.calls[1][1];
      expect(limiter1).toBe(limiter2);

      instance1.destroy();
      instance2.destroy();
    });
  });

  describe('destroy', () => {
    it('should stop scheduler on destroy', () => {
      const config = createConfig({ enabled: true, syncInterval: 5 });
      const credential = createCredential();

      const instance = new ConfigInstance(mockApp as unknown as App, config, credential, shared);
      expect(instance.isSchedulerActive()).toBe(true);

      instance.destroy();
      expect(instance.isSchedulerActive()).toBe(false);
    });

    it('should teardown fileWatcher on destroy', () => {
      const config = createConfig({ enabled: true });
      const credential = createCredential();

      const instance = new ConfigInstance(mockApp as unknown as App, config, credential, shared);
      const fileWatcherInstance = vi.mocked(FileWatcher).mock.instances[0];

      instance.destroy();

      expect(fileWatcherInstance.teardown).toHaveBeenCalled();
    });
  });

  describe('updateSettings', () => {
    it('should propagate updated settings to all services', () => {
      const config = createConfig({ enabled: true });
      const credential = createCredential();

      const instance = new ConfigInstance(mockApp as unknown as App, config, credential, shared);

      const airtableInstance = vi.mocked(AirtableClient).mock.instances[0];
      const conflictInstance = vi.mocked(ConflictResolver).mock.instances[0];
      const orchestratorInstance = vi.mocked(SyncOrchestrator).mock.instances[0];
      const fileWatcherInstance = vi.mocked(FileWatcher).mock.instances[0];

      const updatedConfig = createConfig({ enabled: true, folderPath: 'NewFolder' });
      const updatedCredential = createCredential({ apiKey: 'pat-updated' });

      instance.updateSettings(updatedConfig, updatedCredential);

      expect(airtableInstance.updateSettings).toHaveBeenCalled();
      expect(conflictInstance.updateSettings).toHaveBeenCalled();
      expect(orchestratorInstance.updateSettings).toHaveBeenCalled();
      expect(fileWatcherInstance.teardown).toHaveBeenCalled();
      expect(fileWatcherInstance.updateSettings).toHaveBeenCalled();
      expect(fileWatcherInstance.setup).toHaveBeenCalled();

      instance.destroy();
    });

    it('should restart scheduler on settings update', () => {
      const config = createConfig({ enabled: true, syncInterval: 5 });
      const credential = createCredential();

      const instance = new ConfigInstance(mockApp as unknown as App, config, credential, shared);
      expect(instance.isSchedulerActive()).toBe(true);

      const updatedConfig = createConfig({ enabled: true, syncInterval: 0 });
      instance.updateSettings(updatedConfig, credential);
      expect(instance.isSchedulerActive()).toBe(false);

      const reenabledConfig = createConfig({ enabled: true, syncInterval: 10 });
      instance.updateSettings(reenabledConfig, credential);
      expect(instance.isSchedulerActive()).toBe(true);

      instance.destroy();
    });
  });

  describe('enqueueSyncRequest', () => {
    it('should delegate to syncQueue.enqueue', () => {
      const config = createConfig({ enabled: true });
      const credential = createCredential();

      const instance = new ConfigInstance(mockApp as unknown as App, config, credential, shared);
      const syncQueueInstance = vi.mocked(SyncQueue).mock.instances[0];

      instance.enqueueSyncRequest('from-airtable', 'all');

      expect(syncQueueInstance.enqueue).toHaveBeenCalledWith('from-airtable', 'all', undefined);

      instance.destroy();
    });

    it('should pass filePaths when provided', () => {
      const config = createConfig({ enabled: true });
      const credential = createCredential();

      const instance = new ConfigInstance(mockApp as unknown as App, config, credential, shared);
      const syncQueueInstance = vi.mocked(SyncQueue).mock.instances[0];

      instance.enqueueSyncRequest('to-airtable', 'modified', ['file1.md', 'file2.md']);

      expect(syncQueueInstance.enqueue).toHaveBeenCalledWith('to-airtable', 'modified', ['file1.md', 'file2.md']);

      instance.destroy();
    });
  });
});
