/**
 * Tests for SyncOrchestrator.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SyncOrchestrator } from '../../src/core/sync-orchestrator';
import type { StatusBarHandle, StatusBarController } from '../../src/core/sync-orchestrator';
import type { AutoNoteImporterSettings } from '../../src/types';
import { DEFAULT_SETTINGS } from '../../src/types';
// Import from 'obsidian' (aliased to mock) to ensure same module identity as source code
import { createMockApp, createMockTFile, createMockTFolder } from 'obsidian';
import { createMockAirtableClient } from '../__mocks__/airtable-client.mock';
import { FieldCache } from '../../src/services/field-cache';
import { FrontmatterParser } from '../../src/file-operations/frontmatter-parser';
import { FileWatcher } from '../../src/file-operations/file-watcher';
import { ConflictResolver } from '../../src/core/conflict-resolver';
import type { App } from 'obsidian';

function createSettings(overrides: Partial<AutoNoteImporterSettings> = {}): AutoNoteImporterSettings {
  return {
    ...DEFAULT_SETTINGS,
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
  let mockClient: ReturnType<typeof createMockAirtableClient>;
  let fieldCache: FieldCache;
  let frontmatterParser: FrontmatterParser;
  let fileWatcher: FileWatcher;
  let conflictResolver: ConflictResolver;
  let statusBar: ReturnType<typeof createMockStatusBar>;
  let orchestrator: SyncOrchestrator;
  let settings: AutoNoteImporterSettings;

  beforeEach(() => {
    vi.clearAllMocks();

    settings = createSettings();
    mockApp = createMockApp();
    mockClient = createMockAirtableClient();
    fieldCache = new FieldCache();
    frontmatterParser = new FrontmatterParser(mockApp as unknown as App);
    fileWatcher = new FileWatcher(mockApp as unknown as App, settings, vi.fn());
    conflictResolver = new ConflictResolver(settings, mockClient as never);
    statusBar = createMockStatusBar();

    orchestrator = new SyncOrchestrator(
      mockApp as unknown as App,
      settings,
      mockClient as never,
      fieldCache,
      frontmatterParser,
      fileWatcher,
      conflictResolver,
      statusBar
    );
  });

  describe('processSyncRequest — from-airtable', () => {
    it('should create status bar item and remove it after sync', async () => {
      mockClient.fetchNotes.mockResolvedValue([]);
      mockApp.vault.adapter.exists.mockResolvedValue(true);

      await orchestrator.processSyncRequest('from-airtable', 'all');

      expect(statusBar.createItem).toHaveBeenCalledTimes(1);
      expect(statusBar.lastItem.setText).toHaveBeenCalled();
      expect(statusBar.lastItem.remove).toHaveBeenCalledTimes(1);
    });

    it('should create sync folder if it does not exist', async () => {
      mockClient.fetchNotes.mockResolvedValue([]);
      mockApp.vault.adapter.exists.mockResolvedValue(false);

      await orchestrator.processSyncRequest('from-airtable', 'all');

      expect(mockApp.vault.createFolder).toHaveBeenCalledWith('Sync');
    });

    it('should create notes from fetched records', async () => {
      mockClient.fetchNotes.mockResolvedValue([
        { id: 'rec1', primaryField: 'rec1', fields: { title: 'Note 1' } },
      ]);
      mockApp.vault.adapter.exists.mockResolvedValue(true);
      mockApp.vault.getAbstractFileByPath.mockReturnValue(null);

      await orchestrator.processSyncRequest('from-airtable', 'all');

      expect(mockApp.vault.create).toHaveBeenCalled();
    });

    it('should set and clear syncing flag on fileWatcher', async () => {
      mockClient.fetchNotes.mockResolvedValue([]);
      mockApp.vault.adapter.exists.mockResolvedValue(true);

      const setSyncingSpy = vi.spyOn(fileWatcher, 'setSyncing');
      const clearPendingSpy = vi.spyOn(fileWatcher, 'clearPending');

      await orchestrator.processSyncRequest('from-airtable', 'all');

      expect(setSyncingSpy).toHaveBeenCalledWith(true);
      expect(setSyncingSpy).toHaveBeenCalledWith(false);
      expect(clearPendingSpy).toHaveBeenCalled();
    });

    it('should remove status bar even when sync throws', async () => {
      mockClient.fetchNotes.mockRejectedValue(new Error('API down'));

      await orchestrator.processSyncRequest('from-airtable', 'all');

      expect(statusBar.lastItem.remove).toHaveBeenCalledTimes(1);
    });
  });

  describe('processSyncRequest — to-airtable', () => {
    it('should notice when no files to sync', async () => {
      mockApp.workspace.getActiveViewOfType.mockReturnValue(null);

      await orchestrator.processSyncRequest('to-airtable', 'current');

      // Error is caught and shown via Notice — status bar still cleaned up
      expect(statusBar.lastItem.remove).toHaveBeenCalled();
    });
  });

  describe('processSyncRequest — bidirectional', () => {
    it('should execute two phases when autoSyncFormulas is true', async () => {
      settings.autoSyncFormulas = true;
      settings.formulaSyncDelay = 0;
      orchestrator.updateSettings(settings);

      const file = createMockTFile('Sync/note.md');
      const folder = createMockTFolder('Sync', [file]);
      mockApp.vault.getAbstractFileByPath.mockImplementation((path: string) => {
        if (path === 'Sync') return folder;
        return file;
      });
      mockApp.vault.adapter.exists.mockResolvedValue(true);

      vi.spyOn(frontmatterParser, 'getRecordId').mockReturnValue('rec1');
      vi.spyOn(frontmatterParser, 'extractSyncableFields').mockReturnValue({ Name: 'test' });
      vi.spyOn(conflictResolver, 'shouldSkipConflictDetection').mockReturnValue(true);

      mockClient.batchUpdate.mockResolvedValue([{ success: true, recordId: 'rec1', updatedFields: {} }]);
      mockClient.fetchNotes.mockResolvedValue([]);

      await orchestrator.processSyncRequest('bidirectional', 'all');

      // Phase 1: push to Airtable
      expect(mockClient.batchUpdate).toHaveBeenCalled();
      // Phase 2: pull back
      expect(mockClient.fetchNotes).toHaveBeenCalled();
    });

    it('should skip phase 2 when autoSyncFormulas is false', async () => {
      settings.autoSyncFormulas = false;
      orchestrator.updateSettings(settings);

      const file = createMockTFile('Sync/note.md');
      const folder = createMockTFolder('Sync', [file]);
      mockApp.vault.getAbstractFileByPath.mockImplementation((path: string) => {
        if (path === 'Sync') return folder;
        return file;
      });

      vi.spyOn(frontmatterParser, 'getRecordId').mockReturnValue('rec1');
      vi.spyOn(frontmatterParser, 'extractSyncableFields').mockReturnValue({ Name: 'test' });
      vi.spyOn(conflictResolver, 'shouldSkipConflictDetection').mockReturnValue(true);

      mockClient.batchUpdate.mockResolvedValue([{ success: true, recordId: 'rec1', updatedFields: {} }]);

      await orchestrator.processSyncRequest('bidirectional', 'all');

      expect(mockClient.batchUpdate).toHaveBeenCalled();
      expect(mockClient.fetchNotes).not.toHaveBeenCalled();
    });
  });

  describe('processSyncRequest — scope: current', () => {
    it('should sync current file from airtable', async () => {
      const file = createMockTFile('Sync/note.md');
      mockApp.workspace.getActiveViewOfType.mockReturnValue({ file });

      vi.spyOn(frontmatterParser, 'getRecordId').mockReturnValue('rec1');

      mockClient.fetchRecord.mockResolvedValue({
        id: 'rec1', primaryField: 'rec1', fields: { title: 'Updated' },
      });
      mockApp.vault.getAbstractFileByPath.mockReturnValue(file);
      mockApp.vault.adapter.exists.mockResolvedValue(true);
      mockApp.vault.read.mockResolvedValue('old content');

      await orchestrator.processSyncRequest('from-airtable', 'current');

      expect(mockClient.fetchRecord).toHaveBeenCalledWith('rec1');
    });
  });

  describe('error propagation', () => {
    it('should catch errors and show notice without throwing', async () => {
      mockClient.fetchNotes.mockRejectedValue(new Error('Network error'));

      // Should not throw
      await expect(
        orchestrator.processSyncRequest('from-airtable', 'all')
      ).resolves.toBeUndefined();
    });
  });
});
