/**
 * Settings migration utility for upgrading legacy settings to the current version.
 *
 * @handbook 9.9-settings-migration
 * @tested tests/utils/migration.test.ts
 */

import type { Credential } from '../types/credential.types';
import type { ConfigEntry } from '../types/config.types';
import type { AutoNoteImporterSettings, ConflictResolutionMode } from '../types/settings.types';
import { generateId } from './object-utils';

const CURRENT_VERSION = 3 as const;

const VALID_CONFLICT_MODES: readonly ConflictResolutionMode[] = ['obsidian-wins', 'remote-wins', 'manual'];

/**
 * Normalizes a possibly-legacy conflictResolution value to the current `ConflictResolutionMode`.
 * v2 used `'airtable-wins'`; v3 uses `'remote-wins'`. Unknown values fall back to `'manual'`.
 */
function migrateConflictResolution(value: unknown): ConflictResolutionMode {
  if (typeof value === 'string' && (VALID_CONFLICT_MODES as readonly string[]).includes(value)) {
    return value as ConflictResolutionMode;
  }
  // v2 → v3 rename

  if (value === 'airtable-wins') {
    return 'remote-wins';
  }
  return 'manual';
}

/**
 * Reads a possibly-legacy `autoSyncComputedFields` value (named `autoSyncFormulas` in v2).
 */
function readAutoSyncComputedFields(record: Record<string, unknown>, fallback: boolean): boolean {
  const v3 = record['autoSyncComputedFields'];
  if (typeof v3 === 'boolean') return v3;
  const v2 = record['autoSyncFormulas'];
  if (typeof v2 === 'boolean') return v2;
  return fallback;
}

/**
 * Migrates settings data to the current version.
 *
 * - Returns null for null/undefined input (fresh install, no migration needed).
 * - Returns null if data is already at the current version OR a future version
 *   (downgrades are refused; caller falls back to defaults to avoid corruption).
 * - v2 → v3: rename `autoSyncFormulas` → `autoSyncComputedFields` and `airtable-wins` → `remote-wins` per config; bump version.
 * - v1 / unknown → v3: convert flat legacy single-config layout to multi-config with current field names.
 *
 * @param data - Raw settings data loaded from plugin storage (unknown type)
 * @returns Migrated settings, or null if migration is not applicable
 */
export function migrateSettings(data: unknown): AutoNoteImporterSettings | null {
  if (data == null || typeof data !== 'object') {
    return null;
  }

  const record = data as Record<string, unknown>;
  const versionRaw = record['version'];
  const version = typeof versionRaw === 'number' ? versionRaw : 0;

  if (version >= CURRENT_VERSION) {
    return null;
  }

  if (version === 2) {
    return migrateV2toV3(record);
  }

  return migrateLegacyToV3(record);
}

function buildConfigFromRecord(
  raw: Record<string, unknown>,
  fallbackId: string,
): ConfigEntry {
  return {
    id: typeof raw['id'] === 'string' ? raw['id'] : fallbackId,
    name: typeof raw['name'] === 'string' ? raw['name'] : 'Default',
    enabled: typeof raw['enabled'] === 'boolean' ? raw['enabled'] : true,
    credentialId: typeof raw['credentialId'] === 'string' ? raw['credentialId'] : '',
    baseId: typeof raw['baseId'] === 'string' ? raw['baseId'] : '',
    tableId: typeof raw['tableId'] === 'string' ? raw['tableId'] : '',
    viewId: typeof raw['viewId'] === 'string' ? raw['viewId'] : '',
    folderPath: typeof raw['folderPath'] === 'string' ? raw['folderPath'] : '',
    templatePath: typeof raw['templatePath'] === 'string' ? raw['templatePath'] : '',
    filenameFieldName: typeof raw['filenameFieldName'] === 'string' ? raw['filenameFieldName'] : '',
    subfolderFieldName: typeof raw['subfolderFieldName'] === 'string' ? raw['subfolderFieldName'] : '',
    syncInterval: typeof raw['syncInterval'] === 'number' ? raw['syncInterval'] : 0,
    allowOverwrite: typeof raw['allowOverwrite'] === 'boolean' ? raw['allowOverwrite'] : true,
    bidirectionalSync: typeof raw['bidirectionalSync'] === 'boolean' ? raw['bidirectionalSync'] : false,
    conflictResolution: migrateConflictResolution(raw['conflictResolution']),
    watchForChanges: typeof raw['watchForChanges'] === 'boolean' ? raw['watchForChanges'] : false,
    fileWatchDebounce: typeof raw['fileWatchDebounce'] === 'number' ? raw['fileWatchDebounce'] : 2000,
    autoSyncComputedFields: readAutoSyncComputedFields(raw, false),
    formulaSyncDelay: typeof raw['formulaSyncDelay'] === 'number' ? raw['formulaSyncDelay'] : 1500,
    generateBasesFile: typeof raw['generateBasesFile'] === 'boolean' ? raw['generateBasesFile'] : false,
    basesFileLocation: (raw['basesFileLocation'] === 'synced-folder' || raw['basesFileLocation'] === 'custom')
      ? raw['basesFileLocation']
      : 'vault-root',
    basesCustomPath: typeof raw['basesCustomPath'] === 'string' ? raw['basesCustomPath'] : '',
    basesRegenerateOnSync: typeof raw['basesRegenerateOnSync'] === 'boolean' ? raw['basesRegenerateOnSync'] : false,
  };
}

function migrateV2toV3(record: Record<string, unknown>): AutoNoteImporterSettings {
  const credentials = Array.isArray(record['credentials']) ? record['credentials'] as Credential[] : [];
  const rawConfigs = Array.isArray(record['configs']) ? record['configs'] as Record<string, unknown>[] : [];

  const configs = rawConfigs.map(cfg => buildConfigFromRecord(cfg, generateId()));

  return {
    version: CURRENT_VERSION,
    credentials,
    configs,
    activeConfigId: typeof record['activeConfigId'] === 'string' ? record['activeConfigId'] : '',
    debugMode: typeof record['debugMode'] === 'boolean' ? record['debugMode'] : false,
  };
}

function migrateLegacyToV3(record: Record<string, unknown>): AutoNoteImporterSettings {
  const credentialId = generateId();
  const configId = generateId();

  const credential: Credential = {
    id: credentialId,
    name: 'Airtable',
    type: 'airtable',
    apiKey: typeof record['apiKey'] === 'string' ? record['apiKey'] : '',
  };

  const config: ConfigEntry = buildConfigFromRecord({ ...record, id: configId, name: 'Default', credentialId }, configId);

  return {
    version: CURRENT_VERSION,
    credentials: [credential],
    configs: [config],
    activeConfigId: configId,
    debugMode: typeof record['debugMode'] === 'boolean' ? record['debugMode'] : false,
  };
}
