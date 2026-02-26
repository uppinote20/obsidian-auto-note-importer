/**
 * Settings type definitions for the Auto Note Importer plugin.
 */

/**
 * Conflict resolution modes for bidirectional sync.
 */
export type ConflictResolutionMode = 'obsidian-wins' | 'airtable-wins' | 'manual';

/**
 * Sync scope options for determining which files to sync.
 */
export type SyncScope = 'current' | 'modified' | 'all';

/**
 * Plugin settings interface.
 */
export interface AutoNoteImporterSettings {
  apiKey: string;
  baseId: string;
  tableId: string;
  folderPath: string;
  templatePath: string;
  syncInterval: number;
  allowOverwrite: boolean;
  filenameFieldName: string;
  subfolderFieldName: string;
  bidirectionalSync: boolean;
  conflictResolution: ConflictResolutionMode;
  watchForChanges: boolean;
  fileWatchDebounce: number;
  autoSyncFormulas: boolean;
  formulaSyncDelay: number;
  debugMode: boolean;
}

/**
 * Default values for the plugin settings.
 */
export const DEFAULT_SETTINGS: AutoNoteImporterSettings = {
  apiKey: "",
  baseId: "",
  tableId: "",
  folderPath: "Crawling",
  templatePath: "",
  syncInterval: 0,
  allowOverwrite: false,
  filenameFieldName: "title",
  subfolderFieldName: "",
  bidirectionalSync: false,
  conflictResolution: 'manual',
  watchForChanges: true,
  fileWatchDebounce: 2000,
  autoSyncFormulas: true,
  formulaSyncDelay: 1500,
  debugMode: false,
};
