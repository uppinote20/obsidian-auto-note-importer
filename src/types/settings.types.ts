/**
 * Settings type definitions for the Auto Note Importer plugin.
 * @handbook 9.3-settings-update-pattern
 */

import type { Credential } from './credential.types';
import type { ConfigEntry } from './config.types';

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
 * Legacy single-config settings interface.
 * Used by services internally via ConfigInstance.buildSettingsFromConfig().
 * @deprecated Use AutoNoteImporterSettings (v2 multi-config) for plugin-level settings.
 */
export interface LegacySettings {
  apiKey: string;
  baseId: string;
  tableId: string;
  viewId: string;
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
 * Plugin settings interface (v2 multi-config).
 */
export interface AutoNoteImporterSettings {
  version: 2;
  credentials: Credential[];
  configs: ConfigEntry[];
  activeConfigId: string;
  debugMode: boolean;
}

/**
 * Default values for the legacy per-config settings.
 * Used by services and tests that construct LegacySettings objects.
 */
export const DEFAULT_LEGACY_SETTINGS: LegacySettings = {
  apiKey: '',
  baseId: '',
  tableId: '',
  viewId: '',
  folderPath: 'Crawling',
  templatePath: '',
  syncInterval: 0,
  allowOverwrite: false,
  filenameFieldName: 'title',
  subfolderFieldName: '',
  bidirectionalSync: false,
  conflictResolution: 'manual',
  watchForChanges: true,
  fileWatchDebounce: 2000,
  autoSyncFormulas: true,
  formulaSyncDelay: 1500,
  generateBasesFile: false,
  basesFileLocation: 'vault-root',
  basesCustomPath: '',
  basesRegenerateOnSync: false,
  debugMode: false,
};

/**
 * Default values for the plugin settings.
 */
export const DEFAULT_SETTINGS: AutoNoteImporterSettings = {
  version: 2,
  credentials: [],
  configs: [],
  activeConfigId: '',
  debugMode: false,
};
