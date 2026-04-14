/**
 * Provider registry and factory for DatabaseProvider instances.
 *
 * Each CredentialType has an associated factory that constructs the
 * concrete provider. ConfigInstance looks up the factory by the
 * credential's type, decoupling service wiring from specific providers.
 *
 * Built-in factories register as module side-effects at the bottom of
 * this file; future providers register here too so a single import
 * wires them all up.
 *
 * @handbook 4.4-provider-abstraction
 * @tested tests/services/provider-registry.test.ts
 */

import type {
  Credential,
  CredentialType,
  ConfigEntry,
  DatabaseProvider,
  FieldTypeMapper,
  CredentialFormRenderer,
} from '../types';
import { buildLegacySettings } from '../utils';
import type { RateLimiter } from './rate-limiter';
import { AirtableClient } from './airtable-client';
import { airtableFieldMapper } from './airtable-field-mapper';
import { airtableCredentialFormRenderer } from './airtable-credential-form';

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
const fieldTypeMappers = new Map<CredentialType, FieldTypeMapper>();
const credentialFormRenderers = new Map<CredentialType, CredentialFormRenderer>();

/**
 * Registers a factory for a given credential type. Overwrites any
 * existing registration for that type.
 */
export function registerProvider(type: CredentialType, factory: ProviderFactory): void {
  factories.set(type, factory);
}

/**
 * Registers a field type mapper for a given credential type.
 * Callers without a provider instance (e.g. settings UI) look up
 * the mapper here by credential type.
 */
export function registerFieldTypeMapper(type: CredentialType, mapper: FieldTypeMapper): void {
  fieldTypeMappers.set(type, mapper);
}

/**
 * Returns the field type mapper registered for the given credential type.
 * Throws if no mapper is registered.
 */
export function getFieldTypeMapper(type: CredentialType): FieldTypeMapper {
  const mapper = fieldTypeMappers.get(type);
  if (!mapper) {
    throw new Error(`No field type mapper registered for credential type: ${type}`);
  }
  return mapper;
}

/**
 * Returns true if a field type mapper is registered for the given type.
 */
export function hasFieldTypeMapper(type: CredentialType): boolean {
  return fieldTypeMappers.has(type);
}

/**
 * Registers a credential form renderer for a given credential type.
 * The settings UI delegates to the registered renderer for auth field
 * rendering, credential construction, and (optional) connection testing.
 */
export function registerCredentialFormRenderer(
  type: CredentialType,
  renderer: CredentialFormRenderer,
): void {
  credentialFormRenderers.set(type, renderer);
}

/**
 * Returns the credential form renderer registered for the given type.
 * Throws if no renderer is registered.
 */
export function getCredentialFormRenderer(type: CredentialType): CredentialFormRenderer {
  const renderer = credentialFormRenderers.get(type);
  if (!renderer) {
    throw new Error(`No credential form renderer registered for credential type: ${type}`);
  }
  return renderer;
}

/**
 * Returns true if a credential form renderer is registered for the given type.
 */
export function hasCredentialFormRenderer(type: CredentialType): boolean {
  return credentialFormRenderers.has(type);
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
  return new AirtableClient(buildLegacySettings(config, credential, debugMode), rateLimiter);
});

registerFieldTypeMapper('airtable', airtableFieldMapper);
registerCredentialFormRenderer('airtable', airtableCredentialFormRenderer);
