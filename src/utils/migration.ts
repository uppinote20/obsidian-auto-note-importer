/**
 * Settings migration utility for upgrading legacy settings to the current version.
 *
 * @handbook 9.9-settings-migration
 * @tested tests/utils/migration.test.ts
 */

import type { Credential, CredentialType } from '../types/credential.types';
import { CREDENTIAL_TYPES } from '../types/credential.types';
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

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(record: Record<string, unknown>, key: string, fallback: string): string {
  const v = record[key];
  return typeof v === 'string' ? v : fallback;
}

/**
 * Builds a typed `Credential` from a raw record. Returns `undefined` if the
 * record cannot be safely interpreted as one of the discriminated-union variants
 * (e.g., missing/unknown `type`, missing `id`). The caller filters undefined out.
 *
 * Mirrors `buildConfigFromRecord`'s per-field fallback discipline so a
 * malformed credential like `{ id: 123, name: null }` cannot reach runtime
 * with wrong types.
 */
function buildCredentialFromRecord(raw: Record<string, unknown>): Credential | undefined {
  const id = raw['id'];
  if (typeof id !== 'string' || id.length === 0) return undefined;

  const type = raw['type'];
  if (typeof type !== 'string' || !(CREDENTIAL_TYPES as readonly string[]).includes(type)) {
    return undefined;
  }

  const base = { id, name: readString(raw, 'name', '') };
  switch (type as CredentialType) {
    case 'airtable':
      return { ...base, type: 'airtable', apiKey: readString(raw, 'apiKey', '') };
    case 'seatable':
      return {
        ...base, type: 'seatable',
        apiToken: readString(raw, 'apiToken', ''),
        serverUrl: readString(raw, 'serverUrl', ''),
      };
    case 'supabase':
      return {
        ...base, type: 'supabase',
        projectUrl: readString(raw, 'projectUrl', ''),
        apiKey: readString(raw, 'apiKey', ''),
      };
    case 'notion':
      return { ...base, type: 'notion', integrationToken: readString(raw, 'integrationToken', '') };
    case 'custom-api':
      return {
        ...base, type: 'custom-api',
        baseUrl: readString(raw, 'baseUrl', ''),
        authHeader: readString(raw, 'authHeader', ''),
        authValue: readString(raw, 'authValue', ''),
      };
    default: {
      const _exhaustive: never = type as CredentialType as never;
      throw new Error(`Unknown credential type: ${_exhaustive}`);
    }
  }
}

function migrateV2toV3(record: Record<string, unknown>): AutoNoteImporterSettings {
  const credentials = Array.isArray(record['credentials'])
    ? (record['credentials'] as unknown[])
        .filter(isPlainRecord)
        .map(buildCredentialFromRecord)
        .filter((c): c is Credential => c !== undefined)
    : [];
  const rawConfigs = Array.isArray(record['configs'])
    ? (record['configs'] as unknown[]).filter(isPlainRecord)
    : [];

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
