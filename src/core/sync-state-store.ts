/**
 * Persists per-config, per-record sync snapshots and pending conflicts
 * in a single JSON file (`<pluginDir>/sync-state.json`).
 *
 * @tested tests/core/sync-state-store.test.ts
 */

import { Notice } from 'obsidian';
import type { DataAdapter } from 'obsidian';
import type {
  ConfigSyncState,
  FieldSnapshot,
  PendingConflict,
  RecordSnapshot,
  SyncStateFile,
} from '../types';

export interface ConfigSyncStateHandle {
  getRecord(recordId: string): RecordSnapshot | undefined;
  /** Merges into existing fields and bumps `syncedAt`. */
  setFields(recordId: string, fields: Record<string, FieldSnapshot>): void;
  /** Drops records not in `keep`, along with their pending conflicts. */
  pruneRecords(keep: Set<string>): void;
  upsertConflict(c: PendingConflict): void;
  removeConflict(recordId: string, field: string): void;
  pendingConflicts(): PendingConflict[];
  /** Persists the whole store (delegates to `SyncStateStore.flush`). */
  flush(): Promise<void>;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isAtOrUnder(filePath: string, path: string): boolean {
  return !!path && (filePath === path || filePath.startsWith(`${path}/`));
}

function isValidStateFile(v: unknown): v is SyncStateFile {
  if (!isPlainObject(v) || v.version !== 1 || !isPlainObject(v.configs)) return false;
  return Object.values(v.configs).every(
    c => isPlainObject(c) && isPlainObject(c.records) && Array.isArray(c.pendingConflicts),
  );
}

export class SyncStateStore {
  private state: SyncStateFile = { version: 1, configs: {} };
  private dirty = false;
  /**
   * Set when an existing file could not be read: the session keeps state in
   * memory only, so an empty store never overwrites the real file (e.g. an
   * iCloud placeholder that failed to download).
   */
  private writeBlocked = false;
  /** Flushes run one after another so writes land in call order. */
  private flushChain: Promise<void> = Promise.resolve();

  constructor(private adapter: DataAdapter, private path: string) {}

  async load(): Promise<void> {
    this.state = { version: 1, configs: {} };
    this.dirty = false;

    let raw: string;
    try {
      if (!(await this.adapter.exists(this.path))) {
        this.writeBlocked = false;
        return;
      }
      raw = await this.adapter.read(this.path);
    } catch (error) {
      console.error('Auto Note Importer: failed to read sync-state.json', error);
      if (!this.writeBlocked) {
        new Notice('Auto Note Importer: could not read sync-state.json. Sync state will not be saved until Obsidian restarts.');
      }
      this.writeBlocked = true;
      return;
    }
    this.writeBlocked = false;

    try {
      const parsed: unknown = JSON.parse(raw);
      if (!isValidStateFile(parsed)) throw new Error('unexpected shape');
      this.state = { version: 1, configs: parsed.configs };
    } catch (error) {
      console.error('Auto Note Importer: invalid sync-state.json', error);
      new Notice('Auto Note Importer: sync-state.json is invalid. Starting with empty sync state.');
    }
  }

  /** Persists the store; calls are serialized, and a mutation made during a write is saved by the next flush. */
  flush(): Promise<void> {
    const run = this.flushChain.then(() => this.write());
    this.flushChain = run;
    return run;
  }

  private async write(): Promise<void> {
    if (!this.dirty || this.writeBlocked) return;
    // Cleared before the await (not after): a mutation made while the write is
    // in flight re-marks the store dirty and is saved by the next flush. A failed
    // write re-sets it so nothing is lost. Flushes are serialized on `flushChain`,
    // so two writes never overlap.
    this.dirty = false;
    try {
      await this.adapter.write(this.path, JSON.stringify(this.state));
    } catch (error) {
      this.dirty = true;
      console.error('Auto Note Importer: failed to write sync-state.json', error);
      new Notice('Auto Note Importer: could not save sync-state.json. Will retry on next sync.');
    }
  }

  /** Drops every config entry whose id is not in `ids` (settings membership). */
  retainConfigs(ids: Set<string>): void {
    for (const configId of Object.keys(this.state.configs)) {
      if (!ids.has(configId)) {
        delete this.state.configs[configId];
        this.dirty = true;
      }
    }
  }

  /** Drops pending conflicts of a deleted note (or of every note under a deleted folder). */
  removeConflictsForPath(path: string): boolean {
    let changed = false;
    for (const cfg of Object.values(this.state.configs)) {
      const kept = cfg.pendingConflicts.filter(p => !isAtOrUnder(p.filePath, path));
      if (kept.length !== cfg.pendingConflicts.length) {
        cfg.pendingConflicts = kept;
        changed = true;
      }
    }
    if (changed) this.dirty = true;
    return changed;
  }

  /** Points pending conflicts at a renamed note (or at the notes of a renamed folder). */
  renameConflictPath(oldPath: string, newPath: string): boolean {
    let changed = false;
    for (const cfg of Object.values(this.state.configs)) {
      for (const p of cfg.pendingConflicts) {
        if (isAtOrUnder(p.filePath, oldPath)) {
          p.filePath = newPath + p.filePath.slice(oldPath.length);
          changed = true;
        }
      }
    }
    if (changed) this.dirty = true;
    return changed;
  }

  forConfig(configId: string): ConfigSyncStateHandle {
    const cfg = (): ConfigSyncState => {
      let c = this.state.configs[configId];
      if (!c) {
        c = { records: {}, pendingConflicts: [] };
        this.state.configs[configId] = c;
      }
      return c;
    };
    const peek = (): ConfigSyncState | undefined => this.state.configs[configId];
    const touch = (): void => { this.dirty = true; };

    return {
      getRecord: (recordId) => peek()?.records[recordId],

      setFields: (recordId, fields) => {
        const c = cfg();
        const existing = c.records[recordId];
        c.records[recordId] = {
          syncedAt: new Date().toISOString(),
          fields: { ...(existing?.fields ?? {}), ...fields },
        };
        touch();
      },

      pruneRecords: (keep) => {
        const c = peek();
        if (!c) return;
        let changed = false;
        for (const id of Object.keys(c.records)) {
          if (!keep.has(id)) {
            delete c.records[id];
            changed = true;
          }
        }
        const kept = c.pendingConflicts.filter(p => keep.has(p.recordId));
        if (kept.length !== c.pendingConflicts.length) {
          c.pendingConflicts = kept;
          changed = true;
        }
        if (changed) touch();
      },

      upsertConflict: (conflict) => {
        const c = cfg();
        const idx = c.pendingConflicts.findIndex(
          p => p.recordId === conflict.recordId && p.field === conflict.field,
        );
        if (idx >= 0) c.pendingConflicts[idx] = conflict;
        else c.pendingConflicts.push(conflict);
        touch();
      },

      removeConflict: (recordId, field) => {
        const c = peek();
        if (!c) return;
        const before = c.pendingConflicts.length;
        c.pendingConflicts = c.pendingConflicts.filter(
          p => !(p.recordId === recordId && p.field === field),
        );
        if (c.pendingConflicts.length !== before) touch();
      },

      pendingConflicts: () => [...(peek()?.pendingConflicts ?? [])],

      flush: () => this.flush(),
    };
  }
}
