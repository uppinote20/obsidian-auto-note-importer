/**
 * File and path sanitization utilities.
 */

/**
 * Reserved filenames on Windows that cannot be used.
 */
const WINDOWS_RESERVED_NAMES = [
  'CON', 'PRN', 'AUX', 'NUL',
  'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
  'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9'
];

/**
 * Maximum filename length.
 */
const MAX_FILENAME_LENGTH = 255;

/**
 * Sanitizes a string to be safe for use as a filename.
 * @param name The name to sanitize
 * @returns A sanitized version of the name, suitable for use as a filename
 */
export function sanitizeFileName(name: string): string {
  if (!name) {
    return "";
  }
  return name
    .trim()
    .replace(/[/\\:*?"<>|']/g, "-")
    .replace(/\s+/g, " ")
    .slice(0, MAX_FILENAME_LENGTH);
}

/**
 * Sanitizes a string to be safe for use as a folder path.
 * Similar to sanitizeFileName but allows forward slashes for nested folders.
 * @param path The path to sanitize
 * @returns A sanitized version of the path, suitable for use as a folder path
 */
export function sanitizeFolderPath(path: string): string {
  if (!path) {
    return "";
  }
  return path
    .trim()
    .replace(/[\\:*?"<>|']/g, "-")
    .replace(/\s+/g, " ")
    .split("/")
    .map(segment => segment.trim().slice(0, MAX_FILENAME_LENGTH))
    .filter(segment => segment.length > 0)
    .join("/");
}

/**
 * Validates and sanitizes a value for use as a filename.
 * Returns the sanitized filename if valid, or null if invalid.
 * @param value The value to validate and sanitize
 * @returns Sanitized filename string or null if invalid
 */
export function validateAndSanitizeFilename(value: unknown): string | null {
  if (value == null) return null;

  const strValue = String(value).trim();
  if (!strValue) return null;

  if (strValue.length > MAX_FILENAME_LENGTH) return null;

  const sanitized = sanitizeFileName(strValue);

  if (!sanitized || sanitized.trim() === '' || sanitized === '-'.repeat(sanitized.length)) {
    return null;
  }

  // Reject reserved names on Windows
  const upperSanitized = sanitized.toUpperCase();
  if (
    WINDOWS_RESERVED_NAMES.includes(upperSanitized) ||
    WINDOWS_RESERVED_NAMES.some(name => upperSanitized.startsWith(name + '.'))
  ) {
    return null;
  }

  return sanitized;
}
