/**
 * Settings migration utility for upgrading legacy single-config settings to v2 multi-config format.
 *
 * @tested tests/utils/migration.test.ts
 */

import type { Credential } from '../types/credential.types';
import type { ConfigEntry } from '../types/config.types';
import type { AutoNoteImporterSettings } from '../types/settings.types';
import { generateId } from './object-utils';

/**
 * Migrates legacy single-config settings data to the v2 multi-config format.
 *
 * - Returns null for null/undefined input (fresh install, no migration needed).
 * - Returns null if data is already v2 format (migration already done).
 * - Otherwise converts legacy settings into a single credential + config entry.
 *
 * @param data - Raw settings data loaded from plugin storage (unknown type)
 * @returns Migrated v2 settings, or null if migration is not applicable
 */
export function migrateSettings(data: unknown): AutoNoteImporterSettings | null {
  if (data == null) {
    return null;
  }

  if (typeof data !== 'object') {
    return null;
  }

  const record = data as Record<string, unknown>;

  if (record['version'] === 2) {
    return null;
  }

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
    conflictResolution: (record['conflictResolution'] === 'obsidian-wins' || record['conflictResolution'] === 'airtable-wins')
      ? record['conflictResolution']
      : 'manual',
    watchForChanges: typeof record['watchForChanges'] === 'boolean' ? record['watchForChanges'] : false,
    fileWatchDebounce: typeof record['fileWatchDebounce'] === 'number' ? record['fileWatchDebounce'] : 2000,
    autoSyncFormulas: typeof record['autoSyncFormulas'] === 'boolean' ? record['autoSyncFormulas'] : false,
    formulaSyncDelay: typeof record['formulaSyncDelay'] === 'number' ? record['formulaSyncDelay'] : 1500,
    generateBasesFile: typeof record['generateBasesFile'] === 'boolean' ? record['generateBasesFile'] : false,
    basesFileLocation: (record['basesFileLocation'] === 'synced-folder' || record['basesFileLocation'] === 'custom')
      ? record['basesFileLocation']
      : 'vault-root',
    basesCustomPath: typeof record['basesCustomPath'] === 'string' ? record['basesCustomPath'] : '',
    basesRegenerateOnSync: typeof record['basesRegenerateOnSync'] === 'boolean' ? record['basesRegenerateOnSync'] : false,
  };

  return {
    version: 2,
    credentials: [credential],
    configs: [config],
    activeConfigId: configId,
    debugMode: typeof record['debugMode'] === 'boolean' ? record['debugMode'] : false,
  };
}
