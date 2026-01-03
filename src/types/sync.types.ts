/**
 * Sync-related type definitions.
 */

import type { SyncScope } from './settings.types';

/**
 * Sync direction/mode.
 */
export type SyncMode = 'to-airtable' | 'from-airtable' | 'bidirectional';

/**
 * Represents a sync request in the queue.
 */
export interface SyncRequest {
  id: string;
  mode: SyncMode;
  scope: SyncScope;
  filePaths?: string[];
  timestamp: number;
}

/**
 * Status of a sync queue.
 */
export interface QueueStatus {
  isProcessing: boolean;
  pendingCount: number;
  currentRequest: SyncRequest | null;
}

/**
 * Summary of a sync operation.
 */
export interface SyncSummary {
  created: number;
  updated: number;
  skipped: number;
  errors: number;
}

/**
 * Result of creating a note from remote.
 */
export type NoteCreationResult = 'created' | 'updated' | 'skipped';
