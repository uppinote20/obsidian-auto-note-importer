/**
 * Generates Obsidian Bases (.base) database files.
 *
 * Pure functions that produce YAML content for Bases table/card views.
 * Follows the same stateless pattern as note-builder.ts.
 *
 * @handbook 4.3-data-flow
 */

import { normalizePath } from 'obsidian';
import type { BasesFileLocation, RemoteNote } from '../types';

const YAML_SPECIAL_CHARS = /[:#{}[\],&*?|>!%@`"'\\\n]/;

/**
 * Escapes and quotes a string for safe use in YAML if it contains special characters.
 */
function quoteIfNeeded(value: string): string {
  if (YAML_SPECIAL_CHARS.test(value)) {
    return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  }
  return value;
}

/**
 * Generates the YAML content for a .base file.
 *
 * Produces a table view with file.inFolder filter and ordered columns
 * derived from the synced notes' field names.
 */
export function generateBasesContent(folderPath: string, fieldNames: string[]): string {
  const escapedPath = folderPath.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const lines: string[] = [];

  lines.push('filters:');
  lines.push(`  file.inFolder("${escapedPath}")`);
  lines.push('views:');
  lines.push('  - type: table');
  lines.push('    name: Table');
  lines.push('    order:');
  lines.push('      - file.name');

  for (const name of fieldNames) {
    lines.push(`      - note.${quoteIfNeeded(name)}`);
  }

  return lines.join('\n') + '\n';
}

interface BasesFilePathOptions {
  basesFileLocation: BasesFileLocation;
  folderPath: string;
  basesCustomPath: string;
}

/**
 * Resolves the full vault path for the .base file based on location settings.
 */
export function resolveBasesFilePath(options: BasesFilePathOptions, tableName: string): string {
  const fileName = `${tableName}.base`;

  switch (options.basesFileLocation) {
    case 'synced-folder':
      return normalizePath(`${options.folderPath}/${fileName}`);
    case 'custom':
      return options.basesCustomPath
        ? normalizePath(`${options.basesCustomPath}/${fileName}`)
        : fileName;
    case 'vault-root':
    default:
      return fileName;
  }
}

/**
 * Collects unique field names from an array of RemoteNotes.
 */
export function collectFieldNames(notes: RemoteNote[]): string[] {
  const seen = new Set<string>();

  for (const note of notes) {
    for (const key of Object.keys(note.fields)) {
      seen.add(key);
    }
  }

  return [...seen];
}
