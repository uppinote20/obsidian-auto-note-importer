import { Plugin, TFile, TFolder, normalizePath, Notice, requestUrl } from "obsidian";
import { AutoNoteImporterSettings, DEFAULT_SETTINGS, AutoNoteImporterSettingTab } from "./settings";
import { fetchNotes, RemoteNote, updateAirtableRecord, SyncResult, ConflictInfo } from "./fetcher";
import { buildMarkdownContent, parseTemplate } from "./note-builder";
// import { sanitizeFileName } from "./utils";
import { formatYamlValue, sanitizeFolderPath, validateAndSanitizeFilename, sanitizeFileName } from "./utils";

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
  // Reference to the settings tab for accessing cached field information
  settingTab: AutoNoteImporterSettingTab;
  // Tracks files that have been modified and need to be synced back to Airtable
  pendingSyncFiles: Set<string> = new Set();
  // Debounce timer for file changes to avoid excessive API calls
  syncDebounceTimer: NodeJS.Timeout | null = null;

  // When plugin loaded
  async onload() {

    await this.loadSettings();
    this.settingTab = new AutoNoteImporterSettingTab(this.app, this);
    this.addSettingTab(this.settingTab);
    
    this.addCommand({
      id: "sync-notes-now",
      name: "Sync notes now",
      callback: async () => {
        new Notice("Auto Note Importer: 🚀 Starting sync...");
        await this.syncNotes();
      }
    });

    // Add bidirectional sync command
    this.addCommand({
      id: "sync-to-airtable",
      name: "Sync changes to Airtable",
      callback: async () => {
        if (!this.settings.bidirectionalSync) {
          new Notice("Auto Note Importer: ❌ Bidirectional sync is disabled in settings.");
          return;
        }
        new Notice("Auto Note Importer: 🔄 Syncing changes to Airtable...");
        await this.syncToAirtable();
      }
    });

    this.startScheduler();
    this.setupFileWatcher();
  }

  // When plugin unloaded
  onunload() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
    }
    if (this.syncDebounceTimer) {
      clearTimeout(this.syncDebounceTimer);
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
    const statusBarItem = this.addStatusBarItem();
    
    try {
      statusBarItem.setText("Auto Note Importer: Preparing...");
      const folderPath = normalizePath(this.settings.folderPath);
      if (!await this.app.vault.adapter.exists(folderPath)) {
        await this.app.vault.createFolder(folderPath);
      }

      statusBarItem.setText("Auto Note Importer: Fetching from Airtable...");
      const remoteNotes = await fetchNotes(this.settings);

      let existingPrimaryField: Set<string> | null = null;
      if (!this.settings.allowOverwrite) {
        existingPrimaryField = await this.loadExistingPrimaryField(this.settings.folderPath);
        }
      
      let createdCount = 0;
      let updatedCount = 0;
      let skippedCount = 0;
      
      for (let i = 0; i < remoteNotes.length; i++) {
        const note = remoteNotes[i];
        const shouldProcess = this.settings.allowOverwrite || (existingPrimaryField && !existingPrimaryField.has(note.primaryField));

        // Update status bar with progress
        statusBarItem.setText(`Auto Note Importer: Processing ${i + 1}/${remoteNotes.length}`);

        if (shouldProcess) {
          const result = await this.createNoteFromRemote(note);
          if (result === "created") createdCount++;
          if (result === "updated") updatedCount++;
        } else {
          skippedCount++;
        }
      }

      // Clean up status bar
      statusBarItem.remove();
      
      let summary = `Auto Note Importer: ✅ Sync complete: ${createdCount} created, ${updatedCount} updated.`;
      if (skippedCount > 0) {
        summary += ` (${skippedCount} skipped)`;
      }
      new Notice(summary);
    } catch (error: any) {
      statusBarItem.remove();
      new Notice(`Auto Note Importer: ❌ Error during sync. ${error.message || "Please check your Airtable settings and network connection."}`);
    }
  }

  /**
   * Scans the target folder for existing notes and extracts the value of the `primaryField` from their frontmatter.
   * Recursively searches subfolders to handle subfolder organization.
   * @param folderPath The path to the folder where notes are stored.
   * @returns A Promise that resolves to a Set containing the primaryField values of existing notes.
   */
  async loadExistingPrimaryField(folderPath: string): Promise<Set<string>> {
    const folder = this.app.vault.getAbstractFileByPath(normalizePath(folderPath));
    const primaryField = new Set<string>();

    if (folder instanceof TFolder) {
      await this.scanFolderRecursively(folder, primaryField, 0, 10); // Max depth of 10
    }
    return primaryField;
  }

  /**
   * Recursively scans a folder and its subfolders for markdown files with primaryField frontmatter.
   * @param folder The folder to scan
   * @param primaryField The Set to add found primaryField values to
   * @param currentDepth Current recursion depth
   * @param maxDepth Maximum recursion depth to prevent infinite loops
   */
  private async scanFolderRecursively(folder: TFolder, primaryField: Set<string>, currentDepth = 0, maxDepth = 10): Promise<void> {
    if (currentDepth >= maxDepth) {
      return; // Prevent excessive recursion
    }

    for (const file of folder.children) {
      if (file instanceof TFile && file.extension === "md") {
        const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter;
        if (frontmatter && frontmatter.primaryField) {
          primaryField.add(String(frontmatter.primaryField));
        }
      } else if (file instanceof TFolder) {
        // Recursively scan subfolders with depth tracking
        await this.scanFolderRecursively(file, primaryField, currentDepth + 1, maxDepth);
      }
    }
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
    let safeTitle: string;

    if (this.settings.filenameFieldName && note.fields.hasOwnProperty(this.settings.filenameFieldName)) {
      const rawFilenameValue = note.fields[this.settings.filenameFieldName];

      try {
        // Get field type from cached fields to determine validation approach
        const cacheKey = `${this.settings.baseId}-${this.settings.tableId}`;
        const cachedFields = this.settingTab?.getCachedFields(cacheKey);
        const fieldInfo = cachedFields?.find((f: {name: string; type: string}) => f.name === this.settings.filenameFieldName);
        const fieldType = fieldInfo?.type;

        if (fieldType === 'formula') {
          // Apply strict validation only to formula fields
          const validatedTitle = validateAndSanitizeFilename(rawFilenameValue);
          if (validatedTitle) {
            safeTitle = validatedTitle;
          } else {
            new Notice(`Auto Note Importer: ⚠️ Invalid filename from Formula field "${this.settings.filenameFieldName}". Using record ID as fallback.`);
            safeTitle = note.primaryField;
          }
        } else {
          // For other field types, just sanitize without strict validation
          const sanitizedTitle = sanitizeFileName(String(rawFilenameValue));
          safeTitle = sanitizedTitle || note.primaryField;
        }
      } catch (error) {
        // Fallback to basic sanitization without console logging
        const sanitizedTitle = sanitizeFileName(String(rawFilenameValue));
        safeTitle = sanitizedTitle || note.primaryField;
      }
    } else {
      // Fallback to primaryField (Airtable record ID) - already safe, no sanitization needed
      safeTitle = note.primaryField;
    }

    // Final fallback if somehow we don't have a title
    if (!safeTitle || safeTitle.trim() === '') {
      safeTitle = note.id || 'untitled';
    }
    
    // Determine the folder path based on subfolder field settings
    let finalFolderPath = this.settings.folderPath;
    
    if (this.settings.subfolderFieldName && note.fields.hasOwnProperty(this.settings.subfolderFieldName)) {
      const subfolderValue = note.fields[this.settings.subfolderFieldName];
      if (subfolderValue !== null && subfolderValue !== undefined) {
        const trimmedValue = String(subfolderValue).trim();
        if (trimmedValue) {
          const sanitizedSubfolder = sanitizeFolderPath(trimmedValue);
          if (sanitizedSubfolder) {
            finalFolderPath = `${this.settings.folderPath}/${sanitizedSubfolder}`;
          }
        }
      }
    }
    
    const folderPath = normalizePath(finalFolderPath);
    
    // Ensure the folder exists (create if needed)
    if (!await this.app.vault.adapter.exists(folderPath)) {
      await this.app.vault.createFolder(folderPath);
    }
    
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
          new Notice(`Auto Note Importer: ❌ Template error: ${templateError.message || 'Unknown error'}. Using default format.`);
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
        // Frontmatter exists, but primaryField key is missing. Inject it safely.
        const frontmatterEnd = content.indexOf('\n---\n', 4);
        if (frontmatterEnd !== -1) {
          // Well-formed frontmatter: insert before closing ---
          content = content.slice(0, frontmatterEnd) + '\n' + primaryFieldYamlLine.trim() + content.slice(frontmatterEnd);
        } else {
          // Try alternative frontmatter ending patterns
          const altEnd = content.indexOf('\n---', 4);
          if (altEnd !== -1) {
            content = content.slice(0, altEnd) + '\n' + primaryFieldYamlLine.trim() + content.slice(altEnd);
          } else {
            // Malformed frontmatter: add after opening line
            const firstNewline = content.indexOf('\n', 3);
            if (firstNewline !== -1) {
              content = content.slice(0, firstNewline + 1) + primaryFieldYamlLine + content.slice(firstNewline + 1);
            }
          }
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

  /**
   * Sets up file watching for bidirectional sync functionality.
   * Monitors changes to files in the target folder and triggers sync to Airtable.
   */
  setupFileWatcher() {
    if (!this.settings.bidirectionalSync || !this.settings.watchForChanges) {
      return;
    }

    // Listen for file modifications
    this.registerEvent(
      this.app.vault.on('modify', (file) => {
        if (file instanceof TFile && file.extension === 'md') {
          this.handleFileChange(file);
        }
      })
    );
  }

  /**
   * Handles file change events with debouncing to avoid excessive API calls.
   * @param file The modified file
   */
  handleFileChange(file: TFile) {
    const folderPath = normalizePath(this.settings.folderPath);
    
    // Check if the file is in our target folder (including subfolders)
    if (!file.path.startsWith(folderPath)) {
      return;
    }

    this.pendingSyncFiles.add(file.path);
    
    // Debounce the sync operation
    if (this.syncDebounceTimer) {
      clearTimeout(this.syncDebounceTimer);
    }
    
    this.syncDebounceTimer = setTimeout(async () => {
      await this.syncToAirtable();
    }, 2000); // 2 second debounce
  }

  /**
   * Syncs pending file changes back to Airtable.
   * Extracts field changes from frontmatter and sends updates via API.
   */
  async syncToAirtable() {
    if (!this.settings.bidirectionalSync) {
      return;
    }

    if (this.pendingSyncFiles.size === 0) {
      return;
    }

    const statusBarItem = this.addStatusBarItem();
    let syncedCount = 0;
    let errorCount = 0;
    
    try {
      statusBarItem.setText("Auto Note Importer: Syncing to Airtable...");
      
      for (const filePath of this.pendingSyncFiles) {
        const file = this.app.vault.getAbstractFileByPath(filePath);
        
        if (!(file instanceof TFile)) {
          this.pendingSyncFiles.delete(filePath);
          continue;
        }

        try {
          const result = await this.syncFileToAirtable(file);
          if (result.success) {
            syncedCount++;
          } else {
            errorCount++;
            new Notice(`Auto Note Importer: ❌ Failed to sync ${file.name}: ${result.error}`);
          }
        } catch (error: any) {
          errorCount++;
          new Notice(`Auto Note Importer: ❌ Error syncing ${file.name}: ${error.message}`);
        }
        
        this.pendingSyncFiles.delete(filePath);
      }
      
      statusBarItem.remove();
      
      if (syncedCount > 0 || errorCount > 0) {
        const message = `Auto Note Importer: ✅ Synced ${syncedCount} to Airtable${errorCount > 0 ? ` (${errorCount} errors)` : ''}`;
        new Notice(message);
      }
    } catch (error: any) {
      statusBarItem.remove();
      new Notice(`Auto Note Importer: ❌ Sync to Airtable failed: ${error.message}`);
    }
  }

  /**
   * Syncs a single file's changes back to Airtable.
   * @param file The file to sync
   * @returns Promise<SyncResult>
   */
  async syncFileToAirtable(file: TFile): Promise<SyncResult> {
    try {
      const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter;
      
      if (!frontmatter || !frontmatter.primaryField) {
        return {
          success: false,
          recordId: '',
          updatedFields: {},
          error: 'No primaryField found in frontmatter'
        };
      }

      const recordId = frontmatter.primaryField;
      
      // Extract fields that should be synced back to Airtable
      const fieldsToSync: Record<string, any> = {};
      
      // Get all frontmatter fields except system fields
      const systemFields = ['primaryField'];
      for (const [key, value] of Object.entries(frontmatter)) {
        if (!systemFields.includes(key) && value !== null && value !== undefined) {
          fieldsToSync[key] = value;
        }
      }
      
      if (Object.keys(fieldsToSync).length === 0) {
        return {
          success: true,
          recordId,
          updatedFields: {},
        };
      }

      // Handle conflicts if enabled
      if (this.settings.conflictResolution !== 'obsidian-wins') {
        const conflicts = await this.detectConflicts(recordId, fieldsToSync, file.path);
        if (conflicts.length > 0) {
          return await this.handleConflicts(conflicts, fieldsToSync, recordId);
        }
      }

      return await updateAirtableRecord(this.settings, recordId, fieldsToSync);
    } catch (error: any) {
      return {
        success: false,
        recordId: '',
        updatedFields: {},
        error: error.message || 'Unknown error occurred'
      };
    }
  }

  /**
   * Detects conflicts between Obsidian and Airtable field values.
   * @param recordId The Airtable record ID
   * @param obsidianFields The fields from Obsidian
   * @param filePath The file path for reference
   * @returns Promise<ConflictInfo[]>
   */
  async detectConflicts(recordId: string, obsidianFields: Record<string, any>, filePath: string): Promise<ConflictInfo[]> {
    try {
      // Fetch current Airtable record to compare values
      const url = `https://api.airtable.com/v0/${this.settings.baseId}/${this.settings.tableId}/${recordId}`;
      const response = await requestUrl({
        url: url,
        method: "GET",
        headers: {
          "Authorization": `Bearer ${this.settings.apiKey}`,
          "Content-Type": "application/json",
        },
      });

      if (response.status !== 200) {
        // If we can't fetch the record, assume no conflicts
        return [];
      }

      const airtableRecord = response.json;
      const conflicts: ConflictInfo[] = [];

      for (const [field, obsidianValue] of Object.entries(obsidianFields)) {
        const airtableValue = airtableRecord.fields[field];
        
        // Compare values (simple comparison for now)
        if (airtableValue !== undefined && !this.areValuesEqual(obsidianValue, airtableValue)) {
          conflicts.push({
            field,
            obsidianValue,
            airtableValue,
            recordId,
            filePath
          });
        }
      }

      return conflicts;
    } catch (error) {
      // If conflict detection fails, assume no conflicts
      return [];
    }
  }

  /**
   * Handles detected conflicts based on the conflict resolution strategy.
   * @param conflicts Array of detected conflicts
   * @param fieldsToSync The fields that were to be synced
   * @param recordId The record ID
   * @returns Promise<SyncResult>
   */
  async handleConflicts(conflicts: ConflictInfo[], fieldsToSync: Record<string, any>, recordId: string): Promise<SyncResult> {
    switch (this.settings.conflictResolution) {
      case 'airtable-wins': {
        // Don't sync conflicted fields, only sync non-conflicted ones
        const nonConflictedFields: Record<string, any> = {};
        const conflictedFieldNames = new Set(conflicts.map(c => c.field));
        
        for (const [field, value] of Object.entries(fieldsToSync)) {
          if (!conflictedFieldNames.has(field)) {
            nonConflictedFields[field] = value;
          }
        }
        
        if (Object.keys(nonConflictedFields).length > 0) {
          return await updateAirtableRecord(this.settings, recordId, nonConflictedFields);
        } else {
          return {
            success: true,
            recordId,
            updatedFields: {},
          };
        }
      }

      case 'manual': {
        // Show conflict notification and don't sync
        const conflictFields = conflicts.map(c => c.field).join(', ');
        new Notice(`Auto Note Importer: ⚠️ Conflicts detected in fields: ${conflictFields}. Please resolve manually.`);
        return {
          success: false,
          recordId,
          updatedFields: {},
          error: `Conflicts detected in fields: ${conflictFields}`
        };
      }

      default:
        // This shouldn't happen, but fallback to obsidian-wins
        return await updateAirtableRecord(this.settings, recordId, fieldsToSync);
    }
  }

  /**
   * Compares two values for equality, handling different data types.
   * @param value1 First value to compare
   * @param value2 Second value to compare
   * @returns boolean indicating if values are equal
   */
  areValuesEqual(value1: any, value2: any): boolean {
    // Handle null/undefined
    if (value1 == null && value2 == null) return true;
    if (value1 == null || value2 == null) return false;
    
    // Handle arrays
    if (Array.isArray(value1) && Array.isArray(value2)) {
      if (value1.length !== value2.length) return false;
      return value1.every((item, index) => this.areValuesEqual(item, value2[index]));
    }
    
    // Handle objects
    if (typeof value1 === 'object' && typeof value2 === 'object') {
      const keys1 = Object.keys(value1);
      const keys2 = Object.keys(value2);
      if (keys1.length !== keys2.length) return false;
      return keys1.every(key => this.areValuesEqual(value1[key], value2[key]));
    }
    
    // Handle primitive values
    return String(value1).trim() === String(value2).trim();
  }
}