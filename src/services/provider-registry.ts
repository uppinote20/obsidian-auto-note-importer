/**
 * Provider registry and factory for DatabaseProvider instances.
 *
 * Each CredentialType has an associated factory that constructs the
 * concrete provider. ConfigInstance delegates provider creation to the
 * registry based on the credential's type, decoupling service wiring
 * from specific providers.
 *
 * @handbook 4.4-provider-abstraction
 * @tested tests/services/provider-registry.test.ts
 */

import type {
  Credential,
  CredentialType,
  ConfigEntry,
  DatabaseProvider,
  LegacySettings,
} from '../types';
import type { RateLimiter } from './rate-limiter';
import { AirtableClient } from './airtable-client';

/**
 * Factory signature for creating a provider instance.
 */
export type ProviderFactory = (
  credential: Credential,
  config: ConfigEntry,
  rateLimiter: RateLimiter,
  debugMode: boolean,
) => DatabaseProvider;

const factories = new Map<CredentialType, ProviderFactory>();

/**
 * Registers a factory for a given credential type. Overwrites any
 * existing registration for that type.
 */
export function registerProvider(type: CredentialType, factory: ProviderFactory): void {
  factories.set(type, factory);
}

/**
 * Creates a provider instance for the given credential and config.
 * Throws if no factory is registered for the credential's type.
 */
export function createProvider(
  credential: Credential,
  config: ConfigEntry,
  rateLimiter: RateLimiter,
  debugMode: boolean,
): DatabaseProvider {
  const factory = factories.get(credential.type);
  if (!factory) {
    throw new Error(`No provider registered for credential type: ${credential.type}`);
  }
  return factory(credential, config, rateLimiter, debugMode);
}

/**
 * Returns true if a factory is registered for the given type.
 */
export function hasProvider(type: CredentialType): boolean {
  return factories.has(type);
}

// ─── Built-in provider registrations ─────────────────────────────────

registerProvider('airtable', (credential, config, rateLimiter, debugMode) => {
  if (credential.type !== 'airtable') {
    throw new Error(`Airtable factory received ${credential.type} credential`);
  }
  const settings: LegacySettings = {
    ...config,
    apiKey: credential.apiKey,
    debugMode,
  };
  return new AirtableClient(settings, rateLimiter);
});
