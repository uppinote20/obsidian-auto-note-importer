/**
 * Vitest runs in a plain node environment (see vitest.config.ts), but the
 * plugin source binds timers to `window` for Obsidian popout-window
 * compatibility (scanner rule obsidianmd/prefer-window-timers). In the real
 * Obsidian main window `window === globalThis`; mirror that here so
 * `window.setTimeout` & friends resolve to the same (possibly vi-faked)
 * timer globals at call time.
 */
(globalThis as Record<string, unknown>).window ??= globalThis;

export {};
