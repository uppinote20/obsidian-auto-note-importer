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
  // PostgreSQL json/jsonb: PostgREST's OpenAPI spec describes these as
  // {type: 'string', format: 'jsonb'/'json'}, but the runtime VALUE is a
  // parsed JS object/array (NOT a string) — see OBJECT_SHAPED_TYPES below.
  // Map as 'text' here so the fail-closed default doesn't reject them at
  // the standard-type lookup; the type-aware coercion in SupabaseClient.
  // batchUpdate handles "" → null for upserts; subfolder dropdown filters
  // them out via OBJECT_SHAPED_TYPES because String(value) → '[object …]'.
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

// PostgREST types whose runtime value is a JSON object / array, not a
// scalar string. Object / jsonb / json columns stringify to '[object
// Object]' or unbounded JSON, neither suitable as a folder name.
const OBJECT_SHAPED_TYPES: ReadonlySet<string> = new Set([
  'object',          // PostgREST 'object' type (jsonb composite, etc.)
  'array:object',    // jsonb[] / array of records
  'string:json',     // explicit json format
  'string:jsonb',    // explicit jsonb format
]);

// Excludes types that map to 'unknown' (e.g. 'string:byte' — bytea blobs
// stringify to truncated near-collision garbage) AND object-shaped types
// whose runtime value isn't a usable folder atom. Includes both base and
// :readonly variant for each surviving type.
const SUBFOLDER_SAFE_TYPES = (() => {
  const safeBases = Object.entries(TYPE_TO_STANDARD)
    .filter(([t, std]) => std !== 'unknown' && !OBJECT_SHAPED_TYPES.has(t))
    .map(([t]) => t);
  return [
    ...safeBases,
    ...safeBases.map(t => `${t}${READONLY_SUFFIX}`),
  ].sort() as readonly string[];
})();

class SupabaseFieldMapperImpl implements FieldTypeMapper {
  mapToStandardType(providerType: string): StandardFieldType {
    const base = providerType.endsWith(READONLY_SUFFIX)
      ? providerType.slice(0, -READONLY_SUFFIX.length)
      : providerType;
    return TYPE_TO_STANDARD[base] ?? 'unknown';
  }

  isReadOnly(providerType: string): boolean {
    // Strip optional :readonly suffix then check base via hasOwnProperty.call
    // (not `in`) to avoid prototype-chain leak — 'toString'/'constructor' etc.
    // would otherwise pass the `in` check and return false (writable),
    // breaking the fail-closed contract. Matches Airtable + SeaTable. #98.
    const base = providerType.endsWith(READONLY_SUFFIX)
      ? providerType.slice(0, -READONLY_SUFFIX.length)
      : providerType;
    if (!Object.prototype.hasOwnProperty.call(TYPE_TO_STANDARD, base)) return true;
    return providerType.endsWith(READONLY_SUFFIX);
  }

  isPushable(providerType: string): boolean {
    const base = providerType.endsWith(READONLY_SUFFIX)
      ? providerType.slice(0, -READONLY_SUFFIX.length)
      : providerType;
    if (!Object.prototype.hasOwnProperty.call(TYPE_TO_STANDARD, base)) return false;
    if (TYPE_TO_STANDARD[base] === 'unknown') return false;
    return !providerType.endsWith(READONLY_SUFFIX) && !OBJECT_SHAPED_TYPES.has(base);
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
