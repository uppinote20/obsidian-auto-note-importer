/**
 * File watcher for detecting changes in the sync folder.
 */

import type { App, EventRef } from "obsidian";
import { TFile, normalizePath, Notice } from "obsidian";
import { DEBUG_DELAY_MULTIPLIER } from '../constants';
import type { AutoNoteImporterSettings } from '../types';

/**
 * Callback type for when files are ready to sync.
 */
export type FilesReadyCallback = (files: TFile[]) => Promise<void>;

/**
 * Watches for file changes and triggers sync callbacks.
 */
export class FileWatcher {
  private app: App;
  private settings: AutoNoteImporterSettings;
  private pendingFiles: Set<string> = new Set();
  private debounceTimer: NodeJS.Timeout | null = null;
  private onFilesReady: FilesReadyCallback;
  private eventRef: EventRef | null = null;
  private externalSyncing = false;
  private internalSyncing = false;

  constructor(
    app: App,
    settings: AutoNoteImporterSettings,
    onFilesReady: FilesReadyCallback
  ) {
    this.app = app;
    this.settings = settings;
    this.onFilesReady = onFilesReady;
  }

  /**
   * Updates the settings reference.
   */
  updateSettings(settings: AutoNoteImporterSettings): void {
    this.settings = settings;
  }

  /**
   * Sets the external syncing state (called by main.ts during pull sync).
   */
  setSyncing(syncing: boolean): void {
    this.externalSyncing = syncing;
  }

  /**
   * Checks if currently syncing (external or internal).
   */
  get syncing(): boolean {
    return this.externalSyncing || this.internalSyncing;
  }

  /**
   * Sets up file watching for the sync folder.
   */
  setup(): void {
    if (!this.settings.bidirectionalSync || !this.settings.watchForChanges) {
      return;
    }

    this.eventRef = this.app.vault.on('modify', (file) => {
      if (file instanceof TFile && file.extension === 'md') {
        this.handleFileChange(file);
      }
    });
  }

  /**
   * Tears down the file watcher.
   */
  teardown(): void {
    if (this.eventRef) {
      this.app.vault.offref(this.eventRef);
      this.eventRef = null;
    }
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
  }

  /**
   * Handles a file change event.
   */
  private handleFileChange(file: TFile): void {
    if (this.syncing) return;

    const folderPath = normalizePath(this.settings.folderPath);

    if (!file.path.startsWith(folderPath + '/')) {
      return;
    }

    this.pendingFiles.add(file.path);
    this.scheduleSync();
  }

  /**
   * Calculates debounce time based on settings and debug mode.
   */
  private getDebounceTime(): number {
    const baseDebounce = this.settings.fileWatchDebounce;
    return this.settings.debugMode
      ? baseDebounce * DEBUG_DELAY_MULTIPLIER
      : baseDebounce;
  }

  /**
   * Schedules a debounced sync operation.
   */
  private scheduleSync(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }

    this.debounceTimer = setTimeout(async () => {
      if (!this.syncing && this.pendingFiles.size > 0) {
        this.internalSyncing = true;
        try {
          const files = this.getPendingFiles();
          await this.onFilesReady(files);
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Unknown error';
          new Notice(`Auto Note Importer: File sync failed: ${message}`);
        } finally {
          this.pendingFiles.clear();
          this.internalSyncing = false;
        }
      }
    }, this.getDebounceTime());
  }

  /**
   * Gets all pending files as TFile references (resolves paths via vault).
   */
  getPendingFiles(): TFile[] {
    const files: TFile[] = [];
    for (const filePath of this.pendingFiles) {
      const file = this.app.vault.getAbstractFileByPath(filePath);
      if (file instanceof TFile) {
        files.push(file);
      }
    }
    return files;
  }

  /**
   * Clears all pending files.
   */
  clearPending(): void {
    this.pendingFiles.clear();
  }
}
