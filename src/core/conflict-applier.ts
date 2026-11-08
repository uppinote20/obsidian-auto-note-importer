/**
 * Applies the user's choices for queued sync conflicts (spec §4 "Apply").
 *
 * Every choice re-reads both sides first; a side that moved since the
 * conflict was queued makes the entry stale (refreshed, nothing written).
 *
 * @tested tests/core/conflict-applier.test.ts
 */

import { TFile } from 'obsidian';
import type { App } from 'obsidian';
import type { DatabaseProvider, FieldSnapshot, PendingConflict, RemoteNote } from '../types';
import type { ConfigSyncStateHandle } from './sync-state-store';
import type { FrontmatterParser } from '../file-operations/frontmatter-parser';
import { areValuesEqual, formatObjectLabel } from '../utils';

export type ConflictChoice = 'obsidian' | 'remote' | 'keep-local' | 'later';

export interface ApplyResult {
  applied: number;
  /** Entries whose note or remote moved since queueing (refreshed, re-queued). */
  stale: PendingConflict[];
  /** Entries kept in the queue because the write (or its re-read) failed. */
  failed: Array<{ conflict: PendingConflict; error: string }>;
  /** Entries dropped because the note or remote record is gone. */
  removed: PendingConflict[];
}

/** Thrown for refusals and read problems that should surface as `failed`. */
class ApplyError extends Error {}

/** `processFrontMatter` value for a remote value: object shapes become their label, as the note builder writes them. */
function toFrontmatterValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(item => (typeof item === 'object' && item !== null ? formatObjectLabel(item) : item));
  }
  if (typeof value === 'object' && value !== null) return formatObjectLabel(value);
  return value;
}

export class ConflictApplier {
  constructor(
    private app: App,
    private syncState: ConfigSyncStateHandle,
    private provider: DatabaseProvider,
    private parser: FrontmatterParser,
    private bidirectional: boolean,
  ) {}

  async apply(choices: Array<{ conflict: PendingConflict; choice: ConflictChoice }>): Promise<ApplyResult> {
    const result: ApplyResult = { applied: 0, stale: [], failed: [], removed: [] };
    // Remote re-reads per record; dropped once this apply writes to that record.
    const remoteCache = new Map<string, RemoteNote | null>();

    for (const { conflict, choice } of choices) {
      if (choice === 'later') continue;
      try {
        await this.applyOne(conflict, choice, remoteCache, result);
      } catch (error) {
        result.failed.push({ conflict, error: error instanceof Error ? error.message : 'Unknown error' });
      }
    }

    await this.syncState.flush();
    return result;
  }

  private async applyOne(
    conflict: PendingConflict,
    choice: Exclude<ConflictChoice, 'later'>,
    remoteCache: Map<string, RemoteNote | null>,
    result: ApplyResult,
  ): Promise<void> {
    const { recordId, field } = conflict;

    if (choice === 'obsidian') {
      if (!this.bidirectional) throw new ApplyError('Bidirectional sync is off for this config');
      if (!conflict.writable) throw new ApplyError(`"${field}" can't be written to the remote`);
    }

    const file = this.app.vault.getAbstractFileByPath(conflict.filePath);
    const parsed = file instanceof TFile ? await this.readNote(file) : undefined;
    if (!(file instanceof TFile) || parsed?.recordId !== recordId) {
      // The note is gone (or now belongs to another record): nothing to resolve.
      this.drop(conflict, result);
      return;
    }

    let remote = remoteCache.get(recordId);
    if (remote === undefined) {
      remote = await this.provider.fetchRecord(recordId);
      remoteCache.set(recordId, remote);
    }
    if (!remote) {
      this.drop(conflict, result);
      return;
    }

    const currentLocal = parsed.fields[field];
    const currentRemote = remote.fields[field];
    if (!areValuesEqual(currentLocal, conflict.local) || !areValuesEqual(currentRemote, conflict.remote)) {
      this.markStale(conflict, currentLocal, currentRemote, result);
      return;
    }

    switch (choice) {
      case 'obsidian': {
        remoteCache.delete(recordId);
        const write = await this.provider.updateRecord(recordId, { [field]: currentLocal });
        if (!write.success) throw new ApplyError(write.error);
        const echo = write.updatedFields?.[field];
        this.settle(conflict, { local: currentLocal, remote: echo !== undefined ? echo : currentLocal });
        break;
      }
      case 'remote': {
        const value = toFrontmatterValue(currentRemote);
        // The note text above was read before awaiting fetchRecord(); re-check
        // the live value inside the atomic frontmatter edit so an edit made in
        // that window is never overwritten.
        let editedMeanwhile = false;
        let liveLocal: unknown;
        await this.app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
          if (!areValuesEqual(fm[field], conflict.local)) {
            editedMeanwhile = true;
            liveLocal = fm[field];
            return;
          }
          fm[field] = value;
        });
        if (editedMeanwhile) {
          this.markStale(conflict, liveLocal, currentRemote, result);
          return;
        }
        const written = await this.readNote(file).catch(() => null);
        const local = written && field in written.fields ? written.fields[field] : value;
        this.settle(conflict, { local, remote: currentRemote });
        break;
      }
      case 'keep-local':
        // Pinned: later pulls keep this value until the remote moves.
        this.settle(conflict, { local: currentLocal, remote: currentRemote, pinnedLocal: true });
        break;
    }
    result.applied++;
  }

  /** Reads the note's own text (never the async metadataCache); unparseable → `ApplyError`. */
  private async readNote(file: TFile): Promise<{ recordId: string | null; fields: Record<string, unknown> }> {
    const parsed = this.parser.parseNoteContent(await this.app.vault.read(file));
    if (!parsed) throw new ApplyError(`Frontmatter of ${file.path} could not be read`);
    return parsed;
  }

  private settle(conflict: PendingConflict, baseline: FieldSnapshot): void {
    this.syncState.setFields(conflict.recordId, { [conflict.field]: baseline });
    this.syncState.removeConflict(conflict.recordId, conflict.field);
  }

  /** Re-queues the entry with the values just read, flagged as changed since detected. */
  private markStale(conflict: PendingConflict, local: unknown, remote: unknown, result: ApplyResult): void {
    const refreshed: PendingConflict = { ...conflict, local, remote, stale: true };
    this.syncState.upsertConflict(refreshed);
    result.stale.push(refreshed);
  }

  private drop(conflict: PendingConflict, result: ApplyResult): void {
    this.syncState.removeConflict(conflict.recordId, conflict.field);
    result.removed.push(conflict);
  }
}
