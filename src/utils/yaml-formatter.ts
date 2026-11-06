/**
 * YAML formatting utilities.
 * @handbook 4.3-data-flow
 * @handbook 7.3-read-only-field-protection
 * @tested tests/utils/yaml-formatter.test.ts
 */

/**
 * Escapes a string for safe use inside a YAML double-quoted scalar.
 *
 * Besides backslashes and double quotes, line breaks and tabs are written as
 * escape sequences: remote values are untrusted, and a raw newline would let
 * a value spill onto its own frontmatter line — e.g. forging a second
 * `primaryField` that redirects pushes to another record. The YAML parser
 * decodes the escapes back, so the value round-trips unchanged.
 */
export function escapeYamlString(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
}

/**
 * Formats a JavaScript value into a YAML-compatible string representation.
 * - Strings are quoted and escaped (backslashes and double quotes).
 * - Numbers (finite) and booleans are unquoted.
 * - null and undefined become empty string.
 * - Non-finite numbers (Infinity, NaN) are treated as strings.
 * @param value The value to format.
 * @returns A YAML-compatible string representation.
 */
export function formatYamlValue(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'boolean') return String(value);
  if (typeof value === 'number' && isFinite(value)) return String(value);

  const strValue = String(value);
  return `"${escapeYamlString(strValue)}"`;

}

/**
 * Keys that name an object for display, in priority order. Covers the
 * object shapes the providers hand back unflattened (#133):
 * - `display_value` — SeaTable link
 * - `url`           — Airtable attachment, SeaTable file, Airtable button
 * - `name`          — Airtable collaborator
 * - `label` / `title` / `text` — Airtable button / barcode and similar
 * - `email` / `id`  — last-resort identifiers
 * Notion already flattens its object properties in notion-value-converter,
 * so it never reaches this path.
 */
const OBJECT_LABEL_KEYS = ['display_value', 'url', 'name', 'label', 'title', 'text', 'email', 'id'] as const;

/**
 * Reduces an object-shaped field value to a single display string.
 *
 * Picks the first non-empty label key (see {@link OBJECT_LABEL_KEYS}); an
 * object with none of them is serialised as JSON so nothing is lost (e.g.
 * SeaTable geolocation, Supabase jsonb). Only the rendered frontmatter /
 * template text changes — `RemoteNote.fields` keeps the full object, so
 * nested template paths like `{{Attachment.0.url}}` still work.
 */
export function formatObjectLabel(value: object): string {
  const record = value as Record<string, unknown>;
  for (const key of OBJECT_LABEL_KEYS) {
    const candidate = record[key];
    if (typeof candidate === 'string' && candidate !== '') return candidate;
    if (typeof candidate === 'number' && isFinite(candidate)) return String(candidate);
  }
  try {
    return JSON.stringify(value);
  } catch {
    // Provider responses are parsed JSON, so this is defensive only — a
    // circular structure or BigInt can't be serialised.
    return '[Object]';
  }
}

/**
 * Formats a field value for optimal Bases compatibility in frontmatter.
 * Handles different data types to ensure proper editing in Bases.
 * @param key The field key (for context)
 * @param value The field value to format
 * @returns Formatted string or null if value should be omitted
 */
export function formatFieldForBases(key: string, value: unknown): string | null {
  if (value == null) {
    return '""';
  }

  // Handle arrays
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";

    // Every item becomes a quoted string so the field stays a YAML list that
    // Bases can read; object items collapse to their label (#133) instead of
    // the literal "[Object]", and null items are dropped.
    const items = value
      .filter(item => item != null)
      .map(item => typeof item === 'object' ? formatObjectLabel(item) : String(item));
    return `[${items.map(item => formatYamlValue(item)).join(', ')}]`;
  }

  // Handle booleans
  if (typeof value === 'boolean') {
    return String(value);
  }

  // Handle numbers
  if (typeof value === 'number' && isFinite(value)) {
    return String(value);
  }

  // Handle dates
  // Bases date columns parse ISO datetimes directly — clipping to date-only here
  // caused push-back to overwrite remote timestamps with midnight (PR #125 Codex P1).
  // Only pass the value through unchanged; date-only strings already match this shape.
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value)) {
    return formatYamlValue(value);
  }

  // Handle objects
  if (typeof value === 'object') {
    return formatYamlValue(formatObjectLabel(value));
  }

  // Handle multiline strings
  const stringValue = String(value);
  if (stringValue.includes('\n')) {
    return `|\n  ${stringValue.replace(/\n/g, '\n  ')}`;
  }

  return formatYamlValue(stringValue);
}
