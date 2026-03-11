/**
 * Settings type definitions for the Auto Note Importer plugin.
 * @handbook 9.3-settings-update-pattern
 */

/**
 * Conflict resolution modes for bidirectional sync.
 */
export type ConflictResolutionMode = 'obsidian-wins' | 'airtable-wins' | 'manual';

/**
 * Location options for the generated Bases database file.
 */
export type BasesFileLocation = 'vault-root' | 'synced-folder' | 'custom';

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
  generateBasesFile: boolean;
  basesFileLocation: BasesFileLocation;
  basesCustomPath: string;
  basesRegenerateOnSync: boolean;
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
  generateBasesFile: true,
  basesFileLocation: 'vault-root',
  basesCustomPath: '',
  basesRegenerateOnSync: false,
  debugMode: false,
};
