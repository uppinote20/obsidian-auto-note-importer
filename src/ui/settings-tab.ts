/**
 * Settings tab UI for the Auto Note Importer plugin.
 * UI-only - delegates API calls to FieldCache.
 */

import { App, PluginSettingTab, Setting, Notice } from "obsidian";
import type { Plugin } from "obsidian";
import { FieldCache } from '../services';
import { isFieldTypeSupported } from '../constants';
import type { AutoNoteImporterSettings, ConflictResolutionMode } from '../types';
import { FolderSuggest, FileSuggest } from './suggest';

/**
 * Interface for the plugin that the settings tab needs.
 */
export interface SettingsPlugin extends Plugin {
  settings: AutoNoteImporterSettings;
  saveSettings(): Promise<void>;
  startScheduler(): void;
}

/**
 * Settings tab for the Auto Note Importer plugin.
 */
export class AutoNoteImporterSettingTab extends PluginSettingTab {
  plugin: SettingsPlugin;
  private fieldCache: FieldCache;
  private debounceTimer: NodeJS.Timeout | null = null;

  constructor(app: App, plugin: SettingsPlugin, fieldCache: FieldCache) {
    super(app, plugin);
    this.plugin = plugin;
    this.fieldCache = fieldCache;
  }

  /**
   * Gets the field cache instance.
   */
  getFieldCache(): FieldCache {
    return this.fieldCache;
  }

  /**
   * Gets cached fields for a specific base/table combination.
   */
  getCachedFields(cacheKey: string) {
    return this.fieldCache.getFields(cacheKey);
  }

  private debounceDisplay(delay = 100) {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(() => {
      this.display();
    }, delay);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    // API Key setting
    new Setting(containerEl)
      .setName("Airtable personal access token")
      .setDesc("Enter your Airtable personal access token.")
      .addText(text => {
        text
          .setPlaceholder("your-pat-token")
          .setValue(this.plugin.settings.apiKey)
          .onChange(async (value) => {
            this.plugin.settings.apiKey = value;
            await this.plugin.saveSettings();
            this.debounceDisplay();
          });
        text.inputEl.type = 'password';
      });

    if (this.plugin.settings.apiKey) {
      this.renderBaseSelector(containerEl);
    }

    // Folder path setting
    new Setting(containerEl)
      .setName("New file location")
      .setDesc("Example: folder1/folder2")
      .addText(text => {
        const input = text
          .setPlaceholder("Crawling")
          .setValue(this.plugin.settings.folderPath)
          .onChange(async (value) => {
            this.plugin.settings.folderPath = value;
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
          .setValue(this.plugin.settings.templatePath)
          .onChange(async (value) => {
            this.plugin.settings.templatePath = value;
            await this.plugin.saveSettings();
          });
        new FileSuggest(this.app, input.inputEl as HTMLInputElement);
      });

    // Sync interval setting
    new Setting(containerEl)
      .setName("Sync interval (minutes)")
      .setDesc("How often to sync notes (in minutes).")
      .addText(text => {
        const input = text
          .setPlaceholder("0")
          .setValue(this.plugin.settings.syncInterval.toString())
          .onChange(async (value) => {
            const num = Number(value);
            if (Number.isNaN(num) || num < 0) {
              new Notice("Auto Note Importer: Sync interval must be a positive number.");
              return;
            }
            this.plugin.settings.syncInterval = num;
            await this.plugin.saveSettings();
            this.plugin.startScheduler();
          });
        (input.inputEl as HTMLInputElement).type = "number";
        (input.inputEl as HTMLInputElement).min = "0";
      });

    // Allow overwrite setting
    new Setting(containerEl)
      .setName("Allow overwrite existing notes")
      .setDesc("If enabled, existing notes will be overwritten when syncing.")
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.allowOverwrite)
        .onChange(async (value) => {
          this.plugin.settings.allowOverwrite = value;
          await this.plugin.saveSettings();
        }));

    // Bidirectional sync settings
    this.renderBidirectionalSyncSettings(containerEl);
  }

  private renderBaseSelector(containerEl: HTMLElement): void {
    new Setting(containerEl)
      .setName("Select base")
      .setDesc("Choose the Airtable base you want to import notes from.")
      .addDropdown(async dropdown => {
        try {
          dropdown.addOption("", "-- Select base. --");
          const bases = await this.fieldCache.fetchBases(this.plugin.settings.apiKey);
          bases.forEach(base => {
            dropdown.addOption(base.id, base.name);
          });
          dropdown.setValue(this.plugin.settings.baseId);
          dropdown.onChange(async (value) => {
            this.plugin.settings.baseId = value;
            this.plugin.settings.tableId = "";
            await this.plugin.saveSettings();
            this.debounceDisplay();
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Check PAT or network.';
          new Notice(`Auto Note Importer: Failed to fetch Airtable bases. ${message}`);
        }
      });

    if (this.plugin.settings.baseId) {
      this.renderTableSelector(containerEl);
    }
  }

  private renderTableSelector(containerEl: HTMLElement): void {
    new Setting(containerEl)
      .setName("Select table")
      .setDesc("Choose the specific table within the selected base.")
      .addDropdown(async dropdown => {
        try {
          dropdown.addOption("", "-- Select table --");
          const tables = await this.fieldCache.fetchTables(
            this.plugin.settings.apiKey,
            this.plugin.settings.baseId
          );
          tables.forEach(table => {
            dropdown.addOption(table.id, table.name);
          });
          dropdown.setValue(this.plugin.settings.tableId);
          dropdown.onChange(async (value) => {
            this.plugin.settings.tableId = value;
            await this.plugin.saveSettings();
            this.debounceDisplay();
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Check base ID or network.';
          new Notice(`Auto Note Importer: Failed to fetch Airtable tables. ${message}`);
        }
      });

    if (this.plugin.settings.tableId) {
      this.renderFieldSelectors(containerEl);
    }
  }

  private renderFieldSelectors(containerEl: HTMLElement): void {
    // Filename field selector
    new Setting(containerEl)
      .setName("Filename field")
      .setDesc("Select the field to use for the note's filename.")
      .addDropdown(async dropdown => {
        try {
          dropdown.addOption("", "-- Select field --");
          const fields = await this.fieldCache.fetchFields(
            this.plugin.settings.apiKey,
            this.plugin.settings.baseId,
            this.plugin.settings.tableId
          );

          const supportedFields = fields.filter(field => isFieldTypeSupported(field.type));
          const unsupportedCount = fields.length - supportedFields.length;

          supportedFields.forEach(field => {
            dropdown.addOption(field.name, `${field.name} (${field.type})`);
          });

          if (unsupportedCount > 0) {
            dropdown.addOption("", `--- ${unsupportedCount} unsupported field${unsupportedCount > 1 ? 's' : ''} hidden ---`);
          }

          dropdown.setValue(this.plugin.settings.filenameFieldName);
          dropdown.onChange(async (value) => {
            this.plugin.settings.filenameFieldName = value;
            await this.plugin.saveSettings();
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Check table ID or network.';
          new Notice(`Auto Note Importer: Failed to fetch table fields. ${message}`);
        }
      });

    // Subfolder field selector
    new Setting(containerEl)
      .setName("Subfolder field")
      .setDesc("Select the field to use for subfolder organization.")
      .addDropdown(async dropdown => {
        try {
          dropdown.addOption("", "-- No subfolder --");
          const fields = await this.fieldCache.fetchFields(
            this.plugin.settings.apiKey,
            this.plugin.settings.baseId,
            this.plugin.settings.tableId
          );

          const supportedFields = fields.filter(field => isFieldTypeSupported(field.type));
          const unsupportedCount = fields.length - supportedFields.length;

          supportedFields.forEach(field => {
            dropdown.addOption(field.name, `${field.name} (${field.type})`);
          });

          if (unsupportedCount > 0) {
            dropdown.addOption("", `--- ${unsupportedCount} unsupported field${unsupportedCount > 1 ? 's' : ''} hidden ---`);
          }

          dropdown.setValue(this.plugin.settings.subfolderFieldName);
          dropdown.onChange(async (value) => {
            this.plugin.settings.subfolderFieldName = value;
            await this.plugin.saveSettings();
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Check table ID or network.';
          new Notice(`Auto Note Importer: Failed to fetch table fields. ${message}`);
        }
      });
  }

  private renderBidirectionalSyncSettings(containerEl: HTMLElement): void {
    new Setting(containerEl)
      .setName("Enable bidirectional sync")
      .setDesc("When enabled, changes made in Obsidian will be synced back to Airtable.")
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.bidirectionalSync)
        .onChange(async (value) => {
          this.plugin.settings.bidirectionalSync = value;
          await this.plugin.saveSettings();
          this.debounceDisplay();
        }));

    if (this.plugin.settings.bidirectionalSync) {
      new Setting(containerEl)
        .setName("Conflict resolution")
        .setDesc("How to handle conflicts when the same field is modified in both places.")
        .addDropdown(dropdown => dropdown
          .addOption('manual', 'Manual resolution (show conflicts)')
          .addOption('obsidian-wins', 'Obsidian wins (overwrite Airtable)')
          .addOption('airtable-wins', 'Airtable wins (overwrite Obsidian)')
          .setValue(this.plugin.settings.conflictResolution)
          .onChange(async (value: ConflictResolutionMode) => {
            this.plugin.settings.conflictResolution = value;
            await this.plugin.saveSettings();
          }));

      new Setting(containerEl)
        .setName("Watch for file changes")
        .setDesc("Automatically detect and sync changes made to notes in Obsidian.")
        .addToggle(toggle => toggle
          .setValue(this.plugin.settings.watchForChanges)
          .onChange(async (value) => {
            this.plugin.settings.watchForChanges = value;
            await this.plugin.saveSettings();
          }));

      new Setting(containerEl)
        .setName("Auto-sync formulas and relations")
        .setDesc("Automatically fetch computed formula and relation results after syncing.")
        .addToggle(toggle => toggle
          .setValue(this.plugin.settings.autoSyncFormulas)
          .onChange(async (value) => {
            this.plugin.settings.autoSyncFormulas = value;
            await this.plugin.saveSettings();
            this.debounceDisplay();
          }));

      if (this.plugin.settings.autoSyncFormulas) {
        new Setting(containerEl)
          .setName("Formula sync delay (milliseconds)")
          .setDesc("How long to wait for Airtable to compute formulas before fetching.")
          .addText(text => {
            const input = text
              .setPlaceholder("1500")
              .setValue(this.plugin.settings.formulaSyncDelay.toString())
              .onChange(async (value) => {
                const num = Number(value);
                if (Number.isNaN(num) || num < 0) {
                  new Notice("Auto Note Importer: Formula sync delay must be a positive number.");
                  return;
                }
                this.plugin.settings.formulaSyncDelay = num;
                await this.plugin.saveSettings();
              });
            (input.inputEl as HTMLInputElement).type = "number";
            (input.inputEl as HTMLInputElement).min = "0";
            (input.inputEl as HTMLInputElement).step = "100";
          });
      }
    }
  }
}
