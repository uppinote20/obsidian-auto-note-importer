/**
 * Airtable field type mapper.
 *
 * Maps Airtable's native field type strings to the provider-agnostic
 * StandardFieldType taxonomy, and answers writability / filename-safety
 * questions the sync pipeline needs.
 *
 * @handbook 4.4-provider-abstraction
 * @handbook 7.3-read-only-field-protection
 * @tested tests/services/airtable-field-mapper.test.ts
 */

import type { FieldTypeMapper, StandardFieldType } from '../types';

// Intentional overlap with READ_ONLY_TYPES: `formula` is read-only (its
// value is server-computed) but still safe to use as a filename source
// because the computed value is stable and typically text-like.
const FILENAME_SAFE_TYPES = [
  'singleLineText',
  'singleSelect',
  'number',
  'formula',
] as const;

const READ_ONLY_TYPES = [
  'formula',
  'rollup',
  'count',
  'lookup',
  'createdTime',
  'lastModifiedTime',
  'createdBy',
  'lastModifiedBy',
  'autoNumber',
  'externalSyncSource',
  'aiText',
  'button',
] as const;

const TYPE_TO_STANDARD: Record<string, StandardFieldType> = {
  // text
  singleLineText: 'text',
  multilineText: 'text',
  richText: 'text',
  email: 'text',
  phoneNumber: 'text',
  url: 'text',
  barcode: 'text',
  // number
  number: 'number',
  currency: 'number',
  percent: 'number',
  rating: 'number',
  duration: 'number',
  // date
  date: 'date',
  dateTime: 'date',
  // boolean
  checkbox: 'boolean',
  // select
  singleSelect: 'single-select',
  multipleSelects: 'multi-select',
  multipleCollaborators: 'multi-select',
  singleCollaborator: 'single-select',
  // attachment
  multipleAttachments: 'attachment',
  // link
  multipleRecordLinks: 'link',
  // computed (read-only server-side)
  formula: 'computed',
  rollup: 'computed',
  count: 'computed',
  lookup: 'computed',
  externalSyncSource: 'computed',
  aiText: 'computed',
  button: 'computed',
  // system (read-only metadata)
  createdTime: 'system',
  lastModifiedTime: 'system',
  createdBy: 'system',
  lastModifiedBy: 'system',
  autoNumber: 'system',
};

/**
 * Stateless singleton. Instances are cheap but shared to make identity
 * checks (`===`) meaningful in tests and future caching layers.
 */
class AirtableFieldMapperImpl implements FieldTypeMapper {
  mapToStandardType(providerType: string): StandardFieldType {
    return TYPE_TO_STANDARD[providerType] ?? 'unknown';
  }

  /**
   * Fail-closed: unknown types are treated as read-only so the plugin
   * never silently attempts to write a field the Airtable API will reject.
   * Airtable occasionally introduces new types (e.g. aiText, button) and
   * we'd rather skip the push than 422 the whole batch.
   */
  isReadOnly(providerType: string): boolean {
    if (!(providerType in TYPE_TO_STANDARD)) return true;
    return (READ_ONLY_TYPES as readonly string[]).includes(providerType);
  }

  isFilenameSafe(providerType: string): boolean {
    return (FILENAME_SAFE_TYPES as readonly string[]).includes(providerType);
  }

  getFilenameSafeTypes(): readonly string[] {
    return FILENAME_SAFE_TYPES;
  }

  getReadOnlyTypes(): readonly string[] {
    return READ_ONLY_TYPES;
  }
}

export const airtableFieldMapper: FieldTypeMapper = new AirtableFieldMapperImpl();
