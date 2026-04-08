/**
 * Tests for AirtableClient service.
 * @covers src/services/airtable-client.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AirtableClient } from '../../src/services/airtable-client';
import type { LegacySettings } from '../../src/types';
import { DEFAULT_LEGACY_SETTINGS } from '../../src/types';
import { AIRTABLE_BATCH_SIZE } from '../../src/constants';
import { RateLimiter } from '../../src/services/rate-limiter';
import { requestUrl } from 'obsidian';

const mockRequestUrl = vi.mocked(requestUrl);

function createSettings(overrides: Partial<LegacySettings> = {}): LegacySettings {
  return {
    ...DEFAULT_LEGACY_SETTINGS,
    apiKey: 'pat-test',
    baseId: 'appTest',
    tableId: 'tblTest',
    ...overrides,
  };
}

function mockResponse(json: unknown, status = 200) {
  return { status, json, headers: {}, text: '', arrayBuffer: new ArrayBuffer(0) };
}

describe('AirtableClient', () => {
  let client: AirtableClient;
  let rateLimiter: RateLimiter;

  beforeEach(() => {
    vi.clearAllMocks();
    rateLimiter = new RateLimiter(0);
    client = new AirtableClient(createSettings(), rateLimiter);
  });

  describe('validateSettings', () => {
    it('should throw when apiKey is missing', async () => {
      client = new AirtableClient(createSettings({ apiKey: '' }), rateLimiter);
      await expect(client.fetchNotes()).rejects.toThrow('API key, base ID, and table ID must be set');
    });

    it('should throw when baseId is missing', async () => {
      client = new AirtableClient(createSettings({ baseId: '' }), rateLimiter);
      await expect(client.fetchNotes()).rejects.toThrow('API key, base ID, and table ID must be set');
    });

    it('should throw when tableId is missing', async () => {
      client = new AirtableClient(createSettings({ tableId: '' }), rateLimiter);
      await expect(client.fetchNotes()).rejects.toThrow('API key, base ID, and table ID must be set');
    });
  });

  describe('fetchNotes', () => {
    it('should fetch all records without pagination', async () => {
      mockRequestUrl.mockResolvedValueOnce(mockResponse({
        records: [
          { id: 'rec1', fields: { Name: 'Note 1' } },
          { id: 'rec2', fields: { Name: 'Note 2' } },
        ],
      }));

      const notes = await client.fetchNotes();
      expect(notes).toHaveLength(2);
      expect(notes[0]).toEqual({ id: 'rec1', primaryField: 'rec1', fields: { Name: 'Note 1' } });
    });

    it('should handle pagination with offset', async () => {
      mockRequestUrl
        .mockResolvedValueOnce(mockResponse({
          records: [{ id: 'rec1', fields: {} }],
          offset: 'page2',
        }))
        .mockResolvedValueOnce(mockResponse({
          records: [{ id: 'rec2', fields: {} }],
          offset: 'page3',
        }))
        .mockResolvedValueOnce(mockResponse({
          records: [{ id: 'rec3', fields: {} }],
        }));

      const notes = await client.fetchNotes();
      expect(notes).toHaveLength(3);
      expect(mockRequestUrl).toHaveBeenCalledTimes(3);

      // Verify offset is passed in URL
      const secondUrl = mockRequestUrl.mock.calls[1][0].url;
      expect(secondUrl).toContain('offset=page2');
    });

    it('should throw on non-200 response', async () => {
      mockRequestUrl.mockResolvedValueOnce(mockResponse(
        { error: { message: 'Not authorized' } }, 401
      ));

      await expect(client.fetchNotes()).rejects.toThrow('Failed to fetch remote notes');
    });
  });

  describe('fetchRecord', () => {
    it('should fetch a single record', async () => {
      mockRequestUrl.mockResolvedValueOnce(mockResponse({
        id: 'rec123', fields: { Name: 'Test' },
      }));

      const note = await client.fetchRecord('rec123');
      expect(note).toEqual({ id: 'rec123', primaryField: 'rec123', fields: { Name: 'Test' } });
    });

    it('should return null for 404', async () => {
      mockRequestUrl.mockResolvedValueOnce(mockResponse({}, 404));

      const note = await client.fetchRecord('recMissing');
      expect(note).toBeNull();
    });

    it('should throw on invalid record ID', async () => {
      await expect(client.fetchRecord('invalid')).rejects.toThrow('Invalid Airtable record ID');
    });

    it('should throw on empty record ID', async () => {
      await expect(client.fetchRecord('')).rejects.toThrow('Invalid Airtable record ID');
    });
  });

  describe('updateRecord', () => {
    it('should return success result on 200', async () => {
      mockRequestUrl.mockResolvedValueOnce(mockResponse({
        id: 'rec123', fields: { Name: 'Updated' },
      }));

      const result = await client.updateRecord('rec123', { Name: 'Updated' });
      expect(result).toEqual({
        success: true,
        recordId: 'rec123',
        updatedFields: { Name: 'Updated' },
      });
    });

    it('should return failure result on non-200', async () => {
      mockRequestUrl.mockResolvedValueOnce(mockResponse(
        { error: { message: 'Field not found' } }, 422
      ));

      const result = await client.updateRecord('rec123', { Bad: 'field' });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('Failed to update');
      }
    });

    it('should catch thrown errors and return failure', async () => {
      mockRequestUrl.mockRejectedValueOnce(new Error('Network error'));

      const result = await client.updateRecord('rec123', {});
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toBe('Network error');
      }
    });
  });

  describe('batchUpdate', () => {
    it('should return empty array for no updates', async () => {
      const results = await client.batchUpdate([]);
      expect(results).toEqual([]);
    });

    it('should batch update records', async () => {
      mockRequestUrl.mockResolvedValueOnce(mockResponse({
        records: [
          { id: 'rec1', fields: { Name: 'A' } },
          { id: 'rec2', fields: { Name: 'B' } },
        ],
      }));

      const results = await client.batchUpdate([
        { recordId: 'rec1', fields: { Name: 'A' } },
        { recordId: 'rec2', fields: { Name: 'B' } },
      ]);

      expect(results).toHaveLength(2);
      expect(results[0]).toEqual({ success: true, recordId: 'rec1', updatedFields: { Name: 'A' } });
    });

    it('should throw when exceeding batch size', async () => {
      const updates = Array.from({ length: AIRTABLE_BATCH_SIZE + 1 }, (_, i) => ({
        recordId: `rec${i}`,
        fields: {},
      }));

      await expect(client.batchUpdate(updates))
        .rejects.toThrow(`Maximum ${AIRTABLE_BATCH_SIZE} records allowed`);
    });

    it('should return failure for all records on non-200', async () => {
      mockRequestUrl.mockResolvedValueOnce(mockResponse(
        { error: { message: 'Server error' } }, 500
      ));

      const results = await client.batchUpdate([
        { recordId: 'rec1', fields: {} },
        { recordId: 'rec2', fields: {} },
      ]);

      expect(results).toHaveLength(2);
      expect(results.every(r => !r.success)).toBe(true);
    });

    it('should return failure for all records on thrown error', async () => {
      mockRequestUrl.mockRejectedValueOnce(new Error('Connection lost'));

      const results = await client.batchUpdate([
        { recordId: 'rec1', fields: {} },
      ]);

      expect(results[0].success).toBe(false);
      if (!results[0].success) {
        expect(results[0].error).toBe('Connection lost');
      }
    });
  });

  describe('updateSettings', () => {
    it('should use updated settings for subsequent calls', async () => {
      mockRequestUrl.mockResolvedValue(mockResponse({ records: [] }));

      await client.fetchNotes();
      const firstUrl = mockRequestUrl.mock.calls[0][0].url;
      expect(firstUrl).toContain('appTest/tblTest');

      client.updateSettings(createSettings({ baseId: 'appNew', tableId: 'tblNew' }));
      await client.fetchNotes();
      const secondUrl = mockRequestUrl.mock.calls[1][0].url;
      expect(secondUrl).toContain('appNew/tblNew');
    });
  });
});
