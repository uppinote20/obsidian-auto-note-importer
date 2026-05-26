/**
 * Settings type definitions for the Auto Note Importer plugin.
 * @handbook 9.3-settings-update-pattern
 */

import type { Credential } from './credential.types';
import type { ConfigEntry } from './config.types';

/**
 * Conflict resolution modes for bidirectional sync.
 * `remote-wins` was named `airtable-wins` in settings v2; v3 migration renames it.
 */
export type ConflictResolutionMode = 'obsidian-wins' | 'remote-wins' | 'manual';

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
 * @deprecated Use AutoNoteImporterSettings (v3 multi-config) for plugin-level settings.
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
  subfolderTreatSlashAsLiteral: boolean;
  bidirectionalSync: boolean;
  conflictResolution: ConflictResolutionMode;
  watchForChanges: boolean;
  fileWatchDebounce: number;
  autoSyncComputedFields: boolean;
  formulaSyncDelay: number;
  generateBasesFile: boolean;
  basesFileLocation: BasesFileLocation;
  basesCustomPath: string;
  basesRegenerateOnSync: boolean;
  debugMode: boolean;
}

/**
 * Plugin settings interface (v3 multi-config with provider-agnostic field names).
 *
 * Version history:
 *   v1 (no version field): legacy single-config flat shape
 *   v2: multi-config (`credentials[]` + `configs[]`)
 *   v3: rename `autoSyncFormulas` → `autoSyncComputedFields`, `airtable-wins` → `remote-wins`
 */
export interface AutoNoteImporterSettings {
  version: 3;
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
  subfolderTreatSlashAsLiteral: false,
  bidirectionalSync: false,
  conflictResolution: 'manual',
  watchForChanges: true,
  fileWatchDebounce: 2000,
  autoSyncComputedFields: true,
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
  version: 3,
  credentials: [],
  configs: [],
  activeConfigId: '',
  debugMode: false,
};
