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
      .toThrow(/supabase/i);
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

describe('SupabaseClient.fetchNotes', () => {
  it('builds URL with table and PostgREST pagination headers', async () => {
    mockRequestUrl.mockResolvedValueOnce({
      status: 200, json: [{ id: 'r1', title: 'A' }],
      headers: { 'content-range': '0-0/1' },
    });
    const c = new SupabaseClient(cred, makeConfig(), new RateLimiter(), new SupabaseMetadataCache());
    const notes = await c.fetchNotes();
    expect(notes).toEqual([{ id: 'r1', primaryField: 'r1', fields: { id: 'r1', title: 'A' } }]);
    const call = mockRequestUrl.mock.calls[0][0];
    expect(call.url).toBe('https://abc.supabase.co/rest/v1/notes');
    expect(call.headers.Range).toMatch(/0-/);
    expect(call.headers['Range-Unit']).toBe('items');
  });

  it('uses viewId as endpoint when set', async () => {
    mockRequestUrl.mockResolvedValueOnce({ status: 200, json: [], headers: {} });
    const c = new SupabaseClient(cred, makeConfig({ viewId: 'active_notes' }), new RateLimiter(), new SupabaseMetadataCache());
    await c.fetchNotes();
    expect(mockRequestUrl.mock.calls[0][0].url).toContain('/rest/v1/active_notes');
  });

  it('attaches Accept-Profile for non-public schemas', async () => {
    mockRequestUrl.mockResolvedValueOnce({ status: 200, json: [], headers: {} });
    const c = new SupabaseClient(cred, makeConfig({ baseId: 'app' }), new RateLimiter(), new SupabaseMetadataCache());
    await c.fetchNotes();
    expect(mockRequestUrl.mock.calls[0][0].headers['Accept-Profile']).toBe('app');
  });

  it('paginates until Content-Range total reached', async () => {
    const rows1 = Array.from({ length: 1000 }, (_, i) => ({ id: `r${i}` }));
    const rows2 = [{ id: 'r1000' }];
    mockRequestUrl
      .mockResolvedValueOnce({ status: 200, json: rows1, headers: { 'content-range': '0-999/1001' } })
      .mockResolvedValueOnce({ status: 200, json: rows2, headers: { 'content-range': '1000-1000/1001' } });
    const c = new SupabaseClient(cred, makeConfig(), new RateLimiter(), new SupabaseMetadataCache());
    const notes = await c.fetchNotes();
    expect(notes).toHaveLength(1001);
  });

  it('uses primaryKeyColumn value as RemoteNote id and primaryField', async () => {
    mockRequestUrl.mockResolvedValueOnce({
      status: 200, json: [{ uuid: 'u-1', title: 'A' }], headers: {},
    });
    const c = new SupabaseClient(cred, makeConfig({ primaryKeyColumn: 'uuid' }), new RateLimiter(), new SupabaseMetadataCache());
    const notes = await c.fetchNotes();
    expect(notes[0]).toEqual({ id: 'u-1', primaryField: 'u-1', fields: { uuid: 'u-1', title: 'A' } });
  });

  it('throws on HTTP error with PostgREST error detail', async () => {
    mockRequestUrl.mockResolvedValueOnce({
      status: 401, json: { code: 'PGRST301', message: 'JWT expired' }, headers: {},
    });
    const c = new SupabaseClient(cred, makeConfig(), new RateLimiter(), new SupabaseMetadataCache());
    await expect(c.fetchNotes()).rejects.toThrow(/JWT expired/);
  });
});

describe('SupabaseClient.fetchRecord', () => {
  it('builds URL with pk=eq.id and limit=1', async () => {
    mockRequestUrl.mockResolvedValueOnce({ status: 200, json: [{ id: 'r1', title: 'A' }], headers: {} });
    const c = new SupabaseClient(cred, makeConfig(), new RateLimiter(), new SupabaseMetadataCache());
    const note = await c.fetchRecord('r1');
    expect(note).toEqual({ id: 'r1', primaryField: 'r1', fields: { id: 'r1', title: 'A' } });
    const call = mockRequestUrl.mock.calls[0][0];
    expect(call.url).toContain('/rest/v1/notes?id=eq.r1');
    expect(call.url).toContain('limit=1');
  });

  it('returns null for empty result', async () => {
    mockRequestUrl.mockResolvedValueOnce({ status: 200, json: [], headers: {} });
    const c = new SupabaseClient(cred, makeConfig(), new RateLimiter(), new SupabaseMetadataCache());
    expect(await c.fetchRecord('missing')).toBeNull();
  });

  it('returns null on 404', async () => {
    mockRequestUrl.mockResolvedValueOnce({ status: 404, json: {}, headers: {} });
    const c = new SupabaseClient(cred, makeConfig(), new RateLimiter(), new SupabaseMetadataCache());
    expect(await c.fetchRecord('r1')).toBeNull();
  });

  it('URL-encodes special characters in the id', async () => {
    mockRequestUrl.mockResolvedValueOnce({ status: 200, json: [], headers: {} });
    const c = new SupabaseClient(cred, makeConfig(), new RateLimiter(), new SupabaseMetadataCache());
    await c.fetchRecord('a/b c');
    expect(mockRequestUrl.mock.calls[0][0].url).toContain('id=eq.a%2Fb%20c');
  });

  it('throws when recordId is empty', async () => {
    const c = new SupabaseClient(cred, makeConfig(), new RateLimiter(), new SupabaseMetadataCache());
    await expect(c.fetchRecord('')).rejects.toThrow(/empty/i);
  });
});
