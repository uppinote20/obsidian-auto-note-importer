/**
 * Airtable field type constants.
 *
 * @handbook 7.3-read-only-field-protection
 */

/**
 * Field types that are supported for filename and subfolder selection.
 * These types produce predictable, file-system safe output.
 */
export const SUPPORTED_FIELD_TYPES = [
  'singleLineText',
  'singleSelect',
  'number',
  'formula'
] as const;

export type SupportedFieldType = typeof SUPPORTED_FIELD_TYPES[number];

/**
 * Read-only field types that should only receive updates from Airtable.
 * These fields are computed by Airtable and cannot be written to directly.
 */
export const READ_ONLY_FIELD_TYPES = [
  'formula',
  'rollup',
  'count',
  'lookup',
  'createdTime',
  'lastModifiedTime',
  'createdBy',
  'lastModifiedBy',
  'autoNumber'
] as const;

export type ReadOnlyFieldType = typeof READ_ONLY_FIELD_TYPES[number];

/**
 * Check if a field type is supported for filename/subfolder selection.
 */
export function isFieldTypeSupported(fieldType: string): fieldType is SupportedFieldType {
  return (SUPPORTED_FIELD_TYPES as readonly string[]).includes(fieldType);
}

/**
 * Check if a field type is read-only (computed by Airtable).
 */
export function isReadOnlyFieldType(fieldType: string): fieldType is ReadOnlyFieldType {
  return (READ_ONLY_FIELD_TYPES as readonly string[]).includes(fieldType);
}
