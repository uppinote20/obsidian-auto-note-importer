/**
 * Frontmatter parsing and manipulation utilities.
 */

import type { App } from "obsidian";
import { TFile, TFolder } from "obsidian";
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

      if (value == null) {
        continue;
      }

      // When field metadata is available, only sync fields that exist in Airtable and are writable
      if (cachedFields) {
        const fieldInfo = cachedFields.find(f => f.name === key);
        if (!fieldInfo || isReadOnlyFieldType(fieldInfo.type)) {
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
    const primaryFieldEntry = `primaryField: ${formatYamlValue(primaryField)}`;

    // Already has primaryField -- return as-is
    if (match?.[1] && /^\s*primaryField\s*:/m.test(match[1])) {
      return content;
    }

    // No frontmatter exists -- prepend new frontmatter block
    if (!match) {
      const separator = (content.length > 0 && !content.startsWith('\n')) ? '\n' : '';
      return `---\n${primaryFieldEntry}\n---\n\n${separator}${content}`;
    }

    // Frontmatter exists but missing primaryField -- inject before closing ---
    const closingIndex = content.indexOf('\n---', 4);
    if (closingIndex !== -1) {
      return content.slice(0, closingIndex) + '\n' + primaryFieldEntry + content.slice(closingIndex);
    }

    // Fallback: inject after opening ---
    const firstNewline = content.indexOf('\n', 3);
    if (firstNewline !== -1) {
      return content.slice(0, firstNewline + 1) + primaryFieldEntry + '\n' + content.slice(firstNewline + 1);
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

    if (folder instanceof TFolder) {
      await this.scanFolderRecursively(folder, primaryFields, 0, MAX_FOLDER_DEPTH);
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

    for (const child of folder.children) {
      if (child instanceof TFile && child.extension === "md") {
        const frontmatter = this.app.metadataCache.getFileCache(child)?.frontmatter;
        if (frontmatter?.primaryField) {
          primaryFields.add(String(frontmatter.primaryField));
        }
      } else if (child instanceof TFolder) {
        await this.scanFolderRecursively(child, primaryFields, currentDepth + 1, maxDepth);
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
