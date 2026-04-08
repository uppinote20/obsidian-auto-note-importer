/**
 * Validation utilities for plugin configuration.
 *
 * @tested tests/utils/validation.test.ts
 */

import { normalizePath } from 'obsidian';
import type { ConfigEntry } from '../types/config.types';

/**
 * Validates that a folder path does not overlap with any other config's folder path.
 *
 * Overlap is defined as:
 * - Identical paths
 * - One path is an ancestor of the other (parent-child or child-parent relationship)
 *
 * Disabled configs are still checked to prevent future conflicts when re-enabled.
 *
 * @param configId - The ID of the config being validated (excluded from comparison)
 * @param folderPath - The folder path to validate
 * @param configs - All existing config entries
 * @returns An error message string if there is a conflict, or null if valid
 */
export function validateFolderPath(
  configId: string,
  folderPath: string,
  configs: ConfigEntry[],
): string | null {
  const normalized = normalizePath(folderPath);
  for (const config of configs) {
    if (config.id === configId) continue;
    const other = normalizePath(config.folderPath);
    if (!other) continue;
    if (
      normalized === other ||
      normalized.startsWith(other + '/') ||
      other.startsWith(normalized + '/')
    ) {
      return `Folder conflicts with "${config.name}" configuration`;
    }
  }
  return null;
}
