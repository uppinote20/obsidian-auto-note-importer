/**
 * Sync Orchestrator - Coordinates all sync operations between Airtable and Obsidian.
 *
 * Extracted from main.ts to separate sync orchestration from plugin lifecycle management.
 */

import { App, TFile, TFolder, normalizePath, Notice, MarkdownView } from "obsidian";
import type { AutoNoteImporterSettings, RemoteNote, BatchUpdate, SyncMode, SyncScope, NoteCreationResult } from '../types';
import { AIRTABLE_BATCH_SIZE, DEBUG_DELAY_MULTIPLIER } from '../constants';
import { AirtableClient, FieldCache } from '../services';
import { ConflictResolver } from './conflict-resolver';
import { FrontmatterParser, FileWatcher } from '../file-operations';
import { parseTemplate, buildMarkdownContent } from '../builders';
import { sanitizeFileName, sanitizeFolderPath, validateAndSanitizeFilename } from '../utils';

export interface StatusBarHandle {
  setText(text: string): void;
  remove(): void;
}

export interface StatusBarController {
  createItem(): StatusBarHandle;
}

export class SyncOrchestrator {
  private app: App;
  private settings: AutoNoteImporterSettings;
  private airtableClient: AirtableClient;
  private fieldCache: FieldCache;
  private frontmatterParser: FrontmatterParser;
  private fileWatcher: FileWatcher;
  private conflictResolver: ConflictResolver;
  private statusBar: StatusBarController;

  constructor(
    app: App,
    settings: AutoNoteImporterSettings,
    airtableClient: AirtableClient,
    fieldCache: FieldCache,
    frontmatterParser: FrontmatterParser,
    fileWatcher: FileWatcher,
    conflictResolver: ConflictResolver,
    statusBar: StatusBarController
  ) {
    this.app = app;
    this.settings = settings;
    this.airtableClient = airtableClient;
    this.fieldCache = fieldCache;
    this.frontmatterParser = frontmatterParser;
    this.fileWatcher = fileWatcher;
    this.conflictResolver = conflictResolver;
    this.statusBar = statusBar;
  }

  updateSettings(settings: AutoNoteImporterSettings): void {
    this.settings = settings;
  }

  async processSyncRequest(mode: SyncMode, scope: SyncScope, filePaths?: string[]): Promise<void> {
    const statusBarItem = this.statusBar.createItem();

    try {
      const files = filePaths
        ? filePaths.map(p => this.app.vault.getAbstractFileByPath(p)).filter((f): f is TFile => f instanceof TFile)
        : await this.getFilesToSync(scope);

      if (files.length === 0 && mode !== 'from-airtable') {
        new Notice(`Auto Note Importer: No files to sync for scope: ${scope}`);
        return;
      }

      switch (mode) {
        case 'to-airtable':
          statusBarItem.setText(`Syncing ${files.length} file(s) to Airtable...`);
          await this.syncFilesToAirtable(files);
          new Notice(`Auto Note Importer: Synced ${files.length} file(s) to Airtable`);
          break;

        case 'from-airtable':
          if (scope === 'current') {
            statusBarItem.setText("Syncing current note from Airtable...");
            await this.syncCurrentFromAirtable();
          } else {
            statusBarItem.setText("Syncing from Airtable...");
            await this.syncFromAirtable();
          }
          break;

        case 'bidirectional':
          statusBarItem.setText(`Phase 1/2 - Syncing ${files.length} file(s) to Airtable...`);
          await this.syncFilesToAirtable(files);

          if (this.settings.autoSyncFormulas) {
            const delay = this.settings.debugMode
              ? this.settings.formulaSyncDelay * DEBUG_DELAY_MULTIPLIER
              : this.settings.formulaSyncDelay;
            statusBarItem.setText(`Waiting ${delay}ms for formulas...`);
            await this.sleep(delay);

            statusBarItem.setText("Phase 2/2 - Fetching computed results...");
            await this.syncFromAirtable();
            new Notice("Auto Note Importer: Bidirectional sync complete!");
          } else {
            new Notice(`Auto Note Importer: Synced ${files.length} file(s) to Airtable`);
          }
          break;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      new Notice(`Auto Note Importer: Sync failed: ${message}`);
    } finally {
      statusBarItem.remove();
    }
  }

  private async getFilesToSync(scope: SyncScope): Promise<TFile[]> {
    const folderPath = normalizePath(this.settings.folderPath);

    switch (scope) {
      case 'current': {
        const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (!activeView?.file) {
          throw new Error("No active markdown file");
        }
        if (!activeView.file.path.startsWith(folderPath + '/')) {
          throw new Error("Current file is not in the sync folder");
        }
        return [activeView.file];
      }

      case 'modified': {
        return this.fileWatcher.getPendingFiles();
      }

      case 'all': {
        const folder = this.app.vault.getAbstractFileByPath(folderPath);
        if (!(folder instanceof TFolder)) {
          throw new Error("Sync folder not found");
        }
        return this.collectMarkdownFiles(folder);
      }

      default: {
        const _exhaustive: never = scope;
        throw new Error(`Unknown sync scope: ${_exhaustive}`);
      }
    }
  }

  private collectMarkdownFiles(folder: TFolder): TFile[] {
    const files: TFile[] = [];
    for (const child of folder.children) {
      if (child instanceof TFile && child.extension === 'md') {
        files.push(child);
      } else if (child instanceof TFolder) {
        files.push(...this.collectMarkdownFiles(child));
      }
    }
    return files;
  }

  private async syncCurrentFromAirtable(): Promise<void> {
    const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!activeView?.file) {
      new Notice("Auto Note Importer: No active markdown file");
      return;
    }

    const file = activeView.file;
    const folderPath = normalizePath(this.settings.folderPath);
    if (!file.path.startsWith(folderPath + '/')) {
      new Notice("Auto Note Importer: Current file is not in the sync folder");
      return;
    }

    const recordId = this.frontmatterParser.getRecordId(file);
    if (!recordId) {
      new Notice("Auto Note Importer: No primaryField found in current file");
      return;
    }

    this.fileWatcher.setSyncing(true);
    try {
      const remoteNote = await this.airtableClient.fetchRecord(recordId);
      if (!remoteNote) {
        new Notice("Auto Note Importer: Record not found in Airtable");
        return;
      }

      const result = await this.createNoteFromRemote(remoteNote);
      if (result === "updated") {
        new Notice("Auto Note Importer: Current note updated from Airtable");
      } else if (result === "skipped") {
        new Notice("Auto Note Importer: No changes detected");
      }
    } finally {
      this.fileWatcher.clearPending();
      this.fileWatcher.setSyncing(false);
    }
  }

  private async syncFromAirtable(): Promise<void> {
    const folderPath = normalizePath(this.settings.folderPath);
    if (!await this.app.vault.adapter.exists(folderPath)) {
      await this.app.vault.createFolder(folderPath);
    }

    this.fileWatcher.setSyncing(true);
    try {
      const remoteNotes = await this.airtableClient.fetchNotes();

      let existingPrimaryFields: Set<string> | null = null;
      if (!this.settings.allowOverwrite) {
        existingPrimaryFields = await this.frontmatterParser.loadExistingPrimaryFields(folderPath);
      }

      let createdCount = 0;
      let updatedCount = 0;
      let skippedCount = 0;
      let errorCount = 0;

      for (const note of remoteNotes) {
        const shouldProcess = this.settings.allowOverwrite ||
          !existingPrimaryFields?.has(note.primaryField);

        if (shouldProcess) {
          const result = await this.createNoteFromRemote(note);
          if (result === "created") createdCount++;
          else if (result === "updated") updatedCount++;
          else if (result === "error") errorCount++;
        } else {
          skippedCount++;
        }
      }

      let summary = `Auto Note Importer: Sync complete: ${createdCount} created, ${updatedCount} updated.`;
      if (skippedCount > 0) summary += ` (${skippedCount} skipped)`;
      if (errorCount > 0) summary += ` (${errorCount} errors)`;
      new Notice(summary);
    } finally {
      this.fileWatcher.clearPending();
      this.fileWatcher.setSyncing(false);
    }
  }

  private async createNoteFromRemote(note: RemoteNote): Promise<NoteCreationResult> {
    const safeTitle = this.determineFilename(note);
    const finalFolderPath = this.determineFolderPath(note);
    const folderPath = normalizePath(finalFolderPath);

    if (!await this.app.vault.adapter.exists(folderPath)) {
      await this.app.vault.createFolder(folderPath);
    }

    const filePath = normalizePath(`${folderPath}/${safeTitle}.md`);
    const existingFile = this.app.vault.getAbstractFileByPath(filePath);

    if (existingFile instanceof TFile && !this.settings.allowOverwrite) {
      return "skipped";
    }

    let content = await this.buildNoteContent(note);
    content = this.frontmatterParser.ensurePrimaryField(content, note.primaryField);

    try {
      if (existingFile instanceof TFile) {
        const currentContent = await this.app.vault.read(existingFile);
        if (currentContent !== content) {
          await this.app.vault.modify(existingFile, content);
          return "updated";
        }
        return "skipped";
      } else {
        await this.app.vault.create(filePath, content);
        return "created";
      }
    } catch {
      new Notice(`Auto Note Importer: Failed to save note: ${safeTitle}`);
      return "error";
    }
  }

  private determineFilename(note: RemoteNote): string {
    if (!this.settings.filenameFieldName ||
        !Object.prototype.hasOwnProperty.call(note.fields, this.settings.filenameFieldName)) {
      return note.primaryField;
    }

    const rawValue = note.fields[this.settings.filenameFieldName];

    try {
      const cacheKey = this.fieldCache.getCacheKey(this.settings.baseId, this.settings.tableId);
      const fieldInfo = this.fieldCache.getField(cacheKey, this.settings.filenameFieldName);

      if (fieldInfo?.type === 'formula') {
        const validated = validateAndSanitizeFilename(rawValue);
        if (validated) return validated;
        new Notice(`Auto Note Importer: Invalid filename from Formula field. Using record ID.`);
        return note.primaryField;
      }
    } catch (error) {
      if (this.settings.debugMode) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        new Notice(`Auto Note Importer: Filename field error: ${message}`);
      }
    }

    return sanitizeFileName(String(rawValue)) || note.primaryField;
  }

  private determineFolderPath(note: RemoteNote): string {
    const subfolderValue = this.settings.subfolderFieldName
      ? note.fields[this.settings.subfolderFieldName]
      : null;

    const sanitized = subfolderValue != null
      ? sanitizeFolderPath(String(subfolderValue).trim())
      : '';

    if (!sanitized) {
      return this.settings.folderPath;
    }

    return `${this.settings.folderPath}/${sanitized}`;
  }

  private async buildNoteContent(note: RemoteNote): Promise<string> {
    if (this.settings.templatePath) {
      const templateFile = this.app.vault.getAbstractFileByPath(
        normalizePath(this.settings.templatePath)
      );
      if (templateFile instanceof TFile) {
        try {
          const templateContent = await this.app.vault.read(templateFile);
          return parseTemplate(templateContent, note);
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Unknown error';
          new Notice(`Auto Note Importer: Template error: ${message}. Using default format.`);
        }
      }
    }
    return buildMarkdownContent(note);
  }

  private async syncFilesToAirtable(files: TFile[]): Promise<void> {
    const cacheKey = this.fieldCache.getCacheKey(this.settings.baseId, this.settings.tableId);

    let cachedFields = this.fieldCache.getFields(cacheKey);
    if (!cachedFields && this.settings.apiKey && this.settings.baseId && this.settings.tableId) {
      try {
        cachedFields = await this.fieldCache.fetchFields(
          this.settings.apiKey,
          this.settings.baseId,
          this.settings.tableId
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        new Notice(`Auto Note Importer: Field metadata unavailable: ${message}`);
      }
    }

    const batchUpdates: BatchUpdate[] = [];
    let errorCount = 0;
    const skipConflictDetection = this.conflictResolver.shouldSkipConflictDetection();

    for (const file of files) {
      const recordId = this.frontmatterParser.getRecordId(file);
      if (!recordId) {
        if (this.settings.debugMode) {
          new Notice(`Auto Note Importer: Skipping ${file.name} (no primaryField)`);
        }
        continue;
      }

      const fields = this.frontmatterParser.extractSyncableFields(file, cachedFields);
      if (!fields) continue;

      if (!skipConflictDetection) {
        try {
          const conflicts = await this.conflictResolver.detectConflicts(recordId, fields, file.path);
          if (conflicts.length > 0) {
            const result = await this.conflictResolver.resolve(conflicts, fields, recordId);
            if (!result.success) {
              errorCount++;
            }
            continue;
          }
        } catch (error) {
          errorCount++;
          if (this.settings.debugMode) {
            const message = error instanceof Error ? error.message : 'Unknown error';
            new Notice(`Auto Note Importer: Conflict check failed for ${file.name}: ${message}`);
          }
          continue;
        }
      }

      batchUpdates.push({ recordId, fields });
    }

    let syncedCount = 0;

    for (let i = 0; i < batchUpdates.length; i += AIRTABLE_BATCH_SIZE) {
      const batch = batchUpdates.slice(i, i + AIRTABLE_BATCH_SIZE);

      try {
        const results = await this.airtableClient.batchUpdate(batch);
        const failureErrors: string[] = [];
        for (const result of results) {
          if (result.success) {
            syncedCount++;
          } else {
            errorCount++;
            failureErrors.push(result.error);
          }
        }
        if (failureErrors.length > 0) {
          new Notice(`Auto Note Importer: Batch errors: ${failureErrors.join('; ')}`);
        }
      } catch (error) {
        errorCount += batch.length;
        const message = error instanceof Error ? error.message : 'Unknown error';
        new Notice(`Auto Note Importer: Batch update failed: ${message}`);
      }
    }

    if (errorCount > 0) {
      new Notice(`Auto Note Importer: ${syncedCount} synced, ${errorCount} errors`);
    }

    this.fileWatcher.clearPending();
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
