/**
 * Tests for SupabaseClient service.
 * @covers src/services/supabase-client.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SupabaseClient } from '../../src/services/supabase-client';
import { SupabaseMetadataCache } from '../../src/services/supabase-metadata-cache';
import { RateLimiter } from '../../src/services/rate-limiter';
import type { ConfigEntry, SupabaseCredential } from '../../src/types';

const mockRequestUrl = vi.fn();
vi.mock('obsidian', () => ({
  requestUrl: (...args: unknown[]) => mockRequestUrl(...args),
}));

const cred: SupabaseCredential = {
  id: 'c1', name: 'X', type: 'supabase',
  projectUrl: 'https://abc.supabase.co', apiKey: 'sb_publishable_xxx',
};

function makeConfig(overrides: Partial<ConfigEntry> = {}): ConfigEntry {
  return {
    id: 'cfg1', name: 'D', enabled: true, credentialId: 'c1',
    baseId: 'public', tableId: 'notes', viewId: '', primaryKeyColumn: 'id',
    folderPath: '', templatePath: '', filenameFieldName: '', subfolderFieldName: '',
    syncInterval: 0, allowOverwrite: true, bidirectionalSync: false,
    conflictResolution: 'manual', watchForChanges: false, fileWatchDebounce: 2000,
    autoSyncComputedFields: false, formulaSyncDelay: 1500,
    generateBasesFile: false, basesFileLocation: 'vault-root',
    basesCustomPath: '', basesRegenerateOnSync: false,
    ...overrides,
  };
}

beforeEach(() => mockRequestUrl.mockReset());

describe('SupabaseClient providerType + capabilities', () => {
  it('exposes correct providerType', () => {
    const c = new SupabaseClient(cred, makeConfig(), new RateLimiter(), new SupabaseMetadataCache());
    expect(c.providerType).toBe('supabase');
  });

  it('declares bidirectional + computed capabilities', () => {
    const c = new SupabaseClient(cred, makeConfig(), new RateLimiter(), new SupabaseMetadataCache());
    expect(c.capabilities.bidirectional).toBe(true);
    expect(c.capabilities.hasComputedFields).toBe(true);
    expect(c.capabilities.batchUpdateMaxSize).toBeGreaterThan(0);
  });
});

describe('SupabaseClient.reconfigure', () => {
  it('throws when given a non-supabase credential', () => {
    const c = new SupabaseClient(cred, makeConfig(), new RateLimiter(), new SupabaseMetadataCache());
    expect(() => c.reconfigure({ id: 'c2', name: 'X', type: 'airtable', apiKey: 'k' }, makeConfig(), new RateLimiter(), false))
      .toThrow(/supabase/);
  });

  it('clears metadata cache for credential when apiKey changes', () => {
    const cache = new SupabaseMetadataCache();
    const spy = vi.spyOn(cache, 'clearForCred');
    const c = new SupabaseClient(cred, makeConfig(), new RateLimiter(), cache);
    c.reconfigure({ ...cred, apiKey: 'sb_publishable_NEW' }, makeConfig(), new RateLimiter(), false);
    expect(spy).toHaveBeenCalledWith(cred.id);
  });

  it('does NOT clear metadata cache when only config changes', () => {
    const cache = new SupabaseMetadataCache();
    const spy = vi.spyOn(cache, 'clearForCred');
    const c = new SupabaseClient(cred, makeConfig(), new RateLimiter(), cache);
    c.reconfigure(cred, makeConfig({ tableId: 'other' }), new RateLimiter(), false);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('SupabaseClient validateConfig (via fetchNotes)', () => {
  it('throws when apiKey is empty', async () => {
    const c = new SupabaseClient({ ...cred, apiKey: '' }, makeConfig(), new RateLimiter(), new SupabaseMetadataCache());
    await expect(c.fetchNotes()).rejects.toThrow(/api key/i);
  });

  it('throws when tableId is empty', async () => {
    const c = new SupabaseClient(cred, makeConfig({ tableId: '' }), new RateLimiter(), new SupabaseMetadataCache());
    await expect(c.fetchNotes()).rejects.toThrow(/table/i);
  });

  it('throws when primaryKeyColumn is empty', async () => {
    const c = new SupabaseClient(cred, makeConfig({ primaryKeyColumn: '' }), new RateLimiter(), new SupabaseMetadataCache());
    await expect(c.fetchNotes()).rejects.toThrow(/primary key/i);
  });
});
