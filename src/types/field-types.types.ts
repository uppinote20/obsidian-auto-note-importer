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
   * Read-only is not the whole push-safety contract: some writable provider
   * types still have object-shaped API values that cannot round-trip from
   * frontmatter scalars.
   */
  isReadOnly(providerType: string): boolean;

  /**
   * Returns true if frontmatter values of this provider type can be safely sent
   * back to the remote API. Stricter than `!isReadOnly`: rejects unknown and
   * object-shaped provider types that cannot be reconstructed from YAML values.
   */
  isPushable(providerType: string): boolean;

  /**
   * Returns true if the field type is usable as a filename value.
   * Stricter than `isSubfolderSafe` — only types that stringify to OS-safe
   * filename atoms (no separators, stable text-like output). Used by
   * settings-tab to filter the filename field dropdown.
   */
  isFilenameSafe(providerType: string): boolean;

  /**
   * Returns true if the field type is usable as a subfolder grouping key.
   * Broader than `isFilenameSafe` — every type whose stringified value is a
   * reasonable folder name passes. Subfolder values flow through
   * `sanitizeSubfolderValue` which normalizes path-unsafe characters, so
   * date / formula / multi-select / etc. are all acceptable. Issue #98.
   */
  isSubfolderSafe(providerType: string): boolean;

  /**
   * Returns all known provider-specific types that pass `isFilenameSafe`.
   * Enables UIs to enumerate the whitelist without guessing.
   */
  getFilenameSafeTypes(): readonly string[];

  /**
   * Returns all known provider-specific types that pass `isSubfolderSafe`.
   * Used by settings-tab to filter the subfolder field dropdown.
   */
  getSubfolderSafeTypes(): readonly string[];

  /**
   * Returns all known provider-specific types that pass `isReadOnly`.
   * Enables diagnostics and documentation tooling.
   */
  getReadOnlyTypes(): readonly string[];
}
