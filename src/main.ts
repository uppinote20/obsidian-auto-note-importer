/**
 * Auto Note Importer - Main Plugin Entry Point
 *
 * Orchestrates remote DatabaseProvider <-> Obsidian sync via ConfigManager and per-config service stacks.
 *
 * @handbook 4.2-sync-architecture
 * @handbook 9.2-service-initialization-order
 * @handbook 9.3-settings-update-pattern
 * @handbook 9.4-conditional-command-visibility
 * @tested e2e:tests/e2e/run-e2e.mjs
 */

import { Plugin, Notice, normalizePath } from "obsidian";
import type { AutoNoteImporterSettings, ConfigEntry, PendingConflict, SharedServices, SyncRunResult, SyncTrigger } from './types';
import { DEFAULT_SETTINGS, CREDENTIAL_TYPE_LABELS } from './types';
import { FieldCache, SeaTableMetadataCache, SupabaseMetadataCache, NotionSchemaCache, defaultRateLimiters } from './services';
import { ConfigManager, SyncStateStore } from './core';
import { FrontmatterParser } from './file-operations';
import { AutoNoteImporterSettingTab, ConflictResolutionModal } from './ui';
import type { ConflictGroup, ConflictModalHost } from './ui';
import { migrateSettings, hydrateConfigDefaults } from './utils/migration';
import { findCredentialForConfig, findConfigById, buildCredentialIndex } from './utils';

/**
 * Main plugin class for Auto Note Importer.
 */
export default class AutoNoteImporterPlugin extends Plugin {
  settings!: AutoNoteImporterSettings;
  private settingTab!: AutoNoteImporterSettingTab;

  configManager!: ConfigManager;
  fieldCache!: FieldCache;
  seatableMetadataCache!: SeaTableMetadataCache;
  supabaseMetadataCache!: SupabaseMetadataCache;
  notionSchemaCache!: NotionSchemaCache;
  private syncState!: SyncStateStore;
  private commandFingerprint = '';
  private conflictModal: ConflictResolutionModal | null = null;

  async onload() {
    await this.loadSettings();
    await this.initializeServices();
    this.registerCommands();
    this.registerVaultEvents();
  }

  /** Keeps queued conflicts pointing at existing notes. */
  private registerVaultEvents(): void {
    this.registerEvent(this.app.vault.on('delete', (file) => {
      if (this.syncState.removeConflictsForPath(file.path)) void this.syncState.flush();
    }));
    this.registerEvent(this.app.vault.on('rename', (file, oldPath) => {
      if (this.syncState.renameConflictPath(oldPath, file.path)) void this.syncState.flush();
    }));
  }

  /**
   * Initializes ConfigManager and shared services.
   */
  private async initializeServices(): Promise<void> {
    this.fieldCache = new FieldCache();
    this.seatableMetadataCache = new SeaTableMetadataCache();
    this.supabaseMetadataCache = new SupabaseMetadataCache();
    // NotionSchemaCache defaults to pacing via services/rate-limiter.ts's
    // `defaultRateLimiters` module map, keyed by credential.id — the SAME
    // map notion-credential-form.ts's module-singleton cache resolves
    // through. Using that map here too (instead of a fresh `new Map()`)
    // means settings-tab / credential-form traffic and sync traffic share
    // one RateLimiter per credential, keeping combined requests within the
    // per-credential budget (PR #125 Codex P2 / Claude Medium).
    this.notionSchemaCache = new NotionSchemaCache();

    const syncState = this.syncState = new SyncStateStore(this.app.vault.adapter, `${this.manifest.dir}/sync-state.json`);
    await syncState.load();

    const shared: SharedServices = {
      rateLimiters: defaultRateLimiters,
      fieldCache: this.fieldCache,
      seatableMetadataCache: this.seatableMetadataCache,
      supabaseMetadataCache: this.supabaseMetadataCache,
      notionSchemaCache: this.notionSchemaCache,
      frontmatterParser: new FrontmatterParser(this.app),
      syncState,
      statusBarFactory: () => this.addStatusBarItem(),
      getDebugMode: () => this.settings.debugMode,
      onRunComplete: (configId, trigger, result) => this.notifyRunComplete(configId, trigger, result),
    };

    syncState.retainConfigs(new Set(this.settings.configs.map(c => c.id)));
    await syncState.flush();

    this.configManager = new ConfigManager(this.app, shared);
    this.configManager.initialize(this.settings.configs, this.settings.credentials);

    this.settingTab = new AutoNoteImporterSettingTab(
      this.app,
      this,
      this.fieldCache,
      this.seatableMetadataCache,
      this.supabaseMetadataCache,
      this.notionSchemaCache,
    );
    this.addSettingTab(this.settingTab);
  }

  /**
   * Registers per-config commands for all configurations.
   */
  private registerCommands(): void {
    this.registerResolveCommand();
    for (const config of this.settings.configs) {
      this.registerCommandsForConfig(config);
    }
    this.commandFingerprint = this.getCommandFingerprint();
  }

  private registerResolveCommand(): void {
    this.addCommand({
      id: 'resolve-sync-conflicts',
      name: 'Resolve sync conflicts',
      checkCallback: (checking) => {
        if (!this.conflictGroups().some(g => g.conflicts.length > 0)) return false;
        if (!checking) this.openConflictModal();
        return true;
      },
    });
  }

  private getCommandFingerprint(credIndex?: Map<string, { type: string }>): string {
    const index = credIndex ?? buildCredentialIndex(this.settings);
    return this.settings.configs
      .map(c => {
        const credType = index.get(c.credentialId)?.type ?? '';
        return `${c.id}:${c.name}:${c.enabled}:${c.bidirectionalSync}:${credType}`;
      })
      .join('|');
  }

  /**
   * Unregisters all commands for a given config, then re-registers
   * commands for all current configs. Called when configs change
   * (add/delete/rename/enable/disable).
   */
  private reregisterAllCommands(): void {
    // Collect all config IDs that currently have commands registered
    const commandPrefix = this.manifest.id;
    // Obsidian's command registry is private API (not in the published
    // typings). Narrow to the shape we touch instead of `any`, matching the
    // codebase convention for private-API access.
    const commands = (this.app as unknown as {
      commands?: { commands?: Record<string, unknown> };
    }).commands?.commands;
    if (commands) {
      const registeredIds = Object.keys(commands).filter(
        id => id.startsWith(`${commandPrefix}:`) && id !== commandPrefix,
      );
      for (const fullId of registeredIds) {
        delete commands[fullId];
      }
    }

    // Re-register for all current configs (the sweep above also removed the global command)
    this.registerResolveCommand();
    for (const config of this.settings.configs) {
      this.registerCommandsForConfig(config);
    }
  }

  /**
   * Validates whether the active file belongs to the given config's folder.
   * Returns false (hiding the command) if no file is active or the file
   * is outside the config's folder.
   */
  private isActiveFileInConfigFolder(cfg: ConfigEntry): boolean {
    const activeFile = this.app.workspace.getActiveFile();
    if (!activeFile) return false;
    const folderPath = normalizePath(cfg.folderPath);
    if (folderPath && !activeFile.path.startsWith(folderPath + '/')) return false;
    return true;
  }

  /**
   * Surfaces a finished sync run's new conflicts: a user-triggered run opens
   * the resolution modal with them; an automatic run shows a clickable Notice.
   */
  private notifyRunComplete(configId: string, trigger: SyncTrigger, result: SyncRunResult): void {
    const n = result.newConflicts.length;
    if (n === 0) return;
    if (trigger === 'user') {
      this.openConflictModal(result.newConflicts.map(conflict => ({ configId, conflict })));
      return;
    }
    const config = findConfigById(this.settings, configId);
    const label = this.providerLabelFor(config);
    const notice = new Notice(`Auto Note Importer: ${n} sync conflict${n === 1 ? '' : 's'} with ${label} \u2014 click to resolve`, 10000);
    notice.noticeEl.addEventListener('click', () => {
      notice.hide();
      this.openConflictModal();
    });
  }

  private providerLabelFor(config: ConfigEntry | undefined): string {
    const credential = config && findCredentialForConfig(this.settings, config);
    return credential ? CREDENTIAL_TYPE_LABELS[credential.type] : 'remote';
  }

  /** Pending conflicts of configs that have a running instance, in settings order. */
  private conflictGroups(): ConflictGroup[] {
    const groups: ConflictGroup[] = [];
    for (const config of this.settings.configs) {
      if (!this.configManager.getInstance(config.id)) continue;
      const conflicts = this.syncState.forConfig(config.id).pendingConflicts();
      if (conflicts.length === 0) continue;
      groups.push({
        configId: config.id,
        configName: config.name,
        providerLabel: this.providerLabelFor(config),
        bidirectional: config.bidirectionalSync,
        conflicts,
      });
    }
    return groups;
  }

  private readonly conflictHost: ConflictModalHost = {
    getGroups: () => this.conflictGroups(),
    apply: async (configId, choices) => {
      const instance = this.configManager.getInstance(configId);
      if (!instance) {
        return {
          applied: 0, stale: [], removed: [],
          failed: choices.map(({ conflict }) => ({ conflict, error: 'This config is disabled or has no credential' })),
        };
      }
      return instance.applyConflicts(choices);
    },
  };

  /**
   * Opens the resolution modal (all pending conflicts, or just `only`). An
   * already-open modal takes the new entries instead of stacking a second one.
   */
  private openConflictModal(only?: Array<{ configId: string; conflict: PendingConflict }>): void {
    if (this.conflictModal) {
      this.conflictModal.show(only);
      return;
    }
    const modal = new ConflictResolutionModal(this.app, this.conflictHost, only, () => {
      if (this.conflictModal === modal) this.conflictModal = null;
    });
    this.conflictModal = modal;
    modal.open();
  }

  /**
   * Registers sync commands for a single config entry.
   * Configs with an orphaned credentialId register no commands; they recover
   * automatically when a credential is linked (fingerprint changes → re-register).
   */
  private registerCommandsForConfig(config: ConfigEntry): void {
    const configId = config.id;
    const credential = findCredentialForConfig(this.settings, config);
    if (!credential) return;
    const providerLabel = CREDENTIAL_TYPE_LABELS[credential.type];
    const suffix = ` \u2014 ${config.name}`;

    this.addCommand({
      id: `sync-pull-${configId}`,
      name: `Sync current note from ${providerLabel}${suffix}`,
      checkCallback: (checking) => {
        const cfg = findConfigById(this.settings, configId);
        if (!cfg?.enabled) return false;
        if (!this.isActiveFileInConfigFolder(cfg)) return false;
        if (!checking) void this.configManager.getInstance(configId)?.enqueueSyncRequest('pull', 'current', undefined, 'user');
        return true;
      },
    });

    this.addCommand({
      id: `sync-pull-all-${configId}`,
      name: `Sync all notes from ${providerLabel}${suffix}`,
      checkCallback: (checking) => {
        const cfg = findConfigById(this.settings, configId);
        if (!cfg?.enabled) return false;
        if (!checking) void this.configManager.getInstance(configId)?.enqueueSyncRequest('pull', 'all', undefined, 'user');
        return true;
      },
    });

    this.addCommand({
      id: `sync-push-current-${configId}`,
      name: `Sync current note to ${providerLabel}${suffix}`,
      checkCallback: (checking) => {
        const cfg = findConfigById(this.settings, configId);
        if (!cfg?.enabled || !cfg.bidirectionalSync) return false;
        if (!this.isActiveFileInConfigFolder(cfg)) return false;
        if (!checking) void this.configManager.getInstance(configId)?.enqueueSyncRequest('push', 'current', undefined, 'user');
        return true;
      },
    });

    this.addCommand({
      id: `sync-push-modified-${configId}`,
      name: `Sync modified notes to ${providerLabel}${suffix}`,
      checkCallback: (checking) => {
        const cfg = findConfigById(this.settings, configId);
        if (!cfg?.enabled || !cfg.bidirectionalSync) return false;
        if (!checking) void this.configManager.getInstance(configId)?.enqueueSyncRequest('push', 'modified', undefined, 'user');
        return true;
      },
    });

    this.addCommand({
      id: `sync-push-all-${configId}`,
      name: `Sync all notes to ${providerLabel}${suffix}`,
      checkCallback: (checking) => {
        const cfg = findConfigById(this.settings, configId);
        if (!cfg?.enabled || !cfg.bidirectionalSync) return false;
        if (!checking) void this.configManager.getInstance(configId)?.enqueueSyncRequest('push', 'all', undefined, 'user');
        return true;
      },
    });

    this.addCommand({
      id: `bidirectional-sync-current-${configId}`,
      name: `Bidirectional sync current note with ${providerLabel}${suffix}`,
      checkCallback: (checking) => {
        const cfg = findConfigById(this.settings, configId);
        if (!cfg?.enabled || !cfg.bidirectionalSync) return false;
        if (!this.isActiveFileInConfigFolder(cfg)) return false;
        if (!checking) void this.configManager.getInstance(configId)?.enqueueSyncRequest('bidirectional', 'current', undefined, 'user');
        return true;
      },
    });

    this.addCommand({
      id: `bidirectional-sync-modified-${configId}`,
      name: `Bidirectional sync modified notes with ${providerLabel}${suffix}`,
      checkCallback: (checking) => {
        const cfg = findConfigById(this.settings, configId);
        if (!cfg?.enabled || !cfg.bidirectionalSync) return false;
        if (!checking) void this.configManager.getInstance(configId)?.enqueueSyncRequest('bidirectional', 'modified', undefined, 'user');
        return true;
      },
    });

    this.addCommand({
      id: `bidirectional-sync-all-${configId}`,
      name: `Bidirectional sync all notes with ${providerLabel}${suffix}`,
      checkCallback: (checking) => {
        const cfg = findConfigById(this.settings, configId);
        if (!cfg?.enabled || !cfg.bidirectionalSync) return false;
        if (!checking) void this.configManager.getInstance(configId)?.enqueueSyncRequest('bidirectional', 'all', undefined, 'user');
        return true;
      },
    });
  }

  async loadSettings(): Promise<void> {
    const data = await this.loadData();
    const migrated = migrateSettings(data);

    if (migrated) {
      this.settings = migrated;
      await this.saveData(this.settings);
    } else {
      // Shallow merge only fills top-level keys; per-config hydration covers
      // ConfigEntry fields added in newer plugin versions that the user's
      // saved settings don't yet have (migrateSettings returns null when
      // version already matches CURRENT_VERSION). See PR #97.
      const merged = Object.assign({}, DEFAULT_SETTINGS, data) as AutoNoteImporterSettings;
      this.settings = hydrateConfigDefaults(merged);
    }
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);

    // Remove instances for deleted configs or configs with missing credentials
    const currentIds = new Set(this.settings.configs.map(c => c.id));
    for (const instance of this.configManager.getAllEnabled()) {
      if (!currentIds.has(instance.configId)) {
        this.configManager.removeConfig(instance.configId);
      }
    }

    this.syncState.retainConfigs(new Set(this.settings.configs.map(c => c.id)));
    await this.syncState.flush();

    const credIndex = buildCredentialIndex(this.settings);
    for (const config of this.settings.configs) {
      const credential = credIndex.get(config.credentialId);
      if (credential) {
        this.configManager.updateConfig(config.id, config, credential);
      } else {
        this.configManager.removeConfig(config.id);
      }
    }

    const newFingerprint = this.getCommandFingerprint(credIndex);
    if (this.commandFingerprint !== newFingerprint) {
      this.commandFingerprint = newFingerprint;
      this.reregisterAllCommands();
    }
  }

  onunload(): void {
    this.configManager?.destroy();
  }
}
