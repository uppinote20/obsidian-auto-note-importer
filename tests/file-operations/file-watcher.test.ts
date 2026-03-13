/**
 * Tests for FileWatcher service.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { FileWatcher } from '../../src/file-operations/file-watcher';
import type { AutoNoteImporterSettings } from '../../src/types';
import { DEFAULT_SETTINGS } from '../../src/types';
import { DEBUG_DELAY_MULTIPLIER } from '../../src/constants';
// Import from 'obsidian' (aliased to mock) to ensure same module identity as source code
import { createMockApp, createMockTFile } from 'obsidian';
import type { App } from 'obsidian';

function createSettings(overrides: Partial<AutoNoteImporterSettings> = {}): AutoNoteImporterSettings {
  return {
    ...DEFAULT_SETTINGS,
    folderPath: 'Sync',
    bidirectionalSync: true,
    watchForChanges: true,
    fileWatchDebounce: 100,
    ...overrides,
  };
}

/**
 * Extracts the 'modify' event handler registered via vault.on().
 */
function getModifyHandler(mockApp: ReturnType<typeof createMockApp>): (...args: unknown[]) => void {
  const call = mockApp.vault.on.mock.calls.find(([event]) => event === 'modify');
  if (!call) throw new Error('No modify handler registered');
  return call[1];
}

describe('FileWatcher', () => {
  let mockApp: ReturnType<typeof createMockApp>;
  let onFilesReady: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    mockApp = createMockApp();
    onFilesReady = vi.fn().mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('setup', () => {
    it('should register vault modify listener when bidirectional + watchForChanges', () => {
      const watcher = new FileWatcher(mockApp as unknown as App, createSettings(), onFilesReady);
      watcher.setup();

      expect(mockApp.vault.on).toHaveBeenCalledWith('modify', expect.any(Function));
    });

    it('should not register listener when bidirectionalSync is false', () => {
      const watcher = new FileWatcher(
        mockApp as unknown as App,
        createSettings({ bidirectionalSync: false }),
        onFilesReady
      );
      watcher.setup();

      expect(mockApp.vault.on).not.toHaveBeenCalled();
    });

    it('should not register listener when watchForChanges is false', () => {
      const watcher = new FileWatcher(
        mockApp as unknown as App,
        createSettings({ watchForChanges: false }),
        onFilesReady
      );
      watcher.setup();

      expect(mockApp.vault.on).not.toHaveBeenCalled();
    });
  });

  describe('teardown', () => {
    it('should unregister event listener and clear timer', () => {
      const watcher = new FileWatcher(mockApp as unknown as App, createSettings(), onFilesReady);
      watcher.setup();

      watcher.teardown();

      expect(mockApp.vault.offref).toHaveBeenCalled();
    });

    it('should be safe to call teardown without setup', () => {
      const watcher = new FileWatcher(mockApp as unknown as App, createSettings(), onFilesReady);
      expect(() => watcher.teardown()).not.toThrow();
    });
  });

  describe('file change handling', () => {
    it('should debounce file changes and call onFilesReady', async () => {
      const settings = createSettings({ fileWatchDebounce: 100 });
      const watcher = new FileWatcher(mockApp as unknown as App, settings, onFilesReady);
      watcher.setup();

      const file = createMockTFile('Sync/note1.md');
      mockApp.vault.getAbstractFileByPath.mockReturnValue(file);

      // Simulate file modify event
      const handler = getModifyHandler(mockApp);
      handler(file);

      // Should not fire immediately
      expect(onFilesReady).not.toHaveBeenCalled();

      // After debounce
      await vi.advanceTimersByTimeAsync(100);

      expect(onFilesReady).toHaveBeenCalledTimes(1);
    });

    it('should ignore files outside sync folder', async () => {
      const watcher = new FileWatcher(mockApp as unknown as App, createSettings(), onFilesReady);
      watcher.setup();

      const file = createMockTFile('OtherFolder/note.md');
      const handler = getModifyHandler(mockApp);
      handler(file);

      await vi.advanceTimersByTimeAsync(200);
      expect(onFilesReady).not.toHaveBeenCalled();
    });

    it('should ignore changes while syncing (external)', async () => {
      const watcher = new FileWatcher(mockApp as unknown as App, createSettings(), onFilesReady);
      watcher.setup();

      watcher.setSyncing(true);

      const file = createMockTFile('Sync/note1.md');
      const handler = getModifyHandler(mockApp);
      handler(file);

      await vi.advanceTimersByTimeAsync(200);
      expect(onFilesReady).not.toHaveBeenCalled();

      watcher.setSyncing(false);
    });

    it('should merge multiple rapid changes via debounce', async () => {
      const settings = createSettings({ fileWatchDebounce: 100 });
      const watcher = new FileWatcher(mockApp as unknown as App, settings, onFilesReady);
      watcher.setup();

      const file1 = createMockTFile('Sync/note1.md');
      const file2 = createMockTFile('Sync/note2.md');
      mockApp.vault.getAbstractFileByPath
        .mockReturnValueOnce(file1)
        .mockReturnValueOnce(file2);

      const handler = getModifyHandler(mockApp);
      handler(file1);

      await vi.advanceTimersByTimeAsync(50);
      handler(file2);

      await vi.advanceTimersByTimeAsync(100);

      expect(onFilesReady).toHaveBeenCalledTimes(1);
    });

    it('should apply debug mode multiplier to debounce', async () => {
      const settings = createSettings({ fileWatchDebounce: 100, debugMode: true });
      const watcher = new FileWatcher(mockApp as unknown as App, settings, onFilesReady);
      watcher.setup();

      const file = createMockTFile('Sync/note1.md');
      mockApp.vault.getAbstractFileByPath.mockReturnValue(file);

      const handler = getModifyHandler(mockApp);
      handler(file);

      const debugDebounce = 100 * DEBUG_DELAY_MULTIPLIER;

      // Should not fire after normal debounce
      await vi.advanceTimersByTimeAsync(100);
      expect(onFilesReady).not.toHaveBeenCalled();

      // Should fire after debug multiplied debounce
      await vi.advanceTimersByTimeAsync(debugDebounce - 100);
      expect(onFilesReady).toHaveBeenCalledTimes(1);
    });
  });

  describe('syncing state', () => {
    it('should track external syncing state', () => {
      const watcher = new FileWatcher(mockApp as unknown as App, createSettings(), onFilesReady);

      expect(watcher.syncing).toBe(false);
      watcher.setSyncing(true);
      expect(watcher.syncing).toBe(true);
      watcher.setSyncing(false);
      expect(watcher.syncing).toBe(false);
    });
  });

  describe('getPendingFiles / clearPending', () => {
    it('should return pending files and clear them', async () => {
      const watcher = new FileWatcher(mockApp as unknown as App, createSettings(), onFilesReady);
      watcher.setup();

      const file = createMockTFile('Sync/note1.md');
      mockApp.vault.getAbstractFileByPath.mockReturnValue(file);

      const handler = getModifyHandler(mockApp);
      handler(file);

      const pending = watcher.getPendingFiles();
      expect(pending).toHaveLength(1);

      watcher.clearPending();
      expect(watcher.getPendingFiles()).toHaveLength(0);
    });
  });

  describe('updateSettings', () => {
    it('should use updated settings', async () => {
      const watcher = new FileWatcher(mockApp as unknown as App, createSettings(), onFilesReady);
      watcher.setup();

      watcher.updateSettings(createSettings({ folderPath: 'NewFolder' }));

      const file = createMockTFile('Sync/note1.md');
      const handler = getModifyHandler(mockApp);
      handler(file);

      await vi.advanceTimersByTimeAsync(200);
      // File is in old folder 'Sync', not 'NewFolder' — should be ignored
      expect(onFilesReady).not.toHaveBeenCalled();
    });
  });
});
