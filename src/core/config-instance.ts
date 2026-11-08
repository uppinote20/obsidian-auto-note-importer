/**
 * ConfigInstance owns the full service stack for one config entry.
 *
 * Creates and manages: DatabaseProvider, FileWatcher, SyncOrchestrator,
 * SyncQueue, and a per-config sync scheduler. Sync snapshots come from the
 * shared SyncStateStore (scoped to this config id).
 *
 * @handbook 9.2-service-initialization-order
 * @tested tests/core/config-instance.test.ts
 * @tested e2e:tests/e2e/run-e2e.mjs
 * @tested e2e:tests/e2e/run-seatable-e2e.mjs
 * @tested e2e:tests/e2e/run-supabase-e2e.mjs
 */

import type { App } from "obsidian";
import { Notice } from "obsidian";
import type {
  LegacySettings,
  SyncMode,
  SyncScope,
  SyncTrigger,
  ConfigEntry,
  Credential,
  SharedServices,
  DatabaseProvider,
  PendingConflict,
} from '../types';
import { RateLimiter, createProvider, getOrCreateRateLimiter as getOrCreateSharedRateLimiter } from '../services';
import { SyncQueue, SyncOrchestrator } from '../core';
import type { StatusBarController, StatusBarHandle } from './sync-orchestrator';
import { ConflictApplier } from './conflict-applier';
import type { ApplyResult, ConflictChoice } from './conflict-applier';
import { FileWatcher } from '../file-operations';
import { buildLegacySettings } from '../utils';

/**
 * Manages the full service stack for a single configuration entry.
 */
export class ConfigInstance {
  readonly configId: string;
  credentialId: string;

  /**
   * The credential type this instance was constructed for. ConfigManager
   * compares against the new credential's type on update; when they differ
   * the instance is destroyed and re-created so a SeaTable→Airtable swap
   * doesn't try to `reconfigure()` a SeaTableClient with an Airtable cred.
   * Exposed as a field rather than a getter so unit-test mocks can leave
   * it `undefined` and rely on ConfigManager's truthy guard.
   */
  readonly providerType: DatabaseProvider['providerType'];

  private app: App;
  private shared: SharedServices;
  private settings: LegacySettings;

  private rateLimiter: RateLimiter;
  private databaseProvider: DatabaseProvider;
  private fileWatcher: FileWatcher;
  private syncOrchestrator: SyncOrchestrator;
  private syncQueue: SyncQueue;

  private schedulerIntervalId: number | null = null;

  constructor(app: App, config: ConfigEntry, credential: Credential, shared: SharedServices) {
    this.configId = config.id;
    this.credentialId = credential.id;
    this.app = app;
    this.shared = shared;
    this.settings = buildLegacySettings(config, credential, shared.getDebugMode());

    // 1. Get or create RateLimiter (shared per credential)
    this.rateLimiter = this.getOrCreateRateLimiter(credential);

    // 2. Create DatabaseProvider via registry (based on credential.type)
    this.databaseProvider = createProvider(
      credential,
      config,
      this.rateLimiter,
      shared.getDebugMode(),
      shared,
    );
    this.providerType = this.databaseProvider.providerType;

    // 3. Create FileWatcher (callback captures syncQueue via closure — safe because
    //    setup() is called after syncQueue is assigned, and callbacks fire asynchronously)
    this.fileWatcher = new FileWatcher(
      this.app,
      this.settings,
      async (files) => {
        const mode: SyncMode = this.settings.autoSyncComputedFields ? 'bidirectional' : 'push';
        await this.syncQueue.enqueue(mode, 'modified', files.map(f => f.path), 'auto');
      }
    );

    // 4. Create SyncOrchestrator
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
      this.shared.syncState.forConfig(config.id),
      statusBar,
    );

    // 5. Create SyncQueue
    this.syncQueue = new SyncQueue(
      // A throw skips onRunComplete and reaches the queue's onError instead.
      async ({ mode, scope, filePaths, trigger }) => {
        const result = await this.syncOrchestrator.processSyncRequest(mode, scope, filePaths, trigger);
        this.shared.onRunComplete(this.configId, trigger, result);
      },
      (error) => {
        const message = error instanceof Error ? error.message : 'Unknown error';
        new Notice(`Auto Note Importer: Sync failed: ${message}`);
      }
    );

    // 6. Setup file watcher and scheduler if enabled
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
   * Enqueues a sync request for this config's queue. Returns a promise
   * that resolves once the request has been fully processed by the queue,
   * so callers (e.g. e2e harnesses) can await completion. UI callers
   * that want fire-and-forget behavior can simply ignore the return.
   */
  enqueueSyncRequest(
    mode: SyncMode,
    scope: SyncScope,
    filePaths?: string[],
    trigger: SyncTrigger = 'user',
  ): Promise<void> {
    return this.syncQueue.enqueue(mode, scope, filePaths, trigger);
  }

  /**
   * Applier for this config's queued conflicts. Built per use so it sees the
   * current `bidirectionalSync` setting and provider.
   */
  createConflictApplier(): ConflictApplier {
    return new ConflictApplier(
      this.app,
      this.shared.syncState.forConfig(this.configId),
      this.databaseProvider,
      this.shared.frontmatterParser,
      this.settings.bidirectionalSync && this.databaseProvider.capabilities.bidirectional,
    );
  }

  /**
   * Applies conflict choices on this config's sync queue, so an Apply never
   * interleaves with a running sync (it waits for in-flight and queued runs).
   */
  applyConflicts(choices: Array<{ conflict: PendingConflict; choice: ConflictChoice }>): Promise<ApplyResult> {
    return this.syncQueue.runExclusive(() => this.createConflictApplier().apply(choices));
  }

  /**
   * Updates all services with new config and credential.
   */
  updateSettings(config: ConfigEntry, credential: Credential): void {
    this.credentialId = credential.id;
    this.settings = buildLegacySettings(config, credential, this.shared.getDebugMode());

    // Update RateLimiter if credential changed
    const newRateLimiter = this.getOrCreateRateLimiter(credential);
    if (newRateLimiter !== this.rateLimiter) {
      this.rateLimiter = newRateLimiter;
    }
    this.rateLimiter.setDebugMode(this.shared.getDebugMode());

    // Propagate settings to all services
    this.databaseProvider.reconfigure(credential, config, this.rateLimiter, this.shared.getDebugMode());
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
   * Uses the credential's per-type interval override (e.g. Notion's
   * tighter 334ms) when one exists, falling back to the shared default.
   */
  private getOrCreateRateLimiter(credential: Credential): RateLimiter {
    return getOrCreateSharedRateLimiter(this.shared.rateLimiters, credential, this.shared.getDebugMode());
  }

  /**
   * Starts the periodic sync scheduler if interval > 0.
   */
  private startScheduler(config: ConfigEntry): void {
    if (config.syncInterval > 0) {
      this.schedulerIntervalId = window.setInterval(
        () => { void this.syncQueue.enqueue('pull', 'all', undefined, 'auto'); },
        config.syncInterval * 60 * 1000,
      );
    }
  }

  /**
   * Stops the periodic sync scheduler.
   */
  private stopScheduler(): void {
    if (this.schedulerIntervalId !== null) {
      window.clearInterval(this.schedulerIntervalId);
      this.schedulerIntervalId = null;
    }
  }
}
