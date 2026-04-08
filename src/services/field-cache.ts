/**
 * Field caching service for Airtable metadata.
 *
 * @handbook 9.7-field-cache
 * @tested tests/services/field-cache.test.ts
 */

import { requestUrl } from "obsidian";
import { AIRTABLE_META_API_URL } from '../constants';
import type { AirtableField, AirtableBase, AirtableTable, AirtableView } from '../types';

/**
 * Caches Airtable metadata (bases, tables, fields) to minimize API calls.
 */
export class FieldCache {
  private cachedBases: AirtableBase[] | null = null;
  private cachedTables: Map<string, AirtableTable[]> = new Map();
  private cachedFields: Map<string, AirtableField[]> = new Map();
  private cachedViews: Map<string, AirtableView[]> = new Map();

  /**
   * Clears cached bases (and dependent tables/fields).
   */
  clearBases(): void {
    this.cachedBases = null;
    this.cachedTables.clear();
    this.cachedFields.clear();
    this.cachedViews.clear();
  }

  /**
   * Clears cached tables for a specific base (and dependent fields).
   */
  clearTables(baseId: string): void {
    this.cachedTables.delete(baseId);
    const prefix = `${baseId}-`;
    for (const key of this.cachedFields.keys()) {
      if (key.startsWith(prefix)) this.cachedFields.delete(key);
    }
    for (const key of this.cachedViews.keys()) {
      if (key.startsWith(prefix)) this.cachedViews.delete(key);
    }
  }

  /**
   * Clears cached fields for a specific base/table combination.
   */
  clearFields(baseId: string, tableId: string): void {
    this.cachedFields.delete(this.getCacheKey(baseId, tableId));
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
    const cachedTables = this.cachedTables.get(baseId);
    if (cachedTables) return cachedTables;

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
   * Fetches and caches both fields and views for a table in a single API call.
   */
  private async fetchTableMetadata(apiKey: string, baseId: string, tableId: string): Promise<void> {
    const response = await requestUrl({
      url: `${AIRTABLE_META_API_URL}/bases/${baseId}/tables`,
      method: "GET",
      headers: { "Authorization": `Bearer ${apiKey}` },
    });

    if (response.status !== 200) {
      throw new Error(`Failed to fetch table metadata: HTTP ${response.status}`);
    }

    const json = response.json;
    const table = json.tables.find((t: { id: string }) => t.id === tableId);

    if (!table) {
      throw new Error(`Table with ID ${tableId} not found`);
    }

    const cacheKey = this.getCacheKey(baseId, tableId);

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

    const views: AirtableView[] = (table.views || []).map((v: {
      id: string;
      name: string;
      type: string;
    }) => ({
      id: v.id,
      name: v.name,
      type: v.type
    }));
    this.cachedViews.set(cacheKey, views);
  }

  /**
   * Fetches fields for a specific table.
   */
  async fetchFields(apiKey: string, baseId: string, tableId: string): Promise<AirtableField[]> {
    const cacheKey = this.getCacheKey(baseId, tableId);
    const cached = this.cachedFields.get(cacheKey);
    if (cached) return cached;

    await this.fetchTableMetadata(apiKey, baseId, tableId);
    return this.cachedFields.get(cacheKey)!;
  }

  /**
   * Fetches views for a specific table.
   */
  async fetchViews(apiKey: string, baseId: string, tableId: string): Promise<AirtableView[]> {
    const cacheKey = this.getCacheKey(baseId, tableId);
    const cached = this.cachedViews.get(cacheKey);
    if (cached) return cached;

    await this.fetchTableMetadata(apiKey, baseId, tableId);
    return this.cachedViews.get(cacheKey)!;
  }

  /**
   * Clears cached views for a specific base/table combination.
   */
  clearViews(baseId: string, tableId: string): void {
    this.cachedViews.delete(this.getCacheKey(baseId, tableId));
  }

  /**
   * Gets cached tables for a specific base.
   */
  getTablesForBase(baseId: string): AirtableTable[] | undefined {
    return this.cachedTables.get(baseId);
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

}
