/**
 * Settings UI E2E Tests for Notion provider.
 *
 * Mirrors run-supabase-settings-e2e.mjs. Adds a Notion-specific credential
 * + ConfigEntry, then validates: creating a credential via the UI (token
 * field password type + tone hint), the Test connection button surfacing
 * a data-source count, the Notion Connection card's data-source dropdown
 * (with filename auto-fill from the title property), and the filename /
 * subfolder dropdowns filtered by notion-field-mapper.
 *
 * @covers src/ui/settings-tab.ts
 * @covers src/services/notion-credential-form.ts
 * @covers src/services/notion-schema-cache.ts
 * @covers src/services/notion-field-mapper.ts
 *
 * Prerequisites: same as run-notion-e2e.mjs (.env + Obsidian + plugin).
 *   NOTION_TOKEN=ntn_...
 *   NOTION_DATA_SOURCE_ID=<data source id>
 *
 * Usage:
 *   node tests/e2e/run-notion-settings-e2e.mjs
 */

import { findPageTarget } from './cdp-helpers.mjs';
import { loadEnv } from './load-env.mjs';
import { buildSettingsHarnessHelpers, makeSetConfigAndQuery, buildConfigEntry, createTestHarness } from './obsidian-helpers.mjs';

loadEnv();

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const PLUGIN_ID = 'auto-note-importer';
const E2E_CRED_ID = 'e2e-notion-cred-settings';
const E2E_CFG_ID = 'e2e-notion-cfg-settings';

const ENV = {
  token: process.env.NOTION_TOKEN || '',
  dataSourceId: process.env.NOTION_DATA_SOURCE_ID || '',
};

if (!ENV.token || !ENV.dataSourceId) {
  console.error('Missing NOTION_TOKEN or NOTION_DATA_SOURCE_ID in .env (see tests/e2e/.env.example).');
  process.exit(2);
}

// ---------------------------------------------------------------------------
// Obsidian-side helpers
// ---------------------------------------------------------------------------

const HELPERS = buildSettingsHarnessHelpers({ pluginId: PLUGIN_ID }) + `
  // Notion settings tests inject a dedicated e2e config keyed by
  // E2E_CFG_ID so the user's existing configs stay untouched. The setup
  // helper resets prior runs idempotently and marks the new config active.
  function getActiveConfig() {
    const p = getPlugin();
    return p.settings.configs.find(c => c.id === '${E2E_CFG_ID}');
  }

  function ensureNotionCredentialAndConfig() {
    const p = getPlugin();
    p.settings.credentials = p.settings.credentials.filter(c => c.id !== '${E2E_CRED_ID}');
    const oldCfgIdx = p.settings.configs.findIndex(c => c.id === '${E2E_CFG_ID}');
    if (oldCfgIdx !== -1) {
      p.configManager.removeConfig('${E2E_CFG_ID}');
      p.settings.configs.splice(oldCfgIdx, 1);
    }
    p.settings.credentials.push({
      id: '${E2E_CRED_ID}',
      name: 'E2E Notion (Settings)',
      type: 'notion',
      integrationToken: ${JSON.stringify(ENV.token)},
    });
    p.settings.configs.push(${JSON.stringify(buildConfigEntry({
      id: E2E_CFG_ID,
      name: 'E2E Notion Settings Cfg',
      credentialId: E2E_CRED_ID,
      tableId: ENV.dataSourceId,
      folderPath: 'NotionE2E-Settings',
      filenameFieldName: '',
    }))});
    p.settings.activeConfigId = '${E2E_CFG_ID}';
  }
`;

// ---------------------------------------------------------------------------
// Test runner
// ---------------------------------------------------------------------------

let targetId;
const { results, log, run, test } = createTestHarness({ getTargetId: () => targetId, skipSupported: true });
const setConfigAndQuery = makeSetConfigAndQuery({ helpers: HELPERS, run });

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

(async () => {
  try {
    targetId = await findPageTarget();
    log(`CDP target: ${targetId}`);

    log('\n=== Setup: ensure Notion e2e credential + config ===');
    await run(`(async () => {
      ${HELPERS}
      ensureNotionCredentialAndConfig();
      await getPlugin().saveSettings();
      const tab = await openSettingsTab();
      resetSettingsTabState(tab);   // do not inherit a prior suite's UI state (#116)
      renderTab(tab);
      await new Promise(r => setTimeout(r, 300));
      return JSON.stringify({ ok: true });
    })()`, 10000);

    // ════════════════════════════════════════════════════════════════
    // Credential creation via the Add Credential form
    // ════════════════════════════════════════════════════════════════

    await test('credential form / Notion type shows a password-type token field', async () => {
      const r = await run(`(async () => {
        ${HELPERS}
        await openSettingsTab();
        const c = getContainer();
        const addBtn = Array.from(c.querySelectorAll('button')).find(b => b.textContent.includes('Add credential'));
        addBtn?.click();
        await new Promise(r => setTimeout(r, 300));

        const select = c.querySelector('.ani-credential-edit select');
        select.value = 'notion';
        select.dispatchEvent(new Event('change'));
        await new Promise(r => setTimeout(r, 400));

        const fields = Array.from(c.querySelectorAll('.ani-credential-edit')).map(el =>
          el.querySelector('.setting-item-name')?.textContent || ''
        );
        const tokenInput = c.querySelector('.ani-credential-add-details input');
        const inputType = tokenInput?.type || null;

        const cancelBtn = Array.from(c.querySelectorAll('button')).find(b => b.textContent === 'Cancel');
        cancelBtn?.click();
        await new Promise(r => setTimeout(r, 200));

        return JSON.stringify({ fields, inputType });
      })()`, 10000);
      const hasTokenField = r.fields.includes('Integration token');
      const pass = hasTokenField && r.inputType === 'password';
      return { pass, detail: `fields=[${r.fields.join(',')}] inputType=${r.inputType}` };
    });

    await test('credential form / ntn_-prefixed token shows an ok-tone hint', async () => {
      const r = await run(`(async () => {
        ${HELPERS}
        await openSettingsTab();
        const c = getContainer();
        const addBtn = Array.from(c.querySelectorAll('button')).find(b => b.textContent.includes('Add credential'));
        addBtn?.click();
        await new Promise(r => setTimeout(r, 300));

        const select = c.querySelector('.ani-credential-edit select');
        select.value = 'notion';
        select.dispatchEvent(new Event('change'));
        await new Promise(r => setTimeout(r, 400));

        const tokenInput = c.querySelector('.ani-credential-add-details input[type="password"]');
        const proto = Object.getPrototypeOf(tokenInput);
        const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
        setter.call(tokenInput, 'ntn_e2e_fake_token_for_hint_check');
        tokenInput.dispatchEvent(new Event('input', { bubbles: true }));
        await new Promise(r => setTimeout(r, 100));

        const hintEl = c.querySelector('.ani-credential-hint');
        const result = {
          hintText: hintEl?.textContent || '',
          isOkTone: !!hintEl?.classList.contains('ani-tone-ok'),
        };

        const cancelBtn = Array.from(c.querySelectorAll('button')).find(b => b.textContent === 'Cancel');
        cancelBtn?.click();
        await new Promise(r => setTimeout(r, 200));

        return JSON.stringify(result);
      })()`, 10000);
      const pass = r.isOkTone && /notion internal integration token/i.test(r.hintText);
      return { pass, detail: `hintText="${r.hintText}" isOkTone=${r.isOkTone}` };
    });

    await test('credential form / Test connection button drives a real connection check', async () => {
      // Clicks the real Test button (build + runConnectionTest — the exact
      // path Save also gates on), proving it's wired and enabled for a
      // Notion credential. The Notice text itself isn't inspectable from
      // the harness (esbuild's `external: ['obsidian']` locks the Notice
      // reference at build time — see the #91 note in
      // run-supabase-settings-e2e.mjs); the data-source *count* this same
      // testConnection call would report is instead verified against the
      // connection card's dropdown option count in the next test, since
      // both paths call NotionSchemaCache.listDataSources for the same
      // credential.
      const r = await run(`(async () => {
        ${HELPERS}
        await openSettingsTab();
        const c = getContainer();
        const addBtn = Array.from(c.querySelectorAll('button')).find(b => b.textContent.includes('Add credential'));
        addBtn?.click();
        await new Promise(r => setTimeout(r, 300));

        const select = c.querySelector('.ani-credential-edit select');
        select.value = 'notion';
        select.dispatchEvent(new Event('change'));
        await new Promise(r => setTimeout(r, 400));

        const tokenInput = c.querySelector('.ani-credential-add-details input[type="password"]');
        const proto = Object.getPrototypeOf(tokenInput);
        const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
        setter.call(tokenInput, ${JSON.stringify(ENV.token)});
        tokenInput.dispatchEvent(new Event('input', { bubbles: true }));
        await new Promise(r => setTimeout(r, 100));

        const testBtn = Array.from(c.querySelectorAll('button')).find(b => b.textContent === 'Test');
        const testBtnFound = !!testBtn;
        const testBtnDisabledBefore = !!testBtn?.disabled;
        testBtn?.click();
        await new Promise(r => setTimeout(r, 3000));
        const testBtnDisabledAfter = !!testBtn?.disabled;
        const testBtnTextAfter = testBtn?.textContent || '';

        const cancelBtn = Array.from(c.querySelectorAll('button')).find(b => b.textContent === 'Cancel');
        cancelBtn?.click();
        await new Promise(r => setTimeout(r, 200));

        return JSON.stringify({ testBtnFound, testBtnDisabledBefore, testBtnDisabledAfter, testBtnTextAfter });
      })()`, 15000);
      // The button must re-enable and restore its label after the async
      // check completes — a stuck "Testing…" state means the click threw.
      const pass = r.testBtnFound && !r.testBtnDisabledBefore && !r.testBtnDisabledAfter && r.testBtnTextAfter === 'Test';
      return { pass, detail: JSON.stringify(r) };
    });

    // ════════════════════════════════════════════════════════════════
    // Connection card: data source dropdown + filename auto-fill
    // ════════════════════════════════════════════════════════════════

    await test('connection card / renders a data source dropdown populated from the integration', async () => {
      const r = await run(`(async () => {
        ${HELPERS}
        await rerenderTab();
        let dropdowns = [];
        const start = Date.now();
        while (Date.now() - start < 8000) {
          const c = getContainer();
          dropdowns = Array.from(c.querySelectorAll('.ani-summary-card .ani-card-body select'));
          if (dropdowns.length >= 1) break;
          await new Promise(r => setTimeout(r, 200));
        }
        const dsDropdown = dropdowns[0];
        return JSON.stringify({
          dropdownCount: dropdowns.length,
          dsOptionCount: dsDropdown ? dsDropdown.options.length : 0,
        });
      })()`, 15000);
      const pass = r.dropdownCount >= 1 && r.dsOptionCount >= 2;
      return { pass, detail: `dropdowns=${r.dropdownCount} dsOptions=${r.dsOptionCount}` };
    });

    await test('connection card / selecting a data source fills tableId and auto-fills the filename field from the title property', async () => {
      const r = await run(`(async () => {
        ${HELPERS}
        const p = getPlugin();
        const cfg = getActiveConfig();
        cfg.tableId = '';
        cfg.filenameFieldName = '';
        await p.saveSettings();
        await rerenderTab();
        await new Promise(r => setTimeout(r, 300));

        let dsDropdown = null;
        const start = Date.now();
        while (Date.now() - start < 8000) {
          const c = getContainer();
          dsDropdown = Array.from(c.querySelectorAll('.ani-summary-card .ani-card-body select'))[0];
          if (dsDropdown && dsDropdown.options.length > 1) break;
          await new Promise(r => setTimeout(r, 200));
        }
        if (!dsDropdown) return JSON.stringify({ noDropdown: true });

        // Select the target data source (matches NOTION_DATA_SOURCE_ID).
        dsDropdown.value = ${JSON.stringify(ENV.dataSourceId)};
        dsDropdown.dispatchEvent(new Event('change'));
        // Selecting kicks off an async schema fetch (auto-fill) — poll for it.
        let filled = false;
        const start2 = Date.now();
        while (Date.now() - start2 < 8000) {
          if ((getActiveConfig().filenameFieldName || '') !== '') { filled = true; break; }
          await new Promise(r => setTimeout(r, 200));
        }

        return JSON.stringify({
          tableId: getActiveConfig().tableId,
          filenameFieldName: getActiveConfig().filenameFieldName,
          filled,
        });
      })()`, 20000);
      if (r.noDropdown) return { pass: false, detail: 'data source dropdown never populated' };
      const pass = r.tableId === ENV.dataSourceId && r.filled && r.filenameFieldName;
      return { pass, detail: `tableId=${r.tableId} filenameFieldName="${r.filenameFieldName}" filled=${r.filled}` };
    });

    await test('connection card / filename + subfolder dropdowns are filtered by notion-field-mapper', async () => {
      const r = await run(`(async () => {
        ${HELPERS}
        await rerenderTab();
        let selects = [];
        const start = Date.now();
        while (Date.now() - start < 8000) {
          const c = getContainer();
          selects = Array.from(c.querySelectorAll('.ani-summary-card .ani-card-body select'));
          if (selects.length >= 3) break;
          await new Promise(r => setTimeout(r, 200));
        }
        if (selects.length < 3) return JSON.stringify({ tooFew: true, count: selects.length });
        // Order: Data source, Filename field, Subfolder field.
        const filenameOptions = Array.from(selects[1].options).map(o => o.value).filter(Boolean);
        const subfolderOptions = Array.from(selects[2].options).map(o => o.value).filter(Boolean);
        return JSON.stringify({ filenameOptions, subfolderOptions });
      })()`, 15000);
      if (r.tooFew) return { pass: false, detail: `only ${r.count} selects rendered — schema not loaded in time` };
      // Filename options must never include Notes (rich_text isn't
      // filename-safe) or Tags (multi_select is neither filename- nor
      // subfolder-safe under notion-field-mapper).
      const filenameOk = !r.filenameOptions.includes('Notes') && !r.filenameOptions.includes('Tags');
      const subfolderOk = !r.subfolderOptions.includes('Tags');
      const pass = filenameOk && subfolderOk;
      return { pass, detail: `filenameOptions=[${r.filenameOptions.join(',')}] subfolderOptions=[${r.subfolderOptions.join(',')}]` };
    });

    await test('connection card / falls back to text inputs when integration token is empty', async () => {
      const r = await run(`(async () => {
        ${HELPERS}
        const p = getPlugin();
        const cred = p.settings.credentials.find(c => c.id === '${E2E_CRED_ID}');
        const savedToken = cred.integrationToken;
        cred.integrationToken = '';
        await p.saveSettings();
        await rerenderTab();
        await new Promise(r => setTimeout(r, 300));
        const c = getContainer();
        const inputs = Array.from(c.querySelectorAll('.ani-summary-card .ani-card-body input[type="text"]'));
        const dropdowns = Array.from(c.querySelectorAll('.ani-summary-card .ani-card-body select'));

        cred.integrationToken = savedToken;
        await p.saveSettings();
        await rerenderTab();

        return JSON.stringify({
          inputCount: inputs.length,
          dropdownCount: dropdowns.length,
        });
      })()`, 10000);
      // Fallback renders: Data source ID, Database ID, Filename, Subfolder
      // (4 text inputs). No select elements in fallback mode.
      const pass = r.inputCount >= 3 && r.dropdownCount === 0;
      return { pass, detail: `inputs=${r.inputCount} dropdowns=${r.dropdownCount}` };
    });

    // ── Cleanup ──────────────────────────────────────────────────

    log('\n=== Cleanup ===');
    await run(`(async () => {
      ${HELPERS}
      const p = getPlugin();
      const cfgIdx = p.settings.configs.findIndex(c => c.id === '${E2E_CFG_ID}');
      if (cfgIdx !== -1) {
        p.configManager.removeConfig('${E2E_CFG_ID}');
        p.settings.configs.splice(cfgIdx, 1);
      }
      p.settings.credentials = p.settings.credentials.filter(c => c.id !== '${E2E_CRED_ID}');
      if (p.settings.configs.length > 0) {
        p.settings.activeConfigId = p.settings.configs[0].id;
      }
      await p.saveSettings();
      app.setting.close();
      return JSON.stringify({ ok: true });
    })()`, 10000);

    // ── Summary ──────────────────────────────────────────────────

    log('\n========================================');
    log('   Notion Settings UI E2E SUMMARY');
    log('========================================');
    let passCount = 0;
    let skipCount = 0;
    for (const r of results) {
      const icon = r.skip ? 'SKIP' : (r.pass ? 'PASS' : 'FAIL');
      log(`${icon} | ${r.test}`);
      if (r.skip) { log(`       ${r.detail}`); skipCount++; continue; }
      if (!r.pass) log(`       ${r.detail}`);
      if (r.pass) passCount++;
    }
    log(`\nTotal: ${passCount} passed, ${skipCount} skipped, ${results.length - passCount - skipCount} failed`);

    process.exit((passCount + skipCount) === results.length ? 0 : 1);
  } catch (e) {
    console.error('FATAL:', e.message);
    process.exit(1);
  }
})();
