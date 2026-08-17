/**
 * Notion DatabaseProvider implementation.
 *
 * Talks directly to the Notion REST API (2025-09-03) via Obsidian
 * requestUrl. `config.tableId` stores the data source id (the unit sync
 * actually queries against); `config.baseId` stores the parent database
 * id purely for display — every request keys off the data source.
 *
 * Deviation from the SeaTable/Supabase "fail-open" precedent: those
 * providers send frontmatter values through unchanged when column
 * metadata can't be loaded, because their APIs accept bare scalars.
 * Notion's PATCH body requires a typed property payload
 * (`{"Notes": {"rich_text": [...]}}`) — there is no way to construct
 * that payload without the property-type schema, so a schema-load
 * failure fails the whole batch fast with an actionable message instead
 * of paced per-record API failures.
 *
 * @handbook 4.4-provider-abstraction
 * @handbook 6.1-error-handling
 * @handbook 9.6-api-patterns
 * @tested tests/services/notion-client.test.ts
 * @tested e2e:tests/e2e/run-notion-e2e.mjs
 */

import { Notice, requestUrl } from 'obsidian';
import { NOTION_API_BASE_URL, NOTION_BATCH_SIZE, NOTION_PAGE_SIZE, NOTION_VERSION } from '../constants';
import type {
  BatchUpdate,
  ConfigEntry,
  Credential,
  CredentialType,
  DatabaseProvider,
  FieldTypeMapper,
  NotionCredential,
  NotionPage,
  NotionPropertySchemaMap,
  ProviderCapabilities,
  RemoteFieldInfo,
  RemoteNote,
  SyncResult,
} from '../types';
import { buildBatchFailures, extractApiErrorDetails, formatBatchLimitError } from '../utils';
import { flattenNotionProperties, wrapForNotionPush } from './notion-value-converter';
import { notionFieldMapper } from './notion-field-mapper';
import type { NotionSchemaCache } from './notion-schema-cache';
import { RateLimiter } from './rate-limiter';

const NOTION_CAPABILITIES: ProviderCapabilities = {
  bidirectional: true,
  hasComputedFields: true,
  batchUpdateMaxSize: NOTION_BATCH_SIZE,
};

export class NotionClient implements DatabaseProvider {
  readonly providerType: CredentialType = 'notion';
  readonly capabilities: ProviderCapabilities = NOTION_CAPABILITIES;
  readonly fieldTypeMapper: FieldTypeMapper = notionFieldMapper;

  private credential: NotionCredential;
  private config: ConfigEntry;
  private rateLimiter: RateLimiter;
  private debugMode: boolean;
  private schemaCache: NotionSchemaCache;

  constructor(
    credential: NotionCredential,
    config: ConfigEntry,
    rateLimiter: RateLimiter,
    debugMode: boolean,
    schemaCache: NotionSchemaCache,
  ) {
    this.credential = credential;
    this.config = config;
    this.rateLimiter = rateLimiter;
    this.debugMode = debugMode;
    this.schemaCache = schemaCache;
  }

  reconfigure(
    credential: Credential,
    config: ConfigEntry,
    rateLimiter: RateLimiter,
    debugMode: boolean,
  ): void {
    if (credential.type !== 'notion') {
      throw new Error(`NotionClient cannot be reconfigured with a ${credential.type} credential`);
    }
    if (credential.integrationToken !== this.credential.integrationToken) {
      this.schemaCache.clearForCred(this.credential.id);
    }
    this.credential = credential;
    this.config = config;
    this.rateLimiter = rateLimiter;
    this.debugMode = debugMode;
  }

  /**
   * Fetches property-type schema for the active data source, cache-first
   * via `NotionSchemaCache`. Never rejects — see
   * `DatabaseProvider.fetchFieldMetadata`. The TTL cache means batchUpdate's
   * own `getSchema()` call stays a cache hit within the same sync.
   */
  async fetchFieldMetadata(): Promise<RemoteFieldInfo[] | null> {
    try {
      const schema = await this.schemaCache.getSchema(this.credential, this.config.tableId);
      return Array.from(schema, ([name, type]) => ({ name, type }));
    } catch (error) {
      if (this.debugMode) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        new Notice(`Auto Note Importer: Field metadata unavailable: ${message}`);
      }
      return null;
    }
  }

  private validateConfig(): void {
    if (!this.credential.integrationToken?.trim()) {
      throw new Error('Notion integration token must be set.');
    }
    if (!this.config.tableId?.trim()) {
      throw new Error('Notion data source must be set.');
    }
  }

  private buildHeaders(): Record<string, string> {
    return {
      'Authorization': `Bearer ${this.credential.integrationToken}`,
      'Notion-Version': NOTION_VERSION,
      'Content-Type': 'application/json',
    };
  }

  async fetchNotes(): Promise<RemoteNote[]> {
    this.validateConfig();

    const allNotes: RemoteNote[] = [];
    let cursor: string | undefined;

    do {
      const body: Record<string, unknown> = { page_size: NOTION_PAGE_SIZE };
      if (cursor) body.start_cursor = cursor;

      const response = await this.rateLimiter.execute(() =>
        requestUrl({
          url: `${NOTION_API_BASE_URL}/data_sources/${this.config.tableId}/query`,
          method: 'POST',
          headers: this.buildHeaders(),
          body: JSON.stringify(body),
          throw: false,
        }),
      );

      if (response.status < 200 || response.status >= 300) {
        throw new Error(`Failed to fetch Notion pages: ${extractApiErrorDetails(response)}`);
      }

      const json = response.json as { results: NotionPage[]; has_more: boolean; next_cursor: string | null };
      for (const page of json.results) {
        // The query endpoint normally excludes trashed pages, but the wire
        // type carries `in_trash` — skip defensively, mirroring the
        // listDataSources guard in notion-schema-cache.
        if (page.in_trash) continue;
        allNotes.push({ id: page.id, primaryField: page.id, fields: flattenNotionProperties(page.properties) });
      }

      cursor = json.has_more && json.next_cursor ? json.next_cursor : undefined;
    } while (cursor);

    return allNotes;
  }

  async fetchRecord(recordId: string): Promise<RemoteNote | null> {
    this.validateConfig();
    if (!recordId) {
      throw new Error('Notion page ID cannot be empty.');
    }

    const response = await this.rateLimiter.execute(() =>
      requestUrl({
        url: `${NOTION_API_BASE_URL}/pages/${recordId}`,
        method: 'GET',
        headers: this.buildHeaders(),
        throw: false,
      }),
    );

    if (response.status === 404) return null;
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`Failed to fetch Notion page ${recordId}: ${extractApiErrorDetails(response)}`);
    }

    const json = response.json as NotionPage;
    return { id: json.id, primaryField: json.id, fields: flattenNotionProperties(json.properties) };
  }

  async updateRecord(recordId: string, fields: Record<string, unknown>): Promise<SyncResult> {
    // Notion has no batch-update endpoint (see class docs) — delegate so the
    // per-record PATCH shape and schema-driven property wrapping stay in one
    // place. Mirrors the SeaTable/Supabase precedent.
    const [result] = await this.batchUpdate([{ recordId, fields }]);
    return result;
  }

  /**
   * Composes the Notion PATCH properties payload for one update, filtering
   * out unknown-name / unpushable / unwrappable fields. Returns both the
   * wire payload and the pre-wrap scalar values actually sent (for
   * SyncResult.updatedFields).
   */
  private composeProperties(
    fields: Record<string, unknown>,
    schema: NotionPropertySchemaMap,
    onUnknownField: () => void,
  ): { payload: Record<string, unknown>; sent: Record<string, unknown> } {
    const payload: Record<string, unknown> = {};
    const sent: Record<string, unknown> = {};

    for (const [name, value] of Object.entries(fields)) {
      const type = schema.get(name);
      if (!type) {
        onUnknownField();
        continue;
      }
      if (!notionFieldMapper.isPushable(type)) continue;

      const wrapped = wrapForNotionPush(type, value);
      if (!wrapped.ok) continue;

      payload[name] = wrapped.payload;
      sent[name] = value;
    }

    return { payload, sent };
  }

  /**
   * Fails the record at `i` with `currentError`, then fails every remaining
   * record (`i+1..`) with `abortReason` without issuing further paced API
   * calls — used when a mid-batch failure means the rest of the batch can't
   * possibly succeed either (network failure, dead/revoked token).
   */
  private abortRemaining(
    results: SyncResult[],
    updates: BatchUpdate[],
    i: number,
    currentError: string,
    abortReason: string,
  ): SyncResult[] {
    results.push({ success: false, recordId: updates[i].recordId, error: currentError });
    for (let j = i + 1; j < updates.length; j++) {
      results.push({ success: false, recordId: updates[j].recordId, error: abortReason });
    }
    return results;
  }

  async batchUpdate(updates: BatchUpdate[]): Promise<SyncResult[]> {
    if (updates.length === 0) return [];

    try {
      this.validateConfig();
    } catch (error) {
      return buildBatchFailures(updates, error instanceof Error ? error.message : 'Invalid Notion config');
    }

    if (updates.length > NOTION_BATCH_SIZE) {
      return buildBatchFailures(updates, formatBatchLimitError(NOTION_BATCH_SIZE));
    }

    // Notion PATCH is per-page — a duplicate recordId in the same batch
    // would silently apply both writes sequentially with the second
    // clobbering the first, masking a vault-duplicate bug. Reject the whole
    // batch, matching the Supabase precedent.
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

    let schema: NotionPropertySchemaMap;
    try {
      schema = await this.schemaCache.getSchema(this.credential, this.config.tableId);
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'Unknown error occurred';
      return buildBatchFailures(updates, `Failed to load Notion schema: ${detail}`);
    }

    try {
      const results: SyncResult[] = [];
      let noticedUnknownField = false;
      const noticeUnknownField = () => {
        if (!this.debugMode || noticedUnknownField) return;
        noticedUnknownField = true;
        new Notice('Auto Note Importer: Skipped one or more fields not found in the Notion data source schema.');
      };

      for (let i = 0; i < updates.length; i++) {
        const u = updates[i];
        const { payload, sent } = this.composeProperties(u.fields, schema, noticeUnknownField);

        // Read-only/unknown-only frontmatter composes to an empty payload —
        // firing a no-op PATCH would just burn a 334ms limiter slot.
        if (Object.keys(payload).length === 0) {
          results.push({ success: true, recordId: u.recordId, updatedFields: {} });
          continue;
        }

        let response;
        try {
          response = await this.rateLimiter.execute(() =>
            requestUrl({
              url: `${NOTION_API_BASE_URL}/pages/${u.recordId}`,
              method: 'PATCH',
              headers: this.buildHeaders(),
              body: JSON.stringify({ properties: payload }),
              throw: false,
            }),
          );
        } catch (error) {
          // A thrown error (post-retry network failure) mid-batch must not
          // discard the successes already accumulated in `results` — keep
          // them, fail this record and the rest, and stop (PR #125 Codex P2).
          return this.abortRemaining(
            results,
            updates,
            i,
            `Failed to update Notion page ${u.recordId}: ${error instanceof Error ? error.message : 'Unknown error occurred'}`,
            'aborted: batch aborted mid-flight after a network error',
          );
        }

        if (response.status === 401 || response.status === 403) {
          // A dead/revoked token won't succeed on the remaining records
          // either — fail them without burning more paced API calls.
          return this.abortRemaining(
            results,
            updates,
            i,
            `Failed to update Notion page ${u.recordId}: ${extractApiErrorDetails(response)}`,
            'aborted: authentication failed',
          );
        }

        if (response.status < 200 || response.status >= 300) {
          results.push({
            success: false,
            recordId: u.recordId,
            error: `Failed to update Notion page ${u.recordId}: ${extractApiErrorDetails(response)}`,
          });
          continue;
        }

        results.push({ success: true, recordId: u.recordId, updatedFields: sent });
      }

      return results;
    } catch (error) {
      return buildBatchFailures(updates, error instanceof Error ? error.message : 'Unknown error occurred');
    }
  }
}
