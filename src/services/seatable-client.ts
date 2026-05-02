/**
 * SeaTable API client service.
 *
 * Speaks the SeaTable dtable-server REST API. SeaTable's API-Token is
 * base-specific and is exchanged for a short-lived Base-Token (TTL 3d)
 * via /api/v2.1/dtable/app-access-token/. The Base-Token response also
 * carries the `dtable_uuid` and `dtable_server` URL needed for every
 * subsequent row request, so callers never configure those manually.
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

const MAX_PAGINATION_ITERATIONS = 1000;

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
    const url = (this.credential.serverUrl || SEATABLE_DEFAULT_SERVER_URL).trim();
    return url.replace(/\/+$/, '');
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

    const dtableServer = (json.dtable_server || `${this.getServerUrl()}/dtable-server/`)
      .replace(/\/+$/, '');

    this.cachedToken = {
      accessToken: json.access_token,
      dtableUuid: json.dtable_uuid,
      dtableServer,
      expiresAt: Date.now() + SEATABLE_BASE_TOKEN_TTL_MS,
    };
    return this.cachedToken;
  }

  private buildDtableUrl(token: CachedBaseToken, path: string): string {
    return `${token.dtableServer}/api/v1/dtables/${token.dtableUuid}/${path}`;
  }

  private buildHeaders(token: CachedBaseToken): Record<string, string> {
    return {
      'Authorization': `Token ${token.accessToken}`,
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
    let details = `HTTP ${response.status}`;
    try {
      const body = response.json as
        | { error_msg?: string; error?: string | { message?: string } }
        | undefined;
      const message =
        body?.error_msg ||
        (typeof body?.error === 'string'
          ? body.error
          : body?.error && typeof body.error === 'object'
            ? body.error.message
            : undefined);
      if (message) {
        details += `: ${message}`;
      } else if (response.text) {
        details += `: ${response.text}`;
      }
    } catch {
      // Response body isn't JSON-parsable
    }
    return details;
  }

  // ─── DatabaseProvider implementation ───────────────────────────────

  async fetchNotes(): Promise<RemoteNote[]> {
    this.validateConfig();

    const token = await this.getBaseToken();
    const headers = this.buildHeaders(token);
    const allNotes: RemoteNote[] = [];

    let start = 0;
    for (let iter = 0; iter < MAX_PAGINATION_ITERATIONS; iter++) {
      const params = new URLSearchParams();
      params.set('table_id', this.config.tableId);
      if (this.config.viewId) params.set('view_id', this.config.viewId);
      params.set('start', String(start));
      params.set('limit', String(SEATABLE_PAGE_SIZE));

      const url = this.buildDtableUrl(token, `rows/?${params.toString()}`);
      const response = await this.rateLimiter.execute(() =>
        requestUrl({ url, method: 'GET', headers }),
      );

      if (response.status !== 200) {
        throw new Error(`Failed to fetch SeaTable rows: ${this.extractErrorDetails(response)}`);
      }

      const json = response.json as { rows?: SeaTableRow[] } | undefined;
      const rows = json?.rows ?? [];

      for (const row of rows) {
        if (!row._id) continue;
        const { _id, ...fields } = row;
        allNotes.push({ id: _id, primaryField: _id, fields });
      }

      if (rows.length < SEATABLE_PAGE_SIZE) {
        return allNotes;
      }
      start += rows.length;
    }

    throw new Error(
      `SeaTable pagination exceeded ${MAX_PAGINATION_ITERATIONS} iterations; aborting to avoid infinite loop.`,
    );
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

    const url = this.buildDtableUrl(token, `rows/${encodeURIComponent(recordId)}/?${params.toString()}`);
    const response = await this.rateLimiter.execute(() =>
      requestUrl({ url, method: 'GET', headers }),
    );

    if (response.status === 404) return null;

    if (response.status !== 200) {
      throw new Error(`Failed to fetch SeaTable row ${recordId}: ${this.extractErrorDetails(response)}`);
    }

    const json = response.json as SeaTableRow | undefined;
    if (!json || !json._id) return null;
    const { _id, ...fields } = json;
    return { id: _id, primaryField: _id, fields };
  }

  async updateRecord(recordId: string, fields: Record<string, unknown>): Promise<SyncResult> {
    this.validateConfig();
    if (!recordId) {
      return { success: false, recordId, error: 'SeaTable row ID cannot be empty.' };
    }

    try {
      const token = await this.getBaseToken();
      const headers = this.buildHeaders(token);
      const url = this.buildDtableUrl(token, 'rows/');
      const body = JSON.stringify({
        table_id: this.config.tableId,
        row_id: recordId,
        row: fields,
      });
      const response = await this.rateLimiter.execute(() =>
        requestUrl({ url, method: 'PUT', headers, body }),
      );

      if (response.status !== 200) {
        return {
          success: false,
          recordId,
          error: `Failed to update SeaTable row: ${this.extractErrorDetails(response)}`,
        };
      }
      return { success: true, recordId, updatedFields: fields };
    } catch (error) {
      return {
        success: false,
        recordId,
        error: error instanceof Error ? error.message : 'Unknown error occurred',
      };
    }
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
      const url = this.buildDtableUrl(token, 'batch-update-rows/');
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

      // SeaTable batch-update-rows returns `{ success: true }` without
      // echoing the updated fields, so we mirror back the requested fields
      // as confirmed updates — matching the SyncResult contract.
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
