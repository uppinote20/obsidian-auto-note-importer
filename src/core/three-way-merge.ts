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
 * without a snapshot; templates may omit remote fields). Without a snapshot for the field, local and remote are compared directly.
 */
export function threeWayMerge(
  snapshot: Record<string, FieldSnapshot> | undefined,
  local: Record<string, unknown>,
  remote: Record<string, unknown>,
  fieldNames: string[]
): Record<string, FieldVerdict> {
  const result: Record<string, FieldVerdict> = {};

  for (const name of fieldNames) {
    const localValue = local[name];
    const remoteValue = remote[name];
    const base = snapshot?.[name];

    if (!base) {
      const absentLocally = !(name in local);
      result[name] = absentLocally || areValuesEqual(localValue, remoteValue) ? 'unchanged' : 'conflict';
      continue;
    }

    const localChanged = name in local && !areValuesEqual(localValue, base.local);
    const remoteChanged = !areValuesEqual(remoteValue, base.remote);

    if (!localChanged && !remoteChanged) result[name] = 'unchanged';
    else if (localChanged && !remoteChanged) result[name] = 'local-only';
    else if (!localChanged && remoteChanged) result[name] = 'remote-only';
    else result[name] = areValuesEqual(localValue, remoteValue) ? 'both-same' : 'conflict';
  }

  return result;
}
