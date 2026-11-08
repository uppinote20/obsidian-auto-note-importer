/**
 * Tests for ConflictApplier.
 * @covers src/core/conflict-applier.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ConflictApplier } from '../../src/core/conflict-applier';
import type { ConflictChoice } from '../../src/core/conflict-applier';
import { SyncStateStore } from '../../src/core/sync-state-store';
import type { ConfigSyncStateHandle } from '../../src/core/sync-state-store';
import { FrontmatterParser } from '../../src/file-operations/frontmatter-parser';
import type { PendingConflict } from '../../src/types';
import { createMockApp } from 'obsidian';
import { createMockDatabaseProvider } from '../__mocks__/database-client.mock';
import type { App, DataAdapter } from 'obsidian';
import { dump } from 'js-yaml';

const PATH = 'Sync/Note.md';

function noteContent(frontmatter: Record<string, unknown>): string {
  return `---\n${dump(frontmatter)}---\nbody\n`;
}

function conflict(overrides: Partial<PendingConflict> = {}): PendingConflict {
  return {
    recordId: 'rec1',
    filePath: PATH,
    field: 'Status',
    local: 'Local',
    remote: 'Remote',
    snapshot: { local: 'Base', remote: 'Base' },
    writable: true,
    detectedAt: '2026-11-08T00:00:00.000Z',
    ...overrides,
  };
}

describe('ConflictApplier', () => {
  let app: ReturnType<typeof createMockApp>;
  let provider: ReturnType<typeof createMockDatabaseProvider>;
  let store: SyncStateStore;
  let state: ConfigSyncStateHandle;
  let parser: FrontmatterParser;

  function applier(bidirectional = true): ConflictApplier {
    return new ConflictApplier(app as unknown as App, state, provider as never, parser, bidirectional);
  }

  function seed(c: PendingConflict): void {
    state.upsertConflict(c);
  }

  function noteFields(path = PATH): Record<string, unknown> {
    return parser.parseFieldsFromContent(app._files.get(path) ?? '') ?? {};
  }

  beforeEach(() => {
    vi.clearAllMocks();
    app = createMockApp();
    provider = createMockDatabaseProvider();
    store = new SyncStateStore(app.vault.adapter as unknown as DataAdapter, 'sync-state.json');
    state = store.forConfig('cfg-1');
    parser = new FrontmatterParser(app as unknown as App);

    app._files.set(PATH, noteContent({ primaryField: 'rec1', Status: 'Local', Other: 'x' }));
    provider.fetchRecord.mockResolvedValue({ id: 'rec1', primaryField: 'rec1', fields: { Status: 'Remote', Other: 'x' } });
    provider.updateRecord.mockResolvedValue({ success: true, recordId: 'rec1', updatedFields: { Status: 'Local' } });
  });

  it('later is a no-op', async () => {
    seed(conflict());
    const result = await applier().apply([{ conflict: conflict(), choice: 'later' }]);
    expect(result).toEqual({ applied: 0, stale: [], failed: [], removed: [] });
    expect(provider.fetchRecord).not.toHaveBeenCalled();
    expect(provider.updateRecord).not.toHaveBeenCalled();
    expect(app.fileManager.processFrontMatter).not.toHaveBeenCalled();
    expect(state.pendingConflicts()).toHaveLength(1);
  });

  it('obsidian writes only the remote field, records the echo baseline, clears the entry', async () => {
    seed(conflict());
    provider.updateRecord.mockResolvedValue({ success: true, recordId: 'rec1', updatedFields: { Status: 'local' } });
    const result = await applier().apply([{ conflict: conflict(), choice: 'obsidian' }]);
    expect(result.applied).toBe(1);
    expect(provider.updateRecord).toHaveBeenCalledWith('rec1', { Status: 'Local' });
    expect(app.fileManager.processFrontMatter).not.toHaveBeenCalled();
    expect(app.vault.modify).not.toHaveBeenCalled();
    expect(state.getRecord('rec1')?.fields.Status).toEqual({ local: 'Local', remote: 'local' });
    expect(state.pendingConflicts()).toHaveLength(0);
  });

  it('obsidian falls back to the sent value when the provider echoes nothing', async () => {
    seed(conflict());
    provider.updateRecord.mockResolvedValue({ success: true, recordId: 'rec1' });
    await applier().apply([{ conflict: conflict(), choice: 'obsidian' }]);
    expect(state.getRecord('rec1')?.fields.Status).toEqual({ local: 'Local', remote: 'Local' });
  });

  it('remote writes only the note field via processFrontMatter, records the re-parsed baseline, clears the entry', async () => {
    seed(conflict());
    const result = await applier().apply([{ conflict: conflict(), choice: 'remote' }]);
    expect(result.applied).toBe(1);
    expect(provider.updateRecord).not.toHaveBeenCalled();
    expect(provider.batchUpdate).not.toHaveBeenCalled();
    expect(app.fileManager.processFrontMatter).toHaveBeenCalledTimes(1);
    expect(noteFields()).toEqual({ Status: 'Remote', Other: 'x' });
    expect(app._files.get(PATH)).toContain('body');
    expect(state.getRecord('rec1')?.fields.Status).toEqual({ local: 'Remote', remote: 'Remote' });
    expect(state.pendingConflicts()).toHaveLength(0);
  });

  it('remote writes an object value as its label (the form the note builder writes)', async () => {
    const remoteValue = { id: 'u1', name: 'Alice' };
    seed(conflict({ remote: remoteValue, writable: false }));
    provider.fetchRecord.mockResolvedValue({ id: 'rec1', primaryField: 'rec1', fields: { Status: remoteValue } });
    await applier().apply([{ conflict: conflict({ remote: remoteValue, writable: false }), choice: 'remote' }]);
    expect(noteFields().Status).toBe('Alice');
    expect(state.getRecord('rec1')?.fields.Status).toEqual({ local: 'Alice', remote: remoteValue });
  });

  it('keep-local writes neither side and makes the current values the baseline', async () => {
    seed(conflict());
    const before = app._files.get(PATH);
    const result = await applier().apply([{ conflict: conflict(), choice: 'keep-local' }]);
    expect(result.applied).toBe(1);
    expect(provider.updateRecord).not.toHaveBeenCalled();
    expect(app.fileManager.processFrontMatter).not.toHaveBeenCalled();
    expect(app._files.get(PATH)).toBe(before);
    expect(state.getRecord('rec1')?.fields.Status).toEqual({ local: 'Local', remote: 'Remote', pinnedLocal: true });
    expect(state.pendingConflicts()).toHaveLength(0);
  });

  it.each<ConflictChoice>(['obsidian', 'remote', 'keep-local'])('%s: a changed remote marks the entry stale and writes nothing', async (choice) => {
    seed(conflict());
    provider.fetchRecord.mockResolvedValue({ id: 'rec1', primaryField: 'rec1', fields: { Status: 'Remote 2' } });
    const result = await applier().apply([{ conflict: conflict(), choice }]);
    expect(result.applied).toBe(0);
    expect(result.stale).toHaveLength(1);
    expect(result.stale[0]).toMatchObject({ local: 'Local', remote: 'Remote 2', stale: true });
    expect(provider.updateRecord).not.toHaveBeenCalled();
    expect(app.fileManager.processFrontMatter).not.toHaveBeenCalled();
    expect(state.getRecord('rec1')).toBeUndefined();
    expect(state.pendingConflicts()).toEqual([expect.objectContaining({ remote: 'Remote 2', stale: true })]);
  });

  it.each<ConflictChoice>(['obsidian', 'remote', 'keep-local'])('%s: a changed note marks the entry stale and writes nothing', async (choice) => {
    seed(conflict());
    app._files.set(PATH, noteContent({ primaryField: 'rec1', Status: 'Local 2' }));
    const result = await applier().apply([{ conflict: conflict(), choice }]);
    expect(result.stale).toEqual([expect.objectContaining({ local: 'Local 2', remote: 'Remote', stale: true })]);
    expect(provider.updateRecord).not.toHaveBeenCalled();
    expect(app.fileManager.processFrontMatter).not.toHaveBeenCalled();
    expect(state.getRecord('rec1')).toBeUndefined();
    expect(state.pendingConflicts()).toEqual([expect.objectContaining({ local: 'Local 2', stale: true })]);
  });

  it.each<ConflictChoice>(['obsidian', 'remote'])('%s: the shown values are judged, even after a sync re-queued moved values', async (choice) => {
    const shown = conflict();
    seed(shown);
    // An auto sync re-detects the conflict with a moved remote while the modal is open.
    seed(conflict({ remote: 'Remote 2' }));
    provider.fetchRecord.mockResolvedValue({ id: 'rec1', primaryField: 'rec1', fields: { Status: 'Remote 2' } });
    const result = await applier().apply([{ conflict: shown, choice }]);
    expect(result.applied).toBe(0);
    expect(result.stale).toEqual([expect.objectContaining({ remote: 'Remote 2', stale: true })]);
    expect(provider.updateRecord).not.toHaveBeenCalled();
    expect(app.fileManager.processFrontMatter).not.toHaveBeenCalled();
  });

  it('a stale entry applies once its refreshed values still hold', async () => {
    const refreshed = conflict({ remote: 'Remote 2', stale: true });
    seed(refreshed);
    provider.fetchRecord.mockResolvedValue({ id: 'rec1', primaryField: 'rec1', fields: { Status: 'Remote 2' } });
    const result = await applier().apply([{ conflict: refreshed, choice: 'keep-local' }]);
    expect(result.applied).toBe(1);
    expect(state.pendingConflicts()).toHaveLength(0);
  });

  it('obsidian is refused when bidirectional sync is off', async () => {
    seed(conflict());
    const result = await applier(false).apply([{ conflict: conflict(), choice: 'obsidian' }]);
    expect(result.applied).toBe(0);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].error).toMatch(/bidirectional/i);
    expect(provider.updateRecord).not.toHaveBeenCalled();
    expect(state.pendingConflicts()).toHaveLength(1);
  });

  it('obsidian is refused for a non-writable field', async () => {
    seed(conflict({ writable: false }));
    const result = await applier().apply([{ conflict: conflict({ writable: false }), choice: 'obsidian' }]);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].error).toMatch(/can't be written|not writable|read-only/i);
    expect(provider.updateRecord).not.toHaveBeenCalled();
    expect(state.pendingConflicts()).toHaveLength(1);
  });

  it('one failed write keeps that entry and still applies the others', async () => {
    const a = conflict();
    const b = conflict({ field: 'Other', local: 'x', remote: 'y' });
    seed(a);
    seed(b);
    provider.fetchRecord.mockResolvedValue({ id: 'rec1', primaryField: 'rec1', fields: { Status: 'Remote', Other: 'y' } });
    provider.updateRecord.mockResolvedValueOnce({ success: false, recordId: 'rec1', error: 'HTTP 422' });
    const result = await applier().apply([
      { conflict: a, choice: 'obsidian' },
      { conflict: b, choice: 'remote' },
    ]);
    expect(result.applied).toBe(1);
    expect(result.failed).toEqual([{ conflict: a, error: 'HTTP 422' }]);
    expect(noteFields().Other).toBe('y');
    expect(state.getRecord('rec1')?.fields.Status).toBeUndefined();
    expect(state.pendingConflicts()).toEqual([expect.objectContaining({ field: 'Status' })]);
  });

  it('a thrown write is reported as failed, not thrown', async () => {
    seed(conflict());
    app.fileManager.processFrontMatter.mockRejectedValueOnce(new Error('disk full'));
    const result = await applier().apply([{ conflict: conflict(), choice: 'remote' }]);
    expect(result.failed).toEqual([{ conflict: conflict(), error: 'disk full' }]);
    expect(state.pendingConflicts()).toHaveLength(1);
    expect(state.getRecord('rec1')).toBeUndefined();
  });

  it('a failed remote re-read is reported as failed and keeps the entry', async () => {
    seed(conflict());
    provider.fetchRecord.mockRejectedValueOnce(new Error('network down'));
    const result = await applier().apply([{ conflict: conflict(), choice: 'keep-local' }]);
    expect(result.failed).toEqual([{ conflict: conflict(), error: 'network down' }]);
    expect(state.pendingConflicts()).toHaveLength(1);
  });

  it('unparseable note frontmatter is reported as failed and keeps the entry', async () => {
    seed(conflict());
    app._files.set(PATH, '---\nStatus: [unclosed\n---\n');
    const result = await applier().apply([{ conflict: conflict(), choice: 'remote' }]);
    expect(result.failed).toHaveLength(1);
    expect(app.fileManager.processFrontMatter).not.toHaveBeenCalled();
    expect(state.pendingConflicts()).toHaveLength(1);
  });

  it('a missing note file removes the entry without writing or throwing', async () => {
    seed(conflict());
    app._files.delete(PATH);
    const result = await applier().apply([{ conflict: conflict(), choice: 'obsidian' }]);
    expect(result).toEqual({ applied: 0, stale: [], failed: [], removed: [conflict()] });
    expect(provider.updateRecord).not.toHaveBeenCalled();
    expect(app.fileManager.processFrontMatter).not.toHaveBeenCalled();
    expect(state.pendingConflicts()).toHaveLength(0);
  });

  it('a note now linked to another record removes the entry without writing', async () => {
    seed(conflict());
    app._files.set(PATH, noteContent({ primaryField: 'rec2', Status: 'Local' }));
    const result = await applier().apply([{ conflict: conflict(), choice: 'remote' }]);
    expect(result.removed).toHaveLength(1);
    expect(app.fileManager.processFrontMatter).not.toHaveBeenCalled();
    expect(state.pendingConflicts()).toHaveLength(0);
  });

  it('a deleted remote record removes the entry without writing', async () => {
    seed(conflict());
    provider.fetchRecord.mockResolvedValue(null);
    const result = await applier().apply([{ conflict: conflict(), choice: 'remote' }]);
    expect(result.removed).toHaveLength(1);
    expect(app.fileManager.processFrontMatter).not.toHaveBeenCalled();
    expect(state.pendingConflicts()).toHaveLength(0);
  });

  it('re-reads the remote after its own write to the same record', async () => {
    const a = conflict();
    const b = conflict({ field: 'Other', local: 'x', remote: 'y' });
    seed(a);
    seed(b);
    provider.fetchRecord.mockResolvedValue({ id: 'rec1', primaryField: 'rec1', fields: { Status: 'Remote', Other: 'y' } });
    await applier().apply([
      { conflict: a, choice: 'obsidian' },
      { conflict: b, choice: 'keep-local' },
    ]);
    expect(provider.fetchRecord).toHaveBeenCalledTimes(2);
  });

  it('fetches a record once when nothing was written to it remotely', async () => {
    const a = conflict();
    const b = conflict({ field: 'Other', local: 'x', remote: 'y' });
    seed(a);
    seed(b);
    provider.fetchRecord.mockResolvedValue({ id: 'rec1', primaryField: 'rec1', fields: { Status: 'Remote', Other: 'y' } });
    await applier().apply([
      { conflict: a, choice: 'keep-local' },
      { conflict: b, choice: 'remote' },
    ]);
    expect(provider.fetchRecord).toHaveBeenCalledTimes(1);
  });

  it('flushes the store once per apply', async () => {
    const flush = vi.spyOn(store, 'flush');
    seed(conflict());
    seed(conflict({ field: 'Other', local: 'x', remote: 'y' }));
    provider.fetchRecord.mockResolvedValue({ id: 'rec1', primaryField: 'rec1', fields: { Status: 'Remote', Other: 'y' } });
    await applier().apply([
      { conflict: conflict(), choice: 'keep-local' },
      { conflict: conflict({ field: 'Other', local: 'x', remote: 'y' }), choice: 'remote' },
    ]);
    expect(flush).toHaveBeenCalledTimes(1);
  });
});
