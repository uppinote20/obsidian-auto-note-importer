/**
 * @covers src/services/supabase-metadata-cache.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  SupabaseMetadataCache,
  SupabaseSchemaRpcMissingError,
} from '../../src/services/supabase-metadata-cache';
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

  it('throws and does not cache on non-401 HTTP failure', async () => {
    // 401 now triggers the RPC fallback (publishable-key path). Use 500 to
    // exercise the "real failure" branch that should still throw.
    mockRequestUrl.mockResolvedValueOnce({ status: 500, json: { message: 'boom' }, text: '' });
    const cache = new SupabaseMetadataCache();
    await expect(cache.getSpec(cred, 'public')).rejects.toThrow(/500|boom/i);
    mockRequestUrl.mockResolvedValueOnce({ status: 200, json: sampleSpec, text: '' });
    await cache.getSpec(cred, 'public');
    expect(mockRequestUrl).toHaveBeenCalledTimes(2);
  });
});

describe('SupabaseMetadataCache RPC fallback (publishable-key path)', () => {
  it('falls back to RPC when OpenAPI returns 401 and caches the resulting spec', async () => {
    const rpcDefinitions = {
      notes: {
        properties: {
          id:    { type: 'string', format: 'uuid', description: '<pk/>' },
          title: { type: 'string' },
        },
        required: ['id', 'title'],
      },
    };
    mockRequestUrl
      .mockResolvedValueOnce({ status: 401, json: { message: 'Schema introspection restricted' }, text: '' })
      .mockResolvedValueOnce({ status: 200, json: rpcDefinitions, text: '' });

    const cache = new SupabaseMetadataCache();
    const spec = await cache.getSpec(cred, 'public');
    expect(spec.definitions?.notes).toBeTruthy();
    expect(spec.definitions?.notes.properties?.id.description).toContain('<pk/>');

    // Second call within TTL must hit the cache (no extra request).
    await cache.getSpec(cred, 'public');
    expect(mockRequestUrl).toHaveBeenCalledTimes(2);

    // RPC call shape: POST /rpc/<fn> with { p_schema }.
    const rpcCall = mockRequestUrl.mock.calls[1][0];
    expect(rpcCall.url).toContain('/rest/v1/rpc/ani_supabase_schema');
    expect(rpcCall.method).toBe('POST');
    expect(JSON.parse(rpcCall.body)).toEqual({ p_schema: 'public' });
  });

  it('throws SupabaseSchemaRpcMissingError when RPC returns 404 (function not installed)', async () => {
    mockRequestUrl
      .mockResolvedValueOnce({ status: 401, json: {}, text: '' })
      .mockResolvedValueOnce({ status: 404, json: { code: 'PGRST202', message: 'function not found' }, text: '' });

    const cache = new SupabaseMetadataCache();
    await expect(cache.getSpec(cred, 'public')).rejects.toBeInstanceOf(SupabaseSchemaRpcMissingError);
  });

  it('throws SupabaseSchemaRpcMissingError when RPC body indicates the function is missing (PGRST202)', async () => {
    mockRequestUrl
      .mockResolvedValueOnce({ status: 401, json: {}, text: '' })
      .mockResolvedValueOnce({ status: 404, json: { code: 'PGRST202', message: 'function ani_supabase_schema does not exist' }, text: '' });

    const cache = new SupabaseMetadataCache();
    await expect(cache.getSpec(cred, 'public')).rejects.toBeInstanceOf(SupabaseSchemaRpcMissingError);
  });

  it('does NOT classify generic 400 as SupabaseSchemaRpcMissingError (only PGRST202 / "function does not exist")', async () => {
    // A PG upgrade that changed information_schema column types can make the
    // RPC body return 400 with a totally different error — must not loop the
    // user through the "Run this SQL" banner.
    mockRequestUrl
      .mockResolvedValueOnce({ status: 401, json: {}, text: '' })
      .mockResolvedValueOnce({ status: 400, json: { code: '42703', message: 'column "x" does not exist' }, text: '' });

    const cache = new SupabaseMetadataCache();
    const err = await cache.getSpec(cred, 'public').catch(e => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(SupabaseSchemaRpcMissingError);
  });

  it('throws a plain Error when RPC fails for other reasons (e.g., 500)', async () => {
    mockRequestUrl
      .mockResolvedValueOnce({ status: 401, json: {}, text: '' })
      .mockResolvedValueOnce({ status: 500, json: { message: 'internal error' }, text: '' });

    const cache = new SupabaseMetadataCache();
    const err = await cache.getSpec(cred, 'public').catch(e => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(SupabaseSchemaRpcMissingError);
    expect(String(err.message)).toMatch(/500|internal/i);
  });

  it('conveys the target schema via the p_schema body parameter only (no Accept-Profile/Content-Profile on RPC POST)', async () => {
    // The RPC function lives in public; routing it through Accept-Profile or
    // Content-Profile would mis-route on deployments with a non-default
    // db-schemas order. The body parameter `p_schema` is the source of truth.
    mockRequestUrl
      .mockResolvedValueOnce({ status: 401, json: {}, text: '' })
      .mockResolvedValueOnce({ status: 200, json: { notes: { properties: { id: { type: 'string', description: '<pk/>' } }, required: ['id'] } }, text: '' });

    const cache = new SupabaseMetadataCache();
    await cache.getSpec(cred, 'app');
    const rpcCall = mockRequestUrl.mock.calls[1][0];
    expect(rpcCall.headers['Accept-Profile']).toBeUndefined();
    expect(rpcCall.headers['Content-Profile']).toBeUndefined();
    expect(JSON.parse(rpcCall.body)).toEqual({ p_schema: 'app' });
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

describe('SupabaseMetadataCache.detectPrimaryKey — RPC x-primary-key extension', () => {
  it('returns x-primary-key[0] for single-column PK (RPC path)', () => {
    const cache = new SupabaseMetadataCache();
    const spec = {
      definitions: {
        t: { 'x-primary-key': ['tenant_id'], properties: { tenant_id: { type: 'string' } } },
      },
    } as never;
    expect(cache.detectPrimaryKey(spec, 't')).toBe('tenant_id');
  });

  it('returns null for composite x-primary-key (sync does not support comma-joined PKs)', () => {
    // Composite PK is detected (length > 1) but not auto-filled into the UI —
    // SupabaseClient.validateConfig rejects primaryKeyColumn with a comma, so
    // surfacing one through detectPrimaryKey would only confuse the user.
    const cache = new SupabaseMetadataCache();
    const spec = {
      definitions: {
        t: {
          'x-primary-key': ['org_id', 'item_id'],
          properties: { org_id: { type: 'string' }, item_id: { type: 'string' } },
        },
      },
    } as never;
    expect(cache.detectPrimaryKey(spec, 't')).toBeNull();
  });

  it('ignores empty x-primary-key array and falls through to <pk/> marker', () => {
    const cache = new SupabaseMetadataCache();
    const spec = {
      definitions: {
        t: {
          'x-primary-key': [],
          properties: { id: { type: 'string', description: '<pk/>' } },
        },
      },
    } as never;
    expect(cache.detectPrimaryKey(spec, 't')).toBe('id');
  });

  it('OpenAPI path: returns null when multiple <pk/> markers indicate a composite PK', () => {
    const cache = new SupabaseMetadataCache();
    const spec = {
      definitions: {
        t: {
          properties: {
            org_id:  { type: 'string', description: '<pk/>' },
            item_id: { type: 'string', description: '<pk/>' },
          },
        },
      },
    } as never;
    expect(cache.detectPrimaryKey(spec, 't')).toBeNull();
  });
});

describe('SupabaseMetadataCache.getTables/getViews — RPC x-table-type extension', () => {
  it('classifies PK-less BASE TABLE via x-table-type (audit/queue tables)', () => {
    const cache = new SupabaseMetadataCache();
    const spec = {
      definitions: {
        audit_log: {
          'x-table-type': 'BASE TABLE',
          'x-primary-key': [],
          properties: { action: { type: 'string' } },  // no <pk/> marker
        },
      },
    } as never;
    expect(cache.getTables(spec).map((t: { name: string }) => t.name)).toContain('audit_log');
    expect(cache.getViews(spec).map((v: { name: string }) => v.name)).not.toContain('audit_log');
  });

  it('classifies VIEW via x-table-type even when properties carry a <pk/> marker', () => {
    const cache = new SupabaseMetadataCache();
    const spec = {
      definitions: {
        active_notes: {
          'x-table-type': 'VIEW',
          'x-primary-key': [],
          properties: { id: { type: 'string', description: '<pk/>' } },
        },
      },
    } as never;
    expect(cache.getViews(spec).map((v: { name: string }) => v.name)).toContain('active_notes');
    expect(cache.getTables(spec).map((t: { name: string }) => t.name)).not.toContain('active_notes');
  });
});
