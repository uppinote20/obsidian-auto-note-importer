/**
 * Cross-provider FieldTypeMapper contract tests.
 * @covers src/services/provider-registry.ts
 * @covers src/services/airtable-field-mapper.ts
 * @covers src/services/seatable-field-mapper.ts
 * @covers src/services/supabase-field-mapper.ts
 */

import { describe, it, expect } from 'vitest';
import {
  CREDENTIAL_TYPES,
  type CredentialType,
  type FieldTypeMapper,
  type StandardFieldType,
} from '../../src/types';
import {
  getFieldTypeMapper,
  hasFieldTypeMapper,
} from '../../src/services/provider-registry';

const PROTOTYPE_CHAIN_NAMES = [
  'toString',
  'constructor',
  'hasOwnProperty',
  'valueOf',
  '__proto__',
] as const;

const UNSAFE_SUBFOLDER_STANDARD_TYPES: ReadonlySet<StandardFieldType> = new Set([
  'attachment',
  'link',
  'unknown',
]);

type MapperCase = {
  type: CredentialType;
  mapper: FieldTypeMapper;
};

function getRegisteredMapperCases(): MapperCase[] {
  return CREDENTIAL_TYPES
    .filter(hasFieldTypeMapper)
    .map(type => ({
      type,
      mapper: getFieldTypeMapper(type),
    }));
}

function expectSortedUnique(provider: CredentialType, method: string, types: readonly string[]): void {
  expect(
    [...types],
    `${provider}.${method}() should be sorted`,
  ).toEqual([...types].sort());
  expect(
    new Set(types).size,
    `${provider}.${method}() should not contain duplicates`,
  ).toBe(types.length);
}

function assertFieldTypeMapperContract(provider: CredentialType, mapper: FieldTypeMapper): void {
  for (const type of mapper.getFilenameSafeTypes()) {
    expect(
      mapper.isSubfolderSafe(type),
      `${provider}: filename-safe type "${type}" must also be subfolder-safe`,
    ).toBe(true);
  }

  for (const type of mapper.getSubfolderSafeTypes()) {
    const standardType = mapper.mapToStandardType(type);
    expect(
      UNSAFE_SUBFOLDER_STANDARD_TYPES.has(standardType),
      `${provider}: subfolder-safe type "${type}" maps to unsafe standard type "${standardType}"`,
    ).toBe(false);
  }

  for (const type of PROTOTYPE_CHAIN_NAMES) {
    expect(
      mapper.isReadOnly(type),
      `${provider}: inherited name "${type}" must fail closed as read-only`,
    ).toBe(true);
    expect(
      mapper.isFilenameSafe(type),
      `${provider}: inherited name "${type}" must not be filename-safe`,
    ).toBe(false);
    expect(
      mapper.isSubfolderSafe(type),
      `${provider}: inherited name "${type}" must not be subfolder-safe`,
    ).toBe(false);
  }

  expectSortedUnique(provider, 'getFilenameSafeTypes', mapper.getFilenameSafeTypes());
  expectSortedUnique(provider, 'getSubfolderSafeTypes', mapper.getSubfolderSafeTypes());
}

describe('FieldTypeMapper parity', () => {
  const mapperCases = getRegisteredMapperCases();

  it('discovers all production mappers registered in provider-registry', () => {
    expect(mapperCases.map(c => c.type)).toEqual(expect.arrayContaining([
      'airtable',
      'seatable',
      'supabase',
    ]));
  });

  it.each(mapperCases)('enforces shared mapper contract for $type', ({ type, mapper }) => {
    assertFieldTypeMapperContract(type, mapper);
  });
});
