/**
 * ConfigInstance owns the full service stack for one config entry.
 *
 * Creates and manages: DatabaseProvider, FileWatcher, SyncOrchestrator,
 * SyncQueue, ConflictResolver, and a per-config sync scheduler.
 *
 * @handbook 9.2-service-initialization-order
 * @tested tests/core/config-instance.test.ts
 * @tested e2e:tests/e2e/run-e2e.mjs
 */

import type { App } from "obsidian";
import { Notice } from "obsidian";
import type {
  LegacySettings,
  SyncMode,
  SyncScope,
  ConfigEntry,
  Credential,
  SharedServices,
  DatabaseProvider,
} from '../types';
import { RateLimiter, createProvider } from '../services';
import { SyncQueue, ConflictResolver, SyncOrchestrator } from '../core';
import type { StatusBarController, StatusBarHandle } from './sync-orchestrator';
import { FileWatcher } from '../file-operations';

/**
 * Merges a ConfigEntry with credential and debug info to produce
 * an object structurally compatible with LegacySettings.
 *
 * Non-Airtable credentials do not populate the legacy `apiKey` field;
 * their providers resolve auth from the credential directly.
 */
function buildSettingsFromConfig(
  config: ConfigEntry,
  credential: Credential,
  debugMode: boolean,
): LegacySettings {
  const apiKey = credential.type === 'airtable' ? credential.apiKey : '';
  return {
    ...config,
    apiKey,
    debugMode,
  };
}

/**
 * Manages the full service stack for a single configuration entry.
 */
export class ConfigInstance {
  readonly configId: string;
  credentialId: string;

  private app: App;
  private shared: SharedServices;
  private settings: LegacySettings;

  private rateLimiter: RateLimiter;
  private databaseProvider: DatabaseProvider;
  private conflictResolver: ConflictResolver;
  private fileWatcher: FileWatcher;
  private syncOrchestrator: SyncOrchestrator;
  private syncQueue: SyncQueue;

  private schedulerIntervalId: ReturnType<typeof setInterval> | null = null;

  constructor(app: App, config: ConfigEntry, credential: Credential, shared: SharedServices) {
    this.configId = config.id;
    this.credentialId = credential.id;
    this.app = app;
    this.shared = shared;
    this.settings = buildSettingsFromConfig(config, credential, shared.getDebugMode());

    // 1. Get or create RateLimiter (shared per credential)
    this.rateLimiter = this.getOrCreateRateLimiter(credential.id);

    // 2. Create DatabaseProvider via registry (based on credential.type)
    this.databaseProvider = createProvider(
      credential,
      config,
      this.rateLimiter,
      shared.getDebugMode(),
    );

    // 3. Create ConflictResolver
    this.conflictResolver = new ConflictResolver(this.settings, this.databaseProvider);

    // 4. Create FileWatcher (callback captures syncQueue via closure — safe because
    //    setup() is called after syncQueue is assigned, and callbacks fire asynchronously)
    this.fileWatcher = new FileWatcher(
      this.app,
      this.settings,
      async (files) => {
        const mode: SyncMode = this.settings.autoSyncFormulas ? 'bidirectional' : 'to-airtable';
        await this.syncQueue.enqueue(mode, 'modified', files.map(f => f.path));
      }
    );

    // 5. Create SyncOrchestrator
    const statusBar: StatusBarController = {
      createItem: (): StatusBarHandle => {
        const el = this.shared.statusBarFactory();
        return {
          setText(text: string) { el.textContent = text; },
          remove() { el.remove(); },
        };
      },
    };

    this.syncOrchestrator = new SyncOrchestrator(
      this.app,
      this.settings,
      this.databaseProvider,
      this.shared.fieldCache,
      this.shared.frontmatterParser,
      this.fileWatcher,
      this.conflictResolver,
      statusBar,
    );

    // 6. Create SyncQueue
    this.syncQueue = new SyncQueue(
      ({ mode, scope, filePaths }) => this.syncOrchestrator.processSyncRequest(mode, scope, filePaths),
      (error) => {
        const message = error instanceof Error ? error.message : 'Unknown error';
        new Notice(`Auto Note Importer: Sync failed: ${message}`);
      }
    );

    // 7. Setup file watcher and scheduler if enabled
    if (config.enabled) {
      this.fileWatcher.setup();
      this.startScheduler(config);
    }
  }

  /**
   * Returns whether the periodic sync scheduler is currently active.
   */
  isSchedulerActive(): boolean {
    return this.schedulerIntervalId !== null;
  }

  /**
   * Enqueues a sync request for this config's queue.
   */
  enqueueSyncRequest(mode: SyncMode, scope: SyncScope, filePaths?: string[]): void {
    this.syncQueue.enqueue(mode, scope, filePaths);
  }

  /**
   * Updates all services with new config and credential.
   */
  updateSettings(config: ConfigEntry, credential: Credential): void {
    this.credentialId = credential.id;
    this.settings = buildSettingsFromConfig(config, credential, this.shared.getDebugMode());

    // Update RateLimiter if credential changed
    const newRateLimiter = this.getOrCreateRateLimiter(credential.id);
    if (newRateLimiter !== this.rateLimiter) {
      this.rateLimiter = newRateLimiter;
    }
    this.rateLimiter.setDebugMode(this.shared.getDebugMode());

    // Propagate settings to all services
    this.databaseProvider.reconfigure(credential, config, this.shared.getDebugMode());
    this.conflictResolver.updateSettings(this.settings);
    this.syncOrchestrator.updateSettings(this.settings);

    // Reconfigure file watcher
    this.fileWatcher.teardown();
    this.fileWatcher.updateSettings(this.settings);
    if (config.enabled) {
      this.fileWatcher.setup();
    }

    // Restart scheduler
    this.stopScheduler();
    if (config.enabled) {
      this.startScheduler(config);
    }
  }

  /**
   * Tears down all services and clears the scheduler.
   */
  destroy(): void {
    this.stopScheduler();
    this.fileWatcher.teardown();
  }

  /**
   * Gets or creates a shared RateLimiter for the given credential.
   */
  private getOrCreateRateLimiter(credentialId: string): RateLimiter {
    let limiter = this.shared.rateLimiters.get(credentialId);
    if (!limiter) {
      limiter = new RateLimiter();
      limiter.setDebugMode(this.shared.getDebugMode());
      this.shared.rateLimiters.set(credentialId, limiter);
    }
    return limiter;
  }

  /**
   * Starts the periodic sync scheduler if interval > 0.
   */
  private startScheduler(config: ConfigEntry): void {
    if (config.syncInterval > 0) {
      this.schedulerIntervalId = setInterval(
        () => this.syncQueue.enqueue('from-airtable', 'all'),
        config.syncInterval * 60 * 1000,
      );
    }
  }

  /**
   * Stops the periodic sync scheduler.
   */
  private stopScheduler(): void {
    if (this.schedulerIntervalId !== null) {
      clearInterval(this.schedulerIntervalId);
      this.schedulerIntervalId = null;
    }
  }
}
