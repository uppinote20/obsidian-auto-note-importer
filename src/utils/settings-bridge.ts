/**
 * Bridge helpers between the multi-config data model and the legacy
 * single-config settings shape still consumed by most services.
 *
 * @handbook 9.8-multi-config-architecture
 * @tested tests/utils/settings-bridge.test.ts
 */

import type { Credential, ConfigEntry, LegacySettings, AutoNoteImporterSettings } from '../types';

/**
 * Merges a ConfigEntry with its Credential and debug flag to produce
 * a LegacySettings object compatible with services that predate the
 * multi-config refactor.
 *
 * Non-Airtable credentials populate `apiKey` with an empty string —
 * their providers read auth fields from the credential directly and
 * never consume the legacy field.
 */
export function buildLegacySettings(
  config: ConfigEntry,
  credential: Credential,
  debugMode: boolean,
): LegacySettings {
  const apiKey = credential.type === 'airtable' ? credential.apiKey : '';
  return { ...config, apiKey, debugMode };
}

/**
 * Looks up the credential linked to a config by `credentialId`.
 * Returns `undefined` if the credential is missing (e.g., deleted while a
 * config still references it). Callers must handle the undefined case.
 */
export function findCredentialForConfig(
  settings: AutoNoteImporterSettings,
  config: ConfigEntry,
): Credential | undefined {
  return settings.credentials.find(c => c.id === config.credentialId);
}
