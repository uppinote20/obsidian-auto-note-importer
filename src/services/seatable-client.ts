/**
 * SeaTable API client. Exchanges the base-specific API-Token for a
 * short-lived Base-Token (3d TTL) via /api/v2.1/dtable/app-access-token/,
 * then talks to the API Gateway v2 endpoints returned in `dtable_server`.
 *
 * Subtleties worth knowing:
 * - PUT /rows/ accepts only the batch `{table_id, updates: [...]}` shape.
 *   The single-row `{table_id, row_id, row}` form returns success but is
 *   a silent no-op, so updateRecord delegates to batchUpdate.
 * - Bodies must reference columns by name; column-key form is silently
 *   ignored. `?convert_keys=true` makes responses match.
 *
 * @handbook 4.4-provider-abstraction
 * @handbook 6.1-error-handling
 * @handbook 9.6-api-patterns
 * @tested tests/services/seatable-client.test.ts
 */

import { requestUrl } from "obsidian";
import {
  SEATABLE_BATCH_SIZE,
  SEATABLE_BASE_TOKEN_REFRESH_MARGIN_MS,
  SEATABLE_BASE_TOKEN_TTL_MS,
  SEATABLE_DEFAULT_SERVER_URL,
  SEATABLE_PAGE_SIZE,
} from '../constants';
import type {
  BatchUpdate,
  ConfigEntry,
  Credential,
  CredentialType,
  DatabaseProvider,
  FieldTypeMapper,
  ProviderCapabilities,
  RemoteNote,
  SeaTableCredential,
  SyncResult,
} from '../types';
import { extractApiErrorDetails, normalizeServerUrl } from '../utils';
import { seatableFieldMapper } from './seatable-field-mapper';
import { RateLimiter } from './rate-limiter';

const SEATABLE_CAPABILITIES: ProviderCapabilities = {
  bidirectional: true,
  hasComputedFields: true,
  batchUpdateMaxSize: SEATABLE_BATCH_SIZE,
};

interface BaseTokenResponse {
  access_token?: string;
  dtable_uuid?: string;
  dtable_server?: string;
}

interface CachedBaseToken {
  accessToken: string;
  dtableUuid: string;
  dtableServer: string;
  expiresAt: number;
}

interface SeaTableRow {
  _id?: string;
  [key: string]: unknown;
}

// Hard cap on rows fetched per call. SeaTable returns at most 1000 per
// page, so this caps a single fetchNotes at 1M rows — a defensive limit,
// not an expected one.
const MAX_FETCH_ROWS = 1_000_000;

function stripSystemFields(row: SeaTableRow): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (!key.startsWith('_')) fields[key] = value;
  }
  return fields;
}

export class SeaTableClient implements DatabaseProvider {
  readonly providerType: CredentialType = 'seatable';
  readonly capabilities: ProviderCapabilities = SEATABLE_CAPABILITIES;
  readonly fieldTypeMapper: FieldTypeMapper = seatableFieldMapper;

  private credential: SeaTableCredential;
  private config: ConfigEntry;
  private rateLimiter: RateLimiter;
  private cachedToken: CachedBaseToken | null = null;

  constructor(
    credential: SeaTableCredential,
    config: ConfigEntry,
    rateLimiter: RateLimiter,
  ) {
    this.credential = credential;
    this.config = config;
    this.rateLimiter = rateLimiter;
  }

  reconfigure(
    credential: Credential,
    config: ConfigEntry,
    rateLimiter: RateLimiter,
    _debugMode: boolean,
  ): void {
    if (credential.type !== 'seatable') {
      throw new Error(`SeaTableClient cannot be reconfigured with a ${credential.type} credential`);
    }
    if (
      credential.apiToken !== this.credential.apiToken ||
      credential.serverUrl !== this.credential.serverUrl
    ) {
      this.cachedToken = null;
    }
    this.credential = credential;
    this.config = config;
    this.rateLimiter = rateLimiter;
  }

  // ─── Token management ───────────────────────────────────────────────

  private getServerUrl(): string {
    return normalizeServerUrl(this.credential.serverUrl, SEATABLE_DEFAULT_SERVER_URL);
  }

  private async getBaseToken(): Promise<CachedBaseToken> {
    const now = Date.now();
    if (
      this.cachedToken &&
      this.cachedToken.expiresAt - SEATABLE_BASE_TOKEN_REFRESH_MARGIN_MS > now
    ) {
      return this.cachedToken;
    }

    const apiToken = this.credential.apiToken?.trim();
    if (!apiToken) {
      throw new Error('SeaTable API token must be set.');
    }

    const url = `${this.getServerUrl()}/api/v2.1/dtable/app-access-token/`;
    const response = await this.rateLimiter.execute(() =>
      requestUrl({
        url,
        method: 'GET',
        headers: {
          'Authorization': `Token ${apiToken}`,
          'Accept': 'application/json',
        },
      }),
    );

    if (response.status !== 200) {
      throw new Error(
        `Failed to obtain SeaTable Base-Token: ${this.extractErrorDetails(response)}`,
      );
    }

    const json = response.json as BaseTokenResponse;
    if (!json?.access_token || !json?.dtable_uuid) {
      throw new Error('SeaTable Base-Token response missing access_token or dtable_uuid.');
    }

    const dtableServer = normalizeServerUrl(json.dtable_server, `${this.getServerUrl()}/api-gateway/`);

    this.cachedToken = {
      accessToken: json.access_token,
      dtableUuid: json.dtable_uuid,
      dtableServer,
      expiresAt: Date.now() + SEATABLE_BASE_TOKEN_TTL_MS,
    };
    return this.cachedToken;
  }

  private buildDtableUrl(token: CachedBaseToken, path: string): string {
    return `${token.dtableServer}/api/v2/dtables/${token.dtableUuid}/${path}`;
  }

  private buildHeaders(token: CachedBaseToken): Record<string, string> {
    return {
      'Authorization': `Bearer ${token.accessToken}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    };
  }

  // ─── Validation & error helpers ────────────────────────────────────

  private validateConfig(): void {
    if (!this.credential.apiToken?.trim()) {
      throw new Error('SeaTable API token must be set.');
    }
    if (!this.config.tableId?.trim()) {
      throw new Error('SeaTable table ID must be set.');
    }
  }

  private extractErrorDetails(response: { status: number; json?: unknown; text?: string }): string {
    return extractApiErrorDetails(response);
  }

  // ─── DatabaseProvider implementation ───────────────────────────────

  async fetchNotes(): Promise<RemoteNote[]> {
    this.validateConfig();

    const token = await this.getBaseToken();
    const headers = this.buildHeaders(token);
    const allNotes: RemoteNote[] = [];

    let start = 0;
    while (allNotes.length < MAX_FETCH_ROWS) {
      const params = new URLSearchParams();
      params.set('table_id', this.config.tableId);
      if (this.config.viewId) params.set('view_id', this.config.viewId);
      params.set('start', String(start));
      params.set('limit', String(SEATABLE_PAGE_SIZE));
      // convert_keys=true makes responses use column names instead of column
      // keys (e.g. "Name" vs "0000"), matching the request body shape.
      params.set('convert_keys', 'true');

      const url = this.buildDtableUrl(token, `rows/?${params.toString()}`);
      const response = await this.rateLimiter.execute(() =>
        requestUrl({ url, method: 'GET', headers }),
      );

      if (response.status !== 200) {
        throw new Error(`Failed to fetch SeaTable rows: ${this.extractErrorDetails(response)}`);
      }

      const rows = (response.json as { rows?: SeaTableRow[] } | undefined)?.rows ?? [];
      for (const row of rows) {
        if (!row._id) continue;
        allNotes.push({ id: row._id, primaryField: row._id, fields: stripSystemFields(row) });
      }
      if (rows.length < SEATABLE_PAGE_SIZE) return allNotes;
      start += rows.length;
    }

    throw new Error(`SeaTable fetchNotes hit MAX_FETCH_ROWS=${MAX_FETCH_ROWS} guard.`);
  }

  async fetchRecord(recordId: string): Promise<RemoteNote | null> {
    this.validateConfig();
    if (!recordId) {
      throw new Error('SeaTable row ID cannot be empty.');
    }

    const token = await this.getBaseToken();
    const headers = this.buildHeaders(token);

    const params = new URLSearchParams();
    params.set('table_id', this.config.tableId);
    params.set('convert_keys', 'true');

    const url = this.buildDtableUrl(token, `rows/${encodeURIComponent(recordId)}/?${params.toString()}`);
    const response = await this.rateLimiter.execute(() =>
      requestUrl({ url, method: 'GET', headers }),
    );

    if (response.status === 404) return null;

    if (response.status !== 200) {
      throw new Error(`Failed to fetch SeaTable row ${recordId}: ${this.extractErrorDetails(response)}`);
    }

    const json = response.json as SeaTableRow | undefined;
    if (!json?._id) return null;
    return { id: json._id, primaryField: json._id, fields: stripSystemFields(json) };
  }

  async updateRecord(recordId: string, fields: Record<string, unknown>): Promise<SyncResult> {
    this.validateConfig();
    if (!recordId) {
      return { success: false, recordId, error: 'SeaTable row ID cannot be empty.' };
    }

    // SeaTable's API Gateway treats `{table_id, row_id, row}` as a silent
    // no-op (returns 200 + `{success:true}` but doesn't apply changes), so
    // we always use the batch shape `{table_id, updates: [...]}` even for
    // a single record. delegating to batchUpdate keeps the path & body
    // schema canonical in one place.
    const [result] = await this.batchUpdate([{ recordId, fields }]);
    return result;
  }

  async batchUpdate(updates: BatchUpdate[]): Promise<SyncResult[]> {
    this.validateConfig();

    if (updates.length === 0) return [];

    if (updates.length > SEATABLE_BATCH_SIZE) {
      throw new Error(`Maximum ${SEATABLE_BATCH_SIZE} records allowed per batch update`);
    }

    try {
      const token = await this.getBaseToken();
      const headers = this.buildHeaders(token);
      const url = this.buildDtableUrl(token, 'rows/');
      const body = JSON.stringify({
        table_id: this.config.tableId,
        updates: updates.map(u => ({ row_id: u.recordId, row: u.fields })),
      });
      const response = await this.rateLimiter.execute(() =>
        requestUrl({ url, method: 'PUT', headers, body }),
      );

      if (response.status !== 200) {
        const errorDetails = this.extractErrorDetails(response);
        return updates.map(u => ({
          success: false as const,
          recordId: u.recordId,
          error: `Failed to batch update SeaTable rows: ${errorDetails}`,
        }));
      }

      // SeaTable's PUT /rows/ returns `{success: true}` without echoing
      // the updated fields, so we mirror back the requested fields as
      // confirmed updates — matching the SyncResult contract.
      return updates.map(u => ({
        success: true as const,
        recordId: u.recordId,
        updatedFields: u.fields,
      }));
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error occurred';
      return updates.map(u => ({ success: false as const, recordId: u.recordId, error: message }));
    }
  }
}
