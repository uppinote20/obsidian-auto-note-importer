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

/**
 * Normalizes a possibly-legacy conflictResolution value to the current `ConflictResolutionMode`.
 * v2 used `'airtable-wins'`; v3 uses `'remote-wins'`. Unknown values fall back to `'manual'`.
 */
function migrateConflictResolution(value: unknown): ConflictResolutionMode {
  if (value === 'obsidian-wins' || value === 'remote-wins' || value === 'manual') {
    return value;
  }
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
 * - Returns null if data is already at the current version.
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

  if (record['version'] === CURRENT_VERSION) {
    return null;
  }

  if (record['version'] === 2) {
    return migrateV2toV3(record);
  }

  return migrateLegacyToV3(record);
}

function migrateV2toV3(record: Record<string, unknown>): AutoNoteImporterSettings {
  const credentials = Array.isArray(record['credentials']) ? record['credentials'] as Credential[] : [];
  const rawConfigs = Array.isArray(record['configs']) ? record['configs'] as Record<string, unknown>[] : [];

  const configs = rawConfigs.map(cfg => {
    const next: Record<string, unknown> = { ...cfg };
    next['conflictResolution'] = migrateConflictResolution(cfg['conflictResolution']);
    next['autoSyncComputedFields'] = readAutoSyncComputedFields(cfg, false);
    delete next['autoSyncFormulas'];
    return next as unknown as ConfigEntry;
  });

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

  const config: ConfigEntry = {
    id: configId,
    name: 'Default',
    enabled: true,
    credentialId,
    baseId: typeof record['baseId'] === 'string' ? record['baseId'] : '',
    tableId: typeof record['tableId'] === 'string' ? record['tableId'] : '',
    viewId: typeof record['viewId'] === 'string' ? record['viewId'] : '',
    folderPath: typeof record['folderPath'] === 'string' ? record['folderPath'] : '',
    templatePath: typeof record['templatePath'] === 'string' ? record['templatePath'] : '',
    filenameFieldName: typeof record['filenameFieldName'] === 'string' ? record['filenameFieldName'] : '',
    subfolderFieldName: typeof record['subfolderFieldName'] === 'string' ? record['subfolderFieldName'] : '',
    syncInterval: typeof record['syncInterval'] === 'number' ? record['syncInterval'] : 0,
    allowOverwrite: typeof record['allowOverwrite'] === 'boolean' ? record['allowOverwrite'] : true,
    bidirectionalSync: typeof record['bidirectionalSync'] === 'boolean' ? record['bidirectionalSync'] : false,
    conflictResolution: migrateConflictResolution(record['conflictResolution']),
    watchForChanges: typeof record['watchForChanges'] === 'boolean' ? record['watchForChanges'] : false,
    fileWatchDebounce: typeof record['fileWatchDebounce'] === 'number' ? record['fileWatchDebounce'] : 2000,
    autoSyncComputedFields: readAutoSyncComputedFields(record, false),
    formulaSyncDelay: typeof record['formulaSyncDelay'] === 'number' ? record['formulaSyncDelay'] : 1500,
    generateBasesFile: typeof record['generateBasesFile'] === 'boolean' ? record['generateBasesFile'] : false,
    basesFileLocation: (record['basesFileLocation'] === 'synced-folder' || record['basesFileLocation'] === 'custom')
      ? record['basesFileLocation']
      : 'vault-root',
    basesCustomPath: typeof record['basesCustomPath'] === 'string' ? record['basesCustomPath'] : '',
    basesRegenerateOnSync: typeof record['basesRegenerateOnSync'] === 'boolean' ? record['basesRegenerateOnSync'] : false,
  };

  return {
    version: CURRENT_VERSION,
    credentials: [credential],
    configs: [config],
    activeConfigId: configId,
    debugMode: typeof record['debugMode'] === 'boolean' ? record['debugMode'] : false,
  };
}
