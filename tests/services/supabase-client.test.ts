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

// Default seed: writable `title`/`status` + read-only `full_text` on table `notes`.
// Used by batchUpdate tests so metadata fetch is a cache hit and consumes no
// mockRequestUrl response.
function defaultSpecCache(schema = 'public'): SupabaseMetadataCache {
  const cache = new SupabaseMetadataCache();
  const spec = {
    definitions: {
      notes: {
        properties: {
          id:        { type: 'string', description: '<pk/>' },
          title:     { type: 'string' },
          status:    { type: 'string' },
          x:         { type: 'integer' },
          full_text: { type: 'string', readOnly: true },
        },
        required: ['id'],
      },
    },
  };
  (cache as unknown as { entries: Map<string, { spec: unknown; fetchedAt: number }> })
    .entries.set(`c1:${schema}`, { spec, fetchedAt: Date.now() });
  return cache;
}

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

describe('SupabaseClient.batchUpdate (upsert)', () => {
  it('returns empty array for empty input', async () => {
    const c = new SupabaseClient(cred, makeConfig(), new RateLimiter(), defaultSpecCache());
    expect(await c.batchUpdate([])).toEqual([]);
    expect(mockRequestUrl).not.toHaveBeenCalled();
  });

  it('returns per-record failure when batch exceeds limit', async () => {
    const big = Array.from({ length: 101 }, (_, i) => ({ recordId: `r${i}`, fields: { x: 1 } }));
    const c = new SupabaseClient(cred, makeConfig(), new RateLimiter(), defaultSpecCache());
    const result = await c.batchUpdate(big);
    expect(result).toHaveLength(101);
    expect(result.every(r => !r.success)).toBe(true);
  });

  it('POSTs to rest/v1/table with on_conflict=pk and merge-duplicates prefer', async () => {
    mockRequestUrl.mockResolvedValueOnce({
      status: 200,
      json: [{ id: 'r1', title: 'foo' }, { id: 'r2', status: 'archived' }],
      headers: {},
    });
    const c = new SupabaseClient(cred, makeConfig(), new RateLimiter(), defaultSpecCache());
    const result = await c.batchUpdate([
      { recordId: 'r1', fields: { title: 'foo' } },
      { recordId: 'r2', fields: { status: 'archived' } },
    ]);
    const call = mockRequestUrl.mock.calls[0][0];
    expect(call.url).toContain('/rest/v1/notes?on_conflict=id');
    expect(call.method).toBe('POST');
    expect(call.headers.Prefer).toContain('resolution=merge-duplicates');
    expect(call.headers.Prefer).toContain('return=representation');
    expect(JSON.parse(call.body)).toEqual([
      { id: 'r1', title: 'foo' },
      { id: 'r2', status: 'archived' },
    ]);
    expect(result).toEqual([
      { success: true, recordId: 'r1', updatedFields: { id: 'r1', title: 'foo' } },
      { success: true, recordId: 'r2', updatedFields: { id: 'r2', status: 'archived' } },
    ]);
  });

  it('attaches Content-Profile for non-public schemas', async () => {
    mockRequestUrl.mockResolvedValueOnce({ status: 200, json: [{ id: 'r1' }], headers: {} });
    const c = new SupabaseClient(cred, makeConfig({ baseId: 'app' }), new RateLimiter(), defaultSpecCache('app'));
    await c.batchUpdate([{ recordId: 'r1', fields: { x: 1 } }]);
    expect(mockRequestUrl.mock.calls[0][0].headers['Content-Profile']).toBe('app');
  });

  it('maps partial response (missing PK) to per-record failure', async () => {
    mockRequestUrl.mockResolvedValueOnce({
      status: 200, json: [{ id: 'r1', title: 'foo' }], headers: {},
    });
    const c = new SupabaseClient(cred, makeConfig(), new RateLimiter(), defaultSpecCache());
    const result = await c.batchUpdate([
      { recordId: 'r1', fields: { title: 'foo' } },
      { recordId: 'r2', fields: { title: 'bar' } },
    ]);
    expect(result[0]).toMatchObject({ success: true, recordId: 'r1' });
    expect(result[1]).toMatchObject({ success: false, recordId: 'r2' });
    expect(result[1]).toHaveProperty('error');
  });

  it('maps HTTP non-200 to per-record failure with same error', async () => {
    mockRequestUrl.mockResolvedValueOnce({
      status: 403, json: { code: '42501', message: 'permission denied' }, headers: {},
    });
    const c = new SupabaseClient(cred, makeConfig(), new RateLimiter(), defaultSpecCache());
    const result = await c.batchUpdate([
      { recordId: 'r1', fields: { title: 'foo' } },
      { recordId: 'r2', fields: { title: 'bar' } },
    ]);
    expect(result.every(r => !r.success)).toBe(true);
    expect(result.every(r => 'error' in r && r.error.includes('permission denied'))).toBe(true);
  });

  it('maps thrown error to per-record failure', async () => {
    mockRequestUrl.mockRejectedValueOnce(new Error('network down'));
    const c = new SupabaseClient(cred, makeConfig(), new RateLimiter(), defaultSpecCache());
    const result = await c.batchUpdate([{ recordId: 'r1', fields: { x: 1 } }]);
    expect(result).toEqual([{ success: false, recordId: 'r1', error: 'network down' }]);
  });

  it('updateRecord delegates to batchUpdate and unwraps to single SyncResult', async () => {
    mockRequestUrl.mockResolvedValueOnce({
      status: 200, json: [{ id: 'r1', title: 'foo' }], headers: {},
    });
    const c = new SupabaseClient(cred, makeConfig(), new RateLimiter(), defaultSpecCache());
    const result = await c.updateRecord('r1', { title: 'foo' });
    expect(result).toMatchObject({ success: true, recordId: 'r1' });
  });
});

describe('SupabaseClient.fetchNotes Range pagination edge cases (G5: #10+#14)', () => {
  it('#10: treats 416 Range Not Satisfiable as end-of-data when total rows is an exact PAGE_SIZE multiple', async () => {
    // Page 1: full 1000 rows; second request lands past EOF — PostgREST 11+ returns 416.
    const page1 = Array.from({ length: 1000 }, (_, i) => ({ id: `r${i}` }));
    mockRequestUrl
      .mockResolvedValueOnce({ status: 200, json: page1, headers: { 'content-range': '0-999/*' } })
      .mockResolvedValueOnce({ status: 416, json: { code: 'PGRST103', message: 'Requested range not satisfiable' }, headers: {} });
    const c = new SupabaseClient(cred, makeConfig(), new RateLimiter(), defaultSpecCache());
    const notes = await c.fetchNotes();
    expect(notes).toHaveLength(1000);  // 416 is not fatal — it just means EOF
  });

  it('#14: keeps paging when server cap returns fewer rows than PAGE_SIZE but Content-Range says total is larger', async () => {
    // Self-hosted PostgREST with db-pool-max-rows below 1000 caps each page.
    const page1 = Array.from({ length: 500 }, (_, i) => ({ id: `r${i}` }));
    const page2 = Array.from({ length: 500 }, (_, i) => ({ id: `r${i + 500}` }));
    mockRequestUrl
      .mockResolvedValueOnce({ status: 206, json: page1, headers: { 'content-range': '0-499/2000' } })
      .mockResolvedValueOnce({ status: 206, json: page2, headers: { 'content-range': '500-999/2000' } })
      .mockResolvedValueOnce({ status: 206, json: [], headers: { 'content-range': '*/2000' } });
    const c = new SupabaseClient(cred, makeConfig(), new RateLimiter(), defaultSpecCache());
    const notes = await c.fetchNotes();
    // Without the fix, the loop exited after page1 (500 < 1000), silently truncating.
    // With the fix, content-range total (2000) keeps the loop going.
    expect(notes.length).toBeGreaterThan(500);
  });
});

describe('SupabaseClient.batchUpdate duplicate recordIds (G5: #15)', () => {
  it('fails the whole batch with an explicit error when the same recordId appears twice', async () => {
    const c = new SupabaseClient(cred, makeConfig(), new RateLimiter(), defaultSpecCache());
    const result = await c.batchUpdate([
      { recordId: 'r1', fields: { title: 'a' } },
      { recordId: 'r2', fields: { title: 'b' } },
      { recordId: 'r1', fields: { title: 'c' } },  // duplicate
    ]);
    expect(result).toHaveLength(3);
    expect(result.every(r => !r.success)).toBe(true);
    const errs = result.map(r => 'error' in r ? r.error : '');
    expect(errs.every(e => /duplicate/i.test(e))).toBe(true);
    expect(mockRequestUrl).not.toHaveBeenCalled();
  });
});

describe('SupabaseClient.fetchNotes PK validation (G3: #8)', () => {
  it('throws when configured primaryKeyColumn is absent from endpoint rows (avoids silent zero-result truncation)', async () => {
    mockRequestUrl.mockResolvedValueOnce({
      status: 200,
      json: [{ title: 'a', count: 3 }, { title: 'b', count: 7 }],  // no 'id' field
      headers: {},
    });
    const c = new SupabaseClient(cred, makeConfig({ viewId: 'aggregates' }), new RateLimiter(), defaultSpecCache());
    await expect(c.fetchNotes()).rejects.toThrow(/primary key|primaryKeyColumn|not found/i);
  });

  it('still returns empty array when endpoint truly has zero rows', async () => {
    mockRequestUrl.mockResolvedValueOnce({ status: 200, json: [], headers: {} });
    const c = new SupabaseClient(cred, makeConfig(), new RateLimiter(), defaultSpecCache());
    await expect(c.fetchNotes()).resolves.toEqual([]);
  });
});

describe('SupabaseClient.fetchRecord vs view (G2: #3)', () => {
  it('queries the base table even when viewId is set (conflict detection must see rows that left the view)', async () => {
    mockRequestUrl.mockResolvedValueOnce({
      status: 200, json: [{ id: 'r1', archived: true, title: 'foo' }], headers: {},
    });
    const c = new SupabaseClient(cred, makeConfig({ viewId: 'active_notes' }), new RateLimiter(), defaultSpecCache());
    const note = await c.fetchRecord('r1');
    const callUrl = mockRequestUrl.mock.calls[0][0].url;
    expect(callUrl).toContain('/rest/v1/notes?');  // base table, not active_notes
    expect(callUrl).not.toContain('/active_notes');
    expect(note).not.toBeNull();
  });
});

describe('SupabaseClient.batchUpdate RLS-empty representation (G2: #4)', () => {
  it('treats 200 with empty array as all-success (RLS may block SELECT after a permitted UPDATE)', async () => {
    mockRequestUrl.mockResolvedValueOnce({
      status: 200, json: [], headers: {},  // RLS-protected write: upsert OK, SELECT denied
    });
    const c = new SupabaseClient(cred, makeConfig(), new RateLimiter(), defaultSpecCache());
    const result = await c.batchUpdate([
      { recordId: 'r1', fields: { title: 'a' } },
      { recordId: 'r2', fields: { title: 'b' } },
    ]);
    expect(result.every(r => r.success)).toBe(true);
    expect(result.map(r => r.recordId)).toEqual(['r1', 'r2']);
  });

  it('treats 201 with empty array as all-success (RLS WITH-CHECK passes, USING denies)', async () => {
    mockRequestUrl.mockResolvedValueOnce({
      status: 201, json: [], headers: {},
    });
    const c = new SupabaseClient(cred, makeConfig(), new RateLimiter(), defaultSpecCache());
    const result = await c.batchUpdate([{ recordId: 'r1', fields: { title: 'a' } }]);
    expect(result[0]).toMatchObject({ success: true, recordId: 'r1' });
  });

  it('still treats partial representation as partial failures (mixed visibility)', async () => {
    mockRequestUrl.mockResolvedValueOnce({
      status: 200, json: [{ id: 'r1', title: 'a' }], headers: {},  // only r1 visible
    });
    const c = new SupabaseClient(cred, makeConfig(), new RateLimiter(), defaultSpecCache());
    const result = await c.batchUpdate([
      { recordId: 'r1', fields: { title: 'a' } },
      { recordId: 'r2', fields: { title: 'b' } },
    ]);
    expect(result[0]).toMatchObject({ success: true, recordId: 'r1' });
    expect(result[1]).toMatchObject({ success: false, recordId: 'r2' });
  });
});

describe('SupabaseClient.batchUpdate body composition (G1: #1+#2+#5)', () => {
  function seedSpec(cache: SupabaseMetadataCache, tableDef: Record<string, unknown>): void {
    // Direct seed bypassing network — caches a spec keyed by credential.id + schema.
    const spec = {
      definitions: { notes: tableDef },
    } as unknown as Parameters<SupabaseMetadataCache['getColumns']>[0];
    // Use refresh path: clear + manual set via reflection-friendly entry.
    (cache as unknown as { entries: Map<string, { spec: unknown; fetchedAt: number }> })
      .entries.set('c1:public', { spec, fetchedAt: Date.now() });
  }

  it('#1: drops GENERATED/read-only columns from upsert body (PostgREST would 400 otherwise)', async () => {
    const cache = new SupabaseMetadataCache();
    seedSpec(cache, {
      properties: {
        id:        { type: 'string', format: 'uuid', description: '<pk/>' },
        title:     { type: 'string' },
        full_text: { type: 'string', readOnly: true },  // GENERATED column
      },
      required: ['id', 'title'],
    });
    mockRequestUrl.mockResolvedValueOnce({
      status: 200, json: [{ id: 'r1', title: 'foo' }], headers: {},
    });
    const c = new SupabaseClient(cred, makeConfig(), new RateLimiter(), cache);
    await c.batchUpdate([{ recordId: 'r1', fields: { title: 'foo', full_text: 'foo bar' } }]);
    const body = JSON.parse(mockRequestUrl.mock.calls[0][0].body);
    expect(body).toEqual([{ id: 'r1', title: 'foo' }]);
    expect(body[0]).not.toHaveProperty('full_text');
  });

  it('#2: drops columns absent from the base table (view-derived joins) from upsert body', async () => {
    const cache = new SupabaseMetadataCache();
    seedSpec(cache, {
      properties: {
        id:    { type: 'string', format: 'uuid', description: '<pk/>' },
        title: { type: 'string' },
        // author_name does NOT exist on base table notes — only on the view.
      },
      required: ['id', 'title'],
    });
    mockRequestUrl.mockResolvedValueOnce({
      status: 200, json: [{ id: 'r1', title: 'foo' }], headers: {},
    });
    const c = new SupabaseClient(cred, makeConfig({ viewId: 'active_notes_with_author' }), new RateLimiter(), cache);
    await c.batchUpdate([{ recordId: 'r1', fields: { title: 'foo', author_name: 'Kim' } }]);
    const body = JSON.parse(mockRequestUrl.mock.calls[0][0].body);
    expect(body).toEqual([{ id: 'r1', title: 'foo' }]);
    expect(body[0]).not.toHaveProperty('author_name');
  });

  it('#5: u.fields[pk] cannot override the recordId target (recordId always wins)', async () => {
    const cache = new SupabaseMetadataCache();
    seedSpec(cache, {
      properties: {
        id:    { type: 'string', description: '<pk/>' },
        title: { type: 'string' },
      },
      required: ['id', 'title'],
    });
    mockRequestUrl.mockResolvedValueOnce({
      status: 200, json: [{ id: 'r1', title: 'edited' }], headers: {},
    });
    const c = new SupabaseClient(cred, makeConfig(), new RateLimiter(), cache);
    // u.fields has a stale/edited id that disagrees with recordId
    await c.batchUpdate([{ recordId: 'r1', fields: { id: 'r99', title: 'edited' } }]);
    const body = JSON.parse(mockRequestUrl.mock.calls[0][0].body);
    expect(body[0].id).toBe('r1');  // recordId wins, not 'r99'
  });

  it('falls back to sending all writable-looking fields when metadata cache fetch fails', async () => {
    const cache = new SupabaseMetadataCache();
    // No seed -- the cache will try to fetch and fail.
    mockRequestUrl
      .mockRejectedValueOnce(new Error('metadata unavailable'))  // getSpec network call
      .mockResolvedValueOnce({ status: 200, json: [{ id: 'r1', title: 'foo' }], headers: {} });  // upsert POST

    const c = new SupabaseClient(cred, makeConfig(), new RateLimiter(), cache);
    const result = await c.batchUpdate([{ recordId: 'r1', fields: { title: 'foo' } }]);
    // Still completes the upsert — metadata is best-effort, not blocking.
    expect(result[0]).toMatchObject({ success: true, recordId: 'r1' });
  });
});
