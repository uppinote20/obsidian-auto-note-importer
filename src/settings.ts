import { App, PluginSettingTab, Setting, TFolder, TFile, AbstractInputSuggest, Notice, requestUrl } from "obsidian";
import AutoNoteImporterPlugin from "./main";

class FolderSuggest extends AbstractInputSuggest<string> {
  private folderPaths: string[];
  private el: HTMLInputElement;

  // Creates an instance of FolderSuggest.
  constructor(app: App, inputEl: HTMLInputElement) {
    super(app, inputEl);
    this.el = inputEl;
    // Filter out files and get only folder paths
    this.folderPaths = app.vault.getAllLoadedFiles()
      .filter((f): f is TFolder => f instanceof TFolder)
      .map(f => f.path)
  }

  public override getSuggestions(query: string): string[] {
    return this.folderPaths.filter(path => path.toLowerCase().contains(query.toLowerCase()));
  }

  public override renderSuggestion(path: string, el: HTMLElement): void {
    el.createEl("div", { text: path });
  }

  public override selectSuggestion(path: string): void {
    this.el.value = path;
    this.el.dispatchEvent(new Event("input"));
    this.close();
  }
}

class FileSuggest extends AbstractInputSuggest<string> {
  private filePaths: string[];
  private el: HTMLInputElement;

  // Creates an instance of FileSuggest.
  constructor(app: App, inputEl: HTMLInputElement) {
    super(app, inputEl);
    this.el = inputEl;
    // Filter out folders and get only file paths
    this.filePaths = app.vault.getAllLoadedFiles()
    .filter((f): f is TFile => f instanceof TFile)
    .map(f => f.path)
  }

  public override getSuggestions(query: string): string[] {
    return this.filePaths.filter(path => path.toLowerCase().contains(query.toLowerCase()));
  }

  public override renderSuggestion(path: string, el: HTMLElement): void {
    el.createEl("div", { text: path });
  }

  public override selectSuggestion(path: string): void {
    this.el.value = path;
    this.el.dispatchEvent(new Event("input"));
    this.close();
  }
}

// Defines the structure for the plugin's settings.
export interface AutoNoteImporterSettings {
  apiKey: string;
  baseId: string;
  tableId: string;
  folderPath: string;
  templatePath: string;
  syncInterval: number;
  allowOverwrite: boolean;
  primaryFieldName: string;
  filenameFieldName: string;
}

// Default values for the plugin settings.
export const DEFAULT_SETTINGS: AutoNoteImporterSettings = {
  apiKey: "",
  baseId: "",
  tableId: "",
  folderPath: "Crawling",
  templatePath: "",
  syncInterval: 0,
  allowOverwrite: false,
  primaryFieldName: "",
  filenameFieldName: "title",
};

// Represents the settings tab for the Auto Note Importer plugin in Obsidian's settings panel.
export class AutoNoteImporterSettingTab extends PluginSettingTab {
  plugin: AutoNoteImporterPlugin;

  // Creates an instance of the setting tab.
  constructor(app: App, plugin: AutoNoteImporterPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  async fetchBases(apiKey: string): Promise<{id: string, name: string}[]> {
    const response = await requestUrl({
      url: "https://api.airtable.com/v0/meta/bases",
      method: "GET",
      headers: { "Authorization": `Bearer ${apiKey}` },
    });

    if (response.status !== 200) {
      throw new Error(`Failed to fetch bases: HTTP ${response.status}`);
    }

    const json = response.json;
    return json.bases.map((b: any) => ({ id: b.id, name: b.name }));
  }

  async fetchTables(apiKey: string, baseId: string): Promise<{id: string, name: string}[]> {
    const response = await requestUrl({
      url: `https://api.airtable.com/v0/meta/bases/${baseId}/tables`,
      method: "GET",
      headers: { "Authorization": `Bearer ${apiKey}` },
    });

    if (response.status !== 200) {
      throw new Error(`Failed to fetch tables: HTTP ${response.status}`);
    }

    const json = response.json;
    return json.tables.map((t: any) => ({ id: t.id, name: t.name }));
  }

  // Renders the settings UI elements within the container element.
  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    
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
            this.display();
          });
        text.inputEl.type = 'password';
      });

    if (this.plugin.settings.apiKey) {
      new Setting(containerEl)
        .setName("Select base")
        .setDesc("Choose the Airtable base you want to import notes from.")
        .addDropdown(async dropdown => {
          try {
            dropdown.addOption("", "-- Select base. --");
            const bases = await this.fetchBases(this.plugin.settings.apiKey);
            bases.forEach(base => {
              dropdown.addOption(base.id, base.name);
            });
            dropdown.setValue(this.plugin.settings.baseId);
            dropdown.onChange(async (value) => {
              this.plugin.settings.baseId = value;
              this.plugin.settings.tableId = "";
              await this.plugin.saveSettings();
              this.display();
            });
          } catch (error) {
            new Notice(`Auto Note Importer: ❌ Failed to fetch Airtable bases. ${error.message || 'Check PAT or network.'}`);
          }
        });

      if (this.plugin.settings.baseId) {
        new Setting(containerEl)
          .setName("Select table")
          .setDesc("Choose the specific table within the selected base.")
          .addDropdown(async dropdown => {
            try {
              dropdown.addOption("", "-- Select table --");
              const tables = await this.fetchTables(this.plugin.settings.apiKey, this.plugin.settings.baseId);
              tables.forEach(table => {
                dropdown.addOption(table.id, table.name);
              });
              dropdown.setValue(this.plugin.settings.tableId);
              dropdown.onChange(async (value) => {
                this.plugin.settings.tableId = value;
                await this.plugin.saveSettings();
              });
            } catch (error) {
              new Notice(`Auto Note Importer: ❌ Failed to fetch Airtable tables. ${error.message || 'Check base ID or network.'}`);
            }
          });
      }
    }

    new Setting(containerEl)
      .setName("Primary field name")
      .setDesc("Enter the exact name of the Airtable field to use as the unique identifier for notes (for duplicate checking). Leave empty to use the first field.")
      .addText(text => text
        .setPlaceholder("e.g., Unique ID or leave empty")
        .setValue(this.plugin.settings.primaryFieldName)
        .onChange(async (value) => {
          this.plugin.settings.primaryFieldName = value.trim();
          await this.plugin.saveSettings();
        }));
  
    new Setting(containerEl)
      .setName("Filename field name")
      .setDesc("Enter the exact name of the Airtable field to use for the note's filename.")
      .addText(text => text
        .setPlaceholder("e.g., title")
        .setValue(this.plugin.settings.filenameFieldName)
        .onChange(async (value) => {
          this.plugin.settings.filenameFieldName = value.trim();
          await this.plugin.saveSettings();
        }));
  
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
        new FolderSuggest(this.plugin.app, input.inputEl as HTMLInputElement);
      });

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
        new FileSuggest(this.plugin.app, input.inputEl as HTMLInputElement);
      });

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
              new Notice("Auto Note Importer: ❌ Sync interval must be a positive number.");
              return;
            }
            this.plugin.settings.syncInterval = num;
            await this.plugin.saveSettings();
            this.plugin.startScheduler();
          });
        (input.inputEl as HTMLInputElement).type = "number";
        (input.inputEl as HTMLInputElement).min = "0";
      });

    new Setting(containerEl)
      .setName("Allow overwrite existing notes")
      .setDesc("If enabled, existing notes will be overwritten when syncing.")
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.allowOverwrite)
        .onChange(async (value) => {
          this.plugin.settings.allowOverwrite = value;
          await this.plugin.saveSettings();
        }));
  }
}