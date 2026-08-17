/**
 * Per-credential per-data-source schema cache for Notion.
 *
 * The settings tab needs data-source / schema metadata before any
 * ConfigInstance exists for that credential, so this cache is a
 * SharedServices-owned singleton (parallel to SupabaseMetadataCache /
 * SeaTableMetadataCache).
 *
 * @handbook 4.4-provider-abstraction
 * @handbook 9.6-api-patterns
 * @tested tests/services/notion-schema-cache.test.ts
 * @tested e2e:tests/e2e/run-notion-e2e.mjs
 * @tested e2e:tests/e2e/run-notion-settings-e2e.mjs
 */

import { requestUrl } from 'obsidian';
import { NOTION_API_BASE_URL, NOTION_SCHEMA_TTL_MS, NOTION_VERSION } from '../constants';
import type { NotionCredential, NotionDataSourceSummary, NotionPropertySchemaMap } from '../types';
import { extractApiErrorDetails } from '../utils';
import { defaultRateLimiters, getOrCreateRateLimiter } from './rate-limiter';

/** Minimal shape NotionSchemaCache needs from a RateLimiter — lets tests inject a stub. */
export interface RequestPacer {
  execute<T>(fn: () => Promise<T>): Promise<T>;
}

interface SchemaCacheEntry {
  schema: NotionPropertySchemaMap;
  fetchedAt: number;
}

interface DataSourceListCacheEntry {
  dataSources: NotionDataSourceSummary[];
  fetchedAt: number;
}

function buildKey(credentialId: string, dataSourceId: string): string {
  return `${credentialId}:${dataSourceId}`;
}

function buildHeaders(credential: NotionCredential): Record<string, string> {
  return {
    'Authorization': `Bearer ${credential.integrationToken}`,
    'Notion-Version': NOTION_VERSION,
    'Content-Type': 'application/json',
  };
}

interface NotionSearchResultItem {
  id: string;
  parent?: { database_id?: string };
  title?: { plain_text?: string }[];
  in_trash?: boolean;
}

/**
 * Resolves the RateLimiter to pace a request for the given credential.
 * Defaults to `defaultRateLimiters` — the same module-level map used by
 * notion-credential-form.ts's module-singleton cache — so settings-tab /
 * credential-form traffic and sync traffic share pacing per credential
 * even when they're different NotionSchemaCache instances (PR #125
 * Codex P2 / Claude Medium).
 */
type GetLimiter = (credential: NotionCredential) => RequestPacer;

const defaultGetLimiter: GetLimiter = credential =>
  getOrCreateRateLimiter(defaultRateLimiters, credential, false);

export class NotionSchemaCache {
  private schemas = new Map<string, SchemaCacheEntry>();
  private dataSourceLists = new Map<string, DataSourceListCacheEntry>();

  constructor(private getLimiter: GetLimiter = defaultGetLimiter) {}

  /**
   * Lists every data source visible to the integration, paginating via
   * has_more/next_cursor. Trashed entries are skipped. Cached per
   * credential for NOTION_SCHEMA_TTL_MS — settings-tab re-renders would
   * otherwise re-run the full paginated /search sweep on every render.
   * Only successful fetches are cached.
   */
  async listDataSources(credential: NotionCredential): Promise<NotionDataSourceSummary[]> {
    const now = Date.now();
    const cached = this.dataSourceLists.get(credential.id);
    if (cached && now - cached.fetchedAt < NOTION_SCHEMA_TTL_MS) {
      return cached.dataSources;
    }

    const out: NotionDataSourceSummary[] = [];
    let cursor: string | undefined;

    do {
      const body: Record<string, unknown> = {
        filter: { property: 'object', value: 'data_source' },
        page_size: 100,
      };
      if (cursor) body.start_cursor = cursor;

      const response = await this.getLimiter(credential).execute(() =>
        requestUrl({
          url: `${NOTION_API_BASE_URL}/search`,
          method: 'POST',
          headers: buildHeaders(credential),
          body: JSON.stringify(body),
          throw: false,
        }),
      );

      if (response.status < 200 || response.status >= 300) {
        throw new Error(`Failed to list Notion data sources: ${extractApiErrorDetails(response)}`);
      }

      const json = response.json as { results: NotionSearchResultItem[]; has_more: boolean; next_cursor: string | null };
      for (const item of json.results) {
        if (item.in_trash) continue;
        const title = (item.title ?? []).map(t => t.plain_text ?? '').join('') || 'Untitled';
        out.push({
          id: item.id,
          databaseId: item.parent?.database_id ?? '',
          title,
        });
      }

      cursor = json.has_more && json.next_cursor ? json.next_cursor : undefined;
    } while (cursor);

    this.dataSourceLists.set(credential.id, { dataSources: out, fetchedAt: now });
    return out;
  }

  /**
   * Returns a property-name → Notion-type map for the given data source,
   * cached per (credential, dataSourceId) for NOTION_SCHEMA_TTL_MS. Only
   * successful fetches are cached.
   */
  async getSchema(credential: NotionCredential, dataSourceId: string): Promise<NotionPropertySchemaMap> {
    const key = buildKey(credential.id, dataSourceId);
    const now = Date.now();
    const cached = this.schemas.get(key);
    if (cached && now - cached.fetchedAt < NOTION_SCHEMA_TTL_MS) {
      return cached.schema;
    }

    const response = await this.getLimiter(credential).execute(() =>
      requestUrl({
        url: `${NOTION_API_BASE_URL}/data_sources/${dataSourceId}`,
        method: 'GET',
        headers: buildHeaders(credential),
        throw: false,
      }),
    );

    if (response.status < 200 || response.status >= 300) {
      throw new Error(`Failed to fetch Notion data source schema: ${extractApiErrorDetails(response)}`);
    }

    const json = response.json as { properties?: Record<string, { type: string }> };
    const schema: NotionPropertySchemaMap = new Map();
    for (const [name, prop] of Object.entries(json.properties ?? {})) {
      schema.set(name, prop.type);
    }

    this.schemas.set(key, { schema, fetchedAt: now });
    return schema;
  }

  clearForCred(credentialId: string): void {
    for (const key of [...this.schemas.keys()]) {
      if (key.startsWith(`${credentialId}:`)) {
        this.schemas.delete(key);
      }
    }
    this.dataSourceLists.delete(credentialId);
  }

  clear(): void {
    this.schemas.clear();
    this.dataSourceLists.clear();
  }
}
