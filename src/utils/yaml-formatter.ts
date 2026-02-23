/**
 * YAML formatting utilities.
 */

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
  if (value === null) return '';
  if (value === undefined) return '';
  if (typeof value === 'boolean') return String(value);
  if (typeof value === 'number' && isFinite(value)) return String(value);

  const strValue = String(value);
  const escapedValue = strValue.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return `"${escapedValue}"`;
}

/**
 * Formats a field value for optimal Bases compatibility in frontmatter.
 * Handles different data types to ensure proper editing in Bases.
 * @param key The field key (for context)
 * @param value The field value to format
 * @returns Formatted string or null if value should be omitted
 */
export function formatFieldForBases(key: string, value: unknown): string | null {
  if (value === null || value === undefined) {
    return '""';
  }

  // Handle arrays
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";

    const simpleItems = value.filter(item =>
      typeof item === 'string' || typeof item === 'number'
    );
    if (simpleItems.length === value.length) {
      return `[${simpleItems.map(item => formatYamlValue(String(item))).join(', ')}]`;
    }

    return `"${value.map(item =>
      typeof item === 'object' ? '[Object]' : String(item)
    ).join(', ')}"`;
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
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value)) {
    return formatYamlValue(value.split('T')[0]);
  }

  // Handle objects
  if (typeof value === 'object') {
    return `"[Object: ${Object.keys(value as object).slice(0, 3).join(', ')}]"`;
  }

  // Handle multiline strings
  const stringValue = String(value);
  if (stringValue.includes('\n')) {
    return `|\n  ${stringValue.replace(/\n/g, '\n  ')}`;
  }

  return formatYamlValue(stringValue);
}
