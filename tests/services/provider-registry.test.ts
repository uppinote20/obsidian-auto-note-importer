/**
 * Tests for provider-registry service.
 * @covers src/services/provider-registry.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type {
  Credential,
  AirtableCredential,
  ConfigEntry,
  DatabaseProvider,
} from '../../src/types';
import { DEFAULT_CONFIG_ENTRY } from '../../src/types';

function createAirtableCredential(overrides: Partial<AirtableCredential> = {}): AirtableCredential {
  return {
    id: 'cred-1',
    name: 'Test Airtable',
    type: 'airtable',
    apiKey: 'pat-test',
    ...overrides,
  };
}

function createConfig(overrides: Partial<ConfigEntry> = {}): ConfigEntry {
  return {
    ...DEFAULT_CONFIG_ENTRY,
    id: 'cfg-1',
    name: 'Test Config',
    credentialId: 'cred-1',
    baseId: 'appTest',
    tableId: 'tblTest',
    ...overrides,
  };
}

describe('provider-registry', () => {
  // Re-import fresh module in each test so the factories map starts clean
  // (only 'airtable' registered from module side-effects).
  let registerProvider: typeof import('../../src/services/provider-registry').registerProvider;
  let createProvider: typeof import('../../src/services/provider-registry').createProvider;
  let hasProvider: typeof import('../../src/services/provider-registry').hasProvider;
  let registerFieldTypeMapper: typeof import('../../src/services/provider-registry').registerFieldTypeMapper;
  let getFieldTypeMapper: typeof import('../../src/services/provider-registry').getFieldTypeMapper;
  let hasFieldTypeMapper: typeof import('../../src/services/provider-registry').hasFieldTypeMapper;
  let RateLimiter: typeof import('../../src/services/rate-limiter').RateLimiter;
  let AirtableClient: typeof import('../../src/services/airtable-client').AirtableClient;
  let airtableFieldMapper: typeof import('../../src/services/airtable-field-mapper').airtableFieldMapper;

  beforeEach(async () => {
    vi.resetModules();
    const registry = await import('../../src/services/provider-registry');
    const rl = await import('../../src/services/rate-limiter');
    const ac = await import('../../src/services/airtable-client');
    const afm = await import('../../src/services/airtable-field-mapper');
    registerProvider = registry.registerProvider;
    createProvider = registry.createProvider;
    hasProvider = registry.hasProvider;
    registerFieldTypeMapper = registry.registerFieldTypeMapper;
    getFieldTypeMapper = registry.getFieldTypeMapper;
    hasFieldTypeMapper = registry.hasFieldTypeMapper;
    RateLimiter = rl.RateLimiter;
    AirtableClient = ac.AirtableClient;
    airtableFieldMapper = afm.airtableFieldMapper;
  });

  describe('built-in registrations', () => {
    it('should register airtable factory on module load', () => {
      expect(hasProvider('airtable')).toBe(true);
    });

    it('should not register non-airtable providers by default', () => {
      expect(hasProvider('seatable')).toBe(false);
      expect(hasProvider('supabase')).toBe(false);
      expect(hasProvider('notion')).toBe(false);
      expect(hasProvider('custom-api')).toBe(false);
    });

    it('should register airtable field type mapper on module load', () => {
      expect(hasFieldTypeMapper('airtable')).toBe(true);
      expect(getFieldTypeMapper('airtable')).toBe(airtableFieldMapper);
    });

    it('should not register non-airtable field type mappers by default', () => {
      expect(hasFieldTypeMapper('seatable')).toBe(false);
      expect(hasFieldTypeMapper('supabase')).toBe(false);
    });
  });

  describe('getFieldTypeMapper', () => {
    it('should throw when no mapper is registered for credential type', () => {
      expect(() => getFieldTypeMapper('notion')).toThrow(
        /No field type mapper registered for credential type: notion/,
      );
    });

    it('should return the mapper registered via registerFieldTypeMapper', () => {
      const fake = {
        mapToStandardType: () => 'text' as const,
        isReadOnly: () => false,
        isFilenameSafe: () => true,
        getFilenameSafeTypes: () => [],
        getReadOnlyTypes: () => [],
      };
      registerFieldTypeMapper('seatable', fake);
      expect(getFieldTypeMapper('seatable')).toBe(fake);
    });
  });

  describe('createProvider', () => {
    it('should create an AirtableClient for airtable credential', () => {
      const credential = createAirtableCredential();
      const config = createConfig();
      const rateLimiter = new RateLimiter(0);

      const provider = createProvider(credential, config, rateLimiter, false);

      expect(provider).toBeInstanceOf(AirtableClient);
      expect(provider.providerType).toBe('airtable');
      expect(provider.capabilities.bidirectional).toBe(true);
      expect(provider.capabilities.hasComputedFields).toBe(true);
      expect(provider.capabilities.batchUpdateMaxSize).toBe(10);
    });

    it('should expose the same fieldTypeMapper from provider instance and registry', () => {
      // Ensures the dual access paths stay in sync: sync-orchestrator uses
      // provider.fieldTypeMapper while settings-tab uses getFieldTypeMapper
      // by credential type. A new provider registered without a mapper would
      // silently diverge these paths.
      const credential = createAirtableCredential();
      const provider = createProvider(credential, createConfig(), new RateLimiter(0), false);
      expect(provider.fieldTypeMapper).toBe(getFieldTypeMapper(credential.type));
      expect(provider.fieldTypeMapper).toBe(airtableFieldMapper);
    });

    it('should throw when no factory is registered for credential type', () => {
      const credential: Credential = {
        id: 'cred-2',
        name: 'SeaTable',
        type: 'seatable',
        apiToken: 'token',
        serverUrl: 'https://cloud.seatable.io',
      };
      const config = createConfig();
      const rateLimiter = new RateLimiter(0);

      expect(() => createProvider(credential, config, rateLimiter, false)).toThrow(
        /No provider registered for credential type: seatable/,
      );
    });

    it('should pass credential, config, rateLimiter, and debugMode to the factory', () => {
      const factorySpy = vi.fn().mockReturnValue({
        providerType: 'seatable',
        capabilities: { bidirectional: false, hasComputedFields: false, batchUpdateMaxSize: 1 },
        fetchNotes: vi.fn(),
        fetchRecord: vi.fn(),
        updateRecord: vi.fn(),
        batchUpdate: vi.fn(),
        reconfigure: vi.fn(),
      } as unknown as DatabaseProvider);

      registerProvider('seatable', factorySpy);

      const credential: Credential = {
        id: 'cred-3',
        name: 'SeaTable',
        type: 'seatable',
        apiToken: 'st-token',
        serverUrl: 'https://cloud.seatable.io',
      };
      const config = createConfig();
      const rateLimiter = new RateLimiter(0);

      createProvider(credential, config, rateLimiter, true);

      expect(factorySpy).toHaveBeenCalledOnce();
      expect(factorySpy).toHaveBeenCalledWith(credential, config, rateLimiter, true);
    });
  });

  describe('registerProvider', () => {
    it('should add a new factory that hasProvider detects', () => {
      const fakeFactory = vi.fn();
      expect(hasProvider('notion')).toBe(false);

      registerProvider('notion', fakeFactory);

      expect(hasProvider('notion')).toBe(true);
    });

    it('should overwrite an existing factory for the same type', () => {
      const firstFactory = vi.fn().mockReturnValue({ id: 'first' } as unknown as DatabaseProvider);
      const secondFactory = vi.fn().mockReturnValue({ id: 'second' } as unknown as DatabaseProvider);

      registerProvider('custom-api', firstFactory);
      registerProvider('custom-api', secondFactory);

      const credential: Credential = {
        id: 'cred-4',
        name: 'Custom',
        type: 'custom-api',
        baseUrl: 'https://api.example.com',
        authHeader: 'X-API-Key',
        authValue: 'secret',
      };

      createProvider(credential, createConfig(), new RateLimiter(0), false);

      expect(firstFactory).not.toHaveBeenCalled();
      expect(secondFactory).toHaveBeenCalledOnce();
    });
  });

});
