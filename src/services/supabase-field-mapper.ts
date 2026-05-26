/**
 * Supabase / PostgREST field type mapper.
 *
 * Input is the compressed providerType string from SupabaseMetadataCache:
 * `{type}[:{format}][:readonly]`. The `:readonly` suffix is the sole signal
 * for read-only-ness; PostgREST flags GENERATED columns and view-derived
 * columns with `readOnly: true` in the OpenAPI spec.
 *
 * @handbook 4.4-provider-abstraction
 * @handbook 7.3-read-only-field-protection
 * @tested tests/services/supabase-field-mapper.test.ts
 */

import type { FieldTypeMapper, StandardFieldType } from '../types';

const READONLY_SUFFIX = ':readonly';

const TYPE_TO_STANDARD: Record<string, StandardFieldType> = {
  'string': 'text',
  'string:uuid': 'text',
  'string:date': 'date',
  'string:date-time': 'date',
  'string:byte': 'unknown',
  // PostgreSQL json/jsonb are serialized by PostgREST as a JSON string in
  // the OpenAPI shape (type: 'string', format: 'jsonb'/'json'). Map them
  // as 'text' so they aren't rejected by the fail-closed default — the
  // type-aware coercion in SupabaseClient.batchUpdate handles the "" → null
  // conversion for actual upserts.
  'string:jsonb': 'text',
  'string:json': 'text',
  'integer': 'number',
  'integer:int32': 'number',
  'integer:int64': 'number',
  'number': 'number',
  'number:float': 'number',
  'number:double': 'number',
  'boolean': 'boolean',
  'object': 'text',
  'array:string': 'multi-select',
  'array:integer': 'multi-select',
  'array:number': 'multi-select',
  'array:boolean': 'multi-select',
  'array:object': 'text',
};

const FILENAME_SAFE_TYPES = [
  'integer',
  'integer:int32',
  'integer:int32:readonly',
  'integer:int64',
  'integer:int64:readonly',
  'integer:readonly',
  'string',
  'string:readonly',
  'string:uuid',
  'string:uuid:readonly',
].sort() as readonly string[];

const READ_ONLY_TYPES = Object.keys(TYPE_TO_STANDARD)
  .map(t => `${t}${READONLY_SUFFIX}`)
  .sort() as readonly string[];

// Subfolder accepts every known base type AND its :readonly variant.
// Broader than FILENAME_SAFE_TYPES because date / boolean / array etc.
// stringify to reasonable folder names once sanitizeSubfolderValue runs.
const SUBFOLDER_SAFE_TYPES = [
  ...Object.keys(TYPE_TO_STANDARD),
  ...Object.keys(TYPE_TO_STANDARD).map(t => `${t}${READONLY_SUFFIX}`),
].sort() as readonly string[];

class SupabaseFieldMapperImpl implements FieldTypeMapper {
  mapToStandardType(providerType: string): StandardFieldType {
    const base = providerType.endsWith(READONLY_SUFFIX)
      ? providerType.slice(0, -READONLY_SUFFIX.length)
      : providerType;
    return TYPE_TO_STANDARD[base] ?? 'unknown';
  }

  isReadOnly(providerType: string): boolean {
    if (!(providerType.replace(/:readonly$/, '') in TYPE_TO_STANDARD)) return true;
    return providerType.endsWith(READONLY_SUFFIX);
  }

  isFilenameSafe(providerType: string): boolean {
    return (FILENAME_SAFE_TYPES as readonly string[]).includes(providerType);
  }

  /**
   * Subfolder is permissive: every type in TYPE_TO_STANDARD (and its
   * :readonly variant) passes. Issue #98.
   */
  isSubfolderSafe(providerType: string): boolean {
    return (SUBFOLDER_SAFE_TYPES as readonly string[]).includes(providerType);
  }

  getFilenameSafeTypes(): readonly string[] {
    return FILENAME_SAFE_TYPES;
  }

  getSubfolderSafeTypes(): readonly string[] {
    return SUBFOLDER_SAFE_TYPES;
  }

  getReadOnlyTypes(): readonly string[] {
    return READ_ONLY_TYPES;
  }
}

export const supabaseFieldMapper: FieldTypeMapper = new SupabaseFieldMapperImpl();
