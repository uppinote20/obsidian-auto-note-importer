/**
 * Safely retrieves a nested property value from an object using a dot-separated path.
 * Handles cases where intermediate properties might be missing or not objects.
 * @param obj The object to search
 * @param path The path to the property, e.g. "object.nested.property"
 * @returns The value at the specified path, or undefined if not found
 */
export function getNestedValue(obj: unknown, path: string): unknown {
  // Basic validation for inputs
	if (!path || typeof obj !== "object" || obj === null) {
		return undefined;
	}
	
  // Split the path into keys
	const keys = path.split(".");
	let result: unknown = obj;

  // Iterate through each key in the path
	for (const key of keys) {
    // Check if the current result is an object and has the key
    // If it doesn't exist, return undefined
    if (typeof result !== "object" || result === null || !Object.prototype.hasOwnProperty.call(result, key)) {
			return undefined;
		}
    // Move to the next nested level
		result = (result as Record<string, unknown>)[key];
	}
  // Return the final value found at the end of the path
	return result;
}

/**
 * Sanitizes a string to be safe for use as a filename.
 * @param name The name to sanitize
 * @returns A sanitized version of the name, suitable for use as a filename
 */
export function sanitizeFileName(name: string): string {
  // Return an empty string if the input is empty or nullish
  if (!name) {
    return "";
  }
  // Remove leading and trailing whitespace, replace invalid characters with hyphens
  // Replace multiple spaces with a single space, and limit the length to 255 characters
  return name
    .trim()
    .replace(/[/\\:*?"<>|']/g, "-")
    .replace(/\s+/g, " ")
    .slice(0, 255);
}

/**
 * Sanitizes a string to be safe for use as a folder path.
 * Similar to sanitizeFileName but allows forward slashes for nested folders.
 * @param path The path to sanitize
 * @returns A sanitized version of the path, suitable for use as a folder path
 */
export function sanitizeFolderPath(path: string): string {
  // Return an empty string if the input is empty or nullish
  if (!path) {
    return "";
  }
  // Remove leading and trailing whitespace, replace invalid characters with hyphens
  // Keep forward slashes for nested folders but replace backslashes
  // Replace multiple spaces with a single space, and limit each segment to 255 characters
  return path
    .trim()
    .replace(/[\\:*?"<>|']/g, "-")
    .replace(/\s+/g, " ")
    .split("/")
    .map(segment => segment.trim().slice(0, 255))
    .filter(segment => segment.length > 0)
    .join("/");
}

/**
 * Formats a JavaScript value into a YAML-compatible string representation.
 * - Strings are quoted and escaped.
 * - Numbers, booleans, and null are represented directly.
 * - undefined becomes an empty string.
 * - Does not handle complex types like Arrays or Objects directly (intended for simple values).
 * @param value The value to format.
 * @returns A YAML-compatible string representation.
 */
export function formatYamlValue(value: unknown): string {
  if (value === null) return '';
  if (value === undefined) return '';
  if (typeof value === 'boolean') return String(value);
  if (typeof value === 'number' && isFinite(value)) return String(value);

  // Default to string treatment
  const strValue = String(value);
  const escapedValue = strValue.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return `"${escapedValue}"`;
}