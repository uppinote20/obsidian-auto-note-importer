/**
 * Tests for SeaTableClient service.
 * @covers src/services/seatable-client.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SeaTableClient } from '../../src/services/seatable-client';
import type {
  AirtableCredential,
  ConfigEntry,
  SeaTableCredential,
} from '../../src/types';
import { DEFAULT_CONFIG_ENTRY } from '../../src/types';
import { SEATABLE_BATCH_SIZE } from '../../src/constants';
import { RateLimiter } from '../../src/services/rate-limiter';
import { requestUrl } from 'obsidian';

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

function createConfig(overrides: Partial<ConfigEntry> = {}): ConfigEntry {
  return {
    ...DEFAULT_CONFIG_ENTRY,
    id: 'cfg-1',
    name: 'Cfg',
    credentialId: 'cred-1',
    tableId: '0000',
    ...overrides,
  };
}

function mockResponse(json: unknown, status = 200, text = '') {
  return { status, json, headers: {}, text, arrayBuffer: new ArrayBuffer(0) };
}

// Real-world Cloud SeaTable response shape captured via direct API
// inspection — note `dtable_server` ends with `/api-gateway/`.
const BASE_TOKEN_RESPONSE = {
  app_name: 'obsidian-auto-note-importer',
  access_token: 'eyJhbGc.bt-xxx',
  dtable_uuid: 'uuid-xxx',
  workspace_id: 105074,
  dtable_name: 'demo',
  use_api_gateway: true,
  dtable_server: 'https://cloud.seatable.io/api-gateway/',
};

// SeaTable rows always carry these system fields alongside user columns.
// They must be stripped before reaching Obsidian frontmatter.
const SYSTEM_FIELDS = {
  _locked: null,
  _locked_by: null,
  _archived: false,
  _creator: 'someone@auth.local',
  _ctime: '2026-01-01T00:00:00.000+00:00',
  _last_modifier: 'someone@auth.local',
  _mtime: '2026-01-02T00:00:00.000+00:00',
};

describe('SeaTableClient', () => {
  let client: SeaTableClient;
  let rateLimiter: RateLimiter;

  beforeEach(() => {
    vi.clearAllMocks();
    rateLimiter = new RateLimiter(0);
    client = new SeaTableClient(createCredential(), createConfig(), rateLimiter);
  });

  describe('DatabaseProvider interface', () => {
    it('should advertise seatable providerType', () => {
      expect(client.providerType).toBe('seatable');
    });

    it('should advertise capabilities metadata', () => {
      expect(client.capabilities).toEqual({
        bidirectional: true,
        hasComputedFields: true,
        batchUpdateMaxSize: SEATABLE_BATCH_SIZE,
      });
    });
  });

  describe('validateConfig', () => {
    it('should throw when apiToken is missing', async () => {
      client = new SeaTableClient(
        createCredential({ apiToken: '' }),
        createConfig(),
        rateLimiter,
      );
      await expect(client.fetchNotes()).rejects.toThrow('SeaTable API token must be set');
    });

    it('should throw when tableId is missing', async () => {
      client = new SeaTableClient(
        createCredential(),
        createConfig({ tableId: '' }),
        rateLimiter,
      );
      await expect(client.fetchNotes()).rejects.toThrow('SeaTable table ID must be set');
    });
  });

  describe('Base-Token exchange', () => {
    it('should obtain a Base-Token before the first row request', async () => {
      mockRequestUrl
        .mockResolvedValueOnce(mockResponse(BASE_TOKEN_RESPONSE))
        .mockResolvedValueOnce(mockResponse({ rows: [] }));

      await client.fetchNotes();

      expect(mockRequestUrl).toHaveBeenCalledTimes(2);
      const tokenCall = mockRequestUrl.mock.calls[0][0];
      expect(tokenCall.url).toBe('https://cloud.seatable.io/api/v2.1/dtable/app-access-token/');
      const tokenHeaders = tokenCall.headers as Record<string, string>;
      // Token-exchange call uses the API-Token verbatim with `Token` prefix.
      expect(tokenHeaders['Authorization']).toBe('Token st-token-abc');
    });

    it('should cache the Base-Token across calls', async () => {
      mockRequestUrl
        .mockResolvedValueOnce(mockResponse(BASE_TOKEN_RESPONSE))
        .mockResolvedValueOnce(mockResponse({ rows: [] }))
        .mockResolvedValueOnce(mockResponse({ rows: [] }));

      await client.fetchNotes();
      await client.fetchNotes();

      // 1 token + 2 row requests, not 2 token + 2 row requests.
      expect(mockRequestUrl).toHaveBeenCalledTimes(3);
    });

    it('should throw when Base-Token endpoint returns non-200', async () => {
      mockRequestUrl.mockResolvedValueOnce(
        mockResponse({ error_msg: 'Invalid API token' }, 403),
      );

      await expect(client.fetchNotes()).rejects.toThrow(/Failed to obtain SeaTable Base-Token/);
    });

    it('should throw when Base-Token response is missing required fields', async () => {
      mockRequestUrl.mockResolvedValueOnce(mockResponse({ access_token: 'x' }));

      await expect(client.fetchNotes())
        .rejects.toThrow(/missing access_token or dtable_uuid/);
    });

    it('should trim trailing slashes from custom server URL', async () => {
      client = new SeaTableClient(
        createCredential({ serverUrl: 'https://seatable.example.com/' }),
        createConfig(),
        rateLimiter,
      );
      mockRequestUrl
        .mockResolvedValueOnce(mockResponse({
          ...BASE_TOKEN_RESPONSE,
          dtable_server: 'https://seatable.example.com/api-gateway/',
        }))
        .mockResolvedValueOnce(mockResponse({ rows: [] }));

      await client.fetchNotes();

      const tokenCall = mockRequestUrl.mock.calls[0][0];
      expect(tokenCall.url).toBe('https://seatable.example.com/api/v2.1/dtable/app-access-token/');
    });
  });

  describe('fetchNotes', () => {
    it('should call the api-gateway v2 rows endpoint with Bearer auth and convert_keys=true', async () => {
      mockRequestUrl
        .mockResolvedValueOnce(mockResponse(BASE_TOKEN_RESPONSE))
        .mockResolvedValueOnce(mockResponse({ rows: [] }));

      await client.fetchNotes();

      const rowsCall = mockRequestUrl.mock.calls[1][0];
      expect(rowsCall.url).toContain('/api-gateway/api/v2/dtables/uuid-xxx/rows/');
      expect(rowsCall.url).toContain('convert_keys=true');
      const headers = rowsCall.headers as Record<string, string>;
      expect(headers['Authorization']).toBe('Bearer eyJhbGc.bt-xxx');
    });

    it('should fetch rows in a single page when result is smaller than page size', async () => {
      mockRequestUrl
        .mockResolvedValueOnce(mockResponse(BASE_TOKEN_RESPONSE))
        .mockResolvedValueOnce(mockResponse({
          rows: [
            { _id: 'r1', Name: 'Note 1' },
            { _id: 'r2', Name: 'Note 2' },
          ],
        }));

      const notes = await client.fetchNotes();
      expect(notes).toHaveLength(2);
      expect(notes[0]).toEqual({
        id: 'r1',
        primaryField: 'r1',
        fields: { Name: 'Note 1' },
      });
    });

    it('should strip SeaTable system metadata fields from row payloads', async () => {
      mockRequestUrl
        .mockResolvedValueOnce(mockResponse(BASE_TOKEN_RESPONSE))
        .mockResolvedValueOnce(mockResponse({
          rows: [
            { _id: 'r1', Name: 'Note 1', Status: 'Done', ...SYSTEM_FIELDS },
          ],
        }));

      const notes = await client.fetchNotes();

      expect(notes).toHaveLength(1);
      expect(notes[0].fields).toEqual({ Name: 'Note 1', Status: 'Done' });
      // Spot-check that nothing underscore-prefixed leaked into fields.
      for (const key of Object.keys(notes[0].fields)) {
        expect(key.startsWith('_')).toBe(false);
      }
    });

    it('should pass viewId as view_id query param when set', async () => {
      mockRequestUrl
        .mockResolvedValueOnce(mockResponse(BASE_TOKEN_RESPONSE))
        .mockResolvedValueOnce(mockResponse({ rows: [] }));

      client = new SeaTableClient(
        createCredential(),
        createConfig({ viewId: 'view-1' }),
        rateLimiter,
      );
      await client.fetchNotes();

      const rowsUrl = mockRequestUrl.mock.calls[1][0].url;
      expect(rowsUrl).toContain('view_id=view-1');
      expect(rowsUrl).toContain('table_id=0000');
    });

    it('should skip rows missing _id', async () => {
      mockRequestUrl
        .mockResolvedValueOnce(mockResponse(BASE_TOKEN_RESPONSE))
        .mockResolvedValueOnce(mockResponse({
          rows: [{ _id: 'r1', Name: 'OK' }, { Name: 'Bad' }],
        }));

      const notes = await client.fetchNotes();
      expect(notes).toHaveLength(1);
      expect(notes[0].id).toBe('r1');
    });

    it('should throw on non-200 row response', async () => {
      mockRequestUrl
        .mockResolvedValueOnce(mockResponse(BASE_TOKEN_RESPONSE))
        .mockResolvedValueOnce(mockResponse({ error_msg: 'Forbidden' }, 403));

      await expect(client.fetchNotes()).rejects.toThrow(/Failed to fetch SeaTable rows/);
    });
  });

  describe('fetchRecord', () => {
    it('should fetch a single row and strip system fields', async () => {
      mockRequestUrl
        .mockResolvedValueOnce(mockResponse(BASE_TOKEN_RESPONSE))
        .mockResolvedValueOnce(mockResponse({ _id: 'r1', Name: 'Test', ...SYSTEM_FIELDS }));

      const note = await client.fetchRecord('r1');
      expect(note).toEqual({ id: 'r1', primaryField: 'r1', fields: { Name: 'Test' } });
    });

    it('should request convert_keys=true on single-row fetch', async () => {
      mockRequestUrl
        .mockResolvedValueOnce(mockResponse(BASE_TOKEN_RESPONSE))
        .mockResolvedValueOnce(mockResponse({ _id: 'r1', Name: 'Test' }));

      await client.fetchRecord('r1');
      const url = mockRequestUrl.mock.calls[1][0].url;
      expect(url).toContain('/api/v2/dtables/uuid-xxx/rows/r1/');
      expect(url).toContain('convert_keys=true');
    });

    it('should return null for 404', async () => {
      mockRequestUrl
        .mockResolvedValueOnce(mockResponse(BASE_TOKEN_RESPONSE))
        .mockResolvedValueOnce(mockResponse({}, 404));

      const note = await client.fetchRecord('rMissing');
      expect(note).toBeNull();
    });

    it('should throw on empty record ID', async () => {
      await expect(client.fetchRecord('')).rejects.toThrow('SeaTable row ID cannot be empty');
    });
  });

  describe('updateRecord', () => {
    it('should send batch-shaped body to PUT /rows/ for a single update', async () => {
      mockRequestUrl
        .mockResolvedValueOnce(mockResponse(BASE_TOKEN_RESPONSE))
        .mockResolvedValueOnce(mockResponse({ success: true }));

      const result = await client.updateRecord('r1', { Name: 'Updated' });

      expect(result).toEqual({
        success: true,
        recordId: 'r1',
        updatedFields: { Name: 'Updated' },
      });

      const writeCall = mockRequestUrl.mock.calls[1][0];
      expect(writeCall.method).toBe('PUT');
      expect(writeCall.url).toContain('/api/v2/dtables/uuid-xxx/rows/');
      const headers = writeCall.headers as Record<string, string>;
      expect(headers['Authorization']).toBe('Bearer eyJhbGc.bt-xxx');
      // Single update is wrapped in a 1-element `updates` array — the
      // single-row form is a silent no-op on the API Gateway.
      const body = JSON.parse(writeCall.body as string);
      expect(body).toEqual({
        table_id: '0000',
        updates: [{ row_id: 'r1', row: { Name: 'Updated' } }],
      });
    });

    it('should return failure result on non-200', async () => {
      mockRequestUrl
        .mockResolvedValueOnce(mockResponse(BASE_TOKEN_RESPONSE))
        .mockResolvedValueOnce(mockResponse({ error_msg: 'Field not found' }, 400));

      const result = await client.updateRecord('r1', { Bad: 'x' });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('Failed to batch update');
      }
    });

    it('should catch thrown errors and return failure', async () => {
      mockRequestUrl
        .mockResolvedValueOnce(mockResponse(BASE_TOKEN_RESPONSE))
        .mockRejectedValueOnce(new Error('Network down'));

      const result = await client.updateRecord('r1', {});
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toBe('Network down');
      }
    });

    it('should return failure on empty record ID without making a request', async () => {
      const result = await client.updateRecord('', {});
      expect(result.success).toBe(false);
      expect(mockRequestUrl).not.toHaveBeenCalled();
    });
  });

  describe('batchUpdate', () => {
    it('should return empty array for no updates', async () => {
      const results = await client.batchUpdate([]);
      expect(results).toEqual([]);
      expect(mockRequestUrl).not.toHaveBeenCalled();
    });

    it('should batch update rows via PUT /rows/ with updates array', async () => {
      mockRequestUrl
        .mockResolvedValueOnce(mockResponse(BASE_TOKEN_RESPONSE))
        .mockResolvedValueOnce(mockResponse({ success: true }));

      const results = await client.batchUpdate([
        { recordId: 'r1', fields: { Name: 'A' } },
        { recordId: 'r2', fields: { Name: 'B' } },
      ]);

      expect(results).toHaveLength(2);
      expect(results[0]).toEqual({ success: true, recordId: 'r1', updatedFields: { Name: 'A' } });

      const writeCall = mockRequestUrl.mock.calls[1][0];
      expect(writeCall.method).toBe('PUT');
      // Path is `/rows/` (single endpoint handles both single + batch),
      // not the deprecated `/batch-update-rows/` path.
      expect(writeCall.url).toContain('/api/v2/dtables/uuid-xxx/rows/');
      expect(writeCall.url).not.toContain('batch-update-rows');

      const body = JSON.parse(writeCall.body as string);
      expect(body.table_id).toBe('0000');
      expect(body.updates).toEqual([
        { row_id: 'r1', row: { Name: 'A' } },
        { row_id: 'r2', row: { Name: 'B' } },
      ]);
    });

    it('should throw when exceeding batch size', async () => {
      const updates = Array.from({ length: SEATABLE_BATCH_SIZE + 1 }, (_, i) => ({
        recordId: `r${i}`,
        fields: {},
      }));
      await expect(client.batchUpdate(updates))
        .rejects.toThrow(`Maximum ${SEATABLE_BATCH_SIZE} records allowed`);
    });

    it('should return failure for all records on non-200', async () => {
      mockRequestUrl
        .mockResolvedValueOnce(mockResponse(BASE_TOKEN_RESPONSE))
        .mockResolvedValueOnce(mockResponse({ error_msg: 'Server error' }, 500));

      const results = await client.batchUpdate([
        { recordId: 'r1', fields: {} },
        { recordId: 'r2', fields: {} },
      ]);

      expect(results).toHaveLength(2);
      expect(results.every(r => !r.success)).toBe(true);
    });

    it('should return failure for all records on thrown error', async () => {
      mockRequestUrl
        .mockResolvedValueOnce(mockResponse(BASE_TOKEN_RESPONSE))
        .mockRejectedValueOnce(new Error('Connection lost'));

      const results = await client.batchUpdate([{ recordId: 'r1', fields: {} }]);
      expect(results[0].success).toBe(false);
      if (!results[0].success) {
        expect(results[0].error).toBe('Connection lost');
      }
    });
  });

  describe('reconfigure', () => {
    it('should update credential + config and reuse new rate limiter', async () => {
      mockRequestUrl.mockResolvedValue(mockResponse({ rows: [] }));
      mockRequestUrl.mockResolvedValueOnce(mockResponse(BASE_TOKEN_RESPONSE));

      const newLimiter = new RateLimiter(0);
      const limiterSpy = vi.spyOn(newLimiter, 'execute');

      client.reconfigure(
        createCredential({ apiToken: 'new-token' }),
        createConfig({ tableId: 'tbl-2' }),
        newLimiter,
        false,
      );

      mockRequestUrl
        .mockResolvedValueOnce(mockResponse(BASE_TOKEN_RESPONSE))
        .mockResolvedValueOnce(mockResponse({ rows: [] }));
      await client.fetchNotes();

      expect(limiterSpy).toHaveBeenCalled();
      const tokenHeaders = mockRequestUrl.mock.calls[0][0].headers as Record<string, string>;
      expect(tokenHeaders['Authorization']).toBe('Token new-token');
    });

    it('should invalidate cached token when API token changes', async () => {
      // Reset both call history AND any residual mockResolvedValueOnce queue
      // accumulated by earlier `it` blocks — `vi.clearAllMocks()` only clears
      // `.mock.calls`, not the implementation queue, so we need mockReset here.
      mockRequestUrl.mockReset();

      const tokenCalls: Array<Record<string, string>> = [];
      mockRequestUrl.mockImplementation((opts: { url: string; headers?: Record<string, string> }) => {
        if (opts.url.includes('app-access-token')) {
          tokenCalls.push(opts.headers ?? {});
          return Promise.resolve(mockResponse(BASE_TOKEN_RESPONSE));
        }
        return Promise.resolve(mockResponse({ rows: [] }));
      });

      await client.fetchNotes();
      expect(tokenCalls).toHaveLength(1);

      client.reconfigure(
        createCredential({ apiToken: 'rotated-token' }),
        createConfig(),
        rateLimiter,
        false,
      );
      await client.fetchNotes();

      expect(tokenCalls).toHaveLength(2);
      expect(tokenCalls[1]['Authorization']).toBe('Token rotated-token');
    });

    it('should throw when given a non-seatable credential', () => {
      const airtableCred: AirtableCredential = {
        id: 'cred-x',
        name: 'AT',
        type: 'airtable',
        apiKey: 'pat-x',
      };

      expect(() => client.reconfigure(airtableCred, createConfig(), rateLimiter, false)).toThrow(
        /SeaTableClient cannot be reconfigured with a airtable credential/,
      );
    });
  });
});
