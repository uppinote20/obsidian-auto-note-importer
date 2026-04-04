/**
 * Database client interface for abstracting external data sources.
 */

import type { RemoteNote, SyncResult, BatchUpdate } from './airtable.types';

export interface DatabaseClient {
  fetchNotes(): Promise<RemoteNote[]>;
  fetchRecord(recordId: string): Promise<RemoteNote | null>;
  updateRecord(recordId: string, fields: Record<string, unknown>): Promise<SyncResult>;
  batchUpdate(updates: BatchUpdate[]): Promise<SyncResult[]>;
}
