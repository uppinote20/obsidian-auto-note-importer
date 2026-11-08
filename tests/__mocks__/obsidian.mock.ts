/**
 * Obsidian mock for testing.
 */

import { vi } from 'vitest';
import { load, dump } from 'js-yaml';

export const Notice = vi.fn();

export const App = vi.fn();

export const TFile = vi.fn();

export const TFolder = vi.fn();

export const MarkdownView = vi.fn();

export const requestUrl = vi.fn();

export const setIcon = vi.fn();

export class Modal {
  app: unknown;
  contentEl: unknown = {};
  titleEl: unknown = {};
  modalEl: unknown = {};

  constructor(app: unknown) {
    this.app = app;
  }

  open(): void {}
  close(): void {}
  onOpen(): void {}
  onClose(): void {}
}

export class PluginSettingTab {
  app: unknown;
  plugin: unknown;
  containerEl: unknown;

  constructor(app: unknown, plugin: unknown) {
    this.app = app;
    this.plugin = plugin;
    this.containerEl = {};
  }

  display(): void {}
}

export class Setting {
  settingEl = {
    addClass: vi.fn(),
  };

  constructor(_containerEl?: unknown) {}

  setName(): this { return this; }
  setDesc(): this { return this; }
  setClass(): this { return this; }

  addButton(callback: (button: {
    buttonEl: { disabled: boolean; textContent: string | null };
    setButtonText: (text: string) => unknown;
    setCta: () => unknown;
    setDisabled: (disabled: boolean) => unknown;
    onClick: (handler: () => unknown) => unknown;
  }) => unknown): this {
    const button = {
      buttonEl: { disabled: false, textContent: null },
      setButtonText(text: string) {
        this.buttonEl.textContent = text;
        return this;
      },
      setCta() { return this; },
      setDisabled(disabled: boolean) {
        this.buttonEl.disabled = disabled;
        return this;
      },
      onClick(_handler: () => unknown) { return this; },
    };
    callback(button);
    return this;
  }

  addText(callback: (text: {
    inputEl: unknown;
    setValue: (value: string) => unknown;
    setPlaceholder: (value: string) => unknown;
    onChange: (handler: (value: string) => unknown) => unknown;
  }) => unknown): this {
    const text = {
      inputEl: {},
      setValue(_value: string) { return this; },
      setPlaceholder(_value: string) { return this; },
      onChange(_handler: (value: string) => unknown) { return this; },
    };
    callback(text);
    return this;
  }

  addDropdown(callback: (dropdown: {
    addOption: (value: string, label: string) => unknown;
    setValue: (value: string) => unknown;
    onChange: (handler: (value: string) => unknown) => unknown;
  }) => unknown): this {
    const dropdown = {
      addOption(_value: string, _label: string) { return this; },
      setValue(_value: string) { return this; },
      onChange(_handler: (value: string) => unknown) { return this; },
    };
    callback(dropdown);
    return this;
  }

  addToggle(callback: (toggle: {
    setValue: (value: boolean) => unknown;
    onChange: (handler: (value: boolean) => unknown) => unknown;
  }) => unknown): this {
    const toggle = {
      setValue(_value: boolean) { return this; },
      onChange(_handler: (value: boolean) => unknown) { return this; },
    };
    callback(toggle);
    return this;
  }

  addExtraButton(callback: (button: unknown) => unknown): this {
    callback({});
    return this;
  }
}

export class AbstractInputSuggest<T> {
  app: unknown;
  inputEl: unknown;

  constructor(app: unknown, inputEl: unknown) {
    this.app = app;
    this.inputEl = inputEl;
  }

  getSuggestions(_query: string): T[] { return []; }
  renderSuggestion(_value: T, _el: HTMLElement): void {}
  selectSuggestion(_value: T): void {}
  close(): void {}
}

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
          return createMockTFolder(path);
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
        read: vi.fn(async (path: string) => {
          const content = files.get(path);
          if (content === undefined) throw new Error(`ENOENT: ${path}`);
          return content;
        }),
        write: vi.fn(async (path: string, content: string) => {
          files.set(path, content);
        }),
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
    fileManager: {
      // Mirrors Obsidian: parse the note's frontmatter, let the callback
      // mutate it, write it back (body preserved).
      processFrontMatter: vi.fn(async (file: { path: string }, fn: (fm: Record<string, unknown>) => void) => {
        const content = files.get(file.path) ?? '';
        const match = content.match(/^---\r?\n([\s\S]*?)\r?\n?---\r?\n?/);
        const fm = ((match ? load(match[1]) : null) ?? {}) as Record<string, unknown>;
        fn(fm);
        const body = match ? content.slice(match[0].length) : content;
        files.set(file.path, `---\n${dump(fm)}---\n${body}`);
      }),
    },
    // Test helpers (not part of Obsidian API)
    _files: files,
    _folders: folders,
    _eventHandlers: eventHandlers,
  };
}

export function parseYaml(text: string): unknown {
  return load(text);
}
