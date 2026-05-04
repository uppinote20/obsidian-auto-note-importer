/**
 * Shared E2E harness helpers — used by every harness under tests/e2e/.
 *
 * Two flavors live in this module:
 *
 * 1. **String factories** ({@link buildSyncHarnessHelpers},
 *    {@link buildSettingsHarnessHelpers}) — return JS source that the
 *    harness concatenates with its provider-specific inline helpers and
 *    the test expression, then evaluates inside the Obsidian plugin
 *    runtime via CDP `Runtime.evaluate`. We can't ship these as regular
 *    ESM functions because the harness Node process can't reach into
 *    Obsidian's plugin scope.
 *
 * 2. **Node-side ESM utilities** ({@link createTestHarness},
 *    {@link makeSetConfigAndQuery}, {@link buildConfigEntry},
 *    {@link buildConfigExpr}) — run in the harness Node process. They
 *    own the test runner scaffolding, ConfigEntry default merging, and
 *    config-mutation expression assembly. Output strings get spliced
 *    into the eval block, but the assembly itself happens here.
 */
import { evalInObsidian } from './cdp-helpers.mjs';

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
/**
 * Build a per-harness test runner with shared `run` / `test` / `log`
 * scaffolding. Returns the four pieces every harness used to redeclare
 * verbatim. The `targetId` reference goes through a getter so each
 * harness can resolve `findPageTarget()` lazily after construction.
 *
 * `skipSupported: true` enables the sync-harness convention where a test
 * fn returns `{ skip: true, detail }` to mark the case as skipped (not
 * failed) — used by `run-e2e.mjs` for formula-dependent assertions when
 * the Calculation column is missing.
 *
 * @param {object} opts
 * @param {() => string | undefined} opts.getTargetId
 *   Returns the resolved CDP target ID. Called inside `run`, so the
 *   harness can assign `targetId` after `findPageTarget()` resolves.
 * @param {boolean} [opts.skipSupported=false]
 *   When true, `test` honors `{ skip: true }` returns from the test fn.
 */
export function createTestHarness({ getTargetId, skipSupported = false }) {
  const results = [];
  const log = (msg) => console.log(msg);

  const run = async (expr, timeout) => {
    const r = await evalInObsidian(getTargetId(), expr, timeout);
    if (r && typeof r === 'object' && r.__error) throw new Error(r.__error);
    return r;
  };

  const test = async (name, fn) => {
    log(`\n=== ${name} ===`);
    try {
      const result = await fn();
      if (skipSupported && result?.skip) {
        results.push({ test: name, pass: true, skip: true, detail: result.detail || 'skipped' });
        log(`SKIP - ${result.detail || 'skipped'}`);
        return;
      }
      const { pass, detail } = result;
      results.push({ test: name, pass, detail: detail || 'ok' });
      log(pass ? 'PASS' : `FAIL - ${detail}`);
    } catch (e) {
      results.push({ test: name, pass: false, detail: e.message });
      log(`FAIL - ${e.message}`);
    }
  };

  return { results, log, run, test };
}

/**
 * Build a ConfigEntry object with project defaults, merging the supplied
 * overrides on top. The 19 default fields kept the three e2e harnesses
 * with near-identical literal blocks; this factory collapses them so
 * each harness only specifies what differs (id / name / credentialId /
 * tableId / folderPath, plus per-suite knobs like bidirectionalSync).
 *
 * The returned plain object is meant to be `JSON.stringify`'d into the
 * eval block — it doesn't reference any plugin runtime values.
 *
 * Defaults track `DEFAULT_CONFIG_ENTRY` in `src/types/config.types.ts`;
 * adding a new field there means updating this default too. The e2e
 * suites surface mismatches at runtime since unset booleans/numbers
 * change observable behavior.
 *
 * @param {Partial<Record<string, unknown>>} overrides
 */
export function buildConfigEntry(overrides = {}) {
  return {
    id: '',
    name: '',
    enabled: true,
    credentialId: '',
    baseId: '',
    tableId: '',
    viewId: '',
    folderPath: '',
    templatePath: '',
    filenameFieldName: 'Name',
    subfolderFieldName: '',
    syncInterval: 0,
    allowOverwrite: true,
    bidirectionalSync: false,
    conflictResolution: 'manual',
    watchForChanges: false,
    fileWatchDebounce: 2000,
    autoSyncComputedFields: false,
    formulaSyncDelay: 1500,
    generateBasesFile: false,
    basesFileLocation: 'vault-root',
    basesCustomPath: '',
    basesRegenerateOnSync: false,
    ...overrides,
  };
}

export function buildConfigExpr(overrides) {
  return Object.entries(overrides)
    .map(([key, value]) => {
      // String literals need both backslash and single-quote escapes so
      // values like Windows-style paths or quoted text survive the eval
      // round-trip intact. Other scalars (boolean / number) stringify
      // safely on their own; the JSON.stringify catch-all covers any
      // remaining shape (null / object / array) — without it those
      // would degrade to `null` / `[object Object]` in the eval'd code.
      let v;
      if (typeof value === 'string') {
        v = `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
      } else if (typeof value === 'boolean' || typeof value === 'number') {
        v = String(value);
      } else {
        v = JSON.stringify(value);
      }
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
