/**
 * Sync-related type definitions.
 * @handbook 4.2-sync-architecture
 */

import type { SyncScope } from './settings.types';

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
 * Result of creating a note from remote.
 */
export type NoteCreationResult = 'created' | 'updated' | 'skipped' | 'error';
