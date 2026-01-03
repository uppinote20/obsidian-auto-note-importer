/**
 * Field caching service for Airtable metadata.
 * Extracted from settings.ts for better separation of concerns.
 */

import { requestUrl } from "obsidian";
import { AIRTABLE_META_API_URL } from '../constants';
import type { AirtableField, AirtableBase, AirtableTable } from '../types';

/**
 * Caches Airtable metadata (bases, tables, fields) to minimize API calls.
 */
export class FieldCache {
  private cachedBases: AirtableBase[] | null = null;
  private cachedTables: Map<string, AirtableTable[]> = new Map();
  private cachedFields: Map<string, AirtableField[]> = new Map();
  private lastApiKey = "";

  /**
   * Clears cache if the API key has changed.
   */
  private clearCacheIfApiKeyChanged(apiKey: string): void {
    if (this.lastApiKey !== apiKey) {
      this.cachedBases = null;
      this.cachedTables.clear();
      this.cachedFields.clear();
      this.lastApiKey = apiKey;
    }
  }

  /**
   * Generates a cache key for field lookups.
   */
  getCacheKey(baseId: string, tableId: string): string {
    return `${baseId}-${tableId}`;
  }

  /**
   * Fetches available bases from Airtable.
   */
  async fetchBases(apiKey: string): Promise<AirtableBase[]> {
    this.clearCacheIfApiKeyChanged(apiKey);

    if (this.cachedBases) {
      return this.cachedBases;
    }

    const response = await requestUrl({
      url: `${AIRTABLE_META_API_URL}/bases`,
      method: "GET",
      headers: { "Authorization": `Bearer ${apiKey}` },
    });

    if (response.status !== 200) {
      throw new Error(`Failed to fetch bases: HTTP ${response.status}`);
    }

    const json = response.json;
    const bases: AirtableBase[] = json.bases.map((b: { id: string; name: string }) => ({
      id: b.id,
      name: b.name
    }));
    this.cachedBases = bases;
    return bases;
  }

  /**
   * Fetches tables for a specific base.
   */
  async fetchTables(apiKey: string, baseId: string): Promise<AirtableTable[]> {
    this.clearCacheIfApiKeyChanged(apiKey);

    if (this.cachedTables.has(baseId)) {
      return this.cachedTables.get(baseId)!;
    }

    const response = await requestUrl({
      url: `${AIRTABLE_META_API_URL}/bases/${baseId}/tables`,
      method: "GET",
      headers: { "Authorization": `Bearer ${apiKey}` },
    });

    if (response.status !== 200) {
      throw new Error(`Failed to fetch tables: HTTP ${response.status}`);
    }

    const json = response.json;
    const tables: AirtableTable[] = json.tables.map((t: { id: string; name: string }) => ({
      id: t.id,
      name: t.name
    }));
    this.cachedTables.set(baseId, tables);
    return tables;
  }

  /**
   * Fetches fields for a specific table.
   */
  async fetchFields(apiKey: string, baseId: string, tableId: string): Promise<AirtableField[]> {
    this.clearCacheIfApiKeyChanged(apiKey);

    const cacheKey = this.getCacheKey(baseId, tableId);
    if (this.cachedFields.has(cacheKey)) {
      return this.cachedFields.get(cacheKey)!;
    }

    const response = await requestUrl({
      url: `${AIRTABLE_META_API_URL}/bases/${baseId}/tables`,
      method: "GET",
      headers: { "Authorization": `Bearer ${apiKey}` },
    });

    if (response.status !== 200) {
      throw new Error(`Failed to fetch table fields: HTTP ${response.status}`);
    }

    const json = response.json;
    const table = json.tables.find((t: { id: string }) => t.id === tableId);

    if (!table) {
      throw new Error(`Table with ID ${tableId} not found`);
    }

    const fields: AirtableField[] = table.fields.map((f: {
      id: string;
      name: string;
      type: string;
      description?: string;
    }) => ({
      id: f.id,
      name: f.name,
      type: f.type,
      description: f.description
    }));

    this.cachedFields.set(cacheKey, fields);
    return fields;
  }

  /**
   * Gets cached fields for a specific base/table combination.
   */
  getFields(cacheKey: string): AirtableField[] | undefined {
    return this.cachedFields.get(cacheKey);
  }

  /**
   * Gets a specific field by name from the cache.
   */
  getField(cacheKey: string, fieldName: string): AirtableField | undefined {
    const fields = this.cachedFields.get(cacheKey);
    return fields?.find(f => f.name === fieldName);
  }

  /**
   * Invalidates all cached data.
   */
  invalidate(): void {
    this.cachedBases = null;
    this.cachedTables.clear();
    this.cachedFields.clear();
    this.lastApiKey = "";
  }
}
