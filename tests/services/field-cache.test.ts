/**
 * Tests for FieldCache service.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FieldCache } from '../../src/services/field-cache';
import { requestUrl } from 'obsidian';

const mockRequestUrl = vi.mocked(requestUrl);

function mockTablesResponse(tables: { id: string; name: string; fields?: unknown[]; views?: unknown[] }[]) {
  return {
    status: 200,
    json: { tables },
    headers: {},
    text: '',
    arrayBuffer: new ArrayBuffer(0),
  };
}

function mockBasesResponse(bases: { id: string; name: string }[]) {
  return {
    status: 200,
    json: { bases },
    headers: {},
    text: '',
    arrayBuffer: new ArrayBuffer(0),
  };
}

describe('FieldCache', () => {
  let cache: FieldCache;

  beforeEach(() => {
    vi.clearAllMocks();
    cache = new FieldCache();
  });

  describe('fetchBases', () => {
    it('should fetch and cache bases', async () => {
      mockRequestUrl.mockResolvedValueOnce(mockBasesResponse([
        { id: 'app1', name: 'Base 1' },
        { id: 'app2', name: 'Base 2' },
      ]));

      const bases = await cache.fetchBases('pat-key');
      expect(bases).toHaveLength(2);
      expect(bases[0]).toEqual({ id: 'app1', name: 'Base 1' });

      // Second call should use cache
      const cached = await cache.fetchBases('pat-key');
      expect(cached).toEqual(bases);
      expect(mockRequestUrl).toHaveBeenCalledTimes(1);
    });

    it('should clear cache when API key changes', async () => {
      mockRequestUrl
        .mockResolvedValueOnce(mockBasesResponse([{ id: 'app1', name: 'Base 1' }]))
        .mockResolvedValueOnce(mockBasesResponse([{ id: 'app2', name: 'Base 2' }]));

      await cache.fetchBases('key-1');
      const bases = await cache.fetchBases('key-2');

      expect(mockRequestUrl).toHaveBeenCalledTimes(2);
      expect(bases[0].id).toBe('app2');
    });

    it('should throw on non-200 response', async () => {
      mockRequestUrl.mockResolvedValueOnce({
        status: 401, json: {}, headers: {}, text: '', arrayBuffer: new ArrayBuffer(0),
      });

      await expect(cache.fetchBases('bad-key')).rejects.toThrow('HTTP 401');
    });
  });

  describe('fetchTables', () => {
    it('should fetch and cache tables', async () => {
      mockRequestUrl.mockResolvedValueOnce(mockTablesResponse([
        { id: 'tbl1', name: 'Table 1' },
        { id: 'tbl2', name: 'Table 2' },
      ]));

      const tables = await cache.fetchTables('pat-key', 'app1');
      expect(tables).toHaveLength(2);

      // Cache hit
      await cache.fetchTables('pat-key', 'app1');
      expect(mockRequestUrl).toHaveBeenCalledTimes(1);
    });
  });

  describe('fetchFields and fetchViews (shared metadata)', () => {
    const tablesResponse = mockTablesResponse([{
      id: 'tbl1',
      name: 'Table 1',
      fields: [
        { id: 'fld1', name: 'Name', type: 'singleLineText' },
        { id: 'fld2', name: 'Count', type: 'number' },
      ],
      views: [
        { id: 'viw1', name: 'Grid view', type: 'grid' },
        { id: 'viw2', name: 'Kanban', type: 'kanban' },
      ],
    }]);

    it('should fetch fields and populate views cache in one API call', async () => {
      mockRequestUrl.mockResolvedValueOnce(tablesResponse);

      const fields = await cache.fetchFields('pat-key', 'app1', 'tbl1');
      expect(fields).toHaveLength(2);
      expect(fields[0]).toEqual({ id: 'fld1', name: 'Name', type: 'singleLineText', description: undefined });

      // Views should now be cached (no extra API call)
      const views = await cache.fetchViews('pat-key', 'app1', 'tbl1');
      expect(views).toHaveLength(2);
      expect(views[1]).toEqual({ id: 'viw2', name: 'Kanban', type: 'kanban' });

      expect(mockRequestUrl).toHaveBeenCalledTimes(1);
    });

    it('should fetch views and populate fields cache in one API call', async () => {
      mockRequestUrl.mockResolvedValueOnce(tablesResponse);

      const views = await cache.fetchViews('pat-key', 'app1', 'tbl1');
      expect(views).toHaveLength(2);

      // Fields should now be cached
      const fields = await cache.fetchFields('pat-key', 'app1', 'tbl1');
      expect(fields).toHaveLength(2);

      expect(mockRequestUrl).toHaveBeenCalledTimes(1);
    });

    it('should throw when table not found', async () => {
      mockRequestUrl.mockResolvedValueOnce(mockTablesResponse([
        { id: 'tbl99', name: 'Other' },
      ]));

      await expect(cache.fetchFields('pat-key', 'app1', 'tblMissing'))
        .rejects.toThrow('Table with ID tblMissing not found');
    });

    it('should handle tables with no views', async () => {
      mockRequestUrl.mockResolvedValueOnce(mockTablesResponse([{
        id: 'tbl1',
        name: 'Table 1',
        fields: [{ id: 'fld1', name: 'Name', type: 'singleLineText' }],
      }]));

      const views = await cache.fetchViews('pat-key', 'app1', 'tbl1');
      expect(views).toEqual([]);
    });
  });

  describe('cache invalidation', () => {
    it('clearBases should clear all caches', async () => {
      mockRequestUrl
        .mockResolvedValueOnce(mockBasesResponse([{ id: 'app1', name: 'B' }]))
        .mockResolvedValueOnce(mockTablesResponse([{
          id: 'tbl1', name: 'T', fields: [{ id: 'f1', name: 'N', type: 'text' }], views: [],
        }]))
        .mockResolvedValueOnce(mockBasesResponse([{ id: 'app1', name: 'B' }]))
        .mockResolvedValueOnce(mockTablesResponse([{
          id: 'tbl1', name: 'T', fields: [{ id: 'f1', name: 'N', type: 'text' }], views: [],
        }]));

      await cache.fetchBases('key');
      await cache.fetchFields('key', 'app1', 'tbl1');

      cache.clearBases();

      await cache.fetchBases('key');
      await cache.fetchFields('key', 'app1', 'tbl1');
      expect(mockRequestUrl).toHaveBeenCalledTimes(4);
    });

    it('clearTables should clear fields and views for that base', async () => {
      mockRequestUrl
        .mockResolvedValueOnce(mockTablesResponse([{
          id: 'tbl1', name: 'T',
          fields: [{ id: 'f1', name: 'N', type: 'text' }],
          views: [{ id: 'v1', name: 'Grid', type: 'grid' }],
        }]))
        .mockResolvedValueOnce(mockTablesResponse([{
          id: 'tbl1', name: 'T',
          fields: [{ id: 'f1', name: 'N', type: 'text' }],
          views: [{ id: 'v1', name: 'Grid', type: 'grid' }],
        }]));

      await cache.fetchFields('key', 'app1', 'tbl1');
      cache.clearTables('app1');
      await cache.fetchViews('key', 'app1', 'tbl1');

      expect(mockRequestUrl).toHaveBeenCalledTimes(2);
    });

    it('clearFields should only clear fields for specific table', async () => {
      mockRequestUrl.mockResolvedValueOnce(mockTablesResponse([{
        id: 'tbl1', name: 'T',
        fields: [{ id: 'f1', name: 'N', type: 'text' }],
        views: [{ id: 'v1', name: 'Grid', type: 'grid' }],
      }]));

      await cache.fetchFields('key', 'app1', 'tbl1');

      // Views should be cached
      const views = await cache.fetchViews('key', 'app1', 'tbl1');
      expect(views).toHaveLength(1);

      // Clear fields only
      cache.clearFields('app1', 'tbl1');

      // Views should still be cached
      const viewsAfter = await cache.fetchViews('key', 'app1', 'tbl1');
      expect(viewsAfter).toHaveLength(1);
      expect(mockRequestUrl).toHaveBeenCalledTimes(1);
    });

    it('clearViews should only clear views for specific table', async () => {
      mockRequestUrl
        .mockResolvedValueOnce(mockTablesResponse([{
          id: 'tbl1', name: 'T',
          fields: [{ id: 'f1', name: 'N', type: 'text' }],
          views: [{ id: 'v1', name: 'Grid', type: 'grid' }],
        }]))
        .mockResolvedValueOnce(mockTablesResponse([{
          id: 'tbl1', name: 'T',
          fields: [{ id: 'f1', name: 'N', type: 'text' }],
          views: [{ id: 'v1', name: 'Grid', type: 'grid' }],
        }]));

      await cache.fetchViews('key', 'app1', 'tbl1');
      cache.clearViews('app1', 'tbl1');

      // Fields should still be cached, views need refetch
      await cache.fetchViews('key', 'app1', 'tbl1');
      expect(mockRequestUrl).toHaveBeenCalledTimes(2);
    });
  });

  describe('getField', () => {
    it('should find field by name from cache', async () => {
      mockRequestUrl.mockResolvedValueOnce(mockTablesResponse([{
        id: 'tbl1', name: 'T',
        fields: [
          { id: 'f1', name: 'Name', type: 'singleLineText' },
          { id: 'f2', name: 'Count', type: 'number' },
        ],
        views: [],
      }]));

      await cache.fetchFields('key', 'app1', 'tbl1');
      const field = cache.getField('app1-tbl1', 'Count');
      expect(field?.type).toBe('number');
    });

    it('should return undefined for unknown field', () => {
      const field = cache.getField('app1-tbl1', 'Unknown');
      expect(field).toBeUndefined();
    });
  });
});
