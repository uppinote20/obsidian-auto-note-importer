/**
 * AirtableClient mock for testing.
 */

import { vi } from 'vitest';
import type { AirtableClient } from '../../src/services/airtable-client';
import type { SyncResult } from '../../src/types';

export type MockAirtableClient = {
  [K in keyof AirtableClient]: ReturnType<typeof vi.fn>;
};

export function createMockAirtableClient(): MockAirtableClient {
  return {
    updateSettings: vi.fn(),
    fetchNotes: vi.fn().mockResolvedValue([]),
    fetchRecord: vi.fn(),
    updateRecord: vi.fn().mockResolvedValue({
      success: true,
      recordId: 'rec123',
      updatedFields: {}
    } as SyncResult),
    batchUpdate: vi.fn().mockResolvedValue([])
  };
}
