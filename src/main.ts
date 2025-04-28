import { Plugin, TFile, TFolder, normalizePath, Notice } from "obsidian";
import { AutoNoteImporterSettings, DEFAULT_SETTINGS, AutoNoteImporterSettingTab } from "./settings";
import { fetchNotes, RemoteNote } from "./fetcher";
import { buildMarkdownContent, parseTemplate, sanitizeFileName } from "./note-builder";

export default class AutoNoteImporterPlugin extends Plugin {
  settings: AutoNoteImporterSettings;
  intervalId: number | null = null;

  async onload() {

    await this.loadSettings();
    this.addSettingTab(new AutoNoteImporterSettingTab(this.app, this));
    
    this.addCommand({
      id: "sync-notes-now",
      name: "Sync Notes Now",
      callback: async () => {
        new Notice("Auto Note Importer: ⏳ Syncing notes...");
        await this.syncNotes();
      }
    });

    this.startScheduler();
  }

  onunload() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
    }
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  startScheduler() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
    }

    if (this.settings.syncInterval > 0) {
      this.intervalId = window.setInterval(async () => {
        await this.syncNotes();
      }, this.settings.syncInterval * 60 * 1000);
    }
  }

  async syncNotes() {
    try {
      const remoteNotes = await fetchNotes(this.settings);

      let existingPrimaryField: Set<string> | null = null;
      if (!this.settings.allowOverwrite) {
        existingPrimaryField = await this.loadExistingPrimaryField(this.settings.folderPath);
        }
      
      let createdCount = 0;
      let updatedCount = 0;
      let skippedCount = 0;

      for (const note of remoteNotes) {
        const shouldProcess = this.settings.allowOverwrite || (existingPrimaryField && !existingPrimaryField.has(note.primaryField));

        if (shouldProcess) {
          const result = await this.createNoteFromRemote(note);
          if (result === "created") createdCount++;
          if (result === "updated") updatedCount++;
        } else {
          skippedCount++;
        }
      }

      let summary = `Auto Note Importer: ✅ Sync complete: ${createdCount} created, ${updatedCount} updated.`;
      if (skippedCount > 0) {
        summary += ` (${skippedCount} skipped)`;
      }
      new Notice(summary);
    } catch (error: any) {
      new Notice(`Auto Note Importer: ❌ Error during sync. ${error.message || "Check console for details."}`);
    }
  }

  async loadExistingPrimaryField(folderPath: string): Promise<Set<string>> {
    const folder = this.app.vault.getAbstractFileByPath(normalizePath(folderPath));
    const primaryField = new Set<string>();

    if (folder instanceof TFolder) {
      for (const file of folder.children) {
        if (file instanceof TFile && file.extension === "md") {
          const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter;
          if (frontmatter && frontmatter.primaryField) {
            primaryField.add(String(frontmatter.primaryField));
          }
        }
      }
    }
    return primaryField;
  }

  async createNoteFromRemote(note: RemoteNote): Promise<"created" | "updated" | "skipped"> {
    const folderPath = normalizePath(this.settings.folderPath);
    if (!await this.app.vault.adapter.exists(folderPath)) {
      await this.app.vault.createFolder(folderPath);
    }

    const rawTitle = note.fields.title ?? note.primaryField;
    const safeTitle = sanitizeFileName(String(rawTitle));
    const filePath = normalizePath(`${folderPath}/${safeTitle}.md`);
    const existingFile = this.app.vault.getAbstractFileByPath(filePath);

    if (existingFile instanceof TFile && !this.settings.allowOverwrite) {
      return "skipped";
    }

    let content: string;

    if (this.settings.templatePath) {
      const templateFile = this.app.vault.getAbstractFileByPath(normalizePath(this.settings.templatePath));
      if (templateFile instanceof TFile) {
        try {
          const templateContent = await this.app.vault.read(templateFile);
          content = parseTemplate(templateContent, note);
        } catch (templateError) {
          new Notice("Auto Note Importer: ❌ Error using template. Using default format.");
          content = buildMarkdownContent(note);
        }
      } else {
        content = buildMarkdownContent(note);
      } 
    } else {
      content = buildMarkdownContent(note);
    } 
  
    try {
      if (existingFile instanceof TFile) {
        const currentContent = await this.app.vault.read(existingFile);
        if (currentContent !== content) {
          await this.app.vault.modify(existingFile, content);
          return "updated";
        } else {
          return "skipped";
        }
      } else {
        await this.app.vault.create(filePath, content);
        return "created";
      }
    } catch (writeError) {
        new Notice(`Auto Note Importer: ❌ Failed to save note: ${safeTitle}`);
        return "skipped";
    }
  }
}