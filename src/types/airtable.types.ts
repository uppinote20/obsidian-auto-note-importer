/**
 * Airtable-specific metadata type definitions.
 * Provider-agnostic record/sync types live in database.types.ts.
 *
 * @handbook 2.1-naming-rules
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
 * Represents an Airtable view within a table.
 */
export interface AirtableView {
  id: string;
  name: string;
  type: string;
}
