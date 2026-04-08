/**
 * Auto Note Importer - Main Plugin Entry Point
 *
 * Orchestrates Airtable <-> Obsidian sync via ConfigManager and per-config service stacks.
 *
 * @handbook 4.2-sync-architecture
 * @handbook 9.2-service-initialization-order
 * @handbook 9.3-settings-update-pattern
 * @handbook 9.4-conditional-command-visibility
 * @tested e2e:tests/e2e/run-e2e.mjs
 */

import { Plugin, normalizePath } from "obsidian";
import type { AutoNoteImporterSettings, ConfigEntry, SharedServices } from './types';
import { DEFAULT_SETTINGS } from './types';
import { FieldCache } from './services';
import { ConfigManager } from './core';
import { FrontmatterParser } from './file-operations';
import { AutoNoteImporterSettingTab } from './ui';
import { migrateSettings } from './utils/migration';

/**
 * Main plugin class for Auto Note Importer.
 */
export default class AutoNoteImporterPlugin extends Plugin {
  settings!: AutoNoteImporterSettings;
  private settingTab!: AutoNoteImporterSettingTab;

  configManager!: ConfigManager;
  fieldCache!: FieldCache;
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

    const shared: SharedServices = {
      rateLimiters: new Map(),
      fieldCache: this.fieldCache,
      frontmatterParser: new FrontmatterParser(this.app),
      statusBarFactory: () => this.addStatusBarItem(),
      getDebugMode: () => this.settings.debugMode,
    };

    this.configManager = new ConfigManager(this.app, shared);
    this.configManager.initialize(this.settings.configs, this.settings.credentials);

    this.settingTab = new AutoNoteImporterSettingTab(this.app, this, this.fieldCache);
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

  private getCommandFingerprint(): string {
    return this.settings.configs
      .map(c => `${c.id}:${c.name}:${c.enabled}:${c.bidirectionalSync}`)
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
    const commands = (this.app as any).commands?.commands;
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
   * Uses checkCallback with dynamic lookup to avoid capturing stale references.
   */
  private registerCommandsForConfig(config: ConfigEntry): void {
    const configId = config.id;
    const suffix = ` \u2014 ${config.name}`;

    // From Airtable commands
    this.addCommand({
      id: `sync-from-airtable-${configId}`,
      name: `Sync current note from Airtable${suffix}`,
      checkCallback: (checking) => {
        const cfg = this.settings.configs.find(c => c.id === configId);
        if (!cfg?.enabled) return false;
        if (!this.isActiveFileInConfigFolder(cfg)) return false;
        if (!checking) this.configManager.getInstance(configId)?.enqueueSyncRequest('from-airtable', 'current');
        return true;
      },
    });

    this.addCommand({
      id: `sync-all-from-airtable-${configId}`,
      name: `Sync all notes from Airtable${suffix}`,
      checkCallback: (checking) => {
        const cfg = this.settings.configs.find(c => c.id === configId);
        if (!cfg?.enabled) return false;
        if (!checking) this.configManager.getInstance(configId)?.enqueueSyncRequest('from-airtable', 'all');
        return true;
      },
    });

    // To Airtable commands (gated by bidirectionalSync)
    this.addCommand({
      id: `sync-current-to-airtable-${configId}`,
      name: `Sync current note to Airtable${suffix}`,
      checkCallback: (checking) => {
        const cfg = this.settings.configs.find(c => c.id === configId);
        if (!cfg?.enabled || !cfg.bidirectionalSync) return false;
        if (!this.isActiveFileInConfigFolder(cfg)) return false;
        if (!checking) this.configManager.getInstance(configId)?.enqueueSyncRequest('to-airtable', 'current');
        return true;
      },
    });

    this.addCommand({
      id: `sync-modified-to-airtable-${configId}`,
      name: `Sync modified notes to Airtable${suffix}`,
      checkCallback: (checking) => {
        const cfg = this.settings.configs.find(c => c.id === configId);
        if (!cfg?.enabled || !cfg.bidirectionalSync) return false;
        if (!checking) this.configManager.getInstance(configId)?.enqueueSyncRequest('to-airtable', 'modified');
        return true;
      },
    });

    this.addCommand({
      id: `sync-all-to-airtable-${configId}`,
      name: `Sync all notes to Airtable${suffix}`,
      checkCallback: (checking) => {
        const cfg = this.settings.configs.find(c => c.id === configId);
        if (!cfg?.enabled || !cfg.bidirectionalSync) return false;
        if (!checking) this.configManager.getInstance(configId)?.enqueueSyncRequest('to-airtable', 'all');
        return true;
      },
    });

    // Bidirectional commands
    this.addCommand({
      id: `bidirectional-sync-current-${configId}`,
      name: `Bidirectional sync current note${suffix}`,
      checkCallback: (checking) => {
        const cfg = this.settings.configs.find(c => c.id === configId);
        if (!cfg?.enabled || !cfg.bidirectionalSync) return false;
        if (!this.isActiveFileInConfigFolder(cfg)) return false;
        if (!checking) this.configManager.getInstance(configId)?.enqueueSyncRequest('bidirectional', 'current');
        return true;
      },
    });

    this.addCommand({
      id: `bidirectional-sync-modified-${configId}`,
      name: `Bidirectional sync modified notes${suffix}`,
      checkCallback: (checking) => {
        const cfg = this.settings.configs.find(c => c.id === configId);
        if (!cfg?.enabled || !cfg.bidirectionalSync) return false;
        if (!checking) this.configManager.getInstance(configId)?.enqueueSyncRequest('bidirectional', 'modified');
        return true;
      },
    });

    this.addCommand({
      id: `bidirectional-sync-all-${configId}`,
      name: `Bidirectional sync all notes${suffix}`,
      checkCallback: (checking) => {
        const cfg = this.settings.configs.find(c => c.id === configId);
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
      this.settings = Object.assign({}, DEFAULT_SETTINGS, data);
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

    for (const config of this.settings.configs) {
      const credential = this.settings.credentials.find(c => c.id === config.credentialId);
      if (credential) {
        this.configManager.updateConfig(config.id, config, credential);
      } else {
        this.configManager.removeConfig(config.id);
      }
    }

    const newFingerprint = this.getCommandFingerprint();
    if (this.commandFingerprint !== newFingerprint) {
      this.commandFingerprint = newFingerprint;
      this.reregisterAllCommands();
    }
  }

  onunload(): void {
    this.configManager?.destroy();
  }
}
