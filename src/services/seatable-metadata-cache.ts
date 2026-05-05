/**
 * SeaTable metadata cache used by the settings UI.
 *
 * Mirrors the role `FieldCache` plays for Airtable: keep tables / columns
 * / views handy for dropdown rendering without re-hitting the API every
 * time the settings tab re-renders. SeaTable adds one wrinkle — the
 * Base-Token exchange is also cached, since metadata calls need it and
 * doing it lazily inside `fetchMetadata` keeps callers from juggling two
 * round trips. Both caches are keyed by `credential.id` so swapping
 * credentials evicts cleanly.
 *
 * Direct `fetch()` calls (instead of plumbing through `SeaTableClient`)
 * are intentional: settings-tab needs metadata before any
 * `ConfigInstance` exists for that credential, and Obsidian's
 * `requestUrl` and the browser `fetch` produce equivalent results for
 * SeaTable's CORS-enabled endpoints. The token refresh margin matches
 * `SeaTableClient` so the two never diverge by more than a few seconds.
 *
 * @handbook 9.7-field-cache
 * @tested tests/services/seatable-metadata-cache.test.ts
 */

import {
  SEATABLE_BASE_TOKEN_REFRESH_MARGIN_MS,
  SEATABLE_BASE_TOKEN_TTL_MS,
  SEATABLE_DEFAULT_SERVER_URL,
} from '../constants';
import type { SeaTableCredential } from '../types';
import { extractApiErrorDetails, normalizeServerUrl } from '../utils';

interface BaseTokenResponse {
  access_token: string;
  dtable_uuid: string;
  dtable_server?: string;
}

interface CachedToken extends BaseTokenResponse {
  /** UNIX ms when this cached entry should be refreshed. */
  refreshAt: number;
  /** Resolved API gateway base for `/api/v2/dtables/<uuid>/...` calls. */
  gatewayBase: string;
}

export interface SeaTableColumn {
  name: string;
  type: string;
}

export interface SeaTableView {
  id: string;
  name: string;
}

export interface SeaTableTable {
  id: string;
  name: string;
  columns: SeaTableColumn[];
  views: SeaTableView[];
}

interface RawMetadataTable {
  _id: string;
  name: string;
  columns?: Array<{ name?: string; type?: string }>;
  views?: Array<{ _id?: string; name?: string }>;
}

export class SeaTableMetadataCache {
  private cachedTokens: Map<string, CachedToken> = new Map();
  private cachedTables: Map<string, SeaTableTable[]> = new Map();
  /**
   * Promises currently fetching tables for a credential. Lets concurrent
   * `fetchTables` callers (e.g. two rapid `display()` re-renders before
   * the first network round-trip finishes) share a single in-flight
   * request instead of racing duplicate token + metadata exchanges.
   */
  private inFlightTables: Map<string, Promise<SeaTableTable[]>> = new Map();

  /**
   * Drop everything cached for a given credential — used by the settings
   * tab's Refresh button, and on credential edit/delete.
   */
  clearForCred(credentialId: string): void {
    this.cachedTokens.delete(credentialId);
    this.cachedTables.delete(credentialId);
    this.inFlightTables.delete(credentialId);
  }

  /** Wipe all cached metadata + tokens. */
  clear(): void {
    this.cachedTokens.clear();
    this.cachedTables.clear();
    this.inFlightTables.clear();
  }

  /**
   * Fetch and cache the table metadata (tables + columns + views) for a
   * SeaTable credential. Returns the same array shape on repeat calls
   * until {@link clearForCred} or {@link clear} is invoked. Concurrent
   * calls share a single in-flight request.
   */
  async fetchTables(credential: SeaTableCredential): Promise<SeaTableTable[]> {
    const cached = this.cachedTables.get(credential.id);
    if (cached) return cached;
    const existing = this.inFlightTables.get(credential.id);
    if (existing) return existing;

    const promise = this.fetchTablesUncached(credential);
    this.inFlightTables.set(credential.id, promise);
    try {
      return await promise;
    } finally {
      this.inFlightTables.delete(credential.id);
    }
  }

  private async fetchTablesUncached(credential: SeaTableCredential): Promise<SeaTableTable[]> {
    const token = await this.getBaseToken(credential);
    const url = this.buildDtableUrl(token, 'metadata/');
    const r = await fetch(url, {
      headers: { Authorization: `Bearer ${token.access_token}` },
    });
    if (!r.ok) {
      throw new Error(
        `Failed to fetch SeaTable metadata: ${extractApiErrorDetails({
          status: r.status,
          json: await r.json().catch(() => undefined),
        })}`,
      );
    }
    const json = (await r.json()) as { metadata?: { tables?: RawMetadataTable[] } };
    const rawTables = json.metadata?.tables ?? [];
    const tables: SeaTableTable[] = rawTables.map(t => ({
      id: t._id,
      name: t.name,
      columns: (t.columns ?? [])
        .filter(c => typeof c.name === 'string' && typeof c.type === 'string')
        .map(c => ({ name: c.name as string, type: c.type as string })),
      views: (t.views ?? [])
        .filter(v => typeof v._id === 'string' && typeof v.name === 'string')
        .map(v => ({ id: v._id as string, name: v.name as string })),
    }));
    this.cachedTables.set(credential.id, tables);
    return tables;
  }

  /**
   * Lookup helper for a single table from the cached metadata. Returns
   * `undefined` when {@link fetchTables} hasn't run yet or the table id
   * isn't on the base.
   */
  getTable(credentialId: string, tableId: string): SeaTableTable | undefined {
    return this.cachedTables.get(credentialId)?.find(t => t.id === tableId);
  }

  /**
   * Exchange the API-Token for a short-lived Base-Token. Mirrors the
   * caching policy in `SeaTableClient.getBaseToken` — refresh ~5 min
   * before the 3-day TTL so clock skew can't trip us up.
   */
  private async getBaseToken(credential: SeaTableCredential): Promise<CachedToken> {
    const cached = this.cachedTokens.get(credential.id);
    if (cached && Date.now() < cached.refreshAt) return cached;

    const serverUrl = normalizeServerUrl(credential.serverUrl, SEATABLE_DEFAULT_SERVER_URL);
    const url = `${serverUrl}/api/v2.1/dtable/app-access-token/`;
    const r = await fetch(url, {
      headers: { Authorization: `Token ${credential.apiToken}` },
    });
    if (!r.ok) {
      throw new Error(
        `Failed to obtain SeaTable Base-Token: ${extractApiErrorDetails({
          status: r.status,
          json: await r.json().catch(() => undefined),
        })}`,
      );
    }
    const body = (await r.json()) as BaseTokenResponse;
    if (!body.access_token || !body.dtable_uuid) {
      throw new Error('SeaTable Base-Token response missing access_token or dtable_uuid');
    }
    const gatewayBase = normalizeServerUrl(body.dtable_server, serverUrl);
    const token: CachedToken = {
      ...body,
      gatewayBase,
      refreshAt: Date.now() + SEATABLE_BASE_TOKEN_TTL_MS - SEATABLE_BASE_TOKEN_REFRESH_MARGIN_MS,
    };
    this.cachedTokens.set(credential.id, token);
    return token;
  }

  private buildDtableUrl(token: CachedToken, path: string): string {
    return `${token.gatewayBase}/api/v2/dtables/${token.dtable_uuid}/${path}`;
  }
}
