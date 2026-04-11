/**
 * DatabaseProvider mock for testing.
 */

import { vi } from 'vitest';
import type { DatabaseProvider, SyncResult, FieldTypeMapper } from '../../src/types';

export type MockDatabaseProvider = {
  providerType: 'airtable';
  capabilities: DatabaseProvider['capabilities'];
  fieldTypeMapper: FieldTypeMapper;
  fetchNotes: ReturnType<typeof vi.fn>;
  fetchRecord: ReturnType<typeof vi.fn>;
  updateRecord: ReturnType<typeof vi.fn>;
  batchUpdate: ReturnType<typeof vi.fn>;
  reconfigure: ReturnType<typeof vi.fn>;
};

const NOOP_MAPPER: FieldTypeMapper = {
  mapToStandardType: () => 'unknown',
  isReadOnly: () => false,
  isFilenameSafe: () => true,
  getFilenameSafeTypes: () => [],
  getReadOnlyTypes: () => [],
};

export function createMockDatabaseProvider(
  overrides: Partial<MockDatabaseProvider> = {},
): MockDatabaseProvider {
  return {
    providerType: 'airtable',
    capabilities: {
      bidirectional: true,
      hasComputedFields: true,
      batchUpdateMaxSize: 10,
    },
    fieldTypeMapper: NOOP_MAPPER,
    fetchNotes: vi.fn().mockResolvedValue([]),
    fetchRecord: vi.fn().mockResolvedValue(null),
    updateRecord: vi.fn().mockResolvedValue({
      success: true,
      recordId: 'rec123',
      updatedFields: {}
    } as SyncResult),
    batchUpdate: vi.fn().mockResolvedValue([]),
    reconfigure: vi.fn(),
    ...overrides,
  };
}
