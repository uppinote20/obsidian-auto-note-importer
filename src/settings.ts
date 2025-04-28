import { App, PluginSettingTab, Setting, TFolder, TFile, AbstractInputSuggest, Notice, requestUrl } from "obsidian";
import AutoNoteImporterPlugin from "./main";

class FolderSuggest extends AbstractInputSuggest<string> {
  private folderPaths: string[];
  private el: HTMLInputElement;

  constructor(app: App, inputEl: HTMLInputElement) {
    super(app, inputEl);
    this.el = inputEl;
    this.folderPaths = app.vault.getAllLoadedFiles()
      .filter(f => f instanceof TFolder)
      .map(f => (f as TFolder).path);
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

  constructor(app: App, inputEl: HTMLInputElement) {
    super(app, inputEl);
    this.el = inputEl;
    this.filePaths = app.vault.getAllLoadedFiles()
      .filter(f => f instanceof TFile)
      .map(f => (f as TFile).path);
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

export interface AutoNoteImporterSettings {
  apiKey: string;
  baseId: string;
  tableId: string;
  folderPath: string;
  templatePath: string;
  syncInterval: number;
  allowOverwrite: boolean;
}

export const DEFAULT_SETTINGS: AutoNoteImporterSettings = {
  apiKey: "",
  baseId: "",
  tableId: "",
  folderPath: "Crawling",
  templatePath: "",
  syncInterval: 0,
  allowOverwrite: false,
};

export class AutoNoteImporterSettingTab extends PluginSettingTab {
  plugin: AutoNoteImporterPlugin;

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

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "Auto Note Importer Settings" });

    new Setting(containerEl)
      .setName("Airtable Personal Access Token")
      .setDesc("Enter your Airtable Personal Access Token. You can create one in your Airtable account settings.")
      .addText(text => text
        .setPlaceholder("your-pat-token")
        .setValue(this.plugin.settings.apiKey)
        .onChange(async (value) => {
          this.plugin.settings.apiKey = value;
          await this.plugin.saveSettings();
          this.display();
        }));

    if (this.plugin.settings.apiKey) {
      new Setting(containerEl)
        .setName("Select Base")
        .setDesc("Choose the Airtable Base you want to import notes from.")
        .addDropdown(async dropdown => {
          const bases = await this.fetchBases(this.plugin.settings.apiKey);
          bases.forEach(base => {
            dropdown.addOption(base.id, base.name);
          });
          dropdown.setValue(this.plugin.settings.baseId);
          dropdown.onChange(async (value) => {
            this.plugin.settings.baseId = value;
            await this.plugin.saveSettings();
            this.display();
          });
        });

      if (this.plugin.settings.baseId) {
        new Setting(containerEl)
          .setName("Select Table")
          .setDesc("Choose the specific Table within the selected Base.")
          .addDropdown(async dropdown => {
            const tables = await this.fetchTables(this.plugin.settings.apiKey, this.plugin.settings.baseId);
            tables.forEach(table => {
              dropdown.addOption(table.id, table.name);
            });
            dropdown.setValue(this.plugin.settings.tableId);
            dropdown.onChange(async (value) => {
              this.plugin.settings.tableId = value;
              await this.plugin.saveSettings();
            });
          });
      }
    }

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
      .setName("Sync Interval (minutes)")
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
      .setName("Allow Overwrite Existing Notes")
      .setDesc("If enabled, existing notes will be overwritten when syncing.")
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.allowOverwrite)
        .onChange(async (value) => {
          this.plugin.settings.allowOverwrite = value;
          await this.plugin.saveSettings();
        }));
  }
}