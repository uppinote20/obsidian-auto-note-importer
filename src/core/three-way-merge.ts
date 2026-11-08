/**
 * Pure three-way per-field judgement (snapshot vs local vs remote).
 *
 * @tested tests/core/three-way-merge.test.ts
 */

import { areValuesEqual } from '../utils';
import type { FieldSnapshot } from '../types';

export type FieldVerdict = 'unchanged' | 'local-only' | 'remote-only' | 'both-same' | 'conflict';

/**
 * Judge each field. Local is compared to `snapshot.local` and remote to
 * `snapshot.remote` (never cross-side) so format asymmetry does not read as a
 * change. A field missing from local is never a local change (with or
 * without a snapshot; templates may omit remote fields). Without a snapshot for the field, local and remote are compared directly;
 * a differing field absent from remote (empty cell) is a local fill (`local-only`).
 *
 * `remoteLocalForm` is the remote value as it reads back once written into a
 * note (e.g. an attachment object rendered as its URL label). When given, the
 * cross-side comparisons — local vs remote without a snapshot, and the
 * `both-same` check — use it (falling back to the raw value for fields it
 * lacks). Remote-change detection always compares the raw remote value.
 */
export function threeWayMerge(
  snapshot: Record<string, FieldSnapshot> | undefined,
  local: Record<string, unknown>,
  remote: Record<string, unknown>,
  fieldNames: string[],
  remoteLocalForm?: Record<string, unknown>
): Record<string, FieldVerdict> {
  const result: Record<string, FieldVerdict> = {};

  for (const name of fieldNames) {
    const localValue = local[name];
    const remoteValue = remote[name];
    const base = snapshot?.[name];
    const remoteAsLocal = remoteLocalForm && name in remoteLocalForm ? remoteLocalForm[name] : remoteValue;

    if (!base) {
      const absentLocally = !(name in local);
      if (absentLocally || areValuesEqual(localValue, remoteAsLocal)) {
        result[name] = 'unchanged';
      } else {
        // Remotes omit empty cells (Airtable), so a key missing remotely but
        // filled locally is a local fill, not a disagreement.
        result[name] = name in remote ? 'conflict' : 'local-only';
      }
      continue;
    }

    const localChanged = name in local && !areValuesEqual(localValue, base.local);
    const remoteChanged = !areValuesEqual(remoteValue, base.remote);

    if (!localChanged && !remoteChanged) result[name] = 'unchanged';
    else if (localChanged && !remoteChanged) result[name] = 'local-only';
    else if (!localChanged && remoteChanged) result[name] = 'remote-only';
    else result[name] = areValuesEqual(localValue, remoteAsLocal) ? 'both-same' : 'conflict';
  }

  return result;
}
