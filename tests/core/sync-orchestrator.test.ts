/**
 * Tests for SyncOrchestrator.
 * @covers src/core/sync-orchestrator.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SyncOrchestrator } from '../../src/core/sync-orchestrator';
import type { StatusBarHandle, StatusBarController } from '../../src/core/sync-orchestrator';
import type { LegacySettings, FieldTypeMapper, RemoteFieldInfo, BatchUpdate } from '../../src/types';
import { DEFAULT_LEGACY_SETTINGS } from '../../src/types';
// Import from 'obsidian' (aliased to mock) to ensure same module identity as source code
import { createMockApp, createMockTFile, createMockTFolder, Notice } from 'obsidian';
import { createMockDatabaseProvider } from '../__mocks__/database-client.mock';
import { FieldCache } from '../../src/services/field-cache';
import { FrontmatterParser } from '../../src/file-operations/frontmatter-parser';
import { FileWatcher } from '../../src/file-operations/file-watcher';
import { SyncStateStore } from '../../src/core/sync-state-store';
import type { ConfigSyncStateHandle } from '../../src/core/sync-state-store';
import type { App, DataAdapter } from 'obsidian';

function createSettings(overrides: Partial<LegacySettings> = {}): LegacySettings {
  return {
    ...DEFAULT_LEGACY_SETTINGS,
    apiKey: 'pat-test',
    baseId: 'appTest',
    tableId: 'tblTest',
    folderPath: 'Sync',
    bidirectionalSync: true,
    ...overrides,
  };
}

function createMockStatusBar(): StatusBarController & { lastItem: StatusBarHandle } {
  const handle: StatusBarHandle = {
    setText: vi.fn(),
    remove: vi.fn(),
  };
  return {
    createItem: vi.fn(() => handle),
    lastItem: handle,
  };
}

describe('SyncOrchestrator', () => {
  let mockApp: ReturnType<typeof createMockApp>;
  let mockProvider: ReturnType<typeof createMockDatabaseProvider>;
  let fieldCache: FieldCache;
  let frontmatterParser: FrontmatterParser;
  let fileWatcher: FileWatcher;
  let syncStore: SyncStateStore;
  let syncState: ConfigSyncStateHandle;
  let statusBar: ReturnType<typeof createMockStatusBar>;
  let orchestrator: SyncOrchestrator;
  let settings: LegacySettings;

  beforeEach(() => {
    vi.clearAllMocks();

    settings = createSettings();
    mockApp = createMockApp();
    mockProvider = createMockDatabaseProvider();
    fieldCache = new FieldCache();
    frontmatterParser = new FrontmatterParser(mockApp as unknown as App);
    fileWatcher = new FileWatcher(mockApp as unknown as App, settings, vi.fn());
    syncStore = new SyncStateStore(mockApp.vault.adapter as unknown as DataAdapter, 'sync-state.json');
    syncState = syncStore.forConfig('cfg-1');
    statusBar = createMockStatusBar();

    orchestrator = new SyncOrchestrator(
      mockApp as unknown as App,
      settings,
      mockProvider as never,
      fieldCache,
      frontmatterParser,
      fileWatcher,
      syncState,
      statusBar
    );
  });

  describe('processSyncRequest — pull', () => {
    it('should create status bar item and remove it after sync', async () => {
      mockProvider.fetchNotes.mockResolvedValue([]);
      mockApp.vault.adapter.exists.mockResolvedValue(true);

      await orchestrator.processSyncRequest('pull', 'all');

      expect(statusBar.createItem).toHaveBeenCalledTimes(1);
      expect(statusBar.lastItem.setText).toHaveBeenCalled();
      expect(statusBar.lastItem.remove).toHaveBeenCalledTimes(1);
    });

    it('should create sync folder if it does not exist', async () => {
      mockProvider.fetchNotes.mockResolvedValue([]);
      mockApp.vault.adapter.exists.mockResolvedValue(false);

      await orchestrator.processSyncRequest('pull', 'all');

      expect(mockApp.vault.createFolder).toHaveBeenCalledWith('Sync');
    });

    it('should create notes from fetched records', async () => {
      mockProvider.fetchNotes.mockResolvedValue([
        { id: 'rec1', primaryField: 'rec1', fields: { title: 'Note 1' } },
      ]);
      mockApp.vault.adapter.exists.mockResolvedValue(true);
      mockApp.vault.getAbstractFileByPath.mockReturnValue(null);

      await orchestrator.processSyncRequest('pull', 'all');

      expect(mockApp.vault.create).toHaveBeenCalled();
    });

    it('should set and clear syncing flag on fileWatcher in correct order', async () => {
      mockProvider.fetchNotes.mockResolvedValue([]);
      mockApp.vault.adapter.exists.mockResolvedValue(true);

      const setSyncingSpy = vi.spyOn(fileWatcher, 'setSyncing');
      const clearPendingSpy = vi.spyOn(fileWatcher, 'clearPending');

      await orchestrator.processSyncRequest('pull', 'all');

      expect(setSyncingSpy).toHaveBeenNthCalledWith(1, true);
      expect(setSyncingSpy).toHaveBeenNthCalledWith(2, false);
      expect(clearPendingSpy).toHaveBeenCalled();
    });

    it('should remove status bar and reset syncing even when sync throws', async () => {
      mockProvider.fetchNotes.mockRejectedValue(new Error('API down'));

      const setSyncingSpy = vi.spyOn(fileWatcher, 'setSyncing');

      await orchestrator.processSyncRequest('pull', 'all');

      expect(statusBar.lastItem.remove).toHaveBeenCalledTimes(1);
      // setSyncing(false) must be called even on error (via finally block in pullAll)
      expect(setSyncingSpy).toHaveBeenCalledWith(false);
    });
  });

  describe('processSyncRequest — pull: subfolder slash policy (#96)', () => {
    function mockNoteWithSubfolder(subfolderValue: string) {
      mockProvider.fetchNotes.mockResolvedValue([
        { id: 'rec1', primaryField: 'rec1', fields: { title: 'Note', Category: subfolderValue } },
      ]);
      mockApp.vault.adapter.exists.mockResolvedValue(true);
      mockApp.vault.getAbstractFileByPath.mockReturnValue(null);
    }

    it('nests on slash when subfolderTreatSlashAsLiteral=false (default behavior)', async () => {
      settings = createSettings({
        subfolderFieldName: 'Category',
        subfolderTreatSlashAsLiteral: false,
      });
      orchestrator.updateSettings(settings);
      mockNoteWithSubfolder('2024/Q1');

      await orchestrator.processSyncRequest('pull', 'all');

      expect(mockApp.vault.create).toHaveBeenCalledWith('Sync/2024/Q1/Note.md', expect.any(String));
    });

    it('replaces slash with dash when subfolderTreatSlashAsLiteral=true', async () => {
      settings = createSettings({
        subfolderFieldName: 'Category',
        subfolderTreatSlashAsLiteral: true,
      });
      orchestrator.updateSettings(settings);
      mockNoteWithSubfolder('AC/DC');

      await orchestrator.processSyncRequest('pull', 'all');

      expect(mockApp.vault.create).toHaveBeenCalledWith('Sync/AC-DC/Note.md', expect.any(String));
    });

    // Issue #98 deep-fix: object-shaped subfolder values must not produce
    // garbage folder names at runtime. If the resolved value stringifies to
    // '[object …]' (i.e. it's a non-array object that the column type didn't
    // pre-stringify), fall back to settings.folderPath. UI-only filter is
    // not sufficient — legacy configs may still hold the field name.
    it('falls back to folderPath when subfolder value is a plain object (defense-in-depth)', async () => {
      settings = createSettings({ subfolderFieldName: 'Category' });
      orchestrator.updateSettings(settings);
      mockProvider.fetchNotes.mockResolvedValue([
        { id: 'rec1', primaryField: 'rec1', fields: { title: 'Note', Category: { id: 'usr1', email: 'a@b.c' } } },
      ]);
      mockApp.vault.adapter.exists.mockResolvedValue(true);
      mockApp.vault.getAbstractFileByPath.mockReturnValue(null);

      await orchestrator.processSyncRequest('pull', 'all');

      expect(mockApp.vault.create).toHaveBeenCalledWith('Sync/Note.md', expect.any(String));
    });

    it('falls back to folderPath when subfolder value is an array of objects', async () => {
      settings = createSettings({ subfolderFieldName: 'Owners' });
      orchestrator.updateSettings(settings);
      mockProvider.fetchNotes.mockResolvedValue([
        { id: 'rec1', primaryField: 'rec1', fields: { title: 'Note', Owners: [{ id: 'u1' }, { id: 'u2' }] } },
      ]);
      mockApp.vault.adapter.exists.mockResolvedValue(true);
      mockApp.vault.getAbstractFileByPath.mockReturnValue(null);

      await orchestrator.processSyncRequest('pull', 'all');

      expect(mockApp.vault.create).toHaveBeenCalledWith('Sync/Note.md', expect.any(String));
    });

    // Regression: bare '..' / '.' in literal mode must NOT escape settings.folderPath
    it('does not escape folderPath when subfolder value is bare ".." in literal mode', async () => {
      settings = createSettings({
        subfolderFieldName: 'Category',
        subfolderTreatSlashAsLiteral: true,
      });
      orchestrator.updateSettings(settings);
      mockNoteWithSubfolder('..');

      await orchestrator.processSyncRequest('pull', 'all');

      // Empty subfolder result falls back to settings.folderPath — file stays inside Sync/
      expect(mockApp.vault.create).toHaveBeenCalledWith('Sync/Note.md', expect.any(String));
    });

    it('does not write to same-dir when subfolder value is "." in literal mode', async () => {
      settings = createSettings({
        subfolderFieldName: 'Category',
        subfolderTreatSlashAsLiteral: true,
      });
      orchestrator.updateSettings(settings);
      mockNoteWithSubfolder('.');

      await orchestrator.processSyncRequest('pull', 'all');

      expect(mockApp.vault.create).toHaveBeenCalledWith('Sync/Note.md', expect.any(String));
    });
  });

  // #134: remote APIs either omit an empty field or send it as null. Both must
  // land on the record id — String(null) === 'null' used to slip past the
  // primaryField fallback, collapsing every empty-name record into null.md.
  describe('processSyncRequest — pull: empty filename fallback (#134)', () => {
    beforeEach(() => {
      mockApp.vault.adapter.exists.mockResolvedValue(true);
      mockApp.vault.getAbstractFileByPath.mockReturnValue(null);
    });

    // null / undefined / objects hit the early guard in determineFilename();
    // '', whitespace and [] stringify to '' and land on the trailing
    // sanitizeFileName(...) || primaryField fallback instead. Both paths are
    // pinned here so neither can regress.
    it.each([
      ['null', null],
      ['undefined', undefined],
      ['empty string', ''],
      ['whitespace only', '   '],
      ['empty array', []],
      ['plain object', { id: 'usr1' }],
      ['array of objects', [{ id: 'u1' }]],
    ])('falls back to the record id when the filename field is %s', async (_label, value) => {
      mockProvider.fetchNotes.mockResolvedValue([
        { id: 'rec1', primaryField: 'rec1', fields: { title: value } },
      ]);

      await orchestrator.processSyncRequest('pull', 'all');

      expect(mockApp.vault.create).toHaveBeenCalledWith('Sync/rec1.md', expect.any(String));
    });

    it('writes one note per record when several share an empty filename field', async () => {
      mockProvider.fetchNotes.mockResolvedValue([
        { id: 'rec1', primaryField: 'rec1', fields: { title: null } },
        { id: 'rec2', primaryField: 'rec2', fields: { title: null } },
      ]);

      await orchestrator.processSyncRequest('pull', 'all');

      const paths = mockApp.vault.create.mock.calls.map(([path]: [string]) => path);
      expect(paths).toEqual(['Sync/rec1.md', 'Sync/rec2.md']);
    });

    it('still uses a non-empty value as the filename', async () => {
      mockProvider.fetchNotes.mockResolvedValue([
        { id: 'rec1', primaryField: 'rec1', fields: { title: 0 } },
      ]);

      await orchestrator.processSyncRequest('pull', 'all');

      expect(mockApp.vault.create).toHaveBeenCalledWith('Sync/0.md', expect.any(String));
    });
  });

  describe('processSyncRequest — pull: syncPageBody (#122)', () => {
    beforeEach(() => {
      mockApp.vault.adapter.exists.mockResolvedValue(true);
      mockApp.vault.getAbstractFileByPath.mockReturnValue(null);
    });

    function withBodyCapableProvider() {
      mockProvider.capabilities = {
        bidirectional: true,
        hasComputedFields: true,
        batchUpdateMaxSize: 10,
        bodySync: 'pull',
      };
      mockProvider.fetchBody = vi.fn().mockResolvedValue('Fetched body');
    }

    it('never calls fetchBody when syncPageBody is off', async () => {
      withBodyCapableProvider();
      settings = createSettings({ syncPageBody: false });
      orchestrator.updateSettings(settings);
      mockProvider.fetchNotes.mockResolvedValue([
        { id: 'rec1', primaryField: 'rec1', fields: { title: 'Note' } },
      ]);

      await orchestrator.processSyncRequest('pull', 'all');

      expect(mockProvider.fetchBody).not.toHaveBeenCalled();
    });

    it('calls fetchBody per processed note and lands body on the note content when on + capable', async () => {
      withBodyCapableProvider();
      settings = createSettings({ syncPageBody: true });
      orchestrator.updateSettings(settings);
      mockProvider.fetchNotes.mockResolvedValue([
        { id: 'rec1', primaryField: 'rec1', fields: { title: 'Note' } },
      ]);

      await orchestrator.processSyncRequest('pull', 'all');

      expect(mockProvider.fetchBody).toHaveBeenCalledWith('rec1');
      expect(mockApp.vault.create).toHaveBeenCalledWith(
        expect.any(String),
        expect.stringContaining('Fetched body')
      );
    });

    it('builds note content fields-only when fetchBody resolves null', async () => {
      withBodyCapableProvider();
      mockProvider.fetchBody = vi.fn().mockResolvedValue(null);
      settings = createSettings({ syncPageBody: true });
      orchestrator.updateSettings(settings);
      mockProvider.fetchNotes.mockResolvedValue([
        { id: 'rec1', primaryField: 'rec1', fields: { title: 'Note' } },
      ]);

      await orchestrator.processSyncRequest('pull', 'all');

      expect(mockProvider.fetchBody).toHaveBeenCalledWith('rec1');
      expect(mockApp.vault.create).toHaveBeenCalled();
    });

    it('builds note content fields-only when fetchBody throws', async () => {
      withBodyCapableProvider();
      mockProvider.fetchBody = vi.fn().mockRejectedValue(new Error('boom'));
      settings = createSettings({ syncPageBody: true });
      orchestrator.updateSettings(settings);
      mockProvider.fetchNotes.mockResolvedValue([
        { id: 'rec1', primaryField: 'rec1', fields: { title: 'Note' } },
      ]);

      await orchestrator.processSyncRequest('pull', 'all');

      expect(mockProvider.fetchBody).toHaveBeenCalledWith('rec1');
      expect(mockApp.vault.create).toHaveBeenCalled();
    });

    it('never calls fetchBody when the provider lacks bodySync/fetchBody', async () => {
      settings = createSettings({ syncPageBody: true });
      orchestrator.updateSettings(settings);
      mockProvider.fetchNotes.mockResolvedValue([
        { id: 'rec1', primaryField: 'rec1', fields: { title: 'Note' } },
      ]);

      await orchestrator.processSyncRequest('pull', 'all');

      expect(mockProvider.fetchBody).toBeUndefined();
      expect(mockApp.vault.create).toHaveBeenCalled();
    });

    it('does not call fetchBody for a note skipped due to allowOverwrite=false + existing file', async () => {
      withBodyCapableProvider();
      settings = createSettings({ syncPageBody: true, allowOverwrite: false });
      orchestrator.updateSettings(settings);
      mockProvider.fetchNotes.mockResolvedValue([
        { id: 'rec1', primaryField: 'rec1', fields: { title: 'Note' } },
      ]);
      // Pre-existing primaryField -> pullAll's shouldProcess pre-filter skips it entirely.
      frontmatterParser.loadExistingPrimaryFields = vi.fn().mockResolvedValue(new Set(['rec1']));

      await orchestrator.processSyncRequest('pull', 'all');

      expect(mockProvider.fetchBody).not.toHaveBeenCalled();
      expect(mockApp.vault.create).not.toHaveBeenCalled();
    });
  });

  describe('processSyncRequest — push', () => {
    it('should clean up status bar when active file is missing', async () => {
      mockApp.workspace.getActiveViewOfType.mockReturnValue(null);

      await orchestrator.processSyncRequest('push', 'current');

      // Error is caught and shown via Notice — status bar still cleaned up
      expect(statusBar.lastItem.remove).toHaveBeenCalled();
    });
  });

  // Mapper used by push tests that pass field metadata: every type is
  // pushable except `formula` (read-only).
  const pushableMapper: FieldTypeMapper = {
    mapToStandardType: () => 'unknown',
    isReadOnly: (type: string) => type === 'formula',
    isPushable: (type: string) => type !== 'formula',
    isFilenameSafe: () => false,
    isSubfolderSafe: () => false,
    getFilenameSafeTypes: () => [],
    getSubfolderSafeTypes: () => [],
    getReadOnlyTypes: () => ['formula'],
  };

  function rebuildOrchestrator(provider: typeof mockProvider): void {
    mockProvider = provider;
    orchestrator = new SyncOrchestrator(
      mockApp as unknown as App,
      settings,
      mockProvider as never,
      fieldCache,
      frontmatterParser,
      fileWatcher,
      syncState,
      statusBar,
    );
  }

  function setMode(mode: LegacySettings['conflictResolution']): void {
    settings = { ...settings, conflictResolution: mode };
    orchestrator.updateSettings(settings);
  }

  /**
   * One note `Sync/note.md` (record `rec1`) with the given frontmatter, and a
   * remote record with the given fields (`null` = record deleted remotely).
   * batchUpdate echoes success for every update unless overridden.
   */
  function setupPushFile(
    frontmatter: Record<string, unknown>,
    remoteFields: Record<string, unknown> | null,
  ) {
    const file = createMockTFile('Sync/note.md');
    const folder = createMockTFolder('Sync', [file]);
    mockApp.vault.getAbstractFileByPath.mockImplementation((path: string) => {
      if (path === 'Sync') return folder;
      return file;
    });
    mockApp.vault.adapter.exists.mockResolvedValue(true);
    (mockApp as unknown as { metadataCache: unknown }).metadataCache = {
      getFileCache: vi.fn().mockReturnValue({ frontmatter: { primaryField: 'rec1', ...frontmatter } }),
    };
    mockProvider.fetchRecord.mockResolvedValue(
      remoteFields ? { id: 'rec1', primaryField: 'rec1', fields: remoteFields } : null,
    );
    mockProvider.batchUpdate.mockImplementation(async (batch: BatchUpdate[]) =>
      batch.map(u => ({ success: true, recordId: u.recordId, updatedFields: u.fields })),
    );
    return file;
  }

  function sentFields(): Array<Record<string, unknown>> {
    return mockProvider.batchUpdate.mock.calls.flatMap(
      ([batch]) => (batch as BatchUpdate[]).map(u => u.fields),
    );
  }

  function noticeTexts(): string[] {
    return vi.mocked(Notice).mock.calls.map(c => String(c[0]));
  }

  describe('processSyncRequest — push: field metadata (#124)', () => {
    it('fetches field metadata and never sends a non-pushable field', async () => {
      rebuildOrchestrator(createMockDatabaseProvider({ fieldTypeMapper: pushableMapper }));
      setMode('obsidian-wins');
      setupPushFile({ Title: 'value', Formula: 'local' }, { Title: 'old', Formula: 'remote' });
      mockProvider.fetchFieldMetadata.mockResolvedValue([
        { name: 'Title', type: 'singleLineText' },
        { name: 'Formula', type: 'formula' },
      ] satisfies RemoteFieldInfo[]);

      await orchestrator.processSyncRequest('push', 'all');

      expect(mockProvider.fetchFieldMetadata).toHaveBeenCalled();
      expect(sentFields()).toEqual([{ Title: 'value' }]);
    });

    it('treats every judged field as writable when fetchFieldMetadata resolves null (fail-open)', async () => {
      // NOOP mapper says nothing is pushable — must not matter without metadata.
      setMode('obsidian-wins');
      setupPushFile({ Title: 'value' }, { Title: 'old' });
      mockProvider.fetchFieldMetadata.mockResolvedValue(null);

      await orchestrator.processSyncRequest('push', 'all');

      expect(sentFields()).toEqual([{ Title: 'value' }]);
    });

    it('treats a rejecting fetchFieldMetadata (contract violation) as null (defensive catch)', async () => {
      setMode('obsidian-wins');
      setupPushFile({ Title: 'value' }, { Title: 'old' });
      mockProvider.fetchFieldMetadata.mockRejectedValue(new Error('should never happen per contract'));

      await expect(orchestrator.processSyncRequest('push', 'all')).resolves.toEqual({ newConflicts: [] });

      expect(sentFields()).toEqual([{ Title: 'value' }]);
    });

    it('does not queue a conflict for a non-pushable field that differs remotely (conflict-asymmetry regression)', async () => {
      rebuildOrchestrator(createMockDatabaseProvider({ providerType: 'seatable', fieldTypeMapper: pushableMapper }));
      setMode('manual');
      setupPushFile(
        { Title: 'same', Formula: 'local-computed-value' },
        { Title: 'same', Formula: 'remote-computed-value' },
      );
      mockProvider.fetchFieldMetadata.mockResolvedValue([
        { name: 'Title', type: 'singleLineText' },
        { name: 'Formula', type: 'formula' },
      ]);

      const result = await orchestrator.processSyncRequest('push', 'all');

      expect(sentFields().some(f => 'Formula' in f)).toBe(false);
      expect(result.newConflicts).toEqual([]);
      expect(syncState.pendingConflicts()).toEqual([]);
    });
  });

  describe('processSyncRequest — push: three-way snapshot (#82)', () => {
    it('manual: pushes a local-only edit (#82 repro)', async () => {
      setMode('manual');
      syncState.setFields('rec1', { Count: { local: 10, remote: 10 } });
      setupPushFile({ Count: 11 }, { Count: 10 });

      const result = await orchestrator.processSyncRequest('push', 'all');

      expect(mockProvider.batchUpdate).toHaveBeenCalledWith([{ recordId: 'rec1', fields: { Count: 11 } }]);
      expect(result.newConflicts).toEqual([]);
      expect(syncState.getRecord('rec1')?.fields.Count).toEqual({ local: 11, remote: 11 });
    });

    it('manual: a field changed on both sides is not sent and is queued once', async () => {
      setMode('manual');
      syncState.setFields('rec1', { Count: { local: 10, remote: 10 } });
      setupPushFile({ Count: 11 }, { Count: 12 });

      const result = await orchestrator.processSyncRequest('push', 'all');

      expect(sentFields().some(f => 'Count' in f)).toBe(false);
      expect(result.newConflicts).toHaveLength(1);
      expect(result.newConflicts[0]).toMatchObject({
        recordId: 'rec1',
        filePath: 'Sync/note.md',
        field: 'Count',
        local: 11,
        remote: 12,
        snapshot: { local: 10, remote: 10 },
        writable: true,
      });
      expect(typeof result.newConflicts[0].detectedAt).toBe('string');
      expect(syncState.pendingConflicts()).toHaveLength(1);
      expect(syncState.getRecord('rec1')?.fields.Count).toEqual({ local: 10, remote: 10 });
      expect(noticeTexts()).toContain('Auto Note Importer: 1 sync conflict(s) need resolving (Airtable)');
    });

    it('manual: a conflict without a snapshot carries snapshot null', async () => {
      setMode('manual');
      setupPushFile({ Count: 11 }, { Count: 12 });

      const result = await orchestrator.processSyncRequest('push', 'all');

      expect(mockProvider.batchUpdate).not.toHaveBeenCalled();
      expect(result.newConflicts).toHaveLength(1);
      expect(result.newConflicts[0].snapshot).toBeNull();
    });

    it('remote-wins: sends only the locally-changed field, never reverts a remote-only change', async () => {
      setMode('remote-wins');
      syncState.setFields('rec1', { A: { local: 'a', remote: 'a' }, B: { local: 'b', remote: 'b' } });
      setupPushFile({ A: 'a2', B: 'b' }, { A: 'a', B: 'b2' });

      await orchestrator.processSyncRequest('push', 'all');

      expect(sentFields()).toEqual([{ A: 'a2' }]);
      // B's remote-only change is left for pull — its baseline must not move.
      expect(syncState.getRecord('rec1')?.fields.B).toEqual({ local: 'b', remote: 'b' });
    });

    it('obsidian-wins: sends the whole local field set and reports overwritten remote changes', async () => {
      setMode('obsidian-wins');
      syncState.setFields('rec1', { A: { local: 'a', remote: 'a' }, B: { local: 'b', remote: 'b' } });
      setupPushFile({ A: 'a2', B: 'b' }, { A: 'a', B: 'b2' });

      await orchestrator.processSyncRequest('push', 'all');

      expect(sentFields()).toEqual([{ A: 'a2', B: 'b' }]);
      expect(noticeTexts().some(t => t.includes('Overwrote remote changes: B'))).toBe(true);
      expect(syncState.getRecord('rec1')?.fields.B).toEqual({ local: 'b', remote: 'b' });
    });

    it('re-detecting the same conflict is not reported as new, but stays queued', async () => {
      setMode('manual');
      syncState.setFields('rec1', { Count: { local: 10, remote: 10 } });
      setupPushFile({ Count: 11 }, { Count: 12 });

      const first = await orchestrator.processSyncRequest('push', 'all');
      const second = await orchestrator.processSyncRequest('push', 'all');

      expect(first.newConflicts).toHaveLength(1);
      expect(second.newConflicts).toHaveLength(0);
      expect(syncState.pendingConflicts()).toHaveLength(1);
    });

    it('a pending conflict whose values changed is reported as new again', async () => {
      setMode('manual');
      syncState.setFields('rec1', { Count: { local: 10, remote: 10 } });
      setupPushFile({ Count: 11 }, { Count: 12 });
      await orchestrator.processSyncRequest('push', 'all');

      setupPushFile({ Count: 13 }, { Count: 12 });
      const second = await orchestrator.processSyncRequest('push', 'all');

      expect(second.newConflicts.map(c => c.local)).toEqual([13]);
      expect(syncState.pendingConflicts()).toHaveLength(1);
      expect(syncState.pendingConflicts()[0].local).toBe(13);
    });

    it('Review Focus 1: format asymmetry between sides (block-scalar newline) is not a change', async () => {
      for (const mode of ['manual', 'remote-wins'] as const) {
        mockProvider.batchUpdate.mockClear();
        setMode(mode);
        syncState.setFields('rec1', { Notes: { local: 'a\n', remote: 'a' } });
        setupPushFile({ Notes: 'a\n' }, { Notes: 'a' });

        const result = await orchestrator.processSyncRequest('push', 'all');

        expect(mockProvider.batchUpdate).not.toHaveBeenCalled();
        expect(result.newConflicts).toEqual([]);
      }
    });

    it('Review Focus 2: local-only keys unknown to the remote are never sent or queued', async () => {
      rebuildOrchestrator(createMockDatabaseProvider({ fieldTypeMapper: pushableMapper }));
      mockProvider.fetchFieldMetadata.mockResolvedValue([{ name: 'Title', type: 'singleLineText' }]);
      for (const mode of ['manual', 'remote-wins', 'obsidian-wins'] as const) {
        mockProvider.batchUpdate.mockClear();
        setMode(mode);
        setupPushFile({ Title: 'x', created: '2024-01-01', status: 'draft' }, { Title: 'x' });

        const result = await orchestrator.processSyncRequest('push', 'all');

        for (const fields of sentFields()) {
          expect(fields).not.toHaveProperty('created');
          expect(fields).not.toHaveProperty('status');
        }
        expect(result.newConflicts).toEqual([]);
        expect(syncState.pendingConflicts()).toEqual([]);
        expect(Object.keys(syncState.getRecord('rec1')?.fields ?? {})).toEqual(['Title']);
      }
    });

    it('without metadata, only remote keys are judged (local-only keys are never sent)', async () => {
      setMode('obsidian-wins');
      mockProvider.fetchFieldMetadata.mockResolvedValue(null);
      setupPushFile({ Title: 'x', created: '2024-01-01' }, { Title: 'x' });

      await orchestrator.processSyncRequest('push', 'all');

      expect(sentFields()).toEqual([{ Title: 'x' }]);
    });

    it('records a snapshot for unchanged fields without sending anything', async () => {
      setMode('manual');
      setupPushFile({ Title: 'same' }, { Title: 'same' });

      await orchestrator.processSyncRequest('push', 'all');

      expect(mockProvider.batchUpdate).not.toHaveBeenCalled();
      expect(syncState.getRecord('rec1')?.fields).toEqual({ Title: { local: 'same', remote: 'same' } });
    });

    it('a failed batchUpdate result leaves the snapshot unchanged', async () => {
      setMode('manual');
      syncState.setFields('rec1', { Count: { local: 10, remote: 10 } });
      const before = structuredClone(syncState.getRecord('rec1'));
      setupPushFile({ Count: 11 }, { Count: 10 });
      mockProvider.batchUpdate.mockResolvedValue([{ success: false, recordId: 'rec1', error: 'boom' }]);

      await orchestrator.processSyncRequest('push', 'all');

      expect(mockProvider.batchUpdate).toHaveBeenCalled();
      expect(syncState.getRecord('rec1')).toEqual(before);
    });

    it('a rejected batchUpdate leaves the snapshot unchanged', async () => {
      setMode('manual');
      syncState.setFields('rec1', { Count: { local: 10, remote: 10 } });
      const before = structuredClone(syncState.getRecord('rec1'));
      setupPushFile({ Count: 11 }, { Count: 10 });
      mockProvider.batchUpdate.mockRejectedValue(new Error('network'));

      await orchestrator.processSyncRequest('push', 'all');

      expect(syncState.getRecord('rec1')).toEqual(before);
    });

    it('a record deleted remotely is skipped, counted as an error, snapshot untouched', async () => {
      setMode('obsidian-wins');
      syncState.setFields('rec1', { Count: { local: 10, remote: 10 } });
      const before = structuredClone(syncState.getRecord('rec1'));
      setupPushFile({ Count: 11 }, null);

      await orchestrator.processSyncRequest('push', 'all');

      expect(mockProvider.batchUpdate).not.toHaveBeenCalled();
      expect(syncState.getRecord('rec1')).toEqual(before);
      expect(noticeTexts()).toContain('Auto Note Importer: 0 synced, 1 errors');
    });

    it('removes a pending conflict once the field is no longer in conflict', async () => {
      setMode('manual');
      syncState.setFields('rec1', { Count: { local: 10, remote: 10 } });
      syncState.upsertConflict({
        recordId: 'rec1', filePath: 'Sync/note.md', field: 'Count', local: 9, remote: 8,
        snapshot: { local: 10, remote: 10 }, writable: true, detectedAt: '2026-01-01T00:00:00.000Z',
      });
      setupPushFile({ Count: 11 }, { Count: 10 });

      await orchestrator.processSyncRequest('push', 'all');

      expect(syncState.pendingConflicts()).toEqual([]);
    });

    it('flushes the sync state once per push run', async () => {
      setMode('manual');
      const file1 = createMockTFile('Sync/a.md');
      const file2 = createMockTFile('Sync/b.md');
      const folder = createMockTFolder('Sync', [file1, file2]);
      mockApp.vault.getAbstractFileByPath.mockImplementation((path: string) => (path === 'Sync' ? folder : null));
      (mockApp as unknown as { metadataCache: unknown }).metadataCache = {
        getFileCache: vi.fn((f: { path: string }) => ({
          frontmatter: { primaryField: f.path === 'Sync/a.md' ? 'recA' : 'recB', Title: 'same' },
        })),
      };
      mockProvider.fetchRecord.mockImplementation(async (id: string) => ({ id, primaryField: id, fields: { Title: 'same' } }));
      const flushSpy = vi.spyOn(syncStore, 'flush');

      await orchestrator.processSyncRequest('push', 'all');

      expect(flushSpy).toHaveBeenCalledTimes(1);
      expect(syncState.getRecord('recA')).toBeDefined();
      expect(syncState.getRecord('recB')).toBeDefined();
    });
  });

  describe('processSyncRequest — bidirectional', () => {
    it('should execute two phases when autoSyncComputedFields is true', async () => {
      settings.autoSyncComputedFields = true;
      settings.formulaSyncDelay = 0;
      settings.conflictResolution = 'obsidian-wins';
      orchestrator.updateSettings(settings);
      setupPushFile({ Name: 'test' }, { Name: 'old' });
      mockProvider.fetchNotes.mockResolvedValue([]);

      await orchestrator.processSyncRequest('bidirectional', 'all');

      // Phase 1: push to the remote
      expect(mockProvider.batchUpdate).toHaveBeenCalled();
      // Phase 2: pull back
      expect(mockProvider.fetchNotes).toHaveBeenCalled();
    });

    it('should skip phase 2 when autoSyncComputedFields is false', async () => {
      settings.autoSyncComputedFields = false;
      settings.conflictResolution = 'obsidian-wins';
      orchestrator.updateSettings(settings);
      setupPushFile({ Name: 'test' }, { Name: 'old' });

      await orchestrator.processSyncRequest('bidirectional', 'all');

      expect(mockProvider.batchUpdate).toHaveBeenCalled();
      expect(mockProvider.fetchNotes).not.toHaveBeenCalled();
    });

    it('returns the push phase conflicts', async () => {
      settings.autoSyncComputedFields = false;
      settings.conflictResolution = 'manual';
      orchestrator.updateSettings(settings);
      setupPushFile({ Name: 'local' }, { Name: 'remote' });

      const result = await orchestrator.processSyncRequest('bidirectional', 'all');

      expect(result.newConflicts.map(c => c.field)).toEqual(['Name']);
    });
  });
  describe('processSyncRequest — scope: current', () => {
    it('should sync current file from airtable', async () => {
      const file = createMockTFile('Sync/note.md');
      mockApp.workspace.getActiveViewOfType.mockReturnValue({ file });

      vi.spyOn(frontmatterParser, 'getRecordId').mockReturnValue('rec1');

      mockProvider.fetchRecord.mockResolvedValue({
        id: 'rec1', primaryField: 'rec1', fields: { title: 'Updated' },
      });
      mockApp.vault.getAbstractFileByPath.mockReturnValue(file);
      mockApp.vault.adapter.exists.mockResolvedValue(true);
      mockApp.vault.read.mockResolvedValue('old content');

      await orchestrator.processSyncRequest('pull', 'current');

      expect(mockProvider.fetchRecord).toHaveBeenCalledWith('rec1');
    });
  });

  describe('error propagation', () => {
    it('should catch errors and show notice without throwing', async () => {
      mockProvider.fetchNotes.mockRejectedValue(new Error('Network error'));

      // Should not throw
      await expect(
        orchestrator.processSyncRequest('pull', 'all')
      ).resolves.toEqual({ newConflicts: [] });
    });
  });

  // Regression guard: status bar / Notice text must derive the provider name
  // from `provider.providerType` via CREDENTIAL_TYPE_LABELS, not a hardcoded string.
  describe('provider-aware labels', () => {
    function createOrchestrator(provider: typeof mockProvider): SyncOrchestrator {
      return new SyncOrchestrator(
        mockApp as unknown as App,
        settings,
        provider as never,
        fieldCache,
        frontmatterParser,
        fileWatcher,
        syncState,
        statusBar,
      );
    }

    it("should label status bar with the provider's display name (airtable)", async () => {
      mockApp.vault.adapter.exists.mockResolvedValue(true);
      mockProvider.fetchNotes.mockResolvedValue([]);

      await orchestrator.processSyncRequest('pull', 'all');

      expect(statusBar.lastItem.setText).toHaveBeenCalledWith(
        expect.stringContaining('Airtable'),
      );
    });

    it('should reflect a different provider type in status bar text', async () => {
      const notionProvider = createMockDatabaseProvider({ providerType: 'notion' });
      notionProvider.fetchNotes.mockResolvedValue([]);
      mockApp.vault.adapter.exists.mockResolvedValue(true);

      const notionOrchestrator = createOrchestrator(notionProvider);
      await notionOrchestrator.processSyncRequest('pull', 'all');

      const calls = (statusBar.lastItem.setText as ReturnType<typeof vi.fn>).mock.calls.map(
        (c) => String(c[0]),
      );
      expect(calls.some((text) => text.includes('Notion'))).toBe(true);
      expect(calls.every((text) => !text.includes('Airtable'))).toBe(true);
    });
  });
});
