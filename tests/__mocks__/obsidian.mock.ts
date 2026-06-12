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

export const setIcon = vi.fn();

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
