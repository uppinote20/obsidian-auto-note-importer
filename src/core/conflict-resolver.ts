/**
 * Conflict detection and resolution for bidirectional sync.
 */

import { Notice } from "obsidian";
import { areValuesEqual } from '../utils';
import { AirtableClient } from '../services';
import type { AutoNoteImporterSettings, ConflictInfo, SyncResult } from '../types';

/**
 * Handles conflict detection and resolution between Obsidian and Airtable.
 */
export class ConflictResolver {
  private settings: AutoNoteImporterSettings;
  private airtableClient: AirtableClient;

  constructor(settings: AutoNoteImporterSettings, airtableClient: AirtableClient) {
    this.settings = settings;
    this.airtableClient = airtableClient;
  }

  /**
   * Updates the settings reference.
   */
  updateSettings(settings: AutoNoteImporterSettings): void {
    this.settings = settings;
  }

  /**
   * Detects conflicts between Obsidian and Airtable field values.
   */
  async detectConflicts(
    recordId: string,
    obsidianFields: Record<string, unknown>,
    filePath: string
  ): Promise<ConflictInfo[]> {
    try {
      const record = await this.airtableClient.fetchRecord(recordId);

      if (!record) {
        return [];
      }

      const conflicts: ConflictInfo[] = [];

      for (const [field, obsidianValue] of Object.entries(obsidianFields)) {
        const airtableValue = record.fields[field];

        if (airtableValue !== undefined && !areValuesEqual(obsidianValue, airtableValue)) {
          conflicts.push({
            field,
            obsidianValue,
            airtableValue,
            recordId,
            filePath
          });
        }
      }

      return conflicts;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      new Notice(`Auto Note Importer: Unable to check for conflicts: ${message}. Proceeding with sync.`);
      return [];
    }
  }

  /**
   * Handles detected conflicts based on the resolution strategy.
   */
  async resolve(
    conflicts: ConflictInfo[],
    fieldsToSync: Record<string, unknown>,
    recordId: string
  ): Promise<SyncResult> {
    switch (this.settings.conflictResolution) {
      case 'obsidian-wins':
        // Sync all fields, overwriting Airtable
        return await this.airtableClient.updateRecord(recordId, fieldsToSync);

      case 'airtable-wins':
        return await this.resolveAirtableWins(conflicts, fieldsToSync, recordId);

      case 'manual':
        return this.resolveManual(conflicts, recordId);

      default:
        // Fallback to obsidian-wins
        return await this.airtableClient.updateRecord(recordId, fieldsToSync);
    }
  }

  /**
   * Resolves conflicts with Airtable winning.
   */
  private async resolveAirtableWins(
    conflicts: ConflictInfo[],
    fieldsToSync: Record<string, unknown>,
    recordId: string
  ): Promise<SyncResult> {
    const conflictedFieldNames = new Set(conflicts.map(c => c.field));
    const nonConflictedFields: Record<string, unknown> = {};

    for (const [field, value] of Object.entries(fieldsToSync)) {
      if (!conflictedFieldNames.has(field)) {
        nonConflictedFields[field] = value;
      }
    }

    if (conflicts.length > 0) {
      const conflictFields = conflicts.map(c => c.field).join(', ');
      new Notice(`Auto Note Importer: Conflicted fields ignored (Airtable wins): ${conflictFields}`);
    }

    if (Object.keys(nonConflictedFields).length > 0) {
      return await this.airtableClient.updateRecord(recordId, nonConflictedFields);
    }

    return {
      success: true,
      recordId,
      updatedFields: {},
    };
  }

  /**
   * Resolves conflicts with manual mode (show notification, don't sync).
   */
  private resolveManual(conflicts: ConflictInfo[], recordId: string): SyncResult {
    const conflictFields = conflicts.map(c => c.field).join(', ');
    new Notice(`Auto Note Importer: Conflicts detected in fields: ${conflictFields}. Please resolve manually.`);

    return {
      success: false,
      recordId,
      updatedFields: {},
      error: `Conflicts detected in fields: ${conflictFields}`
    };
  }

  /**
   * Checks if conflict detection should be skipped.
   */
  shouldSkipConflictDetection(): boolean {
    return this.settings.conflictResolution === 'obsidian-wins';
  }
}
