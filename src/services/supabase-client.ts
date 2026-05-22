/**
 * Supabase / PostgREST DatabaseProvider implementation.
 *
 * Talks directly to /rest/v1/ endpoints via Obsidian requestUrl (no SDK).
 * Reads OpenAPI metadata through SupabaseMetadataCache shared with the
 * settings tab. Uses PostgREST upsert (Prefer resolution=merge-duplicates)
 * for row-with-different-fields batch updates.
 *
 * @handbook 4.4-provider-abstraction
 * @handbook 6.1-error-handling
 * @handbook 9.6-api-patterns
 * @tested tests/services/supabase-client.test.ts
 * @tested e2e:tests/e2e/run-supabase-e2e.mjs
 */

import { requestUrl } from 'obsidian';
import {
  SUPABASE_DEFAULT_BATCH_SIZE,
  SUPABASE_DEFAULT_SCHEMA,
  SUPABASE_PAGE_SIZE,
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
  SupabaseCredential,
  SyncResult,
} from '../types';
import { normalizeServerUrl, extractApiErrorDetails, buildBatchFailures, formatBatchLimitError } from '../utils';
import { supabaseFieldMapper } from './supabase-field-mapper';
import { SupabaseMetadataCache } from './supabase-metadata-cache';
import { RateLimiter } from './rate-limiter';

const SUPABASE_CAPABILITIES: ProviderCapabilities = {
  bidirectional: true,
  hasComputedFields: true,
  batchUpdateMaxSize: SUPABASE_DEFAULT_BATCH_SIZE,
};

const MAX_FETCH_ROWS = 1_000_000;

function parseContentRangeTotal(header: string | undefined): number | null {
  if (!header) return null;
  const match = header.match(/\/(\d+|\*)$/);
  if (!match || match[1] === '*') return null;
  const n = parseInt(match[1], 10);
  return Number.isFinite(n) ? n : null;
}

export class SupabaseClient implements DatabaseProvider {
  readonly providerType: CredentialType = 'supabase';
  readonly capabilities: ProviderCapabilities = SUPABASE_CAPABILITIES;
  readonly fieldTypeMapper: FieldTypeMapper = supabaseFieldMapper;

  private credential: SupabaseCredential;
  private config: ConfigEntry;
  private rateLimiter: RateLimiter;
  private metadataCache: SupabaseMetadataCache;

  constructor(
    credential: SupabaseCredential,
    config: ConfigEntry,
    rateLimiter: RateLimiter,
    metadataCache: SupabaseMetadataCache,
  ) {
    this.credential = credential;
    this.config = config;
    this.rateLimiter = rateLimiter;
    this.metadataCache = metadataCache;
  }

  reconfigure(
    credential: Credential,
    config: ConfigEntry,
    rateLimiter: RateLimiter,
    _debugMode: boolean,
  ): void {
    if (credential.type !== 'supabase') {
      throw new Error(`SupabaseClient cannot be reconfigured with a ${credential.type} credential`);
    }
    if (
      credential.projectUrl !== this.credential.projectUrl ||
      credential.apiKey !== this.credential.apiKey
    ) {
      this.metadataCache.clearForCred(credential.id);
    }
    this.credential = credential;
    this.config = config;
    this.rateLimiter = rateLimiter;
  }

  private validateConfig(): void {
    if (!this.credential.apiKey?.trim()) {
      throw new Error('Supabase API key must be set.');
    }
    if (!this.credential.projectUrl?.trim()) {
      throw new Error('Supabase project URL must be set.');
    }
    if (!this.config.tableId?.trim()) {
      throw new Error('Supabase table must be set.');
    }
    if (!this.config.primaryKeyColumn?.trim()) {
      throw new Error('Supabase primary key column must be set.');
    }
  }

  private getSchema(): string {
    return (this.config.baseId?.trim() || SUPABASE_DEFAULT_SCHEMA);
  }

  private getEndpoint(): string {
    return (this.config.viewId?.trim() || this.config.tableId);
  }

  private getProjectUrl(): string {
    return normalizeServerUrl(this.credential.projectUrl, '');
  }

  private buildHeaders(opts: { write?: boolean } = {}): Record<string, string> {
    const headers: Record<string, string> = {
      'apikey': this.credential.apiKey,
      'Authorization': `Bearer ${this.credential.apiKey}`,
    };
    const schema = this.getSchema();
    if (schema !== SUPABASE_DEFAULT_SCHEMA) {
      headers[opts.write ? 'Content-Profile' : 'Accept-Profile'] = schema;
    }
    return headers;
  }

  async fetchNotes(): Promise<RemoteNote[]> {
    this.validateConfig();
    const projectUrl = this.getProjectUrl();
    const endpoint = this.getEndpoint();
    const pk = this.config.primaryKeyColumn;
    const url = `${projectUrl}/rest/v1/${endpoint}`;

    const allNotes: RemoteNote[] = [];
    let start = 0;
    while (allNotes.length < MAX_FETCH_ROWS) {
      const end = start + SUPABASE_PAGE_SIZE - 1;
      const response = await this.rateLimiter.execute(() =>
        requestUrl({
          url,
          method: 'GET',
          headers: {
            ...this.buildHeaders(),
            'Range-Unit': 'items',
            'Range': `${start}-${end}`,
          },
        }),
      );

      if (response.status !== 200 && response.status !== 206) {
        throw new Error(`Failed to fetch Supabase rows: ${extractApiErrorDetails(response)}`);
      }

      const rows = (response.json as Record<string, unknown>[] | undefined) ?? [];
      for (const row of rows) {
        const idValue = row[pk];
        if (idValue === undefined || idValue === null) continue;
        const idString = String(idValue);
        allNotes.push({ id: idString, primaryField: idString, fields: row });
      }

      const contentRange = (response.headers?.['content-range'] ?? response.headers?.['Content-Range']) as string | undefined;
      const total = parseContentRangeTotal(contentRange);
      if (rows.length < SUPABASE_PAGE_SIZE) return allNotes;
      if (total !== null && allNotes.length >= total) return allNotes;
      start += rows.length;
    }
    throw new Error(`Supabase fetchNotes hit MAX_FETCH_ROWS=${MAX_FETCH_ROWS} guard.`);
  }

  async fetchRecord(recordId: string): Promise<RemoteNote | null> {
    this.validateConfig();
    if (!recordId) throw new Error('Supabase record ID cannot be empty.');

    const projectUrl = this.getProjectUrl();
    const endpoint = this.getEndpoint();
    const pk = this.config.primaryKeyColumn;
    const url = `${projectUrl}/rest/v1/${endpoint}?${encodeURIComponent(pk)}=eq.${encodeURIComponent(recordId)}&limit=1`;

    const response = await this.rateLimiter.execute(() =>
      requestUrl({ url, method: 'GET', headers: this.buildHeaders() }),
    );

    if (response.status === 404) return null;
    if (response.status !== 200) {
      throw new Error(`Failed to fetch Supabase record ${recordId}: ${extractApiErrorDetails(response)}`);
    }
    const rows = (response.json as Record<string, unknown>[] | undefined) ?? [];
    if (rows.length === 0) return null;
    const row = rows[0];
    const idValue = row[pk];
    if (idValue === undefined || idValue === null) return null;
    const idString = String(idValue);
    return { id: idString, primaryField: idString, fields: row };
  }

  async updateRecord(recordId: string, fields: Record<string, unknown>): Promise<SyncResult> {
    this.validateConfig();
    if (!recordId) return { success: false, recordId, error: 'Record ID cannot be empty.' };
    const [result] = await this.batchUpdate([{ recordId, fields }]);
    return result;
  }

  async batchUpdate(updates: BatchUpdate[]): Promise<SyncResult[]> {
    this.validateConfig();
    if (updates.length === 0) return [];

    if (updates.length > SUPABASE_DEFAULT_BATCH_SIZE) {
      return buildBatchFailures(updates, formatBatchLimitError(SUPABASE_DEFAULT_BATCH_SIZE));
    }

    try {
      const projectUrl = this.getProjectUrl();
      const tableName = this.config.tableId;  // upsert always targets base table, not view
      const pk = this.config.primaryKeyColumn;
      const url = `${projectUrl}/rest/v1/${tableName}?on_conflict=${encodeURIComponent(pk)}`;

      const body = updates.map(u => ({ [pk]: u.recordId, ...u.fields }));

      const response = await this.rateLimiter.execute(() =>
        requestUrl({
          url,
          method: 'POST',
          headers: {
            ...this.buildHeaders({ write: true }),
            'Content-Type': 'application/json',
            'Prefer': 'resolution=merge-duplicates,return=representation',
          },
          body: JSON.stringify(body),
        }),
      );

      if (response.status !== 200 && response.status !== 201) {
        return buildBatchFailures(updates, `Failed to batch update Supabase rows: ${extractApiErrorDetails(response)}`);
      }

      const returned = (response.json as Record<string, unknown>[] | undefined) ?? [];
      const returnedByPk = new Map<string, Record<string, unknown>>();
      for (const row of returned) {
        const v = row[pk];
        if (v !== undefined && v !== null) returnedByPk.set(String(v), row);
      }

      return updates.map<SyncResult>(u => {
        const row = returnedByPk.get(u.recordId);
        if (row) {
          return { success: true, recordId: u.recordId, updatedFields: row };
        }
        return {
          success: false,
          recordId: u.recordId,
          error: 'Row not updated - RLS denial or PK missing.',
        };
      });
    } catch (error) {
      return buildBatchFailures(updates, error instanceof Error ? error.message : 'Unknown error occurred');
    }
  }
}
