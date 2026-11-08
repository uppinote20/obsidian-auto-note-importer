/**
 * Tests for SyncStateStore persistence and per-config isolation.
 * @covers src/core/sync-state-store.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Notice } from 'obsidian';
import type { DataAdapter } from 'obsidian';
import { SyncStateStore } from '../../src/core/sync-state-store';
import { createMockApp } from '../__mocks__/obsidian.mock';
import type { PendingConflict } from '../../src/types';

const PATH = 'plugins/x/sync-state.json';

function conflict(recordId: string, field: string, local: unknown = 'l'): PendingConflict {
  return {
    recordId, filePath: `${recordId}.md`, field, local, remote: 'r',
    snapshot: null, writable: true, detectedAt: '2026-11-08T00:00:00.000Z',
  };
}

describe('SyncStateStore', () => {
  let app: ReturnType<typeof createMockApp>;
  let adapter: DataAdapter;
  let store: SyncStateStore;

  beforeEach(() => {
    vi.clearAllMocks();
    app = createMockApp();
    adapter = app.vault.adapter as unknown as DataAdapter;
    store = new SyncStateStore(adapter, PATH);
  });

  it('loads empty when no file exists', async () => {
    await store.load();
    expect(store.forConfig('a').getRecord('r1')).toBeUndefined();
    expect(store.allPending()).toEqual([]);
    expect(Notice).not.toHaveBeenCalled();
  });

  it('loads empty and warns once on invalid JSON', async () => {
    app._files.set(PATH, '{not json');
    await store.load();
    expect(store.allPending()).toEqual([]);
    expect(Notice).toHaveBeenCalledTimes(1);
    expect(String((Notice as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0])).toContain('sync-state.json');
  });

  it.each([
    ['wrong version', '{"version":2,"configs":{}}'],
    ['configs is an array', '{"version":1,"configs":[]}'],
    ['config entry missing fields', '{"version":1,"configs":{"a":{}}}'],
    ['records is an array', '{"version":1,"configs":{"a":{"records":[],"pendingConflicts":[]}}}'],
    ['pendingConflicts not an array', '{"version":1,"configs":{"a":{"records":{},"pendingConflicts":{}}}}'],
  ])('rejects malformed file (%s): empty state, one Notice, no throws', async (_n, raw) => {
    app._files.set(PATH, raw);
    await store.load();
    expect(Notice).toHaveBeenCalledTimes(1);
    const h = store.forConfig('a');
    expect(() => h.getRecord('x')).not.toThrow();
    expect(h.getRecord('x')).toBeUndefined();
    expect(h.pendingConflicts()).toEqual([]);
    expect(store.allPending()).toEqual([]);
    expect(() => h.upsertConflict(conflict('x', 'f'))).not.toThrow();
  });

  it('loads a previously flushed state', async () => {
    const h = store.forConfig('a');
    h.setFields('r1', { f: { local: 1, remote: 1 } });
    await store.flush();
    const store2 = new SyncStateStore(adapter, PATH);
    await store2.load();
    expect(store2.forConfig('a').getRecord('r1')?.fields.f).toEqual({ local: 1, remote: 1 });
  });

  it('merges setFields and flushes once only when dirty', async () => {
    const h = store.forConfig('a');
    h.setFields('r1', { f1: { local: 1, remote: 1 } });
    h.setFields('r1', { f2: { local: 2, remote: 2 } });
    const rec = h.getRecord('r1')!;
    expect(Object.keys(rec.fields).sort()).toEqual(['f1', 'f2']);
    expect(rec.syncedAt).toMatch(/^\d{4}-/);
    await store.flush();
    expect(adapter.write).toHaveBeenCalledTimes(1);
    expect(app._files.get(PATH)!.startsWith('{"version":1')).toBe(true);
    await store.flush();
    expect(adapter.write).toHaveBeenCalledTimes(1);
  });

  it('upsertConflict replaces same (recordId, field); removeConflict removes', () => {
    const h = store.forConfig('a');
    h.upsertConflict(conflict('r1', 'f', 'one'));
    h.upsertConflict(conflict('r1', 'f', 'two'));
    h.upsertConflict(conflict('r1', 'g'));
    expect(h.pendingConflicts()).toHaveLength(2);
    expect(h.pendingConflicts().find(c => c.field === 'f')?.local).toBe('two');
    h.removeConflict('r1', 'f');
    expect(h.pendingConflicts().map(c => c.field)).toEqual(['g']);
  });

  it('removeRecord drops the record', () => {
    const h = store.forConfig('a');
    h.setFields('r1', { f: { local: 1, remote: 1 } });
    h.removeRecord('r1');
    expect(h.getRecord('r1')).toBeUndefined();
  });

  it('pruneRecords removes records and their conflicts', () => {
    const h = store.forConfig('a');
    h.setFields('a', { f: { local: 1, remote: 1 } });
    h.setFields('b', { f: { local: 1, remote: 1 } });
    h.upsertConflict(conflict('a', 'f'));
    h.upsertConflict(conflict('b', 'f'));
    h.pruneRecords(new Set(['a']));
    expect(h.getRecord('a')).toBeDefined();
    expect(h.getRecord('b')).toBeUndefined();
    expect(h.pendingConflicts().map(c => c.recordId)).toEqual(['a']);
  });

  it('isolates configs and removeConfig leaves others intact', () => {
    const a = store.forConfig('cfgA');
    const b = store.forConfig('cfgB');
    a.setFields('r', { f: { local: 'A', remote: 'A' } });
    b.setFields('r', { f: { local: 'B', remote: 'B' } });
    a.upsertConflict(conflict('r', 'f'));
    expect(b.pendingConflicts()).toEqual([]);
    expect(b.getRecord('r')?.fields.f.local).toBe('B');
    store.removeConfig('cfgA');
    expect(store.forConfig('cfgA').getRecord('r')).toBeUndefined();
    expect(store.forConfig('cfgB').getRecord('r')?.fields.f.local).toBe('B');
    expect(store.allPending()).toEqual([]);
  });

  it('retainConfigs drops absent configs and keeps present ones', async () => {
    store.forConfig('cfgA').setFields('r', { f: { local: 'A', remote: 'A' } });
    store.forConfig('cfgB').setFields('r', { f: { local: 'B', remote: 'B' } });
    store.retainConfigs(new Set(['cfgB']));
    expect(store.forConfig('cfgA').getRecord('r')).toBeUndefined();
    expect(store.forConfig('cfgB').getRecord('r')?.fields.f.local).toBe('B');
  });

  it('flush after a no-op retainConfigs writes nothing', async () => {
    store.forConfig('a').setFields('r', { f: { local: 1, remote: 1 } });
    await store.flush();
    expect(adapter.write).toHaveBeenCalledTimes(1);
    store.retainConfigs(new Set(['a']));
    await store.flush();
    expect(adapter.write).toHaveBeenCalledTimes(1);
  });

  it('allPending spans configs', () => {
    store.forConfig('a').upsertConflict(conflict('r1', 'f'));
    store.forConfig('b').upsertConflict(conflict('r2', 'f'));
    expect(store.allPending().map(e => e.configId).sort()).toEqual(['a', 'b']);
  });

  it('keeps state and retries when write fails', async () => {
    store.forConfig('a').setFields('r1', { f: { local: 1, remote: 1 } });
    (adapter.write as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('disk'));
    await store.flush();
    expect(Notice).toHaveBeenCalledTimes(1);
    expect(app._files.has(PATH)).toBe(false);
    await store.flush();
    expect(adapter.write).toHaveBeenCalledTimes(2);
    expect(app._files.has(PATH)).toBe(true);
  });
});
