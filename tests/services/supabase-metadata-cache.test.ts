/**
 * @covers src/services/supabase-metadata-cache.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SupabaseMetadataCache } from '../../src/services/supabase-metadata-cache';
import type { SupabaseCredential } from '../../src/types';

const mockRequestUrl = vi.fn();
vi.mock('obsidian', () => ({
  requestUrl: (...args: unknown[]) => mockRequestUrl(...args),
}));

const cred: SupabaseCredential = {
  id: 'c1',
  name: 'My Project',
  type: 'supabase',
  projectUrl: 'https://abc.supabase.co',
  apiKey: 'sb_publishable_xxx',
};

const sampleSpec = {
  info: { title: 'PostgREST API' },
  definitions: {
    notes: {
      required: ['id'],
      properties: {
        id: { type: 'string', format: 'uuid', description: 'Note:\nThis is a Primary Key.<pk/>' },
        title: { type: 'string' },
        archived: { type: 'boolean' },
      },
    },
    active_notes: {
      properties: {
        id: { type: 'string', format: 'uuid' },
        title: { type: 'string' },
      },
    },
  },
};

beforeEach(() => {
  mockRequestUrl.mockReset();
  mockRequestUrl.mockResolvedValue({ status: 200, json: sampleSpec, text: '' });
});

afterEach(() => vi.useRealTimers());

describe('SupabaseMetadataCache.getSpec', () => {
  it('fetches OpenAPI spec on first call', async () => {
    const cache = new SupabaseMetadataCache();
    const spec = await cache.getSpec(cred, 'public');
    expect(mockRequestUrl).toHaveBeenCalledTimes(1);
    expect(spec.definitions.notes).toBeTruthy();
  });

  it('reuses cached spec on subsequent calls within TTL', async () => {
    const cache = new SupabaseMetadataCache();
    await cache.getSpec(cred, 'public');
    await cache.getSpec(cred, 'public');
    expect(mockRequestUrl).toHaveBeenCalledTimes(1);
  });

  it('uses separate cache entries per schema', async () => {
    const cache = new SupabaseMetadataCache();
    await cache.getSpec(cred, 'public');
    await cache.getSpec(cred, 'app');
    expect(mockRequestUrl).toHaveBeenCalledTimes(2);
  });

  it('re-fetches after TTL expiry', async () => {
    vi.useFakeTimers();
    const cache = new SupabaseMetadataCache();
    await cache.getSpec(cred, 'public');
    vi.advanceTimersByTime(11 * 60 * 1000);
    await cache.getSpec(cred, 'public');
    expect(mockRequestUrl).toHaveBeenCalledTimes(2);
  });

  it('attaches Accept-Profile header for non-public schemas', async () => {
    const cache = new SupabaseMetadataCache();
    await cache.getSpec(cred, 'app');
    const call = mockRequestUrl.mock.calls[0][0];
    expect(call.headers['Accept-Profile']).toBe('app');
  });

  it('omits Accept-Profile for public schema', async () => {
    const cache = new SupabaseMetadataCache();
    await cache.getSpec(cred, 'public');
    const call = mockRequestUrl.mock.calls[0][0];
    expect(call.headers['Accept-Profile']).toBeUndefined();
  });

  it('throws and does not cache on HTTP failure', async () => {
    mockRequestUrl.mockResolvedValueOnce({ status: 401, json: { message: 'invalid jwt' }, text: '' });
    const cache = new SupabaseMetadataCache();
    await expect(cache.getSpec(cred, 'public')).rejects.toThrow(/401|invalid/i);
    mockRequestUrl.mockResolvedValueOnce({ status: 200, json: sampleSpec, text: '' });
    await cache.getSpec(cred, 'public');
    expect(mockRequestUrl).toHaveBeenCalledTimes(2);
  });
});

describe('SupabaseMetadataCache.getTables and getViews', () => {
  it('classifies definitions with any pk-marked column as tables', async () => {
    const cache = new SupabaseMetadataCache();
    const spec = await cache.getSpec(cred, 'public');
    const tables = cache.getTables(spec);
    expect(tables.map(t => t.name)).toEqual(['notes']);
  });

  it('classifies definitions without pk marker as views', async () => {
    const cache = new SupabaseMetadataCache();
    const spec = await cache.getSpec(cred, 'public');
    const views = cache.getViews(spec);
    expect(views.map(v => v.name)).toEqual(['active_notes']);
  });

  it('returns empty arrays for spec with no definitions', () => {
    const cache = new SupabaseMetadataCache();
    const emptySpec = { definitions: {} } as const;
    expect(cache.getTables(emptySpec as never)).toEqual([]);
    expect(cache.getViews(emptySpec as never)).toEqual([]);
  });
});

describe('SupabaseMetadataCache.detectPrimaryKey', () => {
  it('returns column with pk marker', async () => {
    const cache = new SupabaseMetadataCache();
    const spec = await cache.getSpec(cred, 'public');
    expect(cache.detectPrimaryKey(spec, 'notes')).toBe('id');
  });

  it('does NOT fall back to required[0] (OpenAPI required is an unordered NOT NULL set, picking [0] mis-detects PK for views)', () => {
    const cache = new SupabaseMetadataCache();
    const spec = {
      definitions: {
        active_notes: {
          // View with two NOT NULL columns and no <pk/> marker.
          // The first entry of `required` is NOT guaranteed to be the
          // logical PK — auto-saving it would create on_conflict failures
          // or duplicate rows on subsequent upserts.
          required: ['email', 'user_id'],
          properties: {
            email: { type: 'string' },
            user_id: { type: 'string', format: 'uuid' },
          },
        },
      },
    } as never;
    expect(cache.detectPrimaryKey(spec, 'active_notes')).toBeNull();
  });

  it('falls back to id then uuid', () => {
    const cache = new SupabaseMetadataCache();
    const specA = {
      definitions: {
        t: { properties: { id: { type: 'integer' }, name: { type: 'string' } } },
      },
    } as never;
    expect(cache.detectPrimaryKey(specA, 't')).toBe('id');

    const specB = {
      definitions: {
        t: { properties: { uuid: { type: 'string', format: 'uuid' }, label: { type: 'string' } } },
      },
    } as never;
    expect(cache.detectPrimaryKey(specB, 't')).toBe('uuid');
  });

  it('returns null when no PK can be detected', () => {
    const cache = new SupabaseMetadataCache();
    const spec = {
      definitions: {
        t: { properties: { name: { type: 'string' }, label: { type: 'string' } } },
      },
    } as never;
    expect(cache.detectPrimaryKey(spec, 't')).toBeNull();
  });

  it('returns null for unknown table', () => {
    const cache = new SupabaseMetadataCache();
    const spec = { definitions: {} } as never;
    expect(cache.detectPrimaryKey(spec, 'missing')).toBeNull();
  });
});

describe('SupabaseMetadataCache.getColumns', () => {
  it('returns columns with composed providerType strings', async () => {
    const cache = new SupabaseMetadataCache();
    const spec = await cache.getSpec(cred, 'public');
    const cols = cache.getColumns(spec, 'notes');
    expect(cols).toEqual([
      { name: 'id', providerType: 'string:uuid', isPk: true, default: undefined },
      { name: 'title', providerType: 'string', isPk: false, default: undefined },
      { name: 'archived', providerType: 'boolean', isPk: false, default: undefined },
    ]);
  });

  it('appends readonly when OpenAPI marks the column readOnly', () => {
    const cache = new SupabaseMetadataCache();
    const spec = {
      definitions: {
        t: {
          properties: {
            id: { type: 'integer', readOnly: true },
            name: { type: 'string' },
          },
        },
      },
    } as never;
    const cols = cache.getColumns(spec, 't');
    expect(cols[0].providerType).toBe('integer:readonly');
    expect(cols[1].providerType).toBe('string');
  });

  it('composes array element type into array:string form', () => {
    const cache = new SupabaseMetadataCache();
    const spec = {
      definitions: {
        t: {
          properties: {
            tags: { type: 'array', items: { type: 'string' } },
            counts: { type: 'array', items: { type: 'integer' } },
          },
        },
      },
    } as never;
    const cols = cache.getColumns(spec, 't');
    expect(cols.find(c => c.name === 'tags')?.providerType).toBe('array:string');
    expect(cols.find(c => c.name === 'counts')?.providerType).toBe('array:integer');
  });

  it('returns empty array for unknown table', () => {
    const cache = new SupabaseMetadataCache();
    const spec = { definitions: {} } as never;
    expect(cache.getColumns(spec, 'missing')).toEqual([]);
  });
});

describe('SupabaseMetadataCache invalidation', () => {
  it('clearForCred drops every schema for a credential', async () => {
    const cache = new SupabaseMetadataCache();
    await cache.getSpec(cred, 'public');
    await cache.getSpec(cred, 'app');
    cache.clearForCred(cred.id);
    await cache.getSpec(cred, 'public');
    await cache.getSpec(cred, 'app');
    expect(mockRequestUrl).toHaveBeenCalledTimes(4);
  });

  it('clearForCred leaves other credentials untouched', async () => {
    const other: SupabaseCredential = { ...cred, id: 'c2' };
    const cache = new SupabaseMetadataCache();
    await cache.getSpec(cred, 'public');
    await cache.getSpec(other, 'public');
    cache.clearForCred(cred.id);
    await cache.getSpec(cred, 'public');
    await cache.getSpec(other, 'public');
    expect(mockRequestUrl).toHaveBeenCalledTimes(3);
  });

  it('clear() drops all credentials', async () => {
    const other: SupabaseCredential = { ...cred, id: 'c2' };
    const cache = new SupabaseMetadataCache();
    await cache.getSpec(cred, 'public');
    await cache.getSpec(other, 'public');
    cache.clear();
    await cache.getSpec(cred, 'public');
    await cache.getSpec(other, 'public');
    expect(mockRequestUrl).toHaveBeenCalledTimes(4);
  });

  it('refresh() forces re-fetch', async () => {
    const cache = new SupabaseMetadataCache();
    await cache.getSpec(cred, 'public');
    await cache.refresh(cred, 'public');
    expect(mockRequestUrl).toHaveBeenCalledTimes(2);
  });
});
