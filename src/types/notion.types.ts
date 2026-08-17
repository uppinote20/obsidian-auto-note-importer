/**
 * Notion-specific metadata and wire-response type definitions.
 * Provider-agnostic record/sync types live in database.types.ts.
 *
 * @handbook 2.1-naming-rules
 */

/**
 * A Notion data source (2025-09-03 API) summarized for picker UIs.
 * `databaseId` is the parent database's id — data sources live under a
 * database and the sync config keys off the data source, not the database.
 */
export interface NotionDataSourceSummary {
  id: string;
  databaseId: string;
  title: string;
}

/**
 * Property name → Notion property type (e.g. 'title', 'rich_text',
 * 'select'). Built from a data source's `properties` map.
 */
export type NotionPropertySchemaMap = Map<string, string>;

/**
 * A single property value as returned inline on a Notion page object.
 * Shape varies per `type` — see notion-value-converter.ts for the
 * per-type flatten/wrap rules.
 */
export interface NotionPropertyValue {
  type: string;
  [key: string]: unknown;
}

/**
 * A Notion page object, trimmed to the fields the sync pipeline reads.
 */
export interface NotionPage {
  id: string;
  properties: Record<string, NotionPropertyValue>;
  in_trash?: boolean;
}

/**
 * Envelope shared by /search and /data_sources/{id}/query responses.
 */
export interface NotionListResponse<T> {
  results: T[];
  has_more: boolean;
  next_cursor: string | null;
}
