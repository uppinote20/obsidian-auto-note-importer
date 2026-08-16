/**
 * Notion field type mapper.
 *
 * Maps Notion's native property type strings (snake_case, e.g. `rich_text`,
 * `multi_select`) to the provider-agnostic StandardFieldType taxonomy and
 * answers writability / filename-safety questions the sync pipeline needs.
 *
 * @handbook 4.4-provider-abstraction
 * @handbook 7.3-read-only-field-protection
 * @tested tests/services/notion-field-mapper.test.ts
 */

import type { FieldTypeMapper, StandardFieldType } from '../types';

// Filename-safe types only need to produce a stable, human-readable
// string — writability isn't required. `unique_id` appears here AND in
// READ_ONLY_TYPES below: it's a great stable identifier but the sync
// pipeline must not push to it.
const FILENAME_SAFE_TYPES = [
  'email',
  'number',
  'phone_number',
  'select',
  'status',
  'title',
  'unique_id',
] as const;

const READ_ONLY_TYPES = [
  'formula',
  'rollup',
  'created_time',
  'created_by',
  'last_edited_time',
  'last_edited_by',
  'unique_id',
  'button',
] as const;

const TYPE_TO_STANDARD: Record<string, StandardFieldType> = {
  // text
  title: 'text',
  rich_text: 'text',
  url: 'text',
  email: 'text',
  phone_number: 'text',
  // number
  number: 'number',
  // date
  date: 'date',
  // boolean
  checkbox: 'boolean',
  // select
  select: 'single-select',
  status: 'single-select',
  multi_select: 'multi-select',
  // people follows the Airtable multipleCollaborators precedent — an array
  // of user objects, closest existing bucket is 'multi-select'.
  people: 'multi-select',
  // attachment
  files: 'attachment',
  // link
  relation: 'link',
  // computed (server-side, read-only)
  formula: 'computed',
  rollup: 'computed',
  button: 'computed',
  // system (server-assigned, read-only)
  created_time: 'system',
  created_by: 'system',
  last_edited_time: 'system',
  last_edited_by: 'system',
  unique_id: 'system',
  // `verification` is deliberately OMITTED (see comment on OBJECT_SHAPED_TYPES
  // below) — absent entries fail closed via the `?? 'unknown'` fallback in
  // mapToStandardType, which also makes isReadOnly/isPushable reject them.
};

// Types whose Notion API value is an object / array of objects, NOT a
// scalar string. people → array of { object, id, name, … }; files →
// array of { name, type, file/external: { url } }; relation → array of
// { id } (source: Notion API reference /reference/property-value-object).
// `verification` is not listed here — it's absent from TYPE_TO_STANDARD
// entirely, so isPushable already rejects it via the hasOwnProperty guard.
const OBJECT_SHAPED_TYPES: ReadonlySet<string> = new Set([
  'people',
  'files',
  'relation',
]);

// Excludes attachment (files) and link (relation) standard types — they
// stringify to JSON / id-array garbage as folder names — and explicit
// object-shaped types (see OBJECT_SHAPED_TYPES). Sorted for deterministic
// enumeration across providers.
const SUBFOLDER_SAFE_TYPES = Object.entries(TYPE_TO_STANDARD)
  .filter(([t, std]) =>
    std !== 'attachment' &&
    std !== 'link' &&
    std !== 'unknown' &&
    !OBJECT_SHAPED_TYPES.has(t)
  )
  .map(([t]) => t)
  .sort() as readonly string[];

class NotionFieldMapperImpl implements FieldTypeMapper {
  mapToStandardType(providerType: string): StandardFieldType {
    return TYPE_TO_STANDARD[providerType] ?? 'unknown';
  }

  isReadOnly(providerType: string): boolean {
    // Use Object.prototype.hasOwnProperty.call to avoid `in`-operator
    // prototype-chain leak (toString/constructor/etc.). See issue #98 fix.
    if (!Object.prototype.hasOwnProperty.call(TYPE_TO_STANDARD, providerType)) return true;
    return (READ_ONLY_TYPES as readonly string[]).includes(providerType);
  }

  isPushable(providerType: string): boolean {
    if (!Object.prototype.hasOwnProperty.call(TYPE_TO_STANDARD, providerType)) return false;
    if (TYPE_TO_STANDARD[providerType] === 'unknown') return false;
    return !this.isReadOnly(providerType) && !OBJECT_SHAPED_TYPES.has(providerType);
  }

  isFilenameSafe(providerType: string): boolean {
    return (FILENAME_SAFE_TYPES as readonly string[]).includes(providerType);
  }

  /**
   * Permissive but excludes attachment / link types. Uses Array.includes to
   * avoid `in TYPE_TO_STANDARD` prototype-chain leak. Issue #98.
   */
  isSubfolderSafe(providerType: string): boolean {
    return SUBFOLDER_SAFE_TYPES.includes(providerType);
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

export const notionFieldMapper: FieldTypeMapper = new NotionFieldMapperImpl();
