/**
 * System field constants.
 * These fields are used internally and should not be synced to Airtable.
 */

/**
 * System fields that should never be synced to Airtable.
 * - primaryField: Airtable record ID used for identification
 * - position: Used by Obsidian for ordering
 */
export const SYSTEM_FIELDS = ['primaryField', 'position'] as const;

export type SystemField = typeof SYSTEM_FIELDS[number];

/**
 * Check if a field is a system field.
 */
export function isSystemField(fieldName: string): boolean {
  return SYSTEM_FIELDS.includes(fieldName as SystemField);
}
