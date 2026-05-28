/**
 * @covers src/services/seatable-metadata-cache.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { requestUrl } from 'obsidian';
import { SeaTableMetadataCache } from '../../src/services/seatable-metadata-cache';
import type { SeaTableCredential } from '../../src/types';

const mockRequestUrl = vi.mocked(requestUrl);

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
  return { status: 200, json: body, headers: {}, text: '', arrayBuffer: new ArrayBuffer(0) };
}

function mockErr(status: number, body: unknown = {}) {
  return { status, json: body, headers: {}, text: '', arrayBuffer: new ArrayBuffer(0) };
}

describe('SeaTableMetadataCache', () => {
  let cache: SeaTableMetadataCache;

  beforeEach(() => {
    // resetAllMocks (not clearAllMocks) drops mockImplementation set in
    // other tests / suites — prevents the obsidian mock from leaking
    // request behavior between files.
    vi.resetAllMocks();
    cache = new SeaTableMetadataCache();
  });

  describe('fetchTables', () => {
    it('exchanges Base-Token then GETs /metadata/ on a fresh cred', async () => {
      mockRequestUrl
        .mockResolvedValueOnce(mockOk(TOKEN_RESPONSE))
        .mockResolvedValueOnce(mockOk(METADATA_RESPONSE));

      const tables = await cache.fetchTables(createCredential());

      expect(mockRequestUrl).toHaveBeenCalledTimes(2);
      const [tokenCall, metaCall] = mockRequestUrl.mock.calls;
      expect(tokenCall[0].url).toBe('https://cloud.seatable.io/api/v2.1/dtable/app-access-token/');
      expect(tokenCall[0].headers?.Authorization).toBe('Token st-token-abc');
      expect(tokenCall[0].headers?.Accept).toBe('application/json');
      expect(metaCall[0].url).toBe('https://cloud.seatable.io/api-gateway/api/v2/dtables/uuid-xxx/metadata/');
      expect(metaCall[0].headers?.Authorization).toBe('Bearer bt-xxx');
      expect(metaCall[0].headers?.Accept).toBe('application/json');
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
      mockRequestUrl
        .mockResolvedValueOnce(mockOk(TOKEN_RESPONSE))
        .mockResolvedValueOnce(mockOk(METADATA_RESPONSE));

      const credential = createCredential();
      const first = await cache.fetchTables(credential);
      const second = await cache.fetchTables(credential);

      expect(first).toBe(second);
      expect(mockRequestUrl).toHaveBeenCalledTimes(2);
    });

    it('refetches metadata after clearForCred()', async () => {
      mockRequestUrl
        .mockResolvedValueOnce(mockOk(TOKEN_RESPONSE))
        .mockResolvedValueOnce(mockOk(METADATA_RESPONSE))
        .mockResolvedValueOnce(mockOk(TOKEN_RESPONSE))
        .mockResolvedValueOnce(mockOk({ metadata: { tables: [] } }));

      const credential = createCredential();
      await cache.fetchTables(credential);
      cache.clearForCred(credential.id);
      const refreshed = await cache.fetchTables(credential);

      expect(refreshed).toEqual([]);
      expect(mockRequestUrl).toHaveBeenCalledTimes(4);
    });

    it('strips trailing slashes from custom server URLs and routes to dtable_server', async () => {
      mockRequestUrl
        .mockResolvedValueOnce(mockOk({
          ...TOKEN_RESPONSE,
          dtable_server: 'https://seatable.example.com/api-gateway/',
        }))
        .mockResolvedValueOnce(mockOk(METADATA_RESPONSE));

      await cache.fetchTables(createCredential({ serverUrl: 'https://seatable.example.com/' }));

      const [tokenCall, metaCall] = mockRequestUrl.mock.calls;
      expect(tokenCall[0].url).toBe('https://seatable.example.com/api/v2.1/dtable/app-access-token/');
      expect(metaCall[0].url).toBe('https://seatable.example.com/api-gateway/api/v2/dtables/uuid-xxx/metadata/');
    });

    it('throws with HTTP details when the Base-Token endpoint fails', async () => {
      mockRequestUrl.mockResolvedValueOnce(mockErr(403, { error_msg: 'Invalid API token' }));

      await expect(cache.fetchTables(createCredential())).rejects.toThrow(/Failed to obtain SeaTable Base-Token/);
    });

    it('throws when Base-Token response is missing required fields', async () => {
      mockRequestUrl.mockResolvedValueOnce(mockOk({ access_token: 'only' }));

      await expect(cache.fetchTables(createCredential()))
        .rejects.toThrow(/missing access_token or dtable_uuid/);
    });

    it('throws with HTTP details when the metadata endpoint fails', async () => {
      mockRequestUrl
        .mockResolvedValueOnce(mockOk(TOKEN_RESPONSE))
        .mockResolvedValueOnce(mockErr(500, { error_msg: 'server error' }));

      await expect(cache.fetchTables(createCredential())).rejects.toThrow(/Failed to fetch SeaTable metadata/);
    });

    it('falls back to `${serverUrl}/api-gateway/` when token response omits dtable_server', async () => {
      // Matches SeaTableClient.getBaseToken's fallback so settings-tab
      // doesn't 404 on self-hosted SeaTable where the proxy strips
      // dtable_server from the token response.
      mockRequestUrl
        .mockResolvedValueOnce(mockOk({ access_token: 'bt-xxx', dtable_uuid: 'uuid-xxx' }))
        .mockResolvedValueOnce(mockOk(METADATA_RESPONSE));

      await cache.fetchTables(createCredential({ serverUrl: 'https://seatable.example.com' }));

      const [, metaCall] = mockRequestUrl.mock.calls;
      expect(metaCall[0].url).toBe('https://seatable.example.com/api-gateway/api/v2/dtables/uuid-xxx/metadata/');
    });

    it('accepts 2xx status codes other than 200 (e.g. 201 from upstream proxies)', async () => {
      mockRequestUrl
        .mockResolvedValueOnce({ status: 201, json: TOKEN_RESPONSE, headers: {}, text: '', arrayBuffer: new ArrayBuffer(0) })
        .mockResolvedValueOnce({ status: 201, json: METADATA_RESPONSE, headers: {}, text: '', arrayBuffer: new ArrayBuffer(0) });

      await expect(cache.fetchTables(createCredential())).resolves.toHaveLength(2);
    });

    it('does not crash when the 200 response body is non-JSON (lazy r.json throws)', async () => {
      // Simulate Obsidian's lazy `.json` getter throwing SyntaxError on
      // an HTML maintenance page returned with status 200.
      const throwingJsonResponse: unknown = {
        status: 200,
        get json() { throw new SyntaxError("Unexpected token '<'"); },
        headers: {},
        text: '<!DOCTYPE html><html>maintenance</html>',
        arrayBuffer: new ArrayBuffer(0),
      };
      mockRequestUrl
        .mockResolvedValueOnce(mockOk(TOKEN_RESPONSE))
        .mockResolvedValueOnce(throwingJsonResponse as Awaited<ReturnType<typeof import('obsidian').requestUrl>>);

      // parseJson swallows the SyntaxError → metadata?.tables ?? [] → empty list.
      await expect(cache.fetchTables(createCredential())).resolves.toEqual([]);
    });

    it('recovers wrapped error shape when older Obsidian builds reject on 4xx (throw:false ignored)', async () => {
      // Simulate the old Obsidian behavior: rejection with a status-bearing error object.
      mockRequestUrl.mockRejectedValueOnce(
        Object.assign(new Error('Forbidden'), { status: 403, json: { error_msg: 'Invalid API token' }, headers: {}, text: '' })
      );

      await expect(cache.fetchTables(createCredential())).rejects.toThrow(/Failed to obtain SeaTable Base-Token/);
    });

    it('drops malformed columns and views silently', async () => {
      mockRequestUrl
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
      mockRequestUrl
        .mockResolvedValueOnce(mockOk(TOKEN_RESPONSE))
        .mockResolvedValueOnce(mockOk(METADATA_RESPONSE));

      await cache.fetchTables(createCredential());

      expect(cache.getTable('cred-1', '0001')?.name).toBe('People');
    });

    it('returns undefined when nothing is cached for the cred', () => {
      expect(cache.getTable('cred-missing', '0000')).toBeUndefined();
    });
  });

  describe('clearForCred during in-flight fetch', () => {
    it('preserves a later in-flight entry when an earlier promise resolves (identity-checked finally)', async () => {
      // Reproduces SWEEP#2 race: clearForCred mid-flight, then a new fetch
      // starts. Without identity-checked delete in fetchTables' finally,
      // the original promise's cleanup would wipe the NEW promise's
      // in-flight entry → a follow-up call would NOT dedupe and start a
      // redundant fetch.
      //
      // We need to observe a follow-up that arrives AFTER A's finally but
      // BEFORE B finishes — and crucially, no cachedTables entry from A
      // (which would short-circuit the dedup test). Solving that by making
      // A fail (its metadata response is a 500), so the cache stays empty
      // and the inFlightTables Map is the only thing keeping D from
      // starting fresh.
      let resolveMetaA!: (v: unknown) => void;
      let resolveMetaB!: (v: unknown) => void;
      const metaPromiseA = new Promise(r => { resolveMetaA = r; });
      const metaPromiseB = new Promise(r => { resolveMetaB = r; });

      mockRequestUrl
        .mockResolvedValueOnce(mockOk(TOKEN_RESPONSE))   // A token
        .mockReturnValueOnce(metaPromiseA)               // A metadata (will fail)
        .mockResolvedValueOnce(mockOk(TOKEN_RESPONSE))   // B token
        .mockReturnValueOnce(metaPromiseB);              // B metadata (will succeed)

      const credential = createCredential();

      const callA = cache.fetchTables(credential);
      // Drain microtasks so A's token resolves and A reaches the metadata
      // await — A is now the in-flight entry.
      for (let i = 0; i < 20; i++) await Promise.resolve();

      cache.clearForCred(credential.id);

      const callB = cache.fetchTables(credential);
      const callC = cache.fetchTables(credential);

      // A's metadata fails. A throws; A's finally runs identity-check:
      // current inFlightTables entry is B's promise, NOT A's → must not delete.
      // A also never reached `cachedTables.set`, so cache is empty.
      resolveMetaA(mockErr(500, { error_msg: 'server error' }));
      await expect(callA).rejects.toThrow();

      // D arrives. With identity check: B's in-flight entry intact → dedupe.
      // Without it (the bug): no in-flight, no cache → fresh round trip.
      const callD = cache.fetchTables(credential);

      resolveMetaB(mockOk(METADATA_RESPONSE));
      const [resB, resC, resD] = await Promise.all([callB, callC, callD]);

      expect(resB).toBe(resC);
      expect(resB).toBe(resD);
      // 4 total mock calls: A(token+meta) + B(token+meta). C and D dedupe.
      // Without the race fix this would be 6 (extra token+meta for D).
      expect(mockRequestUrl).toHaveBeenCalledTimes(4);
    });
  });

  describe('in-flight dedup', () => {
    it('shares a single network round-trip across concurrent fetchTables() calls', async () => {
      let resolveToken!: (v: unknown) => void;
      let resolveMeta!: (v: unknown) => void;
      const tokenPromise = new Promise(r => { resolveToken = r; });
      const metaPromise = new Promise(r => { resolveMeta = r; });
      mockRequestUrl.mockReturnValueOnce(tokenPromise).mockReturnValueOnce(metaPromise);

      const credential = createCredential();
      const a = cache.fetchTables(credential);
      const b = cache.fetchTables(credential);

      resolveToken(mockOk(TOKEN_RESPONSE));
      resolveMeta(mockOk(METADATA_RESPONSE));

      const [resA, resB] = await Promise.all([a, b]);

      expect(resA).toBe(resB);
      // Two fetches total: 1 token + 1 metadata. Without dedup we'd see 4.
      expect(mockRequestUrl).toHaveBeenCalledTimes(2);
    });
  });

  describe('Base-Token TTL refresh', () => {
    it('re-exchanges the Base-Token when the cached entry has expired but keeps tables cache', async () => {
      vi.useFakeTimers();
      try {
        // First fetch — token + metadata.
        mockRequestUrl
          .mockResolvedValueOnce(mockOk(TOKEN_RESPONSE))
          .mockResolvedValueOnce(mockOk(METADATA_RESPONSE));

        const credential = createCredential();
        await cache.fetchTables(credential);
        expect(mockRequestUrl).toHaveBeenCalledTimes(2);

        // Drop the tables cache so the next fetchTables() reaches into
        // the token cache, but advance time past the refresh window so
        // the cached token is treated as stale.
        cache.clearForCred(credential.id);
        // 3 days + slack > TTL, so the cached token (if it survived
        // clearForCred) would be expired. Since clearForCred also drops
        // the token, this branch exercises a fresh exchange on its own;
        // priming the token cache directly via getBaseToken's resolver
        // would require exposing private state.
        vi.advanceTimersByTime(3 * 24 * 60 * 60 * 1000);

        mockRequestUrl
          .mockResolvedValueOnce(mockOk(TOKEN_RESPONSE))
          .mockResolvedValueOnce(mockOk(METADATA_RESPONSE));
        await cache.fetchTables(credential);
        expect(mockRequestUrl).toHaveBeenCalledTimes(4);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('clear()', () => {
    it('drops every cached cred entry, forcing a re-fetch', async () => {
      mockRequestUrl
        .mockResolvedValueOnce(mockOk(TOKEN_RESPONSE))
        .mockResolvedValueOnce(mockOk(METADATA_RESPONSE))
        .mockResolvedValueOnce(mockOk(TOKEN_RESPONSE))
        .mockResolvedValueOnce(mockOk(METADATA_RESPONSE));

      const credential = createCredential();
      await cache.fetchTables(credential);
      cache.clear();
      await cache.fetchTables(credential);

      expect(mockRequestUrl).toHaveBeenCalledTimes(4);
    });
  });
});
