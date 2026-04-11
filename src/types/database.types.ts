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

/**
 * A record fetched from a remote database, normalized across providers.
 */
export interface RemoteNote {
  id: string;
  primaryField: string;
  fields: Record<string, unknown>;
}

/**
 * Result of a sync operation (discriminated union on `success`).
 */
export type SyncResult =
  | { success: true; recordId: string; updatedFields: Record<string, unknown> }
  | { success: false; recordId: string; error: string };

/**
 * Information about a field conflict between Obsidian and a remote database.
 */
export interface ConflictInfo {
  field: string;
  obsidianValue: unknown;
  airtableValue: unknown;
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
 */
export interface ProviderCapabilities {
  /** Supports writing records back to the database. */
  bidirectional: boolean;
  /** Has fields whose values are computed server-side (formulas, rollups, lookups). */
  hasComputedFields: boolean;
  /** Maximum records per batch update call. */
  batchUpdateMaxSize: number;
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

  fetchNotes(): Promise<RemoteNote[]>;
  fetchRecord(recordId: string): Promise<RemoteNote | null>;
  updateRecord(recordId: string, fields: Record<string, unknown>): Promise<SyncResult>;
  batchUpdate(updates: BatchUpdate[]): Promise<SyncResult[]>;

  /**
   * Reconfigures the provider with new credential and config values.
   * Called by ConfigInstance when settings change, keeping references
   * held by other services stable.
   */
  reconfigure(credential: Credential, config: ConfigEntry, debugMode: boolean): void;
}
