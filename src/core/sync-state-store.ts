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
  removeRecord(recordId: string): void;
  /** Drops records not in `keep`, along with their pending conflicts. */
  pruneRecords(keep: Set<string>): void;
  upsertConflict(c: PendingConflict): void;
  removeConflict(recordId: string, field: string): void;
  pendingConflicts(): PendingConflict[];
}

export class SyncStateStore {
  private state: SyncStateFile = { version: 1, configs: {} };
  private dirty = false;

  constructor(private adapter: DataAdapter, private path: string) {}

  async load(): Promise<void> {
    this.state = { version: 1, configs: {} };
    this.dirty = false;

    let raw: string;
    try {
      if (!(await this.adapter.exists(this.path))) return;
      raw = await this.adapter.read(this.path);
    } catch (error) {
      console.error('Auto Note Importer: failed to read sync-state.json', error);
      new Notice('Auto Note Importer: could not read sync-state.json. Starting with empty sync state.');
      return;
    }

    try {
      const parsed = JSON.parse(raw) as Partial<SyncStateFile> | null;
      if (parsed && parsed.version === 1 && parsed.configs && typeof parsed.configs === 'object') {
        this.state = { version: 1, configs: parsed.configs };
      } else {
        throw new Error('unexpected shape');
      }
    } catch (error) {
      console.error('Auto Note Importer: invalid sync-state.json', error);
      new Notice('Auto Note Importer: sync-state.json is invalid. Starting with empty sync state.');
    }
  }

  async flush(): Promise<void> {
    if (!this.dirty) return;
    try {
      await this.adapter.write(this.path, JSON.stringify(this.state));
      this.dirty = false;
    } catch (error) {
      console.error('Auto Note Importer: failed to write sync-state.json', error);
      new Notice('Auto Note Importer: could not save sync-state.json. Will retry on next sync.');
    }
  }

  removeConfig(configId: string): void {
    if (configId in this.state.configs) {
      delete this.state.configs[configId];
      this.dirty = true;
    }
  }

  allPending(): Array<{ configId: string; conflict: PendingConflict }> {
    const out: Array<{ configId: string; conflict: PendingConflict }> = [];
    for (const [configId, cfg] of Object.entries(this.state.configs)) {
      for (const conflict of cfg.pendingConflicts) out.push({ configId, conflict });
    }
    return out;
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

      removeRecord: (recordId) => {
        const c = peek();
        if (c && recordId in c.records) {
          delete c.records[recordId];
          touch();
        }
      },

      pruneRecords: (keep) => {
        const c = peek();
        if (!c) return;
        for (const id of Object.keys(c.records)) {
          if (!keep.has(id)) {
            delete c.records[id];
            touch();
          }
        }
        const before = c.pendingConflicts.length;
        c.pendingConflicts = c.pendingConflicts.filter(p => keep.has(p.recordId));
        if (c.pendingConflicts.length !== before) touch();
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
    };
  }
}
