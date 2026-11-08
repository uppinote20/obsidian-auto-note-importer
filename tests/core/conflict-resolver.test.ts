/**
 * Tests for the conflict-resolver verdict → plan mapping.
 * @covers src/core/conflict-resolver.ts
 */

import { describe, it, expect } from 'vitest';

import { planPush, planPull } from '../../src/core/conflict-resolver';
import type { FieldVerdict } from '../../src/core/three-way-merge';

describe('planPush / planPull', () => {
  const verdicts: Record<string, FieldVerdict> = {
    u: 'unchanged',
    lo: 'local-only',
    ro: 'remote-only',
    bs: 'both-same',
    c: 'conflict',
    ro_field: 'conflict',
  };
  const local = { u: 1, lo: 2, ro: 3, bs: 4, c: 5, ro_field: 6, outside: 7 };
  const all = () => true;
  const notRo = (f: string) => f !== 'ro_field';

  describe('planPush', () => {
    it('obsidian-wins sends every writable verdict field with a local value', () => {
      const plan = planPush('obsidian-wins', verdicts, local, notRo);
      expect(plan.send).toEqual({ u: 1, lo: 2, ro: 3, bs: 4, c: 5 });
      expect(plan.overwroteRemote).toEqual(['ro', 'c']);
      expect(plan.enqueue).toEqual([]);
    });

    it('obsidian-wins skips fields with no local value', () => {
      const plan = planPush('obsidian-wins', { a: 'unchanged', b: 'conflict' }, { a: undefined }, all);
      expect(plan.send).toEqual({});
      expect(plan.overwroteRemote).toEqual([]);
    });

    it.each(['remote-wins', 'manual'] as const)('%s sends only writable local-only', (mode) => {
      const plan = planPush(mode, verdicts, local, notRo);
      expect(plan.send).toEqual({ lo: 2 });
      expect(plan.overwroteRemote).toEqual([]);
    });

    it('manual enqueues writable conflicts, remote-wins does not', () => {
      expect(planPush('manual', verdicts, local, notRo).enqueue).toEqual(['c']);
      expect(planPush('remote-wins', verdicts, local, notRo).enqueue).toEqual([]);
    });

    it.each(['remote-only', 'unchanged', 'both-same'] as const)(
      'obsidian-wins does not send a null local value judged %s (never clears remote blind)',
      (verdict) => {
        const plan = planPush('obsidian-wins', { Status: verdict, Title: verdict }, { Status: null, Title: 't' }, all);
        expect(plan.send).toEqual({ Title: 't' });
        expect(plan.overwroteRemote).not.toContain('Status');
      },
    );

    it.each(['local-only', 'conflict'] as const)('obsidian-wins sends a null local value judged %s', (verdict) => {
      const plan = planPush('obsidian-wins', { Status: verdict }, { Status: null }, all);
      expect(plan.send).toEqual({ Status: null });
    });

    it.each(['remote-wins', 'manual'] as const)('%s sends a locally cleared (null) local-only field', (mode) => {
      const plan = planPush(mode, { Status: 'local-only' }, { Status: null }, all);
      expect(plan.send).toEqual({ Status: null });
    });

    it.each(['obsidian-wins', 'remote-wins', 'manual'] as const)('%s never sends non-writable fields', (mode) => {
      const plan = planPush(mode, verdicts, local, () => false);
      expect(plan.send).toEqual({});
    });
  });

  describe('planPull', () => {
    it('obsidian-wins keeps local-only and conflict regardless of writability', () => {
      const plan = planPull('obsidian-wins', verdicts, notRo);
      expect(plan.keepLocal).toEqual(['lo', 'c', 'ro_field']);
      expect(plan.restoredRemote).toEqual([]);
      expect(plan.enqueue).toEqual([]);
    });

    it('remote-wins keeps writable local-only, restores conflicts and non-writable local-only', () => {
      const v: Record<string, FieldVerdict> = { lo: 'local-only', nlo: 'local-only', c: 'conflict' };
      const plan = planPull('remote-wins', v, (f) => f !== 'nlo');
      expect(plan.keepLocal).toEqual(['lo']);
      expect(plan.restoredRemote).toEqual(['nlo', 'c']);
      expect(plan.enqueue).toEqual([]);
    });

    it('manual keeps local-only + conflict, enqueues conflict + non-writable local-only', () => {
      const v: Record<string, FieldVerdict> = { lo: 'local-only', nlo: 'local-only', c: 'conflict' };
      const plan = planPull('manual', v, (f) => f !== 'nlo');
      expect(plan.keepLocal).toEqual(['lo', 'nlo', 'c']);
      expect(plan.enqueue).toEqual(['nlo', 'c']);
      expect(plan.restoredRemote).toEqual([]);
    });
  });
});
