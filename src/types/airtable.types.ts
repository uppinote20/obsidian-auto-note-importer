/**
 * Airtable-related type definitions.
 */

/**
 * Represents an Airtable field with its metadata.
 */
export interface AirtableField {
  id: string;
  name: string;
  type: string;
  description?: string;
}

/**
 * Represents an Airtable base.
 */
export interface AirtableBase {
  id: string;
  name: string;
}

/**
 * Represents an Airtable table.
 */
export interface AirtableTable {
  id: string;
  name: string;
}

/**
 * Represents a note fetched from Airtable.
 */
export interface RemoteNote {
  id: string;
  primaryField: string;
  fields: Record<string, unknown>;
}

/**
 * Result of a sync operation.
 */
export interface SyncResult {
  success: boolean;
  recordId: string;
  updatedFields: Record<string, unknown>;
  error?: string;
}

/**
 * Information about a field conflict between Obsidian and Airtable.
 */
export interface ConflictInfo {
  field: string;
  obsidianValue: unknown;
  airtableValue: unknown;
  recordId: string;
  filePath: string;
}

/**
 * Batch update request structure.
 */
export interface BatchUpdate {
  recordId: string;
  fields: Record<string, unknown>;
}
