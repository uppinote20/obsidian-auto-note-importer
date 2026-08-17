/**
 * @covers src/services/notion-schema-cache.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NotionSchemaCache } from '../../src/services/notion-schema-cache';
import type { NotionCredential } from '../../src/types';

const mockRequestUrl = vi.fn();
vi.mock('obsidian', () => ({
  requestUrl: (...args: unknown[]) => mockRequestUrl(...args),
}));

const cred: NotionCredential = {
  id: 'c1',
  name: 'My Notion',
  type: 'notion',
  integrationToken: 'secret_abc',
};

// Stub limiter — passes requests straight through so tests stay
// deterministic/fast, while letting us assert pacing is actually invoked.
let executeCallCount = 0;
const stubLimiter = { execute: <T>(fn: () => Promise<T>) => { executeCallCount++; return fn(); } };
function makeCache(): NotionSchemaCache {
  return new NotionSchemaCache(() => stubLimiter);
}

beforeEach(() => {
  mockRequestUrl.mockReset();
  executeCallCount = 0;
});

afterEach(() => vi.useRealTimers());

describe('NotionSchemaCache.listDataSources', () => {
  it('sends Authorization + Notion-Version headers on the search POST', async () => {
    mockRequestUrl.mockResolvedValueOnce({
      status: 200,
      json: { results: [], has_more: false, next_cursor: null },
      text: '',
    });
    const cache = makeCache();
    await cache.listDataSources(cred);
    const call = mockRequestUrl.mock.calls[0][0];
    expect(call.url).toContain('/search');
    expect(call.method).toBe('POST');
    expect(call.headers['Authorization']).toBe('Bearer secret_abc');
    expect(call.headers['Notion-Version']).toBeTruthy();
    expect(call.headers['Content-Type']).toBe('application/json');
    const body = JSON.parse(call.body);
    expect(body.filter).toEqual({ property: 'object', value: 'data_source' });
  });

  it('maps results to NotionDataSourceSummary, using parent.database_id and joined title', async () => {
    mockRequestUrl.mockResolvedValueOnce({
      status: 200,
      json: {
        results: [
          {
            id: 'ds1',
            parent: { database_id: 'db1' },
            title: [{ plain_text: 'My ' }, { plain_text: 'Table' }],
            in_trash: false,
          },
        ],
        has_more: false,
        next_cursor: null,
      },
      text: '',
    });
    const cache = makeCache();
    const sources = await cache.listDataSources(cred);
    expect(sources).toEqual([{ id: 'ds1', databaseId: 'db1', title: 'My Table' }]);
  });

  it('falls back to "Untitled" when title is empty', async () => {
    mockRequestUrl.mockResolvedValueOnce({
      status: 200,
      json: {
        results: [{ id: 'ds1', parent: {}, title: [] }],
        has_more: false,
        next_cursor: null,
      },
      text: '',
    });
    const cache = makeCache();
    const sources = await cache.listDataSources(cred);
    expect(sources[0].title).toBe('Untitled');
    expect(sources[0].databaseId).toBe('');
  });

  it('skips in_trash entries', async () => {
    mockRequestUrl.mockResolvedValueOnce({
      status: 200,
      json: {
        results: [
          { id: 'ds1', parent: { database_id: 'db1' }, title: [{ plain_text: 'Live' }], in_trash: false },
          { id: 'ds2', parent: { database_id: 'db2' }, title: [{ plain_text: 'Trashed' }], in_trash: true },
        ],
        has_more: false,
        next_cursor: null,
      },
      text: '',
    });
    const cache = makeCache();
    const sources = await cache.listDataSources(cred);
    expect(sources.map(s => s.id)).toEqual(['ds1']);
  });

  it('paginates via has_more/next_cursor and merges results', async () => {
    mockRequestUrl
      .mockResolvedValueOnce({
        status: 200,
        json: {
          results: [{ id: 'ds1', parent: { database_id: 'db1' }, title: [{ plain_text: 'A' }] }],
          has_more: true,
          next_cursor: 'cursor1',
        },
        text: '',
      })
      .mockResolvedValueOnce({
        status: 200,
        json: {
          results: [{ id: 'ds2', parent: { database_id: 'db2' }, title: [{ plain_text: 'B' }] }],
          has_more: false,
          next_cursor: null,
        },
        text: '',
      });
    const cache = makeCache();
    const sources = await cache.listDataSources(cred);
    expect(sources.map(s => s.id)).toEqual(['ds1', 'ds2']);
    expect(mockRequestUrl).toHaveBeenCalledTimes(2);
    const secondCall = mockRequestUrl.mock.calls[1][0];
    expect(JSON.parse(secondCall.body).start_cursor).toBe('cursor1');
  });

  it('throws with extracted API error detail on non-2xx', async () => {
    mockRequestUrl.mockResolvedValueOnce({
      status: 401,
      json: { message: 'Unauthorized' },
      text: '',
    });
    const cache = makeCache();
    await expect(cache.listDataSources(cred)).rejects.toThrow(/401|Unauthorized/i);
  });

  it('caches the list per credential within TTL — second call makes no additional requests', async () => {
    mockRequestUrl.mockResolvedValue({
      status: 200,
      json: { results: [{ id: 'ds1', parent: { database_id: 'db1' }, title: [{ plain_text: 'A' }] }], has_more: false, next_cursor: null },
      text: '',
    });
    const cache = makeCache();
    await cache.listDataSources(cred);
    executeCallCount = 0;
    const sources = await cache.listDataSources(cred);
    expect(mockRequestUrl).toHaveBeenCalledTimes(1);
    expect(executeCallCount).toBe(0);
    expect(sources.map(s => s.id)).toEqual(['ds1']);
  });

  it('re-fetches the list after TTL expiry', async () => {
    vi.useFakeTimers();
    mockRequestUrl.mockResolvedValue({
      status: 200,
      json: { results: [], has_more: false, next_cursor: null },
      text: '',
    });
    const cache = makeCache();
    await cache.listDataSources(cred);
    vi.advanceTimersByTime(11 * 60 * 1000);
    await cache.listDataSources(cred);
    expect(mockRequestUrl).toHaveBeenCalledTimes(2);
  });

  it('does not cache the list on failure', async () => {
    mockRequestUrl
      .mockResolvedValueOnce({ status: 500, json: { message: 'boom' }, text: '' })
      .mockResolvedValueOnce({ status: 200, json: { results: [], has_more: false, next_cursor: null }, text: '' });
    const cache = makeCache();
    await expect(cache.listDataSources(cred)).rejects.toThrow();
    await cache.listDataSources(cred);
    expect(mockRequestUrl).toHaveBeenCalledTimes(2);
  });

  it('clearForCred forces the list to refetch for that credential only', async () => {
    mockRequestUrl.mockResolvedValue({ status: 200, json: { results: [], has_more: false, next_cursor: null }, text: '' });
    const other: NotionCredential = { ...cred, id: 'c2' };
    const cache = makeCache();
    await cache.listDataSources(cred);
    await cache.listDataSources(other);
    cache.clearForCred(cred.id);
    await cache.listDataSources(cred);
    await cache.listDataSources(other);
    expect(mockRequestUrl).toHaveBeenCalledTimes(3);
  });
});

describe('NotionSchemaCache.getSchema', () => {
  it('fetches and maps properties into a Map(name -> type)', async () => {
    mockRequestUrl.mockResolvedValueOnce({
      status: 200,
      json: {
        properties: {
          Name: { type: 'title' },
          Done: { type: 'checkbox' },
        },
      },
      text: '',
    });
    const cache = makeCache();
    const schema = await cache.getSchema(cred, 'ds1');
    expect(schema).toBeInstanceOf(Map);
    expect(schema.get('Name')).toBe('title');
    expect(schema.get('Done')).toBe('checkbox');
  });

  it('sends GET to /data_sources/{id}', async () => {
    mockRequestUrl.mockResolvedValueOnce({ status: 200, json: { properties: {} }, text: '' });
    const cache = makeCache();
    await cache.getSchema(cred, 'ds1');
    const call = mockRequestUrl.mock.calls[0][0];
    expect(call.url).toContain('/data_sources/ds1');
    expect(call.method).toBe('GET');
  });

  it('caches schema per (credential, dataSourceId) within TTL', async () => {
    mockRequestUrl.mockResolvedValue({ status: 200, json: { properties: { A: { type: 'text' } } }, text: '' });
    const cache = makeCache();
    await cache.getSchema(cred, 'ds1');
    await cache.getSchema(cred, 'ds1');
    expect(mockRequestUrl).toHaveBeenCalledTimes(1);
  });

  it('uses separate cache entries per dataSourceId', async () => {
    mockRequestUrl.mockResolvedValue({ status: 200, json: { properties: {} }, text: '' });
    const cache = makeCache();
    await cache.getSchema(cred, 'ds1');
    await cache.getSchema(cred, 'ds2');
    expect(mockRequestUrl).toHaveBeenCalledTimes(2);
  });

  it('re-fetches after TTL expiry', async () => {
    vi.useFakeTimers();
    mockRequestUrl.mockResolvedValue({ status: 200, json: { properties: {} }, text: '' });
    const cache = makeCache();
    await cache.getSchema(cred, 'ds1');
    vi.advanceTimersByTime(11 * 60 * 1000);
    await cache.getSchema(cred, 'ds1');
    expect(mockRequestUrl).toHaveBeenCalledTimes(2);
  });

  it('does not cache on failure', async () => {
    mockRequestUrl
      .mockResolvedValueOnce({ status: 500, json: { message: 'boom' }, text: '' })
      .mockResolvedValueOnce({ status: 200, json: { properties: {} }, text: '' });
    const cache = makeCache();
    await expect(cache.getSchema(cred, 'ds1')).rejects.toThrow();
    await cache.getSchema(cred, 'ds1');
    expect(mockRequestUrl).toHaveBeenCalledTimes(2);
  });

  it('throws with extracted API error detail on non-2xx', async () => {
    mockRequestUrl.mockResolvedValueOnce({ status: 404, json: { message: 'Not found' }, text: '' });
    const cache = makeCache();
    await expect(cache.getSchema(cred, 'ds-missing')).rejects.toThrow(/404|Not found/i);
  });
});

describe('NotionSchemaCache invalidation', () => {
  it('clearForCred forces refetch for that credential only', async () => {
    mockRequestUrl.mockResolvedValue({ status: 200, json: { properties: {} }, text: '' });
    const other: NotionCredential = { ...cred, id: 'c2' };
    const cache = makeCache();
    await cache.getSchema(cred, 'ds1');
    await cache.getSchema(other, 'ds1');
    cache.clearForCred(cred.id);
    await cache.getSchema(cred, 'ds1');
    await cache.getSchema(other, 'ds1');
    expect(mockRequestUrl).toHaveBeenCalledTimes(3);
  });

  it('clear() drops all credentials', async () => {
    mockRequestUrl.mockResolvedValue({ status: 200, json: { properties: {} }, text: '' });
    const other: NotionCredential = { ...cred, id: 'c2' };
    const cache = makeCache();
    await cache.getSchema(cred, 'ds1');
    await cache.getSchema(other, 'ds1');
    cache.clear();
    await cache.getSchema(cred, 'ds1');
    await cache.getSchema(other, 'ds1');
    expect(mockRequestUrl).toHaveBeenCalledTimes(4);
  });
});

describe('NotionSchemaCache pacing', () => {
  it('routes every HTTP request, including each pagination page, through the injected limiter', async () => {
    mockRequestUrl
      .mockResolvedValueOnce({
        status: 200,
        json: {
          results: [{ id: 'ds1', parent: { database_id: 'db1' }, title: [{ plain_text: 'A' }] }],
          has_more: true,
          next_cursor: 'cursor1',
        },
        text: '',
      })
      .mockResolvedValueOnce({
        status: 200,
        json: {
          results: [{ id: 'ds2', parent: { database_id: 'db2' }, title: [{ plain_text: 'B' }] }],
          has_more: false,
          next_cursor: null,
        },
        text: '',
      })
      .mockResolvedValueOnce({ status: 200, json: { properties: {} }, text: '' });

    const cache = makeCache();
    await cache.listDataSources(cred);
    await cache.getSchema(cred, 'ds1');

    expect(mockRequestUrl).toHaveBeenCalledTimes(3);
    expect(executeCallCount).toBe(3);
  });
});
