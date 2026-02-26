/**
 * Airtable API client service.
 */

import { requestUrl } from "obsidian";
import { AIRTABLE_API_BASE_URL, AIRTABLE_BATCH_SIZE } from '../constants';
import type { AutoNoteImporterSettings, RemoteNote, SyncResult, BatchUpdate } from '../types';
import { RateLimiter } from './rate-limiter';

/**
 * Client for interacting with the Airtable API.
 */
export class AirtableClient {
  private settings: AutoNoteImporterSettings;
  private rateLimiter: RateLimiter;

  constructor(settings: AutoNoteImporterSettings, rateLimiter?: RateLimiter) {
    this.settings = settings;
    this.rateLimiter = rateLimiter || new RateLimiter();
  }

  /**
   * Updates the settings reference.
   */
  updateSettings(settings: AutoNoteImporterSettings): void {
    this.settings = settings;
  }

  /**
   * Validates that required settings are configured.
   */
  private validateSettings(): void {
    const { apiKey, baseId, tableId } = this.settings;
    if (!apiKey || !baseId || !tableId) {
      throw new Error("Airtable API key, base ID, and table ID must be set.");
    }
  }

  /**
   * Builds the base URL for API requests.
   */
  private getBaseUrl(): string {
    return `${AIRTABLE_API_BASE_URL}/${this.settings.baseId}/${this.settings.tableId}`;
  }

  /**
   * Validates that a record ID has the expected Airtable format.
   */
  private validateRecordId(recordId: string): void {
    if (!recordId || !recordId.startsWith('rec')) {
      throw new Error(`Invalid Airtable record ID: ${recordId}`);
    }
  }

  /**
   * Builds authorization headers for API requests.
   */
  private getHeaders(): Record<string, string> {
    return {
      "Authorization": `Bearer ${this.settings.apiKey}`,
      "Content-Type": "application/json",
    };
  }

  /**
   * Extracts a human-readable error message from an API response.
   */
  private extractErrorDetails(response: { status: number; json?: unknown }): string {
    let details = `HTTP ${response.status}`;
    try {
      const errorJson = response.json as { error?: { message?: string } } | undefined;
      details += `: ${errorJson?.error?.message || JSON.stringify(errorJson)}`;
    } catch {
      // Response body isn't valid JSON
    }
    return details;
  }

  /**
   * Fetches all notes from Airtable with pagination.
   */
  async fetchNotes(): Promise<RemoteNote[]> {
    this.validateSettings();

    const allNotes: RemoteNote[] = [];
    let offset: string | undefined;
    const baseUrl = this.getBaseUrl();

    do {
      const url = offset ? `${baseUrl}?offset=${offset}` : baseUrl;
      const response = await this.rateLimiter.execute(() =>
        requestUrl({
          url,
          method: "GET",
          headers: this.getHeaders(),
        })
      );

      if (response.status !== 200) {
        throw new Error(`Failed to fetch remote notes: ${this.extractErrorDetails(response)}`);
      }

      const json = response.json;

      const notesFromPage: RemoteNote[] = json.records.map((record: {
        id: string;
        fields: Record<string, unknown>;
      }) => ({
        id: record.id,
        primaryField: record.id,
        fields: record.fields
      }));

      allNotes.push(...notesFromPage);
      offset = json.offset;
    } while (offset);

    return allNotes;
  }

  /**
   * Fetches a single record from Airtable.
   */
  async fetchRecord(recordId: string): Promise<RemoteNote | null> {
    this.validateSettings();
    this.validateRecordId(recordId);

    const url = `${this.getBaseUrl()}/${recordId}`;

    const response = await this.rateLimiter.execute(() =>
      requestUrl({
        url,
        method: "GET",
        headers: this.getHeaders(),
      })
    );

    if (response.status === 404) {
      return null;
    }

    if (response.status !== 200) {
      const errorDetails = this.extractErrorDetails(response);
      throw new Error(`Failed to fetch record ${recordId}: ${errorDetails}`);
    }

    const json = response.json;
    return {
      id: json.id,
      primaryField: json.id,
      fields: json.fields
    };
  }

  /**
   * Updates a single record in Airtable.
   */
  async updateRecord(recordId: string, fields: Record<string, unknown>): Promise<SyncResult> {
    this.validateSettings();
    this.validateRecordId(recordId);

    try {
      const url = `${this.getBaseUrl()}/${recordId}`;
      const response = await this.rateLimiter.execute(() =>
        requestUrl({
          url,
          method: "PATCH",
          headers: this.getHeaders(),
          body: JSON.stringify({ fields })
        })
      );

      if (response.status !== 200) {
        return {
          success: false,
          recordId,
          error: `Failed to update Airtable record: ${this.extractErrorDetails(response)}`
        };
      }

      const json = response.json;
      return {
        success: true,
        recordId: json.id,
        updatedFields: json.fields,
      };
    } catch (error) {
      return {
        success: false,
        recordId,
        error: error instanceof Error ? error.message : "Unknown error occurred"
      };
    }
  }

  /**
   * Batch updates multiple records in Airtable.
   * Automatically handles the 10-record limit per batch.
   */
  async batchUpdate(updates: BatchUpdate[]): Promise<SyncResult[]> {
    this.validateSettings();

    if (updates.length === 0) {
      return [];
    }

    if (updates.length > AIRTABLE_BATCH_SIZE) {
      throw new Error(`Maximum ${AIRTABLE_BATCH_SIZE} records allowed per batch update`);
    }

    try {
      const url = this.getBaseUrl();
      const records = updates.map(update => ({
        id: update.recordId,
        fields: update.fields
      }));

      const response = await this.rateLimiter.execute(() =>
        requestUrl({
          url,
          method: "PATCH",
          headers: this.getHeaders(),
          body: JSON.stringify({ records })
        })
      );

      if (response.status !== 200) {
        const errorDetails = this.extractErrorDetails(response);
        return updates.map(update => ({
          success: false as const,
          recordId: update.recordId,
          error: `Failed to batch update Airtable records: ${errorDetails}`
        }));
      }

      const json = response.json;
      return json.records.map((record: { id: string; fields: Record<string, unknown> }) => ({
        success: true as const,
        recordId: record.id,
        updatedFields: record.fields,
      }));
    } catch (error) {
      return updates.map(update => ({
        success: false as const,
        recordId: update.recordId,
        error: error instanceof Error ? error.message : "Unknown error occurred"
      }));
    }
  }
}
