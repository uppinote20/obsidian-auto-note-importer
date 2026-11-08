/**
 * Tests for three-way-merge field judgement.
 * @covers src/core/three-way-merge.ts
 */

import { describe, it, expect } from 'vitest';
import { threeWayMerge } from '../../src/core/three-way-merge';
import type { FieldSnapshot } from '../../src/types';

const F = ['F'];
const judge = (
  snapshot: Record<string, FieldSnapshot> | undefined,
  local: Record<string, unknown>,
  remote: Record<string, unknown>
) => threeWayMerge(snapshot, local, remote, F).F;

describe('threeWayMerge', () => {
  describe('no snapshot', () => {
    it('equal values are unchanged', () => {
      expect(judge(undefined, { F: 1 }, { F: 1 })).toBe('unchanged');
    });
    it('differing values are a conflict', () => {
      expect(judge(undefined, { F: 1 }, { F: 2 })).toBe('conflict');
    });
    it('field absent from both is unchanged', () => {
      expect(judge(undefined, {}, {})).toBe('unchanged');
    });
    it('field absent from local but present in remote is unchanged', () => {
      expect(judge(undefined, {}, { F: 'x' })).toBe('unchanged');
    });
    it('field present locally but absent remotely is local-only (filling an empty remote cell)', () => {
      expect(judge(undefined, { F: 'Done' }, {})).toBe('local-only');
    });
    it('empty local value with the field absent remotely is unchanged', () => {
      expect(judge(undefined, { F: null }, {})).toBe('unchanged');
    });
    it('snapshot lacking the field is treated as no snapshot', () => {
      expect(judge({ G: { local: 1, remote: 1 } }, { F: 1 }, { F: 2 })).toBe('conflict');
      expect(judge({ G: { local: 1, remote: 1 } }, { F: 1 }, { F: 1 })).toBe('unchanged');
    });
  });

  describe('with snapshot', () => {
    const snap = { F: { local: 1, remote: 1 } };
    it('1/1 unchanged', () => expect(judge(snap, { F: 1 }, { F: 1 })).toBe('unchanged'));
    it('2/1 local-only', () => expect(judge(snap, { F: 2 }, { F: 1 })).toBe('local-only'));
    it('1/2 remote-only', () => expect(judge(snap, { F: 1 }, { F: 2 })).toBe('remote-only'));
    it('2/2 both-same', () => expect(judge(snap, { F: 2 }, { F: 2 })).toBe('both-same'));
    it('2/3 conflict', () => expect(judge(snap, { F: 2 }, { F: 3 })).toBe('conflict'));

    it('field absent from local is not a local change (remote same)', () => {
      expect(judge(snap, {}, { F: 1 })).toBe('unchanged');
    });
    it('field absent from local is not a local change (remote changed)', () => {
      expect(judge(snap, {}, { F: 2 })).toBe('remote-only');
    });

    it('both absent with undefined snapshot values is unchanged', () => {
      expect(judge({ F: { local: undefined, remote: undefined } }, {}, {})).toBe('unchanged');
    });
    it('remote absent vs snapshot remote value is remote-only', () => {
      expect(judge({ F: { local: 'x', remote: 'x' } }, { F: 'x' }, {})).toBe('remote-only');
    });

    it('format asymmetry between local and remote snapshot is unchanged', () => {
      expect(judge({ F: { local: 'a\n', remote: 'a' } }, { F: 'a\n' }, { F: 'a' })).toBe('unchanged');
    });
  });

  describe('remote value in local form (cross-form comparisons)', () => {
    const judgeForm = (
      snapshot: Record<string, FieldSnapshot> | undefined,
      local: Record<string, unknown>,
      remote: Record<string, unknown>,
      remoteLocalForm: Record<string, unknown>,
    ) => threeWayMerge(snapshot, local, remote, F, remoteLocalForm).F;
    const obj = (url: string, sig = 1) => [{ url, filename: 'a.png', sig }];

    it('no snapshot: local equal to the remote local form is unchanged', () => {
      expect(judgeForm(undefined, { F: ['u'] }, { F: obj('u') }, { F: ['u'] })).toBe('unchanged');
      // Without the local form the raw object never matches the label.
      expect(judge(undefined, { F: ['u'] }, { F: obj('u') })).toBe('conflict');
    });
    it('no snapshot: local differing from the remote local form is a conflict', () => {
      expect(judgeForm(undefined, { F: ['v'] }, { F: obj('u') }, { F: ['u'] })).toBe('conflict');
    });
    it('both changed: equal to the remote local form is both-same, else conflict', () => {
      const snap = { F: { local: ['a'], remote: obj('a') } };
      expect(judgeForm(snap, { F: ['b'] }, { F: obj('b') }, { F: ['b'] })).toBe('both-same');
      expect(judgeForm(snap, { F: ['c'] }, { F: obj('b') }, { F: ['b'] })).toBe('conflict');
    });
    it('remote-change detection still uses the raw remote value', () => {
      const snap = { F: { local: ['a'], remote: obj('a', 1) } };
      expect(judgeForm(snap, { F: ['a'] }, { F: obj('a', 2) }, { F: ['a'] })).toBe('remote-only');
    });
    it('a field missing from the local form falls back to the raw remote value', () => {
      expect(judgeForm(undefined, { F: 1 }, { F: 1 }, {})).toBe('unchanged');
      expect(judgeForm(undefined, { F: ['u'] }, { F: obj('u') }, {})).toBe('conflict');
    });
  });
  describe('pinned local value (keep local)', () => {
    const pin = (local: unknown, remote: unknown) => ({ F: { local, remote, pinnedLocal: true as const } });
    it('remote unchanged: pinned, even after a further local edit', () => {
      expect(judge(pin(5, 1), { F: 5 }, { F: 1 })).toBe('pinned');
      expect(judge(pin(5, 1), { F: 6 }, { F: 1 })).toBe('pinned');
    });
    it('remote unchanged and local back to the remote value: unchanged', () => {
      expect(judge(pin(5, 1), { F: 1 }, { F: 1 })).toBe('unchanged');
    });
    it('remote moved: the pin no longer holds — a differing local value is a conflict', () => {
      expect(judge(pin(5, 1), { F: 5 }, { F: 2 })).toBe('conflict');
      expect(judge(pin(5, 1), { F: 5 }, { F: 5 })).toBe('both-same');
    });
    it('a pinned field missing locally is judged without the pin', () => {
      expect(judge(pin(5, 1), {}, { F: 1 })).toBe('unchanged');
      expect(judge(pin(5, 1), {}, { F: 2 })).toBe('remote-only');
    });
  });
});
