/**
 * The modal applies the values it rendered, not the store's current entries.
 * @covers src/ui/modals/conflict-resolution-modal.ts
 */

import { describe, it, expect } from 'vitest';
import { buildApplyList } from '../../../src/ui/modals/conflict-resolution-modal';
import type { RenderedConflict } from '../../../src/ui/modals/conflict-resolution-modal';
import type { ConflictChoice } from '../../../src/core/conflict-applier';
import type { PendingConflict } from '../../../src/types';

function conflict(overrides: Partial<PendingConflict> = {}): PendingConflict {
  return {
    recordId: 'rec1', filePath: 'Sync/Note.md', field: 'Status', local: 'Local', remote: 'Remote',
    snapshot: null, writable: true, detectedAt: '2026-11-08T00:00:00.000Z', ...overrides,
  };
}

describe('buildApplyList', () => {
  it('uses the rendered conflict objects, grouped by config, skipping later', () => {
    const shownA = conflict();
    const shownB = conflict({ field: 'Other' });
    const shownC = conflict({ recordId: 'rec2' });
    const rendered = new Map<string, RenderedConflict>([
      ['a', { configId: 'cfg-1', conflict: shownA }],
      ['b', { configId: 'cfg-1', conflict: shownB }],
      ['c', { configId: 'cfg-2', conflict: shownC }],
    ]);
    const choices = new Map<string, ConflictChoice>([['a', 'obsidian'], ['b', 'later'], ['c', 'remote']]);

    const list = buildApplyList(rendered, choices, new Set(['a', 'b', 'c']));

    expect([...list.keys()]).toEqual(['cfg-1', 'cfg-2']);
    expect(list.get('cfg-1')).toEqual([{ conflict: shownA, choice: 'obsidian' }]);
    expect(list.get('cfg-1')?.[0].conflict).toBe(shownA);
    expect(list.get('cfg-2')?.[0].conflict).toBe(shownC);
  });

  it('ignores choices for rows that are not rendered and defaults missing choices to later', () => {
    const rendered = new Map<string, RenderedConflict>([['a', { configId: 'cfg-1', conflict: conflict() }]]);
    expect(buildApplyList(rendered, new Map([['zz', 'obsidian']]), new Set(['a', 'zz'])).size).toBe(0);
  });

  it('skips rendered rows no longer pending (a sync settled them; re-queueing them would resurrect them)', () => {
    const rendered = new Map<string, RenderedConflict>([['a', { configId: 'cfg-1', conflict: conflict() }]]);
    expect(buildApplyList(rendered, new Map([['a', 'obsidian']]), new Set()).size).toBe(0);
  });
});
