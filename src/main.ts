/**
 * Auto Note Importer - Main Plugin Entry Point
 *
 * Orchestrates Airtable <-> Obsidian sync via services, core logic, and file operations.
 */

import { Plugin, Notice } from "obsidian";
import type { AutoNoteImporterSettings, SyncMode, SyncScope } from './types';
import { DEFAULT_SETTINGS } from './types';
import { AirtableClient, FieldCache, RateLimiter } from './services';
import { SyncQueue, ConflictResolver, SyncOrchestrator } from './core';
import { FrontmatterParser, FileWatcher } from './file-operations';
import { AutoNoteImporterSettingTab } from './ui';

/**
 * Main plugin class for Auto Note Importer.
 */
export default class AutoNoteImporterPlugin extends Plugin {
  settings: AutoNoteImporterSettings;
  private intervalId: number | null = null;
  private settingTab: AutoNoteImporterSettingTab;

  // Services
  private airtableClient: AirtableClient;
  private fieldCache: FieldCache;
  private rateLimiter: RateLimiter;

  // Core
  private syncQueue: SyncQueue;
  private conflictResolver: ConflictResolver;
  private syncOrchestrator: SyncOrchestrator;

  // File Operations
  private frontmatterParser: FrontmatterParser;
  private fileWatcher: FileWatcher;

  async onload() {
    await this.loadSettings();
    this.initializeServices();
    this.registerCommands();
    this.startScheduler();
  }

  /**
   * Initializes all service instances.
   */
  private initializeServices(): void {
    this.rateLimiter = new RateLimiter();
    this.rateLimiter.setDebugMode(this.settings.debugMode);
    this.fieldCache = new FieldCache();
    this.airtableClient = new AirtableClient(this.settings, this.rateLimiter);

    this.frontmatterParser = new FrontmatterParser(this.app);
    this.conflictResolver = new ConflictResolver(this.settings, this.airtableClient);

    this.fileWatcher = new FileWatcher(
      this.app,
      this.settings,
      async (files) => {
        const mode: SyncMode = this.settings.autoSyncFormulas ? 'bidirectional' : 'to-airtable';
        await this.syncQueue.enqueue(mode, 'modified', files.map(f => f.path));
      }
    );

    this.syncOrchestrator = new SyncOrchestrator(
      this.app,
      this.settings,
      this.airtableClient,
      this.fieldCache,
      this.frontmatterParser,
      this.fileWatcher,
      this.conflictResolver,
      { createItem: () => this.addStatusBarItem() }
    );

    this.syncQueue = new SyncQueue(
      ({ mode, scope, filePaths }) => this.syncOrchestrator.processSyncRequest(mode, scope, filePaths),
      (error) => {
        const message = error instanceof Error ? error.message : 'Unknown error';
        new Notice(`Auto Note Importer: Sync failed: ${message}`);
      }
    );

    this.fileWatcher.setup();

    this.settingTab = new AutoNoteImporterSettingTab(this.app, this, this.fieldCache);
    this.addSettingTab(this.settingTab);
  }

  /**
   * Registers all plugin commands.
   * Commands requiring bidirectional sync use checkCallback to hide when disabled.
   */
  private registerCommands(): void {
    this.addCommand({
      id: "sync-current-from-airtable",
      name: "Sync current note from Airtable",
      callback: () => this.syncQueue.enqueue('from-airtable', 'current')
    });

    this.addCommand({
      id: "sync-all-from-airtable",
      name: "Sync all notes from Airtable",
      callback: () => this.syncQueue.enqueue('from-airtable', 'all')
    });

    this.addBidirectionalCommand("sync-current-to-airtable", "Sync current note to Airtable", 'to-airtable', 'current');
    this.addBidirectionalCommand("sync-modified-to-airtable", "Sync modified notes to Airtable", 'to-airtable', 'modified');
    this.addBidirectionalCommand("sync-all-to-airtable", "Sync all notes to Airtable", 'to-airtable', 'all');
    this.addBidirectionalCommand("bidirectional-sync-current", "Bidirectional sync current note (with formulas)", 'bidirectional', 'current');
    this.addBidirectionalCommand("bidirectional-sync-modified", "Bidirectional sync modified notes (with formulas)", 'bidirectional', 'modified');
    this.addBidirectionalCommand("bidirectional-sync-all", "Bidirectional sync all notes (with formulas)", 'bidirectional', 'all');
  }

  private addBidirectionalCommand(id: string, name: string, mode: SyncMode, scope: SyncScope): void {
    this.addCommand({
      id,
      name,
      checkCallback: (checking) => {
        if (!this.settings.bidirectionalSync) return false;
        if (!checking) this.syncQueue.enqueue(mode, scope);
        return true;
      }
    });
  }

  /**
   * Starts the automatic sync scheduler.
   */
  startScheduler(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
    }

    if (this.settings.syncInterval > 0) {
      this.intervalId = window.setInterval(
        () => this.syncQueue.enqueue('from-airtable', 'all'),
        this.settings.syncInterval * 60 * 1000
      );
    }
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);

    // Update service settings
    this.rateLimiter?.setDebugMode(this.settings.debugMode);
    this.airtableClient?.updateSettings(this.settings);
    this.conflictResolver?.updateSettings(this.settings);
    this.syncOrchestrator?.updateSettings(this.settings);

    // Reconfigure file watcher (applies watchForChanges setting without reload)
    if (this.fileWatcher) {
      this.fileWatcher.teardown();
      this.fileWatcher.updateSettings(this.settings);
      this.fileWatcher.setup();
    }
  }

  onunload(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
    }
    this.fileWatcher?.teardown();
  }
}
