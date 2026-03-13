/**
 * Obsidian mock for testing.
 */

import { vi } from 'vitest';

export const Notice = vi.fn();

export const App = vi.fn();

export const TFile = vi.fn();

export const TFolder = vi.fn();

export const MarkdownView = vi.fn();

export const requestUrl = vi.fn();

export function normalizePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/$/, '');
}

/**
 * Creates a mock TFile instance that passes instanceof checks.
 */
export function createMockTFile(path: string, extension = 'md') {
  const name = path.split('/').pop() || '';
  const basename = name.replace(/\.[^.]+$/, '');
  const file = Object.create(TFile.prototype);
  return Object.assign(file, { path, extension, name, basename });
}

/**
 * Creates a mock TFolder instance that passes instanceof checks.
 */
export function createMockTFolder(path: string, children: unknown[] = []) {
  const folder = Object.create(TFolder.prototype);
  return Object.assign(folder, { path, children });
}

/**
 * Creates a mock Obsidian App with vault operations.
 */
export function createMockApp() {
  const files = new Map<string, string>();
  const folders = new Set<string>();
  const eventHandlers = new Map<string, ((...args: unknown[]) => void)[]>();

  return {
    vault: {
      getAbstractFileByPath: vi.fn((path: string) => {
        if (files.has(path)) {
          return createMockTFile(path);
        }
        if (folders.has(path)) {
          return { path, children: [] };
        }
        return null;
      }),
      read: vi.fn(async (file: { path: string }) => files.get(file.path) || ''),
      create: vi.fn(async (path: string, content: string) => {
        files.set(path, content);
        return createMockTFile(path);
      }),
      modify: vi.fn(async (file: { path: string }, content: string) => {
        files.set(file.path, content);
      }),
      createFolder: vi.fn(async (path: string) => {
        folders.add(path);
      }),
      adapter: {
        exists: vi.fn(async (path: string) => files.has(path) || folders.has(path)),
      },
      on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
        const handlers = eventHandlers.get(event) || [];
        handlers.push(handler);
        eventHandlers.set(event, handlers);
        return { event, handler };
      }),
      offref: vi.fn(),
      getFiles: vi.fn(() => [...files.keys()].map(p => createMockTFile(p))),
    },
    workspace: {
      getActiveViewOfType: vi.fn(() => null),
    },
    // Test helpers (not part of Obsidian API)
    _files: files,
    _folders: folders,
    _eventHandlers: eventHandlers,
  };
}
