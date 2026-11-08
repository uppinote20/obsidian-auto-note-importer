/**
 * Maps three-way field verdicts to per-mode push / pull plans.
 *
 * @handbook 9.5-conflict-resolution-modes
 * @tested tests/core/conflict-resolver.test.ts
 * @tested e2e:tests/e2e/run-e2e.mjs
 */

import { assertNever } from '../utils';
import type { ConflictResolutionMode } from '../types';
import type { FieldVerdict } from './three-way-merge';

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
