import { Plugin, TFile, TFolder, normalizePath, Notice } from "obsidian";
import { AutoNoteImporterSettings, DEFAULT_SETTINGS, AutoNoteImporterSettingTab } from "./settings";
import { fetchNotes, RemoteNote } from "./fetcher";
import { buildMarkdownContent, parseTemplate } from "./note-builder";
// import { sanitizeFileName } from "./utils";
import { sanitizeFileName, formatYamlValue } from "./utils";

/**
 * The main plugin class for Auto Note Importer.
 * Handles loading settings, scheduling synchronization, fetching remote notes,
 * and creating/updating local notes in Obsidian.
 */
export default class AutoNoteImporterPlugin extends Plugin {
  // Stores the plugin settings.
  settings: AutoNoteImporterSettings;
  // Holds the ID of the interval timer used for scheduled synchronization.
  // Null if scheduling is disabled or not started.
  intervalId: number | null = null;

  // When plugin loaded
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

  // When plugin unloaded
  onunload() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
    }
  }

  // Load settings from data storage
  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  // Save settings to data storage
  async saveSettings() {
    await this.saveData(this.settings);
  }

  startScheduler() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
    }

    // Starts the automatic synchronization scheduler based on the interval
    if (this.settings.syncInterval > 0) {
      this.intervalId = window.setInterval(async () => {
        await this.syncNotes();
      }, this.settings.syncInterval * 60 * 1000);
    }
  }

  /**
   * Performs the core synchronization process:
   * 1. Fetches notes from the remote source (e.g., Airtable).
   * 2. Determines which notes need to be created or updated based on settings.
   * 3. Calls `createNoteFromRemote` for each note to be processed.
   * 4. Displays status notices (start, completion, errors).
   */
  async syncNotes() {
    try {
      const folderPath = normalizePath(this.settings.folderPath);
      if (!await this.app.vault.adapter.exists(folderPath)) {
        await this.app.vault.createFolder(folderPath);
      }

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

  /**
   * Scans the target folder for existing notes and extracts the value of the `primaryField` from their frontmatter.
   * @param folderPath The path to the folder where notes are stored.
   * @returns A Promise that resolves to a Set containing the primaryField values of existing notes.
   */
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

  /**
   * Creates or updates a single note file in Obsidian based on a RemoteNote object.
   * - Determines the filename based on settings or primary field.
   * - Sanitizes the filename.
   * - Checks if the file exists and whether overwriting is allowed.
   * - Generates content using a template or the default builder.
   * - Writes the content to the vault (creates or modifies the file).
   * @param note The RemoteNote object containing the data for the note.
   * @returns A Promise resolving to "created", "updated", or "skipped" based on the action taken.
   */
  async createNoteFromRemote(note: RemoteNote): Promise<"created" | "updated" | "skipped"> {
    let rawFilenameValue: any;
    if (this.settings.filenameFieldName && note.fields.hasOwnProperty(this.settings.filenameFieldName)) {
      rawFilenameValue = note.fields[this.settings.filenameFieldName];
    } else {
      rawFilenameValue = note.primaryField;
    }
  
    let potentialTitle = String(rawFilenameValue ?? "").trim();
    if (!potentialTitle) {
      potentialTitle = note.id;
    }
    const safeTitle = sanitizeFileName(potentialTitle);
    const folderPath = normalizePath(this.settings.folderPath);
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
  
    // --- Ensure primaryField exists in frontmatter for consistency and duplicate checking ---
    const frontmatterRegex = /^---\s*([\s\S]*?)\s*---/;
    const match = content.match(frontmatterRegex);
    let hasPrimaryFieldKey = false;

    const primaryFieldYamlLine = `primaryField: ${formatYamlValue(note.primaryField)}\n`;

    if (match && match[1]) {
      // Frontmatter exists, check if primaryField key is present
      if (/^\s*primaryField\s*:/m.test(match[1])) {
          hasPrimaryFieldKey = true;
      }
    }

    if (!hasPrimaryFieldKey) {
      if (match) {
        // Frontmatter exists, but primaryField key is missing. Inject it.
        // Find the end of the frontmatter block (second '---')
        const endFrontmatterIndex = content.indexOf('---', 3);
        if (endFrontmatterIndex !== -1) {
            // Insert the primaryField line just before the closing '---'
            const insertionPoint = content.lastIndexOf('\n', endFrontmatterIndex -1) + 1;
            content = content.slice(0, insertionPoint) + primaryFieldYamlLine + content.slice(insertionPoint);
        } else {
          // Malformed frontmatter (only opening '---')? Append after opening line.
          content = content.slice(0, 3) + '\n' + primaryFieldYamlLine + content.slice(3);
      
        }
      } else {
        // No frontmatter exists. Create a new frontmatter block at the beginning.
        const newFrontmatter = `---\n${primaryFieldYamlLine}---\n\n`;
        // Add a newline if content isn't empty and doesn't start with one
        const separator = (content.length > 0 && !content.startsWith('\n')) ? '\n' : '';
        content = newFrontmatter + separator + content;
      }
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