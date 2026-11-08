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

  it('removeConflictsForPath drops entries of that note (or folder) in every config', () => {
    store.forConfig('a').upsertConflict({ ...conflict('r1', 'f'), filePath: 'Sync/A.md' });
    store.forConfig('b').upsertConflict({ ...conflict('r2', 'f'), filePath: 'Sync/A.md' });
    store.forConfig('b').upsertConflict({ ...conflict('r3', 'f'), filePath: 'Sync/Sub/B.md' });
    store.forConfig('b').upsertConflict({ ...conflict('r4', 'f'), filePath: 'Sync/AB.md' });
    expect(store.removeConflictsForPath('Sync/A.md')).toBe(true);
    expect(store.allPending().map(e => e.conflict.recordId)).toEqual(['r3', 'r4']);
    expect(store.removeConflictsForPath('Sync/Sub')).toBe(true);
    expect(store.allPending().map(e => e.conflict.recordId)).toEqual(['r4']);
    expect(store.removeConflictsForPath('Other.md')).toBe(false);
  });

  it('renameConflictPath follows a renamed note or folder', async () => {
    store.forConfig('a').upsertConflict({ ...conflict('r1', 'f'), filePath: 'Sync/A.md' });
    store.forConfig('a').upsertConflict({ ...conflict('r2', 'f'), filePath: 'Sync/Sub/B.md' });
    store.forConfig('a').upsertConflict({ ...conflict('r3', 'f'), filePath: 'Sync/SubX.md' });
    expect(store.renameConflictPath('Sync/A.md', 'Sync/A2.md')).toBe(true);
    expect(store.renameConflictPath('Sync/Sub', 'Sync/New')).toBe(true);
    expect(store.renameConflictPath('None.md', 'X.md')).toBe(false);
    expect(store.allPending().map(e => e.conflict.filePath)).toEqual(['Sync/A2.md', 'Sync/New/B.md', 'Sync/SubX.md']);
    await store.flush();
    expect(adapter.write).toHaveBeenCalledTimes(1);
  });

  it('an empty path matches nothing for remove and rename', () => {
    store.forConfig('a').upsertConflict({ ...conflict('r1', 'f'), filePath: '' });
    expect(store.removeConflictsForPath('')).toBe(false);
    expect(store.renameConflictPath('', 'X.md')).toBe(false);
    expect(store.allPending().map(e => e.conflict.filePath)).toEqual(['']);
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
  it('persists a mutation made while a write is in flight on the next flush', async () => {
    const h = store.forConfig('a');
    h.setFields('r1', { f: { local: 1, remote: 1 } });
    const write = adapter.write as unknown as ReturnType<typeof vi.fn>;
    let release!: () => void;
    write.mockImplementationOnce((path: string, data: string) => new Promise<void>(resolve => {
      release = () => { app._files.set(path, data); resolve(); };
    }));
    const first = store.flush();
    await vi.waitFor(() => expect(write).toHaveBeenCalledTimes(1));
    h.setFields('r1', { g: { local: 2, remote: 2 } });
    release();
    await first;
    await store.flush();
    expect(write).toHaveBeenCalledTimes(2);
    expect(JSON.parse(app._files.get(PATH)!).configs.a.records.r1.fields.g).toEqual({ local: 2, remote: 2 });
  });

  it('serializes overlapping flushes so the later state lands last', async () => {
    const h = store.forConfig('a');
    const write = adapter.write as unknown as ReturnType<typeof vi.fn>;
    const order: string[] = [];
    let releaseFirst!: () => void;
    write.mockImplementationOnce((path: string, data: string) => new Promise<void>(resolve => {
      releaseFirst = () => { order.push('first'); app._files.set(path, data); resolve(); };
    }));
    write.mockImplementationOnce(async (path: string, data: string) => {
      order.push('second');
      app._files.set(path, data);
    });
    h.setFields('r1', { f: { local: 1, remote: 1 } });
    const first = store.flush();
    await vi.waitFor(() => expect(write).toHaveBeenCalledTimes(1));
    h.setFields('r1', { f: { local: 2, remote: 2 } });
    const second = store.flush();
    await new Promise(resolve => setTimeout(resolve, 0));
    releaseFirst();
    await Promise.all([first, second]);
    expect(order).toEqual(['first', 'second']);
    expect(JSON.parse(app._files.get(PATH)!).configs.a.records.r1.fields.f).toEqual({ local: 2, remote: 2 });
  });

  it('never writes in a session whose existing file could not be read', async () => {
    app._files.set(PATH, '{"version":1,"configs":{"a":{"records":{"r1":{"syncedAt":"x","fields":{}}},"pendingConflicts":[]}}}');
    (adapter.read as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('EAGAIN'));
    await store.load();
    expect(Notice).toHaveBeenCalledTimes(1);
    expect(String((Notice as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0])).toMatch(/^Auto Note Importer: /);
    store.forConfig('a').setFields('r2', { f: { local: 1, remote: 1 } });
    await store.flush();
    await store.flush();
    expect(adapter.write).not.toHaveBeenCalled();
    expect(Notice).toHaveBeenCalledTimes(1);
  });
});
