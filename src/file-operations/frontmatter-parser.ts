/**
 * Frontmatter parsing and manipulation utilities.
 */

import type { App, TFile, TFolder } from "obsidian";
import { MAX_FOLDER_DEPTH, isSystemField, isReadOnlyFieldType } from '../constants';
import { formatYamlValue } from '../utils';
import type { AirtableField } from '../types';

/**
 * Handles frontmatter parsing, extraction, and injection.
 */
export class FrontmatterParser {
  private app: App;

  constructor(app: App) {
    this.app = app;
  }

  /**
   * Extracts the primaryField value from a file's frontmatter.
   */
  extractPrimaryField(file: TFile): string | null {
    const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter;
    if (frontmatter?.primaryField) {
      return String(frontmatter.primaryField);
    }
    return null;
  }

  /**
   * Extracts syncable fields from a file's frontmatter.
   * Filters out system fields and read-only fields.
   */
  extractSyncableFields(
    file: TFile,
    cachedFields?: AirtableField[]
  ): Record<string, unknown> | null {
    const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter;

    if (!frontmatter || !frontmatter.primaryField) {
      return null;
    }

    const fieldsToSync: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(frontmatter)) {
      // Skip system fields
      if (isSystemField(key)) {
        continue;
      }

      // Skip null/undefined values
      if (value === null || value === undefined) {
        continue;
      }

      // Check if field is read-only (formula, rollup, etc.)
      if (cachedFields) {
        const fieldInfo = cachedFields.find(f => f.name === key);
        if (fieldInfo && isReadOnlyFieldType(fieldInfo.type)) {
          continue;
        }
      }

      fieldsToSync[key] = value;
    }

    if (Object.keys(fieldsToSync).length === 0) {
      return null;
    }

    return fieldsToSync;
  }

  /**
   * Ensures primaryField exists in content's frontmatter.
   * Injects it if missing.
   */
  ensurePrimaryField(content: string, primaryField: string): string {
    const frontmatterRegex = /^---\s*([\s\S]*?)\s*---/;
    const match = content.match(frontmatterRegex);
    let hasPrimaryFieldKey = false;

    const primaryFieldYamlLine = `primaryField: ${formatYamlValue(primaryField)}\n`;

    if (match && match[1]) {
      if (/^\s*primaryField\s*:/m.test(match[1])) {
        hasPrimaryFieldKey = true;
      }
    }

    if (!hasPrimaryFieldKey) {
      if (match) {
        // Frontmatter exists, but primaryField key is missing
        const frontmatterEnd = content.indexOf('\n---\n', 4);
        if (frontmatterEnd !== -1) {
          content = content.slice(0, frontmatterEnd) + '\n' + primaryFieldYamlLine.trim() + content.slice(frontmatterEnd);
        } else {
          const altEnd = content.indexOf('\n---', 4);
          if (altEnd !== -1) {
            content = content.slice(0, altEnd) + '\n' + primaryFieldYamlLine.trim() + content.slice(altEnd);
          } else {
            const firstNewline = content.indexOf('\n', 3);
            if (firstNewline !== -1) {
              content = content.slice(0, firstNewline + 1) + primaryFieldYamlLine + content.slice(firstNewline + 1);
            }
          }
        }
      } else {
        // No frontmatter exists
        const newFrontmatter = `---\n${primaryFieldYamlLine}---\n\n`;
        const separator = (content.length > 0 && !content.startsWith('\n')) ? '\n' : '';
        content = newFrontmatter + separator + content;
      }
    }

    return content;
  }

  /**
   * Loads existing primaryField values from a folder.
   * Recursively searches subfolders.
   */
  async loadExistingPrimaryFields(folderPath: string): Promise<Set<string>> {
    const folder = this.app.vault.getAbstractFileByPath(folderPath);
    const primaryFields = new Set<string>();

    if (folder && 'children' in folder) {
      await this.scanFolderRecursively(folder as TFolder, primaryFields, 0, MAX_FOLDER_DEPTH);
    }
    return primaryFields;
  }

  /**
   * Recursively scans a folder for markdown files with primaryField.
   */
  private async scanFolderRecursively(
    folder: TFolder,
    primaryFields: Set<string>,
    currentDepth: number,
    maxDepth: number
  ): Promise<void> {
    if (currentDepth >= maxDepth) {
      return;
    }

    for (const file of folder.children) {
      if ('extension' in file && (file as TFile).extension === "md") {
        const frontmatter = this.app.metadataCache.getFileCache(file as TFile)?.frontmatter;
        if (frontmatter?.primaryField) {
          primaryFields.add(String(frontmatter.primaryField));
        }
      } else if ('children' in file) {
        await this.scanFolderRecursively(file as TFolder, primaryFields, currentDepth + 1, maxDepth);
      }
    }
  }

  /**
   * Gets the record ID from a file's frontmatter.
   */
  getRecordId(file: TFile): string | null {
    return this.extractPrimaryField(file);
  }
}
