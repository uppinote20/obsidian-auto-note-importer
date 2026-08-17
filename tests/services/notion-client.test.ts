/**
 * Tests for NotionClient service.
 * @covers src/services/notion-client.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NotionClient } from '../../src/services/notion-client';
import { NotionSchemaCache } from '../../src/services/notion-schema-cache';
import { RateLimiter } from '../../src/services/rate-limiter';
import type { ConfigEntry, NotionCredential, NotionPropertySchemaMap } from '../../src/types';
import { DEFAULT_CONFIG_ENTRY } from '../../src/types';

const mockRequestUrl = vi.fn();
vi.mock('obsidian', () => ({
  requestUrl: (...args: unknown[]) => mockRequestUrl(...args),
  Notice: vi.fn(),
}));

const cred: NotionCredential = {
  id: 'c1', name: 'X', type: 'notion', integrationToken: 'ntn_test123',
};

function makeConfig(overrides: Partial<ConfigEntry> = {}): ConfigEntry {
  return {
    ...DEFAULT_CONFIG_ENTRY,
    id: 'cfg1', name: 'D', credentialId: 'c1',
    baseId: 'db-1', tableId: 'ds-1',
    ...overrides,
  };
}

// Pre-seeds the private schema cache map, matching the supabase-client.test.ts
// convention (`entries.set`) — notion-schema-cache.ts:44 uses `schemas`.
function seedSchema(cache: NotionSchemaCache, credentialId: string, dataSourceId: string, schema: NotionPropertySchemaMap): void {
  (cache as unknown as { schemas: Map<string, { schema: NotionPropertySchemaMap; fetchedAt: number }> })
    .schemas.set(`${credentialId}:${dataSourceId}`, { schema, fetchedAt: Date.now() });
}

function defaultSchemaCache(): NotionSchemaCache {
  const cache = new NotionSchemaCache();
  const schema: NotionPropertySchemaMap = new Map([
    ['Name', 'title'],
    ['Notes', 'rich_text'],
    ['Assignees', 'people'],
    ['Attachments', 'files'],
    ['Status', 'status'],
  ]);
  seedSchema(cache, 'c1', 'ds-1', schema);
  return cache;
}

beforeEach(() => mockRequestUrl.mockReset());

describe('NotionClient providerType + capabilities', () => {
  it('exposes correct providerType and capabilities', () => {
    const c = new NotionClient(cred, makeConfig(), new RateLimiter(0), false, new NotionSchemaCache());
    expect(c.providerType).toBe('notion');
    expect(c.capabilities.bidirectional).toBe(true);
    expect(c.capabilities.hasComputedFields).toBe(true);
    expect(c.capabilities.batchUpdateMaxSize).toBe(10);
  });
});

describe('NotionClient.fetchNotes', () => {
  it('merges paginated results and flattens properties', async () => {
    mockRequestUrl
      .mockResolvedValueOnce({
        status: 200,
        json: {
          results: [
            { id: 'page-1', properties: { Name: { type: 'title', title: [{ plain_text: 'Alpha' }] } } },
          ],
          has_more: true,
          next_cursor: 'cursor-1',
        },
      })
      .mockResolvedValueOnce({
        status: 200,
        json: {
          results: [
            { id: 'page-2', properties: { Name: { type: 'title', title: [{ plain_text: 'Beta' }] } } },
            { id: 'page-3', in_trash: true, properties: { Name: { type: 'title', title: [{ plain_text: 'Trashed' }] } } },
          ],
          has_more: false,
          next_cursor: null,
        },
      });

    const c = new NotionClient(cred, makeConfig(), new RateLimiter(0), false, new NotionSchemaCache());
    const notes = await c.fetchNotes();

    expect(notes).toHaveLength(2);
    expect(notes[0]).toEqual({ id: 'page-1', primaryField: 'page-1', fields: { Name: 'Alpha' } });
    expect(notes[1]).toEqual({ id: 'page-2', primaryField: 'page-2', fields: { Name: 'Beta' } });
    expect(mockRequestUrl).toHaveBeenCalledTimes(2);
    const secondCallBody = JSON.parse(mockRequestUrl.mock.calls[1][0].body);
    expect(secondCallBody.start_cursor).toBe('cursor-1');
  });
});

describe('NotionClient.fetchRecord', () => {
  it('returns null on 404', async () => {
    mockRequestUrl.mockResolvedValueOnce({ status: 404, json: {} });
    const c = new NotionClient(cred, makeConfig(), new RateLimiter(0), false, new NotionSchemaCache());
    const result = await c.fetchRecord('page-1');
    expect(result).toBeNull();
  });

  it('returns a RemoteNote for a found page', async () => {
    mockRequestUrl.mockResolvedValueOnce({
      status: 200,
      json: { id: 'page-1', properties: { Name: { type: 'title', title: [{ plain_text: 'Alpha' }] } } },
    });
    const c = new NotionClient(cred, makeConfig(), new RateLimiter(0), false, new NotionSchemaCache());
    const result = await c.fetchRecord('page-1');
    expect(result).toEqual({ id: 'page-1', primaryField: 'page-1', fields: { Name: 'Alpha' } });
  });
});

describe('NotionClient.batchUpdate', () => {
  it('returns [] for an empty batch', async () => {
    const c = new NotionClient(cred, makeConfig(), new RateLimiter(0), false, new NotionSchemaCache());
    expect(await c.batchUpdate([])).toEqual([]);
  });

  it('rejects a batch larger than NOTION_BATCH_SIZE', async () => {
    const c = new NotionClient(cred, makeConfig(), new RateLimiter(0), false, new NotionSchemaCache());
    const updates = Array.from({ length: 11 }, (_, i) => ({ recordId: `p${i}`, fields: { Name: 'x' } }));
    const results = await c.batchUpdate(updates);
    expect(results).toHaveLength(11);
    expect(results.every(r => !r.success)).toBe(true);
    expect(mockRequestUrl).not.toHaveBeenCalled();
  });

  it('rejects the whole batch on duplicate recordId', async () => {
    const c = new NotionClient(cred, makeConfig(), new RateLimiter(0), false, defaultSchemaCache());
    const results = await c.batchUpdate([
      { recordId: 'p1', fields: { Name: 'a' } },
      { recordId: 'p1', fields: { Name: 'b' } },
    ]);
    expect(results).toHaveLength(2);
    expect(results.every(r => !r.success)).toBe(true);
    if (!results[0].success) expect(results[0].error).toMatch(/Duplicate recordId/);
    expect(mockRequestUrl).not.toHaveBeenCalled();
  });

  it('fails fast with a clear message when schema load fails', async () => {
    const cache = new NotionSchemaCache();
    vi.spyOn(cache, 'getSchema').mockRejectedValueOnce(new Error('HTTP 500: boom'));
    const c = new NotionClient(cred, makeConfig(), new RateLimiter(0), false, cache);
    const results = await c.batchUpdate([{ recordId: 'p1', fields: { Name: 'a' } }]);
    expect(results).toHaveLength(1);
    expect(results[0].success).toBe(false);
    if (!results[0].success) expect(results[0].error).toMatch(/Failed to load Notion schema: HTTP 500: boom/);
    expect(mockRequestUrl).not.toHaveBeenCalled();
  });

  it('wraps pushable fields, skips object-shaped and unknown-name fields, and reports post-filter updatedFields', async () => {
    mockRequestUrl.mockResolvedValueOnce({ status: 200, json: { id: 'p1', properties: {} } });
    const c = new NotionClient(cred, makeConfig(), new RateLimiter(0), false, defaultSchemaCache());

    const results = await c.batchUpdate([{
      recordId: 'p1',
      fields: {
        Notes: 'hello world',
        Assignees: ['a', 'b'],   // people — object-shaped, skipped
        Attachments: ['x'],      // files — object-shaped, skipped
        Unknown: 'ignored',      // not in schema — skipped
      },
    }]);

    expect(results).toHaveLength(1);
    expect(results[0].success).toBe(true);
    if (results[0].success) {
      expect(results[0].updatedFields).toEqual({ Notes: 'hello world' });
    }

    const call = mockRequestUrl.mock.calls[0][0];
    expect(call.url).toBe('https://api.notion.com/v1/pages/p1');
    expect(call.method).toBe('PATCH');
    const body = JSON.parse(call.body);
    expect(body.properties).toEqual({ Notes: { rich_text: [{ text: { content: 'hello world' } }] } });
  });

  it('reports a per-record failure without aborting the batch on a non-2xx status', async () => {
    mockRequestUrl.mockResolvedValueOnce({ status: 400, json: { message: 'bad request' } });
    const c = new NotionClient(cred, makeConfig(), new RateLimiter(0), false, defaultSchemaCache());
    const results = await c.batchUpdate([{ recordId: 'p1', fields: { Notes: 'x' } }]);
    expect(results).toHaveLength(1);
    expect(results[0].success).toBe(false);
  });

  it('aborts remaining records without firing requests on 401', async () => {
    mockRequestUrl.mockResolvedValueOnce({ status: 401, json: { message: 'Unauthorized' } });
    const c = new NotionClient(cred, makeConfig(), new RateLimiter(0), false, defaultSchemaCache());
    const results = await c.batchUpdate([
      { recordId: 'p1', fields: { Notes: 'x' } },
      { recordId: 'p2', fields: { Notes: 'y' } },
      { recordId: 'p3', fields: { Notes: 'z' } },
    ]);
    expect(results).toHaveLength(3);
    expect(results.every(r => !r.success)).toBe(true);
    expect(mockRequestUrl).toHaveBeenCalledTimes(1);
    if (!results[1].success) expect(results[1].error).toMatch(/aborted/i);
    if (!results[2].success) expect(results[2].error).toMatch(/aborted/i);
  });

  it('preserves already-accumulated successes when a later record throws mid-batch', async () => {
    mockRequestUrl
      .mockResolvedValueOnce({ status: 200, json: { id: 'p1', properties: {} } })
      .mockResolvedValueOnce({ status: 200, json: { id: 'p2', properties: {} } })
      .mockRejectedValueOnce(new Error('network error'));
    const c = new NotionClient(cred, makeConfig(), new RateLimiter(0), false, defaultSchemaCache());
    const results = await c.batchUpdate([
      { recordId: 'p1', fields: { Notes: 'a' } },
      { recordId: 'p2', fields: { Notes: 'b' } },
      { recordId: 'p3', fields: { Notes: 'c' } },
      { recordId: 'p4', fields: { Notes: 'd' } },
    ]);
    expect(results).toHaveLength(4);
    expect(results[0].success).toBe(true);
    expect(results[1].success).toBe(true);
    expect(results[2].success).toBe(false);
    expect(results[3].success).toBe(false);
    if (!results[3].success) expect(results[3].error).toMatch(/aborted/i);
    expect(mockRequestUrl).toHaveBeenCalledTimes(3);
  });

  it('skips the PATCH request and reports success for updates with no pushable fields', async () => {
    const c = new NotionClient(cred, makeConfig(), new RateLimiter(0), false, defaultSchemaCache());
    const results = await c.batchUpdate([{
      recordId: 'p1',
      fields: { Assignees: ['a'], Unknown: 'x' }, // people (read-only-ish/object) + unknown name
    }]);
    expect(results).toHaveLength(1);
    expect(results[0]).toEqual({ success: true, recordId: 'p1', updatedFields: {} });
    expect(mockRequestUrl).not.toHaveBeenCalled();
  });
});

describe('NotionClient.reconfigure', () => {
  it('throws when given a non-notion credential', () => {
    const c = new NotionClient(cred, makeConfig(), new RateLimiter(0), false, new NotionSchemaCache());
    expect(() => c.reconfigure(
      { id: 'x', name: 'X', type: 'airtable', apiKey: 'k' },
      makeConfig(),
      new RateLimiter(0),
      false,
    )).toThrow(/notion/i);
  });

  it('clears the schema cache when integrationToken changes', () => {
    const cache = new NotionSchemaCache();
    const clearSpy = vi.spyOn(cache, 'clearForCred');
    const c = new NotionClient(cred, makeConfig(), new RateLimiter(0), false, cache);
    c.reconfigure({ ...cred, integrationToken: 'ntn_new' }, makeConfig(), new RateLimiter(0), false);
    expect(clearSpy).toHaveBeenCalledWith('c1');
  });

  it('does not clear the schema cache when integrationToken is unchanged', () => {
    const cache = new NotionSchemaCache();
    const clearSpy = vi.spyOn(cache, 'clearForCred');
    const c = new NotionClient(cred, makeConfig(), new RateLimiter(0), false, cache);
    c.reconfigure({ ...cred }, makeConfig({ baseId: 'db-2' }), new RateLimiter(0), false);
    expect(clearSpy).not.toHaveBeenCalled();
  });
});
