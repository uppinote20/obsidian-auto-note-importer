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
 * Uses Obsidian's `requestUrl` (matching `SeaTableClient`) rather than
 * native `fetch` — keeps a single network surface for plugin guideline
 * compliance and avoids CORS issues on Obsidian Mobile where browser
 * fetch is more restrictive. Settings-tab still calls this directly
 * (without going through `ConfigInstance`) because metadata is needed
 * before any sync config is wired up. The token refresh margin matches
 * `SeaTableClient` so the two never diverge by more than a few seconds.
 *
 * Defensive patterns mirror `SupabaseMetadataCache`:
 *  - `request()` wraps requestUrl with a try/catch fallback for older
 *    Obsidian builds that ignore `throw: false` and reject on 4xx/5xx.
 *  - `parseJson()` swallows SyntaxError from the lazy `r.json` getter
 *    so a non-JSON body (proxy maintenance page, HTML 502) surfaces
 *    as a friendly `HTTP {status}` message, not a raw parse error.
 *
 * @handbook 9.7-field-cache
 * @tested tests/services/seatable-metadata-cache.test.ts
 */

import { requestUrl, type RequestUrlParam, type RequestUrlResponse } from 'obsidian';

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
      // Identity-checked delete: if `clearForCred` (or a later concurrent
      // call) replaced our entry mid-flight, leave the new entry alone so
      // it can dedupe its own callers.
      if (this.inFlightTables.get(credential.id) === promise) {
        this.inFlightTables.delete(credential.id);
      }
    }
  }

  private async fetchTablesUncached(credential: SeaTableCredential): Promise<SeaTableTable[]> {
    const token = await this.getBaseToken(credential);
    const url = this.buildDtableUrl(token, 'metadata/');
    const r = await this.request({
      url,
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${token.access_token}`,
        'Accept': 'application/json',
      },
    });
    if (r.status < 200 || r.status >= 300) {
      throw new Error(`Failed to fetch SeaTable metadata: ${extractApiErrorDetails(r)}`);
    }
    const json = this.parseJson(r) as { metadata?: { tables?: RawMetadataTable[] } } | null;
    const rawTables = json?.metadata?.tables ?? [];
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
    const r = await this.request({
      url,
      method: 'GET',
      headers: {
        'Authorization': `Token ${credential.apiToken}`,
        'Accept': 'application/json',
      },
    });
    if (r.status < 200 || r.status >= 300) {
      throw new Error(`Failed to obtain SeaTable Base-Token: ${extractApiErrorDetails(r)}`);
    }
    const body = this.parseJson(r) as BaseTokenResponse | null;
    if (!body?.access_token || !body?.dtable_uuid) {
      throw new Error('SeaTable Base-Token response missing access_token or dtable_uuid');
    }
    // Fallback matches SeaTableClient.getBaseToken (line 164) so settings-tab
    // and sync paths agree on the gateway base when SeaTable omits
    // `dtable_server` (older self-hosted, custom proxies).
    const gatewayBase = normalizeServerUrl(body.dtable_server, `${serverUrl}/api-gateway/`);
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

  /**
   * Wraps `requestUrl({...opts, throw: false})` with a fallback for older
   * Obsidian builds that ignore `throw: false` and reject on 4xx/5xx —
   * recovers the response shape so `r.status` branches stay live.
   * Mirrors `SupabaseMetadataCache` and `SupabaseClient`.
   */
  private async request(opts: RequestUrlParam): Promise<RequestUrlResponse> {
    try {
      return await requestUrl({ ...opts, throw: false });
    } catch (e) {
      const err = e as { status?: number; headers?: Record<string, string>; json?: unknown; text?: string };
      if (typeof err.status !== 'number') throw e;
      return {
        status: err.status,
        headers: err.headers ?? {},
        json: err.json,
        text: err.text ?? '',
        arrayBuffer: new ArrayBuffer(0),
      } as RequestUrlResponse;
    }
  }

  /**
   * Safe access to the lazy `r.json` getter. Obsidian's requestUrl parses
   * JSON on demand and throws `SyntaxError` if the body is non-JSON
   * (proxy HTML interstitials, captive portals). Returns `null` on parse
   * failure so callers can fall back to `??` defaulting.
   */
  private parseJson(r: RequestUrlResponse): unknown {
    try {
      return r.json;
    } catch {
      return null;
    }
  }
}
