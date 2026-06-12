/**
 * DatabaseProvider mock for testing.
 */

import { vi } from 'vitest';
import type { DatabaseProvider, SyncResult, FieldTypeMapper, CredentialType } from '../../src/types';

export type MockDatabaseProvider = {
  providerType: CredentialType;
  capabilities: DatabaseProvider['capabilities'];
  fieldTypeMapper: FieldTypeMapper;
  fetchNotes: ReturnType<typeof vi.fn>;
  fetchRecord: ReturnType<typeof vi.fn>;
  updateRecord: ReturnType<typeof vi.fn>;
  batchUpdate: ReturnType<typeof vi.fn>;
  reconfigure: ReturnType<typeof vi.fn>;
};

// Mirror the real mapper contract: fail-closed by default. Tests that need
// permissive behavior should construct a custom mapper instead of relying
// on a too-permissive NOOP. This prevents 'subfolder picks attachment' style
// bugs from sneaking past tests that use this mock.
const NOOP_MAPPER: FieldTypeMapper = {
  mapToStandardType: () => 'unknown',
  isReadOnly: () => true,      // unknown → read-only (matches production fail-closed)
  isPushable: () => false,     // unknown → not pushable
  isFilenameSafe: () => false, // unknown → not filename-safe
  isSubfolderSafe: () => false,// unknown → not subfolder-safe
  getFilenameSafeTypes: () => [],
  getSubfolderSafeTypes: () => [],
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
