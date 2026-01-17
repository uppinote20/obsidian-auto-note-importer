/**
 * File watcher for detecting changes in the sync folder.
 */

import type { App, TFile, EventRef } from "obsidian";
import { normalizePath } from "obsidian";
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
  private isSyncing = false;

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
   * Sets the syncing state.
   */
  setSyncing(syncing: boolean): void {
    this.isSyncing = syncing;
  }

  /**
   * Checks if currently syncing.
   */
  get syncing(): boolean {
    return this.isSyncing;
  }

  /**
   * Sets up file watching for the sync folder.
   */
  setup(): void {
    if (!this.settings.bidirectionalSync || !this.settings.watchForChanges) {
      return;
    }

    this.eventRef = this.app.vault.on('modify', (file) => {
      if ('extension' in file && (file as TFile).extension === 'md') {
        this.handleFileChange(file as TFile);
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
    const folderPath = normalizePath(this.settings.folderPath);

    // Check if the file is in our target folder
    if (!file.path.startsWith(folderPath)) {
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
      if (!this.isSyncing && this.pendingFiles.size > 0) {
        this.isSyncing = true;
        try {
          const files = this.getPendingFiles();
          await this.onFilesReady(files);
        } finally {
          this.isSyncing = false;
        }
      }
    }, this.getDebounceTime());
  }

  /**
   * Gets all pending files and clears the pending set.
   */
  getPendingFiles(): TFile[] {
    const files: TFile[] = [];
    for (const filePath of this.pendingFiles) {
      const file = this.app.vault.getAbstractFileByPath(filePath);
      if (file && 'extension' in file) {
        files.push(file as TFile);
      }
    }
    return files;
  }

  /**
   * Adds a file to the pending set.
   */
  addPendingFile(path: string): void {
    this.pendingFiles.add(path);
  }

  /**
   * Removes a file from the pending set.
   */
  removePendingFile(path: string): void {
    this.pendingFiles.delete(path);
  }

  /**
   * Clears all pending files.
   */
  clearPending(): void {
    this.pendingFiles.clear();
  }

  /**
   * Gets the count of pending files.
   */
  get pendingCount(): number {
    return this.pendingFiles.size;
  }

  /**
   * Cleans up non-existent files from the pending set.
   */
  cleanup(): void {
    const toRemove: string[] = [];

    for (const filePath of this.pendingFiles) {
      const file = this.app.vault.getAbstractFileByPath(filePath);
      if (!file || !('extension' in file)) {
        toRemove.push(filePath);
      }
    }

    toRemove.forEach(path => this.pendingFiles.delete(path));
  }
}
