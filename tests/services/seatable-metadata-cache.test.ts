/**
 * @covers src/services/seatable-metadata-cache.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SeaTableMetadataCache } from '../../src/services/seatable-metadata-cache';
import type { SeaTableCredential } from '../../src/types';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function createCredential(overrides: Partial<SeaTableCredential> = {}): SeaTableCredential {
  return {
    id: 'cred-1',
    name: 'Test SeaTable',
    type: 'seatable',
    apiToken: 'st-token-abc',
    serverUrl: 'https://cloud.seatable.io',
    ...overrides,
  };
}

const TOKEN_RESPONSE = {
  access_token: 'bt-xxx',
  dtable_uuid: 'uuid-xxx',
  dtable_server: 'https://cloud.seatable.io/api-gateway/',
};

const METADATA_RESPONSE = {
  metadata: {
    tables: [
      {
        _id: '0000',
        name: 'Tasks',
        columns: [
          { name: 'Name', type: 'text' },
          { name: 'Notes', type: 'long-text' },
          { name: 'Done', type: 'checkbox' },
        ],
        views: [
          { _id: 'v1', name: 'Default View' },
          { _id: 'v2', name: 'Active' },
        ],
      },
      {
        _id: '0001',
        name: 'People',
        columns: [{ name: 'Name', type: 'text' }],
        views: [{ _id: 'v3', name: 'All' }],
      },
    ],
  },
};

function mockOk(body: unknown) {
  return {
    ok: true,
    status: 200,
    json: async () => body,
  };
}

function mockErr(status: number, body: unknown = {}) {
  return {
    ok: false,
    status,
    json: async () => body,
  };
}

describe('SeaTableMetadataCache', () => {
  let cache: SeaTableMetadataCache;

  beforeEach(() => {
    vi.clearAllMocks();
    cache = new SeaTableMetadataCache();
  });

  describe('fetchTables', () => {
    it('exchanges Base-Token then GETs /metadata/ on a fresh cred', async () => {
      mockFetch
        .mockResolvedValueOnce(mockOk(TOKEN_RESPONSE))
        .mockResolvedValueOnce(mockOk(METADATA_RESPONSE));

      const tables = await cache.fetchTables(createCredential());

      expect(mockFetch).toHaveBeenCalledTimes(2);
      const [tokenCall, metaCall] = mockFetch.mock.calls;
      expect(tokenCall[0]).toBe('https://cloud.seatable.io/api/v2.1/dtable/app-access-token/');
      expect(tokenCall[1].headers.Authorization).toBe('Token st-token-abc');
      expect(metaCall[0]).toBe('https://cloud.seatable.io/api-gateway/api/v2/dtables/uuid-xxx/metadata/');
      expect(metaCall[1].headers.Authorization).toBe('Bearer bt-xxx');
      expect(tables).toHaveLength(2);
      expect(tables[0]).toEqual({
        id: '0000',
        name: 'Tasks',
        columns: [
          { name: 'Name', type: 'text' },
          { name: 'Notes', type: 'long-text' },
          { name: 'Done', type: 'checkbox' },
        ],
        views: [
          { id: 'v1', name: 'Default View' },
          { id: 'v2', name: 'Active' },
        ],
      });
    });

    it('reuses the cached tables across repeat calls without hitting the API', async () => {
      mockFetch
        .mockResolvedValueOnce(mockOk(TOKEN_RESPONSE))
        .mockResolvedValueOnce(mockOk(METADATA_RESPONSE));

      const credential = createCredential();
      const first = await cache.fetchTables(credential);
      const second = await cache.fetchTables(credential);

      expect(first).toBe(second);
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('refetches metadata after clearForCred()', async () => {
      mockFetch
        .mockResolvedValueOnce(mockOk(TOKEN_RESPONSE))
        .mockResolvedValueOnce(mockOk(METADATA_RESPONSE))
        .mockResolvedValueOnce(mockOk(TOKEN_RESPONSE))
        .mockResolvedValueOnce(mockOk({ metadata: { tables: [] } }));

      const credential = createCredential();
      await cache.fetchTables(credential);
      cache.clearForCred(credential.id);
      const refreshed = await cache.fetchTables(credential);

      expect(refreshed).toEqual([]);
      expect(mockFetch).toHaveBeenCalledTimes(4);
    });

    it('strips trailing slashes from custom server URLs and routes to dtable_server', async () => {
      mockFetch
        .mockResolvedValueOnce(mockOk({
          ...TOKEN_RESPONSE,
          dtable_server: 'https://seatable.example.com/api-gateway/',
        }))
        .mockResolvedValueOnce(mockOk(METADATA_RESPONSE));

      await cache.fetchTables(createCredential({ serverUrl: 'https://seatable.example.com/' }));

      const [tokenCall, metaCall] = mockFetch.mock.calls;
      expect(tokenCall[0]).toBe('https://seatable.example.com/api/v2.1/dtable/app-access-token/');
      expect(metaCall[0]).toBe('https://seatable.example.com/api-gateway/api/v2/dtables/uuid-xxx/metadata/');
    });

    it('throws with HTTP details when the Base-Token endpoint fails', async () => {
      mockFetch.mockResolvedValueOnce(mockErr(403, { error_msg: 'Invalid API token' }));

      await expect(cache.fetchTables(createCredential())).rejects.toThrow(/Failed to obtain SeaTable Base-Token/);
    });

    it('throws when Base-Token response is missing required fields', async () => {
      mockFetch.mockResolvedValueOnce(mockOk({ access_token: 'only' }));

      await expect(cache.fetchTables(createCredential()))
        .rejects.toThrow(/missing access_token or dtable_uuid/);
    });

    it('throws with HTTP details when the metadata endpoint fails', async () => {
      mockFetch
        .mockResolvedValueOnce(mockOk(TOKEN_RESPONSE))
        .mockResolvedValueOnce(mockErr(500, { error_msg: 'server error' }));

      await expect(cache.fetchTables(createCredential())).rejects.toThrow(/Failed to fetch SeaTable metadata/);
    });

    it('drops malformed columns and views silently', async () => {
      mockFetch
        .mockResolvedValueOnce(mockOk(TOKEN_RESPONSE))
        .mockResolvedValueOnce(mockOk({
          metadata: {
            tables: [{
              _id: '0000',
              name: 'Tasks',
              columns: [
                { name: 'Good', type: 'text' },
                { name: 42 as unknown as string, type: 'text' },
                { type: 'text' },
              ],
              views: [
                { _id: 'v1', name: 'OK' },
                { name: 'no id' },
              ],
            }],
          },
        }));

      const tables = await cache.fetchTables(createCredential());

      expect(tables[0].columns).toEqual([{ name: 'Good', type: 'text' }]);
      expect(tables[0].views).toEqual([{ id: 'v1', name: 'OK' }]);
    });
  });

  describe('getTable', () => {
    it('returns the cached table by id', async () => {
      mockFetch
        .mockResolvedValueOnce(mockOk(TOKEN_RESPONSE))
        .mockResolvedValueOnce(mockOk(METADATA_RESPONSE));

      await cache.fetchTables(createCredential());

      expect(cache.getTable('cred-1', '0001')?.name).toBe('People');
    });

    it('returns undefined when nothing is cached for the cred', () => {
      expect(cache.getTable('cred-missing', '0000')).toBeUndefined();
    });
  });

  describe('clear()', () => {
    it('drops every cached cred entry, forcing a re-fetch', async () => {
      mockFetch
        .mockResolvedValueOnce(mockOk(TOKEN_RESPONSE))
        .mockResolvedValueOnce(mockOk(METADATA_RESPONSE))
        .mockResolvedValueOnce(mockOk(TOKEN_RESPONSE))
        .mockResolvedValueOnce(mockOk(METADATA_RESPONSE));

      const credential = createCredential();
      await cache.fetchTables(credential);
      cache.clear();
      await cache.fetchTables(credential);

      expect(mockFetch).toHaveBeenCalledTimes(4);
    });
  });
});
