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

import { Plugin, normalizePath } from "obsidian";
import type { AutoNoteImporterSettings, ConfigEntry, SharedServices } from './types';
import { DEFAULT_SETTINGS, CREDENTIAL_TYPE_LABELS } from './types';
import { FieldCache, SeaTableMetadataCache, SupabaseMetadataCache } from './services';
import { ConfigManager } from './core';
import { FrontmatterParser } from './file-operations';
import { AutoNoteImporterSettingTab } from './ui';
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
  private commandFingerprint = '';

  async onload() {
    await this.loadSettings();
    this.initializeServices();
    this.registerCommands();
  }

  /**
   * Initializes ConfigManager and shared services.
   */
  private initializeServices(): void {
    this.fieldCache = new FieldCache();
    this.seatableMetadataCache = new SeaTableMetadataCache();
    this.supabaseMetadataCache = new SupabaseMetadataCache();

    const shared: SharedServices = {
      rateLimiters: new Map(),
      fieldCache: this.fieldCache,
      seatableMetadataCache: this.seatableMetadataCache,
      supabaseMetadataCache: this.supabaseMetadataCache,
      frontmatterParser: new FrontmatterParser(this.app),
      statusBarFactory: () => this.addStatusBarItem(),
      getDebugMode: () => this.settings.debugMode,
    };

    this.configManager = new ConfigManager(this.app, shared);
    this.configManager.initialize(this.settings.configs, this.settings.credentials);

    this.settingTab = new AutoNoteImporterSettingTab(
      this.app,
      this,
      this.fieldCache,
      this.seatableMetadataCache,
      this.supabaseMetadataCache,
    );
    this.addSettingTab(this.settingTab);
  }

  /**
   * Registers per-config commands for all configurations.
   */
  private registerCommands(): void {
    for (const config of this.settings.configs) {
      this.registerCommandsForConfig(config);
    }
    this.commandFingerprint = this.getCommandFingerprint();
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

    // Re-register for all current configs
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
        if (!checking) this.configManager.getInstance(configId)?.enqueueSyncRequest('pull', 'current');
        return true;
      },
    });

    this.addCommand({
      id: `sync-pull-all-${configId}`,
      name: `Sync all notes from ${providerLabel}${suffix}`,
      checkCallback: (checking) => {
        const cfg = findConfigById(this.settings, configId);
        if (!cfg?.enabled) return false;
        if (!checking) this.configManager.getInstance(configId)?.enqueueSyncRequest('pull', 'all');
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
        if (!checking) this.configManager.getInstance(configId)?.enqueueSyncRequest('push', 'current');
        return true;
      },
    });

    this.addCommand({
      id: `sync-push-modified-${configId}`,
      name: `Sync modified notes to ${providerLabel}${suffix}`,
      checkCallback: (checking) => {
        const cfg = findConfigById(this.settings, configId);
        if (!cfg?.enabled || !cfg.bidirectionalSync) return false;
        if (!checking) this.configManager.getInstance(configId)?.enqueueSyncRequest('push', 'modified');
        return true;
      },
    });

    this.addCommand({
      id: `sync-push-all-${configId}`,
      name: `Sync all notes to ${providerLabel}${suffix}`,
      checkCallback: (checking) => {
        const cfg = findConfigById(this.settings, configId);
        if (!cfg?.enabled || !cfg.bidirectionalSync) return false;
        if (!checking) this.configManager.getInstance(configId)?.enqueueSyncRequest('push', 'all');
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
        if (!checking) this.configManager.getInstance(configId)?.enqueueSyncRequest('bidirectional', 'current');
        return true;
      },
    });

    this.addCommand({
      id: `bidirectional-sync-modified-${configId}`,
      name: `Bidirectional sync modified notes with ${providerLabel}${suffix}`,
      checkCallback: (checking) => {
        const cfg = findConfigById(this.settings, configId);
        if (!cfg?.enabled || !cfg.bidirectionalSync) return false;
        if (!checking) this.configManager.getInstance(configId)?.enqueueSyncRequest('bidirectional', 'modified');
        return true;
      },
    });

    this.addCommand({
      id: `bidirectional-sync-all-${configId}`,
      name: `Bidirectional sync all notes with ${providerLabel}${suffix}`,
      checkCallback: (checking) => {
        const cfg = findConfigById(this.settings, configId);
        if (!cfg?.enabled || !cfg.bidirectionalSync) return false;
        if (!checking) this.configManager.getInstance(configId)?.enqueueSyncRequest('bidirectional', 'all');
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
