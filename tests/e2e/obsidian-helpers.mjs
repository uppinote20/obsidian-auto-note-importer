/**
 * Shared Obsidian-side helper builders for E2E harnesses.
 *
 * The harnesses inject these helpers into the Obsidian plugin runtime via
 * CDP `Runtime.evaluate`, so we cannot ship them as a normal ESM module the
 * runtime calls into. Instead each builder returns a JS string that the
 * harness concatenates with its provider-specific helpers and the test
 * expression, then evaluates as a single block.
 *
 * Two builders cover the surface used by all four harnesses:
 *
 * - {@link buildSyncHarnessHelpers}: helpers for sync harnesses
 *   (run-e2e.mjs, run-seatable-e2e.mjs). Defines a `getConfig()` that
 *   resolves the dedicated e2e config by ID, plus the standard sync
 *   utilities — file I/O wait helpers, frontmatter mutation, and queue
 *   delegation.
 *
 * - {@link buildSettingsHarnessHelpers}: helpers for settings-tab harnesses
 *   (run-settings-e2e.mjs, run-seatable-settings-e2e.mjs). Defines tab
 *   open/rerender + summary-card querying. Each settings harness layers
 *   its own `getActiveConfig` / `getSeaConfig` on top.
 *
 * The non-string helper {@link buildConfigExpr} stays a regular ESM export —
 * it runs in the harness Node process to assemble assignment lines, never
 * inside the Obsidian runtime.
 */

/**
 * Build the helper string for sync harnesses (run-e2e.mjs, run-seatable-e2e.mjs).
 *
 * @param {object} opts
 * @param {string} opts.pluginId  Plugin ID (e.g. 'auto-note-importer').
 * @param {string} opts.e2eCfgId  Dedicated e2e config ID — `getConfig()`
 *                                resolves to this, falling back to the first
 *                                config when the e2e setup hasn't run yet.
 * @returns {string} JS source ready to inject into a CDP `Runtime.evaluate`.
 */
export function buildSyncHarnessHelpers({ pluginId, e2eCfgId }) {
  return `
    function getPlugin() { return app.plugins.plugins['${pluginId}']; }

    function getConfig() {
      const p = getPlugin();
      return p.settings.configs.find(c => c.id === '${e2eCfgId}') || p.settings.configs[0];
    }

    function getCredential(config) {
      const p = getPlugin();
      const cfg = config || getConfig();
      return p.settings.credentials.find(c => c.id === cfg.credentialId);
    }

    function getInstance(config) {
      const p = getPlugin();
      const cfg = config || getConfig();
      return p.configManager.getInstance(cfg.id);
    }

    function setMode(mode, autoFormula, config) {
      const cfg = config || getConfig();
      const cred = getCredential(cfg);
      cfg.conflictResolution = mode;
      if (autoFormula !== undefined) cfg.autoSyncComputedFields = autoFormula;
      getInstance(cfg).updateSettings(cfg, cred);
    }

    async function enqueueSync(mode, scope, config) {
      const cfg = config || getConfig();
      const inst = getInstance(cfg);
      if (!inst) throw new Error('No ConfigInstance for ' + cfg.id);
      return inst.enqueueSyncRequest(mode, scope);
    }

    function waitForCache(file, key, val, maxWait = 3000) {
      return new Promise((resolve) => {
        const start = Date.now();
        (function check() {
          const fm = app.metadataCache.getFileCache(file)?.frontmatter;
          if (fm && String(fm[key]) === String(val)) return resolve(true);
          if (Date.now() - start > maxWait) return resolve(false);
          setTimeout(check, 100);
        })();
      });
    }

    async function openAndActivate(path) {
      const file = app.vault.getAbstractFileByPath(path);
      if (!file) throw new Error('No file at ' + path);
      const leaf = app.workspace.getLeaf(false);
      await leaf.openFile(file);
      await new Promise(r => setTimeout(r, 800));
      return file;
    }

    async function modifyField(file, key, value) {
      let content = await app.vault.read(file);
      const re = new RegExp('^' + key + ':.*$', 'm');
      const line = key + ': ' + (typeof value === 'string' && /[:#\\-]/.test(value) ? JSON.stringify(value) : value);
      if (re.test(content)) {
        content = content.replace(re, line);
      } else {
        content = content.replace(/^---\\n([\\s\\S]*?)\\n---/, (_, body) => '---\\n' + body + '\\n' + line + '\\n---');
      }
      await app.vault.modify(file, content);
      await waitForCache(file, key, value);
    }
  `;
}

/**
 * Build the helper string for settings-tab harnesses (run-settings-e2e.mjs,
 * run-seatable-settings-e2e.mjs).
 *
 * @param {object} opts
 * @param {string} opts.pluginId  Plugin ID (e.g. 'auto-note-importer').
 * @returns {string} JS source ready to inject into a CDP `Runtime.evaluate`.
 */
export function buildSettingsHarnessHelpers({ pluginId }) {
  return `
    function getPlugin() { return app.plugins.plugins['${pluginId}']; }

    function getSettingsTab() {
      return app.setting.pluginTabs.find(t => t.id === '${pluginId}');
    }

    async function openSettingsTab() {
      app.setting.open();
      await new Promise(r => setTimeout(r, 200));
      const tab = getSettingsTab();
      if (!tab) throw new Error('Plugin settings tab not found');
      app.setting.openTab(tab);
      tab.display();
      await new Promise(r => setTimeout(r, 400));
      return tab;
    }

    async function rerenderTab() {
      const tab = getSettingsTab();
      if (tab) tab.display();
      await new Promise(r => setTimeout(r, 300));
      return tab;
    }

    function getContainer() {
      return getSettingsTab()?.containerEl;
    }

    function queryCards(container) {
      const el = container || getContainer();
      return Array.from(el.querySelectorAll('.ani-summary-card'));
    }

    function cardInfo(card) {
      return {
        title: card.querySelector('.ani-card-title')?.textContent || '',
        summary: card.querySelector('.ani-card-summary')?.textContent || '',
        badge: card.querySelector('.ani-card-badge')?.textContent || '',
        isOk: !!card.querySelector('.ani-card-badge-ok'),
        isOff: !!card.querySelector('.ani-card-badge-off'),
        expanded: card.classList.contains('is-expanded'),
      };
    }

    function allCardInfos(container) {
      return queryCards(container).map(c => cardInfo(c));
    }
  `;
}

/**
 * Assemble `cfg.<key> = <value>;` lines from an overrides object. Used by
 * both settings harnesses to generate inline assignments inside their
 * `setConfigAndQuery` helper. Stays a regular ESM export — the result is
 * a string literal pasted into the eval block, but the building runs in
 * the Node-side harness, not inside Obsidian.
 *
 * @param {Record<string, unknown>} overrides
 * @returns {string}
 */
export function buildConfigExpr(overrides) {
  return Object.entries(overrides)
    .map(([key, value]) => {
      const v = typeof value === 'string' ? `'${value.replace(/'/g, "\\'")}'`
        : typeof value === 'boolean' ? String(value)
        : value;
      return `cfg.${key} = ${v};`;
    })
    .join('\n      ');
}

/**
 * Build the canonical `setConfigAndQuery` helper used by both settings
 * harnesses. Each harness keeps its own `getActiveConfig` definition (the
 * fixture strategy differs — Airtable settings reuses the user's active
 * config, SeaTable settings injects a dedicated e2e config and marks it
 * active) but the resolution name is the same, so the rest of the body is
 * identical. Factory parameters are the harness's `HELPERS` string and
 * `run()` function.
 *
 * @param {object} opts
 * @param {string} opts.helpers   Composed HELPERS string (factory output + provider-specific).
 * @param {(expr: string, timeoutMs?: number) => Promise<unknown>} opts.run
 *                                The harness's CDP eval wrapper.
 * @returns {(overrides: Record<string, unknown>) => Promise<unknown>}
 */
export function makeSetConfigAndQuery({ helpers, run }) {
  return async function setConfigAndQuery(overrides) {
    const assignments = buildConfigExpr(overrides);
    return run(`(async () => {
      ${helpers}
      const p = getPlugin();
      const cfg = getActiveConfig();
      ${assignments}
      await p.saveSettings();
      await rerenderTab();
      return JSON.stringify(allCardInfos());
    })()`, 10000);
  };
}
