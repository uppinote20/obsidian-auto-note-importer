import { Plugin, TFile, TFolder, normalizePath, Notice, requestUrl, MarkdownView } from "obsidian";
import { AutoNoteImporterSettings, DEFAULT_SETTINGS, AutoNoteImporterSettingTab, READ_ONLY_FIELD_TYPES, SyncScope } from "./settings";
import { fetchNotes, RemoteNote, updateAirtableRecord, SyncResult, ConflictInfo, batchUpdateAirtableRecords } from "./fetcher";
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
  // Flag to prevent concurrent sync operations
  isSyncing = false;
  // Rate limiter for API requests
  private rateLimiter = {
    lastRequest: 0,
    minInterval: 200, // 200ms minimum between requests
  };

  // When plugin loaded
  async onload() {

    await this.loadSettings();
    this.settingTab = new AutoNoteImporterSettingTab(this.app, this);
    this.addSettingTab(this.settingTab);
    
    // Sync from Airtable commands
    this.addCommand({
      id: "sync-all-from-airtable",
      name: "Sync all notes from Airtable",
      callback: async () => {
        if (this.isSyncing) {
          new Notice("Auto Note Importer: ⏳ Sync already in progress...");
          return;
        }
        new Notice("Auto Note Importer: 🚀 Syncing all notes from Airtable...");
        this.isSyncing = true;
        try {
          await this.syncNotes();
        } finally {
          this.isSyncing = false;
        }
      }
    });

    // Sync to Airtable commands
    this.addCommand({
      id: "sync-current-to-airtable",
      name: "Sync current note to Airtable",
      callback: async () => {
        if (!this.settings.bidirectionalSync) {
          new Notice("Auto Note Importer: ❌ Bidirectional sync is disabled in settings.");
          return;
        }
        await this.performSync('to-airtable', 'current');
      }
    });

    this.addCommand({
      id: "sync-modified-to-airtable",
      name: "Sync modified notes to Airtable",
      callback: async () => {
        if (!this.settings.bidirectionalSync) {
          new Notice("Auto Note Importer: ❌ Bidirectional sync is disabled in settings.");
          return;
        }
        await this.performSync('to-airtable', 'modified');
      }
    });

    this.addCommand({
      id: "sync-all-to-airtable",
      name: "Sync all notes to Airtable",
      callback: async () => {
        if (!this.settings.bidirectionalSync) {
          new Notice("Auto Note Importer: ❌ Bidirectional sync is disabled in settings.");
          return;
        }
        await this.performSync('to-airtable', 'all');
      }
    });

    // Bidirectional sync with formulas commands
    this.addCommand({
      id: "bidirectional-sync-current",
      name: "Bidirectional sync current note (with formulas)",
      callback: async () => {
        if (!this.settings.bidirectionalSync) {
          new Notice("Auto Note Importer: ❌ Bidirectional sync is disabled in settings.");
          return;
        }
        await this.performSync('bidirectional', 'current');
      }
    });

    this.addCommand({
      id: "bidirectional-sync-modified",
      name: "Bidirectional sync modified notes (with formulas)",
      callback: async () => {
        if (!this.settings.bidirectionalSync) {
          new Notice("Auto Note Importer: ❌ Bidirectional sync is disabled in settings.");
          return;
        }
        await this.performSync('bidirectional', 'modified');
      }
    });

    this.addCommand({
      id: "bidirectional-sync-all",
      name: "Bidirectional sync all notes (with formulas)",
      callback: async () => {
        if (!this.settings.bidirectionalSync) {
          new Notice("Auto Note Importer: ❌ Bidirectional sync is disabled in settings.");
          return;
        }
        await this.performSync('bidirectional', 'all');
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

  /**
   * Unified sync method that handles different sync modes and scopes.
   * @param mode 'to-airtable' | 'from-airtable' | 'bidirectional'
   * @param scope 'current' | 'modified' | 'all'
   */
  async performSync(mode: 'to-airtable' | 'from-airtable' | 'bidirectional', scope: SyncScope) {
    if (this.isSyncing) {
      new Notice("Auto Note Importer: ⏳ Sync already in progress...");
      return;
    }

    this.isSyncing = true;
    const statusBarItem = this.addStatusBarItem();

    try {
      // Get files to sync based on scope
      const filesToSync = await this.getFilesToSync(scope);

      if (filesToSync.length === 0) {
        new Notice(`Auto Note Importer: ℹ️ No files to sync for scope: ${scope}`);
        statusBarItem.remove();
        return;
      }

      // Execute sync based on mode
      switch (mode) {
        case 'to-airtable':
          statusBarItem.setText(`Auto Note Importer: Syncing ${filesToSync.length} file(s) to Airtable...`);
          await this.syncFilesToAirtable(filesToSync);
          new Notice(`Auto Note Importer: ✅ Synced ${filesToSync.length} file(s) to Airtable`);
          break;

        case 'from-airtable':
          statusBarItem.setText("Auto Note Importer: Syncing from Airtable...");
          await this.syncNotes();
          break;

        case 'bidirectional':
          // Phase 1: Sync to Airtable
          statusBarItem.setText(`Auto Note Importer: Phase 1/2 - Syncing ${filesToSync.length} file(s) to Airtable...`);
          await this.syncFilesToAirtable(filesToSync);

          // Phase 2: Wait for formulas and sync back
          if (this.settings.autoSyncFormulas) {
            statusBarItem.setText(`Auto Note Importer: Waiting ${this.settings.formulaSyncDelay}ms for formulas...`);
            await new Promise(resolve => setTimeout(resolve, this.settings.formulaSyncDelay));

            statusBarItem.setText("Auto Note Importer: Phase 2/2 - Fetching computed results...");
            await this.syncNotes();
            new Notice("Auto Note Importer: ✅ Bidirectional sync complete with formulas updated!");
          } else {
            new Notice(`Auto Note Importer: ✅ Synced ${filesToSync.length} file(s) to Airtable`);
          }
          break;
      }

      statusBarItem.remove();
    } catch (error: any) {
      statusBarItem.remove();
      new Notice(`Auto Note Importer: ❌ Sync failed: ${error.message}`);
    } finally {
      this.isSyncing = false;
    }
  }

  /**
   * Gets files to sync based on the specified scope.
   */
  async getFilesToSync(scope: SyncScope): Promise<TFile[]> {
    const folderPath = normalizePath(this.settings.folderPath);

    switch (scope) {
      case 'current': {
        // Get currently active file
        const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (!activeView || !activeView.file) {
          throw new Error("No active markdown file");
        }
        const file = activeView.file;
        // Check if file is in target folder
        if (!file.path.startsWith(folderPath)) {
          throw new Error("Current file is not in the sync folder");
        }
        return [file];
      }

      case 'modified': {
        // Get pending sync files
        const files: TFile[] = [];
        for (const filePath of this.pendingSyncFiles) {
          const file = this.app.vault.getAbstractFileByPath(filePath);
          if (file instanceof TFile) {
            files.push(file);
          }
        }
        return files;
      }

      case 'all': {
        // Get all markdown files in sync folder
        const folder = this.app.vault.getAbstractFileByPath(folderPath);
        if (!(folder instanceof TFolder)) {
          throw new Error("Sync folder not found");
        }
        const files: TFile[] = [];
        await this.collectMarkdownFiles(folder, files);
        return files;
      }

      default:
        return [];
    }
  }

  /**
   * Recursively collects all markdown files from a folder.
   */
  private async collectMarkdownFiles(folder: TFolder, files: TFile[]): Promise<void> {
    for (const child of folder.children) {
      if (child instanceof TFile && child.extension === 'md') {
        files.push(child);
      } else if (child instanceof TFolder) {
        await this.collectMarkdownFiles(child, files);
      }
    }
  }

  /**
   * Syncs an array of files to Airtable.
   */
  async syncFilesToAirtable(files: TFile[]): Promise<void> {
    const batchUpdates: Array<{ recordId: string; fields: Record<string, any>; filePath: string }> = [];

    for (const file of files) {
      const updateData = await this.prepareFileForSync(file);
      if (updateData) {
        batchUpdates.push({
          recordId: updateData.recordId,
          fields: updateData.fields,
          filePath: file.path
        });
      }
    }

    if (batchUpdates.length === 0) {
      return;
    }

    // Process updates in batches of 10 (Airtable limit)
    const batchSize = 10;
    let syncedCount = 0;
    let errorCount = 0;

    for (let i = 0; i < batchUpdates.length; i += batchSize) {
      const batch = batchUpdates.slice(i, i + batchSize);

      try {
        const results = await this.makeRateLimitedRequest(() =>
          batchUpdateAirtableRecords(this.settings, batch)
        );

        results.forEach(result => {
          if (result.success) {
            syncedCount++;
          } else {
            errorCount++;
          }
        });
      } catch (error: any) {
        errorCount += batch.length;
      }
    }

    if (errorCount > 0) {
      new Notice(`Auto Note Importer: ⚠️ ${syncedCount} synced, ${errorCount} errors`);
    }

    // Clear pending files if we synced them
    files.forEach(file => this.pendingSyncFiles.delete(file.path));
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
   * Automatically performs bidirectional sync if autoSyncFormulas is enabled.
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
      if (!this.isSyncing) {
        this.isSyncing = true;
        try {
          // Use bidirectional sync if formula auto-sync is enabled
          if (this.settings.autoSyncFormulas) {
            await this.performSync('bidirectional', 'modified');
          } else {
            await this.syncToAirtable();
          }
        } finally {
          this.isSyncing = false;
        }
      }
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

    // Clean up non-existent files first to prevent memory leak
    this.cleanupPendingSyncFiles();

    const statusBarItem = this.addStatusBarItem();
    let syncedCount = 0;
    let errorCount = 0;
    
    try {
      statusBarItem.setText("Auto Note Importer: Preparing batch sync...");
      
      // Collect all updates for batch processing
      const batchUpdates: Array<{ recordId: string; fields: Record<string, any>; filePath: string }> = [];
      const filesToProcess: TFile[] = [];
      
      for (const filePath of this.pendingSyncFiles) {
        const file = this.app.vault.getAbstractFileByPath(filePath);
        
        if (!(file instanceof TFile)) {
          this.pendingSyncFiles.delete(filePath);
          continue;
        }
        
        try {
          const updateData = await this.prepareFileForSync(file);
          if (updateData) {
            batchUpdates.push({
              recordId: updateData.recordId,
              fields: updateData.fields,
              filePath: file.path
            });
            filesToProcess.push(file);
          }
        } catch (error: any) {
          errorCount++;
          new Notice(`Auto Note Importer: ❌ Error preparing ${file.name}: ${error.message}`);
        }
      }
      
      // Process updates in batches of 10 (Airtable limit)
      const batchSize = 10;
      for (let i = 0; i < batchUpdates.length; i += batchSize) {
        const batch = batchUpdates.slice(i, i + batchSize);
        statusBarItem.setText(`Auto Note Importer: Syncing batch ${Math.floor(i / batchSize) + 1}...`);
        
        try {
          const results = await this.makeRateLimitedRequest(() => 
            batchUpdateAirtableRecords(this.settings, batch)
          );
          
          results.forEach((result, index) => {
            if (result.success) {
              syncedCount++;
            } else {
              errorCount++;
              const fileName = filesToProcess[i + index]?.name || 'unknown';
              new Notice(`Auto Note Importer: ❌ Failed to sync ${fileName}: ${result.error}`);
            }
          });
        } catch (error: any) {
          errorCount += batch.length;
          new Notice(`Auto Note Importer: ❌ Batch sync failed: ${error.message}`);
        }
      }
      
      // Clear all processed files
      this.pendingSyncFiles.clear();
      
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
   * Prepares a file for batch sync by extracting record ID and fields.
   * Filters out read-only fields (formulas, rollups, etc.) that shouldn't be synced to Airtable.
   * @param file The file to prepare
   * @returns Promise with recordId and fields, or null if file can't be synced
   */
  async prepareFileForSync(file: TFile): Promise<{ recordId: string; fields: Record<string, any> } | null> {
    try {
      const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter;

      if (!frontmatter || !frontmatter.primaryField) {
        return null;
      }

      const recordId = frontmatter.primaryField;

      // Get cached field information to determine field types
      const cacheKey = `${this.settings.baseId}-${this.settings.tableId}`;
      const cachedFields = this.settingTab?.getCachedFields(cacheKey);

      // Extract fields that should be synced back to Airtable
      const fieldsToSync: Record<string, any> = {};

      // System fields that should never be synced
      const systemFields = ['primaryField', 'position'];

      for (const [key, value] of Object.entries(frontmatter)) {
        // Skip system fields
        if (systemFields.includes(key)) {
          continue;
        }

        // Skip null/undefined values
        if (value === null || value === undefined) {
          continue;
        }

        // Check if field is read-only (formula, rollup, etc.)
        if (cachedFields) {
          const fieldInfo = cachedFields.find(f => f.name === key);
          if (fieldInfo && READ_ONLY_FIELD_TYPES.includes(fieldInfo.type as any)) {
            // Skip read-only fields - they should only be updated from Airtable
            continue;
          }
        }

        fieldsToSync[key] = value;
      }

      if (Object.keys(fieldsToSync).length === 0) {
        return null;
      }

      return { recordId, fields: fieldsToSync };
    } catch (error: any) {
      throw new Error(`Failed to prepare file for sync: ${error.message}`);
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

      // Skip conflict detection if obsidian-wins is selected (performance optimization)
      if (this.settings.conflictResolution === 'obsidian-wins') {
        return await this.makeRateLimitedRequest(() => 
          updateAirtableRecord(this.settings, recordId, fieldsToSync)
        );
      }

      // Handle conflicts for other resolution modes
      const conflicts = await this.detectConflicts(recordId, fieldsToSync, file.path);
      if (conflicts.length > 0) {
        return await this.handleConflicts(conflicts, fieldsToSync, recordId);
      }

      return await this.makeRateLimitedRequest(() => 
        updateAirtableRecord(this.settings, recordId, fieldsToSync)
      );
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
      // Fetch current Airtable record to compare values (with rate limiting)
      const url = `https://api.airtable.com/v0/${this.settings.baseId}/${this.settings.tableId}/${recordId}`;
      const response = await this.makeRateLimitedRequest(() => requestUrl({
        url: url,
        method: "GET",
        headers: {
          "Authorization": `Bearer ${this.settings.apiKey}`,
          "Content-Type": "application/json",
        },
      }));

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
    } catch (error: any) {
      new Notice(`Auto Note Importer: ⚠️ Unable to check for conflicts: ${error.message || 'Unknown error'}. Proceeding with sync.`);
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
        
        // Notify user about ignored conflicts
        if (conflicts.length > 0) {
          const conflictFields = conflicts.map(c => c.field).join(', ');
          new Notice(`Auto Note Importer: ⚠️ Conflicted fields ignored (Airtable wins): ${conflictFields}`);
        }
        
        if (Object.keys(nonConflictedFields).length > 0) {
          return await this.makeRateLimitedRequest(() => 
            updateAirtableRecord(this.settings, recordId, nonConflictedFields)
          );
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
        return await this.makeRateLimitedRequest(() => 
          updateAirtableRecord(this.settings, recordId, fieldsToSync)
        );
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

  /**
   * Cleans up non-existent files from pendingSyncFiles to prevent memory leaks.
   */
  private cleanupPendingSyncFiles(): void {
    const filesToRemove: string[] = [];
    
    for (const filePath of this.pendingSyncFiles) {
      const file = this.app.vault.getAbstractFileByPath(filePath);
      if (!(file instanceof TFile)) {
        filesToRemove.push(filePath);
      }
    }
    
    filesToRemove.forEach(filePath => {
      this.pendingSyncFiles.delete(filePath);
    });
  }

  /**
   * Makes a rate-limited request to prevent overwhelming the Airtable API.
   * @param requestFn Function that makes the actual request
   * @returns Promise resolving to the request result
   */
  private async makeRateLimitedRequest<T>(requestFn: () => Promise<T>): Promise<T> {
    const now = Date.now();
    const timeSinceLastRequest = now - this.rateLimiter.lastRequest;
    
    if (timeSinceLastRequest < this.rateLimiter.minInterval) {
      const delay = this.rateLimiter.minInterval - timeSinceLastRequest;
      await new Promise(resolve => setTimeout(resolve, delay));
    }
    
    this.rateLimiter.lastRequest = Date.now();
    return await requestFn();
  }
}