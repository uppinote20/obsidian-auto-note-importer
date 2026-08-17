/**
 * Provider-agnostic database type definitions.
 *
 * These types are used by the DatabaseProvider interface and all
 * concrete provider implementations (Airtable, SeaTable, Supabase, etc.).
 *
 * @handbook 4.4-provider-abstraction
 */

import type { Credential, CredentialType } from './credential.types';
import type { ConfigEntry } from './config.types';
import type { FieldTypeMapper } from './field-types.types';
import type { RateLimiter } from '../services/rate-limiter';

/**
 * Metadata for a single remote field/column, as reported by a provider's
 * own schema/metadata API. `type` is a provider-native type string
 * (e.g. Airtable's `"multipleAttachments"`, PostgREST's `"integer"`) —
 * it is meaningful only when interpreted by that same provider's
 * `fieldTypeMapper`.
 */
export interface RemoteFieldInfo {
  name: string;
  type: string;
}

/**
 * A record fetched from a remote database, normalized across providers.
 */
export interface RemoteNote {
  id: string;
  primaryField: string;
  fields: Record<string, unknown>;
  /**
   * Markdown note body. Not populated by `fetchNotes()` / `fetchRecord()` —
   * fetched separately via `DatabaseProvider.fetchBody()` and filled in by
   * the sync orchestrator only when the config opts into body sync.
   */
  body?: string;
}

/**
 * Result of a sync operation (discriminated union on `success`).
 *
 * `updatedFields` is the server-echoed record after the write (used to pull
 * formula/generated values back into the local note). It is optional because
 * a provider may legitimately succeed without being able to return the row
 * (e.g. Supabase RLS that permits the write but denies SELECT).
 */
export type SyncResult =
  | { success: true; recordId: string; updatedFields?: Record<string, unknown> }
  | { success: false; recordId: string; error: string };

/**
 * Information about a field conflict between Obsidian and a remote database.
 */
export interface ConflictInfo {
  field: string;
  obsidianValue: unknown;
  remoteValue: unknown;
  recordId: string;
  filePath: string;
}

/**
 * Batch update request structure.
 */
export interface BatchUpdate {
  recordId: string;
  fields: Record<string, unknown>;
}

/**
 * Capabilities a database provider advertises at runtime.
 *
 * Callers check these flags instead of branching on concrete provider
 * classes — e.g. the sync orchestrator can skip the formula-wait phase
 * when `hasComputedFields` is false.
 */
export interface ProviderCapabilities {
  /** Supports writing records back to the database. */
  bidirectional: boolean;
  /** Has fields whose values are computed server-side (formulas, rollups, lookups). */
  hasComputedFields: boolean;
  /**
   * Maximum records per batch update call. Providers should report the
   * largest batch their API accepts; read-only providers (`bidirectional: false`)
   * must still report a positive number (e.g. `1`) — callers guarantee they
   * won't call `batchUpdate()` when `bidirectional` is false.
   */
  batchUpdateMaxSize: number;
  /**
   * Whether the provider supports fetching a note's markdown body via
   * `fetchBody()`. `'pull'` is the only implemented direction; the string
   * (rather than boolean) reserves `'bidirectional'` for a future push
   * path. Absent means the provider has no body concept.
   */
  bodySync?: 'pull';
}

/**
 * Provider-agnostic interface implemented by all database clients.
 *
 * Each provider (AirtableClient, SeaTableClient, ...) implements this
 * interface so higher layers can operate on any database uniformly.
 */
export interface DatabaseProvider {
  readonly providerType: CredentialType;
  readonly capabilities: ProviderCapabilities;
  readonly fieldTypeMapper: FieldTypeMapper;

  /**
   * Fetches field/column metadata from the provider's schema API.
   *
   * Contract: `null` means metadata is unavailable or unsupported —
   * callers MUST fail open (treat as "no metadata, send everything") in
   * that case. This method MUST NEVER reject; all errors are caught and
   * mapped to `null`. Implementations MUST serve from the provider's own
   * cache so repeated calls within a single sync don't multiply API
   * requests.
   */
  fetchFieldMetadata(): Promise<RemoteFieldInfo[] | null>;

  fetchNotes(): Promise<RemoteNote[]>;
  fetchRecord(recordId: string): Promise<RemoteNote | null>;
  updateRecord(recordId: string, fields: Record<string, unknown>): Promise<SyncResult>;
  /**
   * Updates multiple records in a single batch.
   *
   * Failure contract: this method always resolves to a `SyncResult[]` with
   * one entry per requested update for input-side guards (e.g. exceeding
   * `capabilities.batchUpdateMaxSize`) and per-call API response failures
   * (HTTP non-2xx, network errors). Implementations must not `throw` for
   * those — wrap each failure into per-record `{ success: false, recordId,
   * error }` so callers handle one shape regardless of cause.
   *
   * Configuration errors (missing API key, unset table ID, etc.) are a
   * separate category — the up-front `validateSettings()` / `validateConfig()`
   * checks may still throw, since misconfiguration is a wiring bug rather
   * than a per-call failure. See handbook §6.1.
   */
  batchUpdate(updates: BatchUpdate[]): Promise<SyncResult[]>;

  /**
   * Fetches a record's markdown body. Optional — only present when
   * `capabilities.bodySync` is set. `null` means the page/record is gone
   * or the body is unavailable; callers proceed fields-only in that case.
   * Implementations MUST pace every request through the provider's own
   * rate limiter and MUST bound their own request count (a body can be an
   * arbitrarily deep/large block tree).
   */
  fetchBody?(recordId: string): Promise<string | null>;

  /**
   * Reconfigures the provider with new credential, config, and rate limiter.
   * Called by ConfigInstance when settings change, keeping references
   * held by other services stable.
   *
   * The rate limiter may change when a config is reassigned to a different
   * credential — providers must rebind to the new limiter so the per-credential
   * sharing invariant in `SharedServices.rateLimiters` stays intact.
   */
  reconfigure(
    credential: Credential,
    config: ConfigEntry,
    rateLimiter: RateLimiter,
    debugMode: boolean,
  ): void;
}
