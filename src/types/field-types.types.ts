/**
 * Provider-agnostic field type taxonomy and mapper interface.
 *
 * Each DatabaseProvider exposes a FieldTypeMapper that normalizes its
 * provider-specific field type strings to the StandardFieldType union
 * below, and answers push/filename-safety questions about them.
 *
 * @handbook 4.4-provider-abstraction
 * @handbook 7.3-read-only-field-protection
 */

/**
 * Normalized field type taxonomy across all providers.
 *
 * - `text`: single- or multi-line text
 * - `number`: numeric (int or float)
 * - `date`: date or datetime
 * - `boolean`: checkbox / toggle
 * - `single-select`: enum with one value
 * - `multi-select`: enum with multiple values
 * - `attachment`: file / media reference
 * - `link`: reference to another record/row
 * - `computed`: server-computed value (formula, rollup, lookup) — read-only
 * - `system`: server-assigned metadata (createdTime, createdBy, autoNumber) — read-only
 * - `unknown`: provider reported a type the mapper doesn't recognize
 */
export type StandardFieldType =
  | 'text'
  | 'number'
  | 'date'
  | 'boolean'
  | 'single-select'
  | 'multi-select'
  | 'attachment'
  | 'link'
  | 'computed'
  | 'system'
  | 'unknown';

/**
 * Per-provider field type mapper. Stateless singleton.
 *
 * Providers register their mapper via `provider-registry.ts` so
 * provider-agnostic code can look up the correct mapper by credential type.
 */
export interface FieldTypeMapper {
  /**
   * Normalizes a provider-specific type string to the standard taxonomy.
   * Unknown types map to `'unknown'`.
   */
  mapToStandardType(providerType: string): StandardFieldType;

  /**
   * Returns true if the field type is read-only (computed or system-assigned).
   * Used by frontmatter-parser to exclude fields from push payloads.
   */
  isReadOnly(providerType: string): boolean;

  /**
   * Returns true if the field type is usable as a filename or subfolder value.
   * Used by settings-tab to filter the filename/subfolder field dropdown.
   */
  isFilenameSafe(providerType: string): boolean;

  /**
   * Returns all known provider-specific types that pass `isFilenameSafe`.
   * Enables UIs to enumerate the whitelist without guessing.
   */
  getFilenameSafeTypes(): readonly string[];

  /**
   * Returns all known provider-specific types that pass `isReadOnly`.
   * Enables diagnostics and documentation tooling.
   */
  getReadOnlyTypes(): readonly string[];
}
