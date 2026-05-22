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
