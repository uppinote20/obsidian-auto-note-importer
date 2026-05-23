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

  private async loadWritableColumns(tableName: string, schema: string): Promise<Map<string, string> | null> {
    try {
      const spec = await this.metadataCache.getSpec(this.credential, schema);
      const columns = this.metadataCache.getColumns(spec, tableName);
      const m = new Map<string, string>();
      for (const c of columns) {
        if (!supabaseFieldMapper.isReadOnly(c.providerType)) {
          m.set(c.name, c.providerType);
        }
      }
      return m;
    } catch {
      return null;
    }
  }

  /**
   * Coerce a frontmatter value into something PostgREST accepts for the
   * column's type. `note-builder` writes null → '""' (so the field stays
   * visible in Obsidian frontmatter), but PostgREST rejects empty strings
   * for non-text columns (text[], jsonb, integer, boolean, etc.).
   *
   * Returns the symbol `SKIP_FIELD` when the field should be dropped from
   * the upsert body entirely (e.g. empty string for a numeric column).
   */
  private coerceForSupabase(value: unknown, providerType: string | undefined): unknown {
    if (value !== '') return value;  // only "" is the problem case
    if (!providerType) return value;
    if (providerType.startsWith('array:')) return [];      // empty PostgreSQL array
    if (providerType.includes(':jsonb') || providerType.includes(':json')) return null;
    // string/text columns legitimately accept "" — keep it.
    if (providerType.startsWith('string') && !providerType.includes(':uuid')) return value;
    // Numeric/boolean/uuid/date/timestamp/etc. can't accept "" — drop the field.
    return SupabaseClient.SKIP_FIELD;
  }

  private static readonly SKIP_FIELD = Symbol('skip');

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
    // PostgREST takes the path segment verbatim; tables/views with spaces or
    // non-ASCII characters need percent-encoding so the URL stays valid.
    const url = `${projectUrl}/rest/v1/${encodeURIComponent(endpoint)}`;

    const allNotes: RemoteNote[] = [];
    let rawRowsFetched = 0;   // counts every server-returned row, including PK-null skips
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

      // 416 Range Not Satisfiable past EOF is normal once we've accumulated
      // rows — PostgREST 11+ returns it when the requested range starts
      // beyond the last row (e.g. table size is an exact PAGE_SIZE multiple).
      if (response.status === 416 && allNotes.length > 0) return allNotes;

      if (response.status !== 200 && response.status !== 206) {
        throw new Error(`Failed to fetch Supabase rows: ${extractApiErrorDetails(response)}`);
      }

      const rows = (response.json as Record<string, unknown>[] | undefined) ?? [];
      // Fail fast on the first page when the configured PK column doesn't
      // appear in the endpoint's rows. Otherwise the loop silently produces
      // [] and the user sees "0 notes synced" with no hint that the view
      // is the wrong shape for this PK.
      if (start === 0 && rows.length > 0 && !(pk in rows[0])) {
        throw new Error(
          `Supabase primaryKeyColumn "${pk}" not found in endpoint "${endpoint}". ` +
          `The configured view/table does not expose that column — pick a different PK or endpoint in settings.`,
        );
      }
      for (const row of rows) {
        const idValue = row[pk];
        if (idValue === undefined || idValue === null) continue;
        const idString = String(idValue);
        allNotes.push({ id: idString, primaryField: idString, fields: row });
      }

      const contentRange = (response.headers?.['content-range'] ?? response.headers?.['Content-Range']) as string | undefined;
      const total = parseContentRangeTotal(contentRange);

      rawRowsFetched += rows.length;

      // Exit priority:
      // 1. Total known and reached — stop. Compare against rawRowsFetched
      //    (every server-returned row) not allNotes.length (only PK-non-null
      //    rows), so a PK-null skip can't trick us into an extra empty page.
      // 2. Server returned zero rows — guaranteed EOF (also infinite-loop guard).
      // 3. Total unknown AND server returned a short page — best-effort EOF guess.
      //    (Skipped when total IS known: a server-side row cap below PAGE_SIZE
      //    would otherwise silently truncate the table.)
      if (total !== null && rawRowsFetched >= total) return allNotes;
      if (rows.length === 0) return allNotes;
      if (total === null && rows.length < SUPABASE_PAGE_SIZE) return allNotes;
      start += rows.length;
    }
    throw new Error(`Supabase fetchNotes hit MAX_FETCH_ROWS=${MAX_FETCH_ROWS} guard.`);
  }

  async fetchRecord(recordId: string): Promise<RemoteNote | null> {
    this.validateConfig();
    if (!recordId) throw new Error('Supabase record ID cannot be empty.');

    const projectUrl = this.getProjectUrl();
    // Base table — not the view — so conflict detection sees rows that
    // left the view (status flip, soft-delete). Pulling through a view
    // would silently report "row not found" and let pushFiles overwrite
    // concurrent remote edits.
    const endpoint = this.config.tableId;
    const pk = this.config.primaryKeyColumn;
    const url = `${projectUrl}/rest/v1/${encodeURIComponent(endpoint)}?${encodeURIComponent(pk)}=eq.${encodeURIComponent(recordId)}&limit=1`;

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

    // PostgREST silently merges duplicate-PK rows server-side; the original
    // body composition then reported both as "success" against the merged
    // result, masking the fact that one shadowed the other. Reject the
    // whole batch explicitly so the user can fix vault duplicates rather
    // than seeing a silent overwrite.
    const seen = new Set<string>();
    for (const u of updates) {
      if (seen.has(u.recordId)) {
        return buildBatchFailures(
          updates,
          `Duplicate recordId "${u.recordId}" in batch — vault contains multiple notes with the same primaryField. Remove duplicates and retry.`,
        );
      }
      seen.add(u.recordId);
    }

    try {
      const projectUrl = this.getProjectUrl();
      const tableName = this.config.tableId;  // upsert always targets base table, not view
      const pk = this.config.primaryKeyColumn;
      const schema = this.getSchema();
      const url = `${projectUrl}/rest/v1/${encodeURIComponent(tableName)}?on_conflict=${encodeURIComponent(pk)}`;

      // Base-table column type map (writable only) lets us filter out GENERATED
      // columns + view-derived joins AND coerce frontmatter "" placeholders
      // (which note-builder emits for null values) back into PostgreSQL-valid
      // empty values per column type. Metadata fetch is best-effort — failures
      // fall through to "send everything".
      const writableColumns = await this.loadWritableColumns(tableName, schema);

      const body = updates.map(u => {
        const filtered: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(u.fields)) {
          if (k === pk) continue;
          if (writableColumns && !writableColumns.has(k)) continue;
          const coerced = this.coerceForSupabase(v, writableColumns?.get(k));
          if (coerced === SupabaseClient.SKIP_FIELD) continue;
          filtered[k] = coerced;
        }
        return { ...filtered, [pk]: u.recordId };
      });

      // `return=representation` always on: the conflict-resolver and the
      // bidirectional sync flow both rely on `SyncResult.updatedFields` to
      // pull server-computed values (defaults, generated columns) back into
      // the local note. A push-only optimization to `return=minimal` would
      // require plumbing the orchestrator mode through to the provider and
      // is tracked separately rather than here.
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

      // Empty representation on a 200/201 means the upsert ran but the RLS
      // policy denied SELECT (common for write-only audit tables, or WITH
      // CHECK passing while USING denies). Treat as success for every
      // requested record — we can't fabricate updatedFields, but at least
      // the user doesn't see N false failures for N successful writes.
      if (returned.length === 0) {
        return updates.map<SyncResult>(u => ({ success: true, recordId: u.recordId }));
      }

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
