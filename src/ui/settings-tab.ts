/**
 * Settings tab UI for the Auto Note Importer plugin.
 * UI-only - delegates API calls to FieldCache.
 *
 * Temporary bridge: reads/writes through activeConfig and activeCredential
 * helpers until Tasks 10-11 implement the full multi-config UI.
 *
 * @handbook 5.1-ui-components
 */

import { App, PluginSettingTab, Setting, Notice } from "obsidian";
import type { ExtraButtonComponent, Plugin } from "obsidian";
import { FieldCache } from '../services';
import { isFieldTypeSupported } from '../constants';
import type { AutoNoteImporterSettings, ConfigEntry, Credential, ConflictResolutionMode, BasesFileLocation } from '../types';
import { FolderSuggest, FileSuggest } from './suggest';

/**
 * Interface for the plugin that the settings tab needs.
 */
export interface SettingsPlugin extends Plugin {
  settings: AutoNoteImporterSettings;
  saveSettings(): Promise<void>;
}

/**
 * Settings tab for the Auto Note Importer plugin.
 */
export class AutoNoteImporterSettingTab extends PluginSettingTab {
  plugin: SettingsPlugin;
  private fieldCache: FieldCache;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(app: App, plugin: SettingsPlugin, fieldCache: FieldCache) {
    super(app, plugin);
    this.plugin = plugin;
    this.fieldCache = fieldCache;
  }

  /**
   * Returns the active config entry, or undefined if none exists.
   */
  private get activeConfig(): ConfigEntry | undefined {
    const { activeConfigId, configs } = this.plugin.settings;
    return configs.find(c => c.id === activeConfigId) ?? configs[0];
  }

  /**
   * Returns the credential for the active config, or undefined.
   */
  private get activeCredential(): Credential | undefined {
    const config = this.activeConfig;
    if (!config) return undefined;
    return this.plugin.settings.credentials.find(c => c.id === config.credentialId);
  }

  private debounceDisplay(delay = 100): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(() => {
      this.display();
    }, delay);
  }

  private configureRefreshButton(button: ExtraButtonComponent, tooltip: string, clearCache: () => void): ExtraButtonComponent {
    return button
      .setIcon("refresh-cw")
      .setTooltip(tooltip)
      .onClick(() => {
        clearCache();
        this.debounceDisplay();
      });
  }

  hide(): void {
    super.hide();
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    const config = this.activeConfig;
    const credential = this.activeCredential;

    if (!config || !credential) {
      new Setting(containerEl)
        .setName('No configuration')
        .setDesc('Add a configuration to get started.');
      this.renderDebugSettings(containerEl);
      return;
    }

    // API Key setting
    new Setting(containerEl)
      .setName("Airtable personal access token")
      .setDesc("Enter your Airtable personal access token.")
      .addText(text => {
        text
          .setPlaceholder("your-pat-token")
          .setValue(credential.apiKey)
          .onChange(async (value) => {
            credential.apiKey = value;
            await this.plugin.saveSettings();
            this.debounceDisplay();
          });
        text.inputEl.type = 'password';
      });

    if (credential.apiKey) {
      this.renderBaseSelector(containerEl, config, credential);
    }

    // Folder path setting
    new Setting(containerEl)
      .setName("New file location")
      .setDesc("Example: folder1/folder2")
      .addText(text => {
        const input = text
          .setPlaceholder("Crawling")
          .setValue(config.folderPath)
          .onChange(async (value) => {
            config.folderPath = value;
            await this.plugin.saveSettings();
          });
        new FolderSuggest(this.app, input.inputEl as HTMLInputElement);
      });

    // Template path setting
    new Setting(containerEl)
      .setName("Template file")
      .setDesc("Example: templates/template-file.md")
      .addText(text => {
        const input = text
          .setPlaceholder("Templates/note-template.md")
          .setValue(config.templatePath)
          .onChange(async (value) => {
            config.templatePath = value;
            await this.plugin.saveSettings();
          });
        new FileSuggest(this.app, input.inputEl as HTMLInputElement);
      });

    this.renderNumberSetting(containerEl, "Sync interval (minutes)", "How often to sync notes (in minutes).", "0",
      config.syncInterval, "Sync interval",
      (num) => { config.syncInterval = num; });

    // Allow overwrite setting
    new Setting(containerEl)
      .setName("Allow overwrite existing notes")
      .setDesc("If enabled, existing notes will be overwritten when syncing.")
      .addToggle(toggle => toggle
        .setValue(config.allowOverwrite)
        .onChange(async (value) => {
          config.allowOverwrite = value;
          await this.plugin.saveSettings();
        }));

    // Bases database settings
    this.renderBasesSettings(containerEl, config);

    // Bidirectional sync settings
    this.renderBidirectionalSyncSettings(containerEl, config);

    // Debug settings
    this.renderDebugSettings(containerEl);
  }

  private renderBaseSelector(containerEl: HTMLElement, config: ConfigEntry, credential: Credential): void {
    new Setting(containerEl)
      .setName("Select base")
      .setDesc("Choose the Airtable base you want to import notes from.")
      .addDropdown(async dropdown => {
        try {
          dropdown.addOption("", "-- Select base. --");
          const bases = await this.fieldCache.fetchBases(credential.apiKey);
          for (const base of bases) {
            dropdown.addOption(base.id, base.name);
          }
          dropdown.setValue(config.baseId);
          dropdown.onChange(async (value) => {
            config.baseId = value;
            config.tableId = "";
            config.viewId = "";
            await this.plugin.saveSettings();
            this.debounceDisplay();
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Check PAT or network.';
          new Notice(`Auto Note Importer: Failed to fetch Airtable bases. ${message}`);
        }
      })
      .addExtraButton(button => this.configureRefreshButton(button, "Refresh base list", () => {
        this.fieldCache.clearBases();
      }));

    if (config.baseId) {
      this.renderTableSelector(containerEl, config, credential);
    }
  }

  private renderTableSelector(containerEl: HTMLElement, config: ConfigEntry, credential: Credential): void {
    new Setting(containerEl)
      .setName("Select table")
      .setDesc("Choose the specific table within the selected base.")
      .addDropdown(async dropdown => {
        try {
          dropdown.addOption("", "-- Select table --");
          const tables = await this.fieldCache.fetchTables(
            credential.apiKey,
            config.baseId
          );
          for (const table of tables) {
            dropdown.addOption(table.id, table.name);
          }
          dropdown.setValue(config.tableId);
          dropdown.onChange(async (value) => {
            config.tableId = value;
            config.viewId = "";
            await this.plugin.saveSettings();
            this.debounceDisplay();
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Check base ID or network.';
          new Notice(`Auto Note Importer: Failed to fetch Airtable tables. ${message}`);
        }
      })
      .addExtraButton(button => this.configureRefreshButton(button, "Refresh table list", () => {
        this.fieldCache.clearTables(config.baseId);
      }));

    if (config.tableId) {
      this.renderViewSelector(containerEl, config, credential);
      this.renderFieldSelectors(containerEl, config, credential);
    }
  }

  private renderViewSelector(containerEl: HTMLElement, config: ConfigEntry, credential: Credential): void {
    new Setting(containerEl)
      .setName("Select view (optional)")
      .setDesc("Filter synced records by an Airtable view. Leave empty to sync all records.")
      .addDropdown(async dropdown => {
        try {
          dropdown.addOption("", "-- All records (no view filter) --");
          const views = await this.fieldCache.fetchViews(
            credential.apiKey,
            config.baseId,
            config.tableId
          );
          for (const view of views) {
            dropdown.addOption(view.id, `${view.name} (${view.type})`);
          }
          dropdown.setValue(config.viewId);
          dropdown.onChange(async (value) => {
            config.viewId = value;
            await this.plugin.saveSettings();
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Check table ID or network.';
          new Notice(`Auto Note Importer: Failed to fetch views. ${message}`);
        }
      })
      .addExtraButton(button => this.configureRefreshButton(button, "Refresh view list", () => {
        this.fieldCache.clearViews(config.baseId, config.tableId);
      }));
  }

  private renderFieldSelectors(containerEl: HTMLElement, config: ConfigEntry, credential: Credential): void {
    this.renderFieldDropdown(containerEl, "Filename field", "Select the field to use for the note's filename.", "-- Select field --",
      config.filenameFieldName, (value) => { config.filenameFieldName = value; }, config, credential);

    this.renderFieldDropdown(containerEl, "Subfolder field", "Select the field to use for subfolder organization.", "-- No subfolder --",
      config.subfolderFieldName, (value) => { config.subfolderFieldName = value; }, config, credential);
  }

  private renderFieldDropdown(
    containerEl: HTMLElement,
    name: string,
    desc: string,
    placeholder: string,
    currentValue: string,
    onSelect: (value: string) => void,
    config: ConfigEntry,
    credential: Credential
  ): void {
    new Setting(containerEl)
      .setName(name)
      .setDesc(desc)
      .addDropdown(async dropdown => {
        try {
          dropdown.addOption("", placeholder);
          const fields = await this.fieldCache.fetchFields(
            credential.apiKey,
            config.baseId,
            config.tableId
          );

          const supportedFields = fields.filter(field => isFieldTypeSupported(field.type));
          const unsupportedCount = fields.length - supportedFields.length;

          for (const field of supportedFields) {
            dropdown.addOption(field.name, `${field.name} (${field.type})`);
          }

          if (unsupportedCount > 0) {
            dropdown.addOption("", `--- ${unsupportedCount} unsupported field${unsupportedCount > 1 ? 's' : ''} hidden ---`);
          }

          dropdown.setValue(currentValue);
          dropdown.onChange(async (value) => {
            onSelect(value);
            await this.plugin.saveSettings();
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Check table ID or network.';
          new Notice(`Auto Note Importer: Failed to fetch table fields. ${message}`);
        }
      })
      .addExtraButton(button => this.configureRefreshButton(button, "Refresh field list", () => {
        this.fieldCache.clearFields(config.baseId, config.tableId);
      }));
  }

  private renderBasesSettings(containerEl: HTMLElement, config: ConfigEntry): void {
    new Setting(containerEl).setName('Bases database').setHeading();

    new Setting(containerEl)
      .setName('Auto-generate Bases database file')
      .setDesc('Create a .base file after sync for table/card view in Obsidian Bases.')
      .addToggle(toggle => toggle
        .setValue(config.generateBasesFile)
        .onChange(async (value) => {
          config.generateBasesFile = value;
          await this.plugin.saveSettings();
          this.debounceDisplay();
        }));

    if (config.generateBasesFile) {
      new Setting(containerEl)
        .setName('Database file location')
        .setDesc('Where to create the .base file.')
        .addDropdown(dropdown => dropdown
          .addOption('vault-root', 'Vault root')
          .addOption('synced-folder', 'Inside synced folder')
          .addOption('custom', 'Custom path')
          .setValue(config.basesFileLocation)
          .onChange(async (value) => {
            config.basesFileLocation = value as BasesFileLocation;
            await this.plugin.saveSettings();
            this.debounceDisplay();
          }));

      if (config.basesFileLocation === 'custom') {
        new Setting(containerEl)
          .setName('Custom path')
          .setDesc('Folder path for the .base file. Leave empty to use vault root.')
          .addText(text => {
            const input = text
              .setPlaceholder('Bases')
              .setValue(config.basesCustomPath)
              .onChange(async (value) => {
                config.basesCustomPath = value;
                await this.plugin.saveSettings();
              });
            new FolderSuggest(this.app, input.inputEl as HTMLInputElement);
          });
      }

      new Setting(containerEl)
        .setName('Regenerate on each sync')
        .setDesc('Recreate .base file on every sync. Disable to preserve manual edits.')
        .addToggle(toggle => toggle
          .setValue(config.basesRegenerateOnSync)
          .onChange(async (value) => {
            config.basesRegenerateOnSync = value;
            await this.plugin.saveSettings();
          }));
    }
  }

  private renderBidirectionalSyncSettings(containerEl: HTMLElement, config: ConfigEntry): void {
    new Setting(containerEl).setName('Bidirectional sync').setHeading();

    new Setting(containerEl)
      .setName("Enable bidirectional sync")
      .setDesc("When enabled, changes made in Obsidian will be synced back to Airtable.")
      .addToggle(toggle => toggle
        .setValue(config.bidirectionalSync)
        .onChange(async (value) => {
          config.bidirectionalSync = value;
          await this.plugin.saveSettings();
          this.debounceDisplay();
        }));

    if (config.bidirectionalSync) {
      new Setting(containerEl)
        .setName("Conflict resolution")
        .setDesc("How to handle conflicts when the same field is modified in both places.")
        .addDropdown(dropdown => dropdown
          .addOption('manual', 'Manual resolution (show conflicts)')
          .addOption('obsidian-wins', 'Obsidian wins (overwrite Airtable)')
          .addOption('airtable-wins', 'Airtable wins (overwrite Obsidian)')
          .setValue(config.conflictResolution)
          .onChange(async (value) => {
            config.conflictResolution = value as ConflictResolutionMode;
            await this.plugin.saveSettings();
          }));

      new Setting(containerEl)
        .setName("Watch for file changes")
        .setDesc("Automatically detect and sync changes made to notes in Obsidian.")
        .addToggle(toggle => toggle
          .setValue(config.watchForChanges)
          .onChange(async (value) => {
            config.watchForChanges = value;
            await this.plugin.saveSettings();
            this.debounceDisplay();
          }));

      if (config.watchForChanges) {
        this.renderNumberSetting(containerEl, "File watch debounce (milliseconds)",
          "How long to wait after a file change before triggering sync.", "2000",
          config.fileWatchDebounce, "Debounce time",
          (num) => { config.fileWatchDebounce = num; }, undefined, "500");
      }

      new Setting(containerEl)
        .setName("Auto-sync formulas and relations")
        .setDesc("Automatically fetch computed formula and relation results after syncing.")
        .addToggle(toggle => toggle
          .setValue(config.autoSyncFormulas)
          .onChange(async (value) => {
            config.autoSyncFormulas = value;
            await this.plugin.saveSettings();
            this.debounceDisplay();
          }));

      if (config.autoSyncFormulas) {
        this.renderNumberSetting(containerEl, "Formula sync delay (milliseconds)",
          "How long to wait for Airtable to compute formulas before fetching.", "1500",
          config.formulaSyncDelay, "Formula sync delay",
          (num) => { config.formulaSyncDelay = num; }, undefined, "100");
      }
    }
  }

  private renderNumberSetting(
    containerEl: HTMLElement,
    name: string,
    desc: string,
    placeholder: string,
    currentValue: number,
    label: string,
    onSet: (num: number) => void,
    postSave?: () => void,
    step?: string
  ): void {
    new Setting(containerEl)
      .setName(name)
      .setDesc(desc)
      .addText(text => {
        const input = text
          .setPlaceholder(placeholder)
          .setValue(currentValue.toString())
          .onChange(async (value) => {
            const num = Number(value);
            if (Number.isNaN(num) || num < 0) {
              new Notice(`Auto Note Importer: ${label} must be a positive number.`);
              return;
            }
            onSet(num);
            await this.plugin.saveSettings();
            postSave?.();
          });
        const el = input.inputEl as HTMLInputElement;
        el.type = "number";
        el.min = "0";
        if (step) el.step = step;
      });
  }

  private renderDebugSettings(containerEl: HTMLElement): void {
    new Setting(containerEl).setName('Debug').setHeading();

    new Setting(containerEl)
      .setName("Debug mode (slow sync)")
      .setDesc("Slows down all sync operations by 5x for easier testing and observation.")
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.debugMode)
        .onChange(async (value) => {
          this.plugin.settings.debugMode = value;
          await this.plugin.saveSettings();
        }));
  }
}
