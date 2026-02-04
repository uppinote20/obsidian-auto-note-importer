/**
 * AirtableClient mock for testing.
 */

import { vi } from 'vitest';
import type { SyncResult } from '../../src/types';

export interface MockAirtableClient {
  fetchRecord: ReturnType<typeof vi.fn>;
  updateRecord: ReturnType<typeof vi.fn>;
  batchUpdate: ReturnType<typeof vi.fn>;
}

export function createMockAirtableClient(): MockAirtableClient {
  return {
    fetchRecord: vi.fn(),
    updateRecord: vi.fn().mockResolvedValue({
      success: true,
      recordId: 'rec123',
      updatedFields: {}
    } as SyncResult),
    batchUpdate: vi.fn().mockResolvedValue([])
  };
}
