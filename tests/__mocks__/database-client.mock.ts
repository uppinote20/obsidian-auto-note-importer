/**
 * DatabaseProvider mock for testing.
 */

import { vi } from 'vitest';
import type { DatabaseProvider, SyncResult } from '../../src/types';

export type MockDatabaseProvider = {
  providerType: 'airtable';
  capabilities: DatabaseProvider['capabilities'];
  fetchNotes: ReturnType<typeof vi.fn>;
  fetchRecord: ReturnType<typeof vi.fn>;
  updateRecord: ReturnType<typeof vi.fn>;
  batchUpdate: ReturnType<typeof vi.fn>;
  reconfigure: ReturnType<typeof vi.fn>;
};

export function createMockDatabaseProvider(): MockDatabaseProvider {
  return {
    providerType: 'airtable',
    capabilities: {
      bidirectional: true,
      hasComputedFields: true,
      batchUpdateMaxSize: 10,
    },
    fetchNotes: vi.fn().mockResolvedValue([]),
    fetchRecord: vi.fn().mockResolvedValue(null),
    updateRecord: vi.fn().mockResolvedValue({
      success: true,
      recordId: 'rec123',
      updatedFields: {}
    } as SyncResult),
    batchUpdate: vi.fn().mockResolvedValue([]),
    reconfigure: vi.fn(),
  };
}
