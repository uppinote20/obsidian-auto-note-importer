/**
 * Object manipulation utilities.
 */

/**
 * Safely retrieves a nested property value from an object using a dot-separated path.
 * Handles cases where intermediate properties might be missing or not objects.
 * @param obj The object to search
 * @param path The path to the property, e.g. "object.nested.property"
 * @returns The value at the specified path, or undefined if not found
 */
export function getNestedValue(obj: unknown, path: string): unknown {
  if (!path || typeof obj !== "object" || obj === null) {
    return undefined;
  }

  const keys = path.split(".");
  let result: unknown = obj;

  for (const key of keys) {
    if (typeof result !== "object" || result === null || !Object.prototype.hasOwnProperty.call(result, key)) {
      return undefined;
    }
    result = (result as Record<string, unknown>)[key];
  }
  return result;
}

/**
 * Compares two values for deep equality.
 * Handles arrays (element-wise), objects (key-wise), and primitives.
 * Primitives are compared via String conversion with trimming (e.g. "42" equals 42).
 * @param value1 First value to compare
 * @param value2 Second value to compare
 * @returns boolean indicating if values are equal
 */
export function areValuesEqual(value1: unknown, value2: unknown): boolean {
  // Handle null/undefined
  if (value1 == null && value2 == null) return true;
  if (value1 == null || value2 == null) return false;

  // Handle arrays
  if (Array.isArray(value1) && Array.isArray(value2)) {
    if (value1.length !== value2.length) return false;
    return value1.every((item, index) => areValuesEqual(item, value2[index]));
  }

  // Handle objects
  if (typeof value1 === 'object' && typeof value2 === 'object') {
    const keys1 = Object.keys(value1 as object);
    const keys2 = Object.keys(value2 as object);
    if (keys1.length !== keys2.length) return false;
    return keys1.every(key =>
      areValuesEqual(
        (value1 as Record<string, unknown>)[key],
        (value2 as Record<string, unknown>)[key]
      )
    );
  }

  // Handle primitive values
  return String(value1).trim() === String(value2).trim();
}

/**
 * Creates a unique identifier.
 * @returns A unique string identifier
 */
export function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).substring(2, 11)}`;
}
