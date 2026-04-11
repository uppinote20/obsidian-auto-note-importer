/**
 * Bridge helpers between the multi-config data model and the legacy
 * single-config settings shape still consumed by most services.
 *
 * @handbook 9.8-multi-config-architecture
 */

import type { Credential, ConfigEntry, LegacySettings } from '../types';

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
