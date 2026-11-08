/**
 * Conflict detection and resolution for bidirectional sync.
 *
 * @handbook 9.5-conflict-resolution-modes
 * @tested tests/core/conflict-resolver.test.ts
 * @tested e2e:tests/e2e/run-e2e.mjs
 */

import { Notice } from "obsidian";
import { areValuesEqual, assertNever } from '../utils';
import type { LegacySettings, ConflictInfo, SyncResult, DatabaseProvider, ConflictResolutionMode } from '../types';
import type { FieldVerdict } from './three-way-merge';

/**
 * Handles conflict detection and resolution between Obsidian and the remote database.
 */
export class ConflictResolver {
  private settings: LegacySettings;
  private provider: DatabaseProvider;

  constructor(settings: LegacySettings, provider: DatabaseProvider) {
    this.settings = settings;
    this.provider = provider;
  }

  /**
   * Updates the settings reference.
   */
  updateSettings(settings: LegacySettings): void {
    this.settings = settings;
  }

  /**
   * Detects conflicts between Obsidian and the remote database field values.
   */
  async detectConflicts(
    recordId: string,
    obsidianFields: Record<string, unknown>,
    filePath: string
  ): Promise<ConflictInfo[]> {
    const record = await this.provider.fetchRecord(recordId);

    if (!record) {
      return [];
    }

    const conflicts: ConflictInfo[] = [];

    for (const [field, obsidianValue] of Object.entries(obsidianFields)) {
      const remoteValue = record.fields[field];

      if (remoteValue !== undefined && !areValuesEqual(obsidianValue, remoteValue)) {
        conflicts.push({
          field,
          obsidianValue,
          remoteValue,
          recordId,
          filePath
        });
      }
    }

    return conflicts;
  }

  /**
   * Handles detected conflicts based on the resolution strategy.
   */
  async resolve(
    conflicts: ConflictInfo[],
    fieldsToSync: Record<string, unknown>,
    recordId: string
  ): Promise<SyncResult> {
    switch (this.settings.conflictResolution) {
      case 'obsidian-wins':
        return this.provider.updateRecord(recordId, fieldsToSync);

      case 'remote-wins':
        return this.resolveRemoteWins(conflicts, fieldsToSync, recordId);

      case 'manual':
        return this.resolveManual(conflicts, recordId);

      default:
        return assertNever(this.settings.conflictResolution, 'Unknown conflict resolution mode');
    }
  }

  /**
   * Resolves conflicts by letting the remote win.
   */
  private async resolveRemoteWins(
    conflicts: ConflictInfo[],
    fieldsToSync: Record<string, unknown>,
    recordId: string
  ): Promise<SyncResult> {
    const conflictedFieldNames = new Set(conflicts.map(c => c.field));
    const nonConflictedFields: Record<string, unknown> = {};

    for (const [field, value] of Object.entries(fieldsToSync)) {
      if (!conflictedFieldNames.has(field)) {
        nonConflictedFields[field] = value;
      }
    }

    if (conflicts.length > 0) {
      const conflictFields = conflicts.map(c => c.field).join(', ');
      new Notice(`Auto Note Importer: Conflicted fields ignored (remote wins): ${conflictFields}`);
    }

    if (Object.keys(nonConflictedFields).length > 0) {
      return this.provider.updateRecord(recordId, nonConflictedFields);
    }

    return {
      success: true,
      recordId,
      updatedFields: {},
    };
  }

  /**
   * Resolves conflicts with manual mode (show notification, don't sync).
   */
  private resolveManual(conflicts: ConflictInfo[], recordId: string): SyncResult {
    const conflictFields = conflicts.map(c => c.field).join(', ');
    new Notice(`Auto Note Importer: Conflicts detected in fields: ${conflictFields}. Please resolve manually.`);

    return {
      success: false,
      recordId,
      error: `Conflicts detected in fields: ${conflictFields}`
    };
  }

  /**
   * Checks if conflict detection should be skipped.
   */
  shouldSkipConflictDetection(): boolean {
    return this.settings.conflictResolution === 'obsidian-wins';
  }
}

/** Fields to push and bookkeeping for a push, derived from three-way verdicts. */
export interface PushPlan {
  send: Record<string, unknown>;
  overwroteRemote: string[];
  enqueue: string[];
}

/** How to treat each field when pulling remote values into a note. */
export interface PullPlan {
  keepLocal: string[];
  restoredRemote: string[];
  enqueue: string[];
}

/**
 * Maps verdicts to a push plan for the given conflict mode.
 * Non-writable fields are never sent.
 */
export function planPush(
  mode: ConflictResolutionMode,
  verdicts: Record<string, FieldVerdict>,
  local: Record<string, unknown>,
  writable: (field: string) => boolean
): PushPlan {
  const plan: PushPlan = { send: {}, overwroteRemote: [], enqueue: [] };

  for (const [field, verdict] of Object.entries(verdicts)) {
    if (!writable(field)) continue;
    const hasLocal = field in local && local[field] !== undefined;

    if (mode === 'obsidian-wins') {
      if (!hasLocal) continue;
      plan.send[field] = local[field];
      if (verdict === 'conflict' || verdict === 'remote-only') {
        plan.overwroteRemote.push(field);
      }
    } else if (verdict === 'local-only') {
      if (hasLocal) plan.send[field] = local[field];
    } else if (verdict === 'conflict' && mode === 'manual') {
      plan.enqueue.push(field);
    }
  }

  return plan;
}

/**
 * Maps verdicts to a pull plan for the given conflict mode.
 */
export function planPull(
  mode: ConflictResolutionMode,
  verdicts: Record<string, FieldVerdict>,
  writable: (field: string) => boolean
): PullPlan {
  const plan: PullPlan = { keepLocal: [], restoredRemote: [], enqueue: [] };

  for (const [field, verdict] of Object.entries(verdicts)) {
    const localOnly = verdict === 'local-only';
    const conflict = verdict === 'conflict';
    if (!localOnly && !conflict) continue;
    const canPush = writable(field);

    switch (mode) {
      case 'obsidian-wins':
        plan.keepLocal.push(field);
        break;
      case 'remote-wins':
        if (localOnly && canPush) plan.keepLocal.push(field);
        else plan.restoredRemote.push(field);
        break;
      case 'manual':
        plan.keepLocal.push(field);
        if (conflict || !canPush) plan.enqueue.push(field);
        break;
      default:
        assertNever(mode);
    }
  }

  return plan;
}
