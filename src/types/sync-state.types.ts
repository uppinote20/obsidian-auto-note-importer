/**
 * Persisted sync snapshot types for three-way conflict judgement.
 *
 * Local and remote are stored separately because the two sides may serialize
 * the same value differently (e.g. trailing newline in frontmatter).
 */

/** Per-field values as last seen on each side at the previous sync. */
export interface FieldSnapshot {
  local: unknown;
  remote: unknown;
  /**
   * Set by "Keep local (not synced)": the local value is kept on pulls (and
   * never pushed) while the remote stays at `remote`. Once the remote moves
   * the pin no longer holds and the field is judged as a local change again.
   */
  pinnedLocal?: true;
}

/** Snapshot of one record (keyed by remote record id). */
export interface RecordSnapshot {
  syncedAt: string;
  fields: Record<string, FieldSnapshot>;
}

/** A field-level conflict awaiting manual resolution. */
export interface PendingConflict {
  recordId: string;
  filePath: string;
  field: string;
  local: unknown;
  remote: unknown;
  snapshot: FieldSnapshot | null;
  writable: boolean;
  detectedAt: string;
  stale?: boolean;
}

/** Sync state of a single config. */
export interface ConfigSyncState {
  records: Record<string, RecordSnapshot>;
  pendingConflicts: PendingConflict[];
}

/** Root of the persisted sync state file. */
export interface SyncStateFile {
  version: 1;
  configs: Record<string, ConfigSyncState>;
}
