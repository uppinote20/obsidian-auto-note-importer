/**
 * Configuration entry type definitions for multi-config support.
 *
 * @handbook 9.8-multi-config-architecture
 */

import type { ConflictResolutionMode, BasesFileLocation } from './settings.types';
import type { RateLimiter } from '../services/rate-limiter';
import type { FieldCache } from '../services/field-cache';
import type { SeaTableMetadataCache } from '../services/seatable-metadata-cache';
import type { SupabaseMetadataCache } from '../services/supabase-metadata-cache';
import type { FrontmatterParser } from '../file-operations/frontmatter-parser';

export interface SharedServices {
  rateLimiters: Map<string, RateLimiter>;
  fieldCache: FieldCache;
  seatableMetadataCache: SeaTableMetadataCache;
  supabaseMetadataCache: SupabaseMetadataCache;
  frontmatterParser: FrontmatterParser;
  statusBarFactory: () => HTMLElement;
  getDebugMode: () => boolean;
}

export interface ConfigEntry {
  id: string;
  name: string;
  enabled: boolean;
  credentialId: string;

  baseId: string;
  tableId: string;
  viewId: string;

  /**
   * Primary key column name (Supabase provider only).
   * Airtable/SeaTable encode the PK as the immutable record id and ignore
   * this field. Default empty; settings UI auto-fills from OpenAPI on
   * connect, user can override.
   */
  primaryKeyColumn: string;

  folderPath: string;
  templatePath: string;
  filenameFieldName: string;
  subfolderFieldName: string;

  syncInterval: number;
  allowOverwrite: boolean;
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
}

export const DEFAULT_CONFIG_ENTRY: Omit<ConfigEntry, 'id' | 'name' | 'credentialId'> = {
  enabled: true,
  baseId: '',
  tableId: '',
  viewId: '',
  primaryKeyColumn: '',
  folderPath: '',
  templatePath: '',
  filenameFieldName: '',
  subfolderFieldName: '',
  syncInterval: 0,
  allowOverwrite: true,
  bidirectionalSync: false,
  conflictResolution: 'manual',
  watchForChanges: false,
  fileWatchDebounce: 2000,
  autoSyncComputedFields: false,
  formulaSyncDelay: 1500,
  generateBasesFile: false,
  basesFileLocation: 'vault-root',
  basesCustomPath: '',
  basesRegenerateOnSync: false,
};
