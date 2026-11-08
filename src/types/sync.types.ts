/**
 * Sync-related type definitions.
 * @handbook 4.2-sync-architecture
 */

import type { SyncScope } from './settings.types';
import type { PendingConflict } from './sync-state.types';

/**
 * Sync direction/mode.
 *
 * Provider-agnostic terms — applies to any DatabaseProvider, not just Airtable.
 * `push`: local Obsidian → remote. `pull`: remote → local Obsidian. `bidirectional`: push then pull.
 */
export type SyncMode = 'push' | 'pull' | 'bidirectional';

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
 * Who started a sync run: a user command or background sync (watcher,
 * interval). Behaviour keyed on it arrives with the conflict modal.
 */
export type SyncTrigger = 'user' | 'auto';

/**
 * Outcome of one `SyncOrchestrator.processSyncRequest` run.
 */
export interface SyncRunResult {
  /**
   * Conflicts queued for manual resolution during this run that were not
   * already pending with the same local / remote values.
   */
  newConflicts: PendingConflict[];
}

/**
 * Result of creating a note from remote.
 */
export type NoteCreationResult = 'created' | 'updated' | 'skipped' | 'error';
