/**
 * File and path sanitization utilities.
 *
 * @handbook 7.1-input-validation
 * @tested tests/utils/sanitizers.test.ts
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
    .filter(segment => segment.length > 0 && segment !== '.' && segment !== '..')
    .join("/");
}

/**
 * Sanitizes a subfolder field value according to the per-config slash policy.
 * Dispatches between filename rules (`/` collapses to `-`) and folder-path
 * rules (`/` splits into nested segments) based on the toggle. Default mode
 * (`treatSlashAsLiteral=false`) preserves the legacy behavior of nesting on `/`.
 *
 * Defense-in-depth: bare `.` / `..` outputs are rejected (returned as `''`)
 * even though `sanitizeFolderPath` already filters them per-segment — literal
 * mode dispatches to `sanitizeFileName`, which does NOT touch dot characters,
 * and Obsidian's `normalizePath` does NOT collapse `..` segments. Without this
 * guard, a remote value of `..` with the toggle on would let the orchestrator
 * build `${folderPath}/..` and write notes outside the configured sync folder
 * (issue #96 follow-up).
 *
 * Length-cap note: literal mode caps the entire value at 255 chars via
 * `sanitizeFileName`; nest mode caps each `/`-separated segment at 255 via
 * `sanitizeFolderPath`. Toggling on an existing vault can therefore produce
 * different on-disk paths for long values containing `/`.
 *
 * @param value The raw subfolder value from the remote record
 * @param treatSlashAsLiteral When true, `/` becomes `-`; when false, `/` nests
 * @returns Sanitized subfolder path string, or `''` for empty/dot-only inputs
 */
export function sanitizeSubfolderValue(value: string, treatSlashAsLiteral: boolean): string {
  const sanitized = treatSlashAsLiteral ? sanitizeFileName(value) : sanitizeFolderPath(value);
  if (sanitized === '.' || sanitized === '..') return '';
  return sanitized;
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
