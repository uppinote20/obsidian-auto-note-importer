/**
 * DatabaseClient mock for testing.
 */

import { vi } from 'vitest';
import type { DatabaseClient, SyncResult } from '../../src/types';

export type MockDatabaseClient = {
  [K in keyof DatabaseClient]: ReturnType<typeof vi.fn>;
};

export function createMockDatabaseClient(): MockDatabaseClient {
  return {
    fetchNotes: vi.fn().mockResolvedValue([]),
    fetchRecord: vi.fn().mockResolvedValue(null),
    updateRecord: vi.fn().mockResolvedValue({
      success: true,
      recordId: 'rec123',
      updatedFields: {}
    } as SyncResult),
    batchUpdate: vi.fn().mockResolvedValue([]),
  };
}
