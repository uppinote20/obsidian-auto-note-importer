/**
 * Tests for AirtableClient view parameter support.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AirtableClient } from '../../src/services/airtable-client';
import type { AutoNoteImporterSettings } from '../../src/types';
import { DEFAULT_SETTINGS } from '../../src/types';
import { RateLimiter } from '../../src/services/rate-limiter';

vi.mock('obsidian', () => ({
  requestUrl: vi.fn(),
}));

import { requestUrl } from 'obsidian';

const mockRequestUrl = vi.mocked(requestUrl);

function createSettings(overrides: Partial<AutoNoteImporterSettings> = {}): AutoNoteImporterSettings {
  return {
    ...DEFAULT_SETTINGS,
    apiKey: 'pat-test-key',
    baseId: 'appTestBase',
    tableId: 'tblTestTable',
    ...overrides,
  };
}

describe('AirtableClient view parameter', () => {
  let rateLimiter: RateLimiter;

  beforeEach(() => {
    vi.clearAllMocks();
    rateLimiter = new RateLimiter(0);
  });

  it('should not include view parameter when viewId is empty', async () => {
    const settings = createSettings({ viewId: '' });
    const client = new AirtableClient(settings, rateLimiter);

    mockRequestUrl.mockResolvedValueOnce({
      status: 200,
      json: { records: [] },
      headers: {},
      text: '',
      arrayBuffer: new ArrayBuffer(0),
    });

    await client.fetchNotes();

    const calledUrl = mockRequestUrl.mock.calls[0][0].url;
    expect(calledUrl).not.toContain('view=');
  });

  it('should include view parameter when viewId is set', async () => {
    const settings = createSettings({ viewId: 'viwTestView123' });
    const client = new AirtableClient(settings, rateLimiter);

    mockRequestUrl.mockResolvedValueOnce({
      status: 200,
      json: { records: [] },
      headers: {},
      text: '',
      arrayBuffer: new ArrayBuffer(0),
    });

    await client.fetchNotes();

    const calledUrl = mockRequestUrl.mock.calls[0][0].url;
    expect(calledUrl).toContain('view=viwTestView123');
  });

  it('should include both view and offset parameters during pagination', async () => {
    const settings = createSettings({ viewId: 'viwTestView123' });
    const client = new AirtableClient(settings, rateLimiter);

    mockRequestUrl
      .mockResolvedValueOnce({
        status: 200,
        json: {
          records: [{ id: 'rec1', fields: { title: 'Note 1' } }],
          offset: 'nextPage123',
        },
        headers: {},
        text: '',
        arrayBuffer: new ArrayBuffer(0),
      })
      .mockResolvedValueOnce({
        status: 200,
        json: {
          records: [{ id: 'rec2', fields: { title: 'Note 2' } }],
        },
        headers: {},
        text: '',
        arrayBuffer: new ArrayBuffer(0),
      });

    const notes = await client.fetchNotes();

    expect(notes).toHaveLength(2);

    // First call: view only
    const firstUrl = mockRequestUrl.mock.calls[0][0].url;
    expect(firstUrl).toContain('view=viwTestView123');
    expect(firstUrl).not.toContain('offset=');

    // Second call: view + offset
    const secondUrl = mockRequestUrl.mock.calls[1][0].url;
    expect(secondUrl).toContain('view=viwTestView123');
    expect(secondUrl).toContain('offset=nextPage123');
  });
});
