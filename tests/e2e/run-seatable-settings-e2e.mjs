/**
 * Settings UI E2E Tests for SeaTable provider.
 *
 * Mirrors run-settings-e2e.mjs (Airtable). Adds a SeaTable-specific
 * credential + ConfigEntry, then validates the SeaTable Connection card,
 * provider-aware badges/summary, and credential add/edit forms.
 *
 * @covers src/ui/settings-tab.ts
 * @covers src/services/seatable-credential-form.ts
 *
 * Prerequisites: same as run-seatable-e2e.mjs (.env + Obsidian + plugin).
 *
 * Usage:
 *   node tests/e2e/run-seatable-settings-e2e.mjs
 */

import { findPageTarget } from './cdp-helpers.mjs';
import { loadEnv } from './load-env.mjs';
import { buildSettingsHarnessHelpers, makeSetConfigAndQuery, buildConfigEntry, createTestHarness } from './obsidian-helpers.mjs';

loadEnv();

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const PLUGIN_ID = 'auto-note-importer';
const E2E_CRED_ID = 'e2e-seatable-cred-settings';
const E2E_CFG_ID = 'e2e-seatable-cfg-settings';

const ENV = {
  apiToken: process.env.SEATABLE_API_TOKEN || 'placeholder-token',
  serverUrl: (process.env.SEATABLE_SERVER_URL || 'https://cloud.seatable.io').replace(/\/+$/, ''),
  tableId: process.env.SEATABLE_TABLE_ID || '0000',
};

// ---------------------------------------------------------------------------
// Obsidian-side helpers
// ---------------------------------------------------------------------------

const HELPERS = buildSettingsHarnessHelpers({ pluginId: PLUGIN_ID }) + `
  // SeaTable settings tests inject a dedicated e2e config keyed by
  // E2E_CFG_ID so the user's existing configs stay untouched. The setup
  // helper resets prior runs idempotently and marks the new config active.
  function getActiveConfig() {
    const p = getPlugin();
    return p.settings.configs.find(c => c.id === '${E2E_CFG_ID}');
  }

  function ensureSeaCredentialAndConfig() {
    const p = getPlugin();
    p.settings.credentials = p.settings.credentials.filter(c => c.id !== '${E2E_CRED_ID}');
    const oldCfgIdx = p.settings.configs.findIndex(c => c.id === '${E2E_CFG_ID}');
    if (oldCfgIdx !== -1) {
      p.configManager.removeConfig('${E2E_CFG_ID}');
      p.settings.configs.splice(oldCfgIdx, 1);
    }
    p.settings.credentials.push({
      id: '${E2E_CRED_ID}',
      name: 'E2E SeaTable (Settings)',
      type: 'seatable',
      apiToken: ${JSON.stringify(ENV.apiToken)},
      serverUrl: ${JSON.stringify(ENV.serverUrl)},
    });
    p.settings.configs.push(${JSON.stringify(buildConfigEntry({
      id: E2E_CFG_ID,
      name: 'E2E SeaTable Settings Cfg',
      credentialId: E2E_CRED_ID,
      tableId: ENV.tableId,
      folderPath: 'SeaTable-E2E-Settings',
    }))});
    p.settings.activeConfigId = '${E2E_CFG_ID}';
  }
`;

// ---------------------------------------------------------------------------
// Test runner
// ---------------------------------------------------------------------------

let targetId;
const { results, log, run, test } = createTestHarness({ getTargetId: () => targetId });
const setConfigAndQuery = makeSetConfigAndQuery({ helpers: HELPERS, run });

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

(async () => {
  try {
    targetId = await findPageTarget();
    log(`CDP target: ${targetId}`);

    log('\n=== Setup: ensure SeaTable e2e credential + config ===');
    await run(`(async () => {
      ${HELPERS}
      ensureSeaCredentialAndConfig();
      await getPlugin().saveSettings();
      await openSettingsTab();
      return JSON.stringify({ ok: true });
    })()`, 10000);

    // ════════════════════════════════════════════════════════════════
    // Layout
    // ════════════════════════════════════════════════════════════════

    await test('layout / SeaTable connection card renders (4 cards total)', async () => {
      const r = await run(`(async () => {
        ${HELPERS}
        const c = getContainer();
        const cards = c.querySelectorAll('.ani-card-stack .ani-summary-card');
        const titles = Array.from(cards).map(card =>
          card.querySelector('.ani-card-title')?.textContent || ''
        );
        return JSON.stringify({ count: cards.length, titles });
      })()`, 10000);
      const pass = r.count === 4
        && r.titles.includes('SeaTable Connection')
        && r.titles.includes('File Settings')
        && r.titles.includes('Bases Database')
        && r.titles.includes('Bidirectional Sync');
      return { pass, detail: `count=${r.count} titles=[${r.titles.join(', ')}]` };
    });

    await test('layout / Airtable Connection card NOT rendered for SeaTable cred', async () => {
      const r = await run(`(async () => {
        ${HELPERS}
        const c = getContainer();
        const titles = Array.from(c.querySelectorAll('.ani-card-title')).map(t => t.textContent);
        return JSON.stringify({ titles });
      })()`, 10000);
      return { pass: !r.titles.includes('Airtable Connection'), detail: `titles=[${r.titles.join(', ')}]` };
    });

    // ════════════════════════════════════════════════════════════════
    // Badges (tableId-only since SeaTable's API token is base-specific)
    // ════════════════════════════════════════════════════════════════

    await test('badge / connection — Connected when tableId set', async () => {
      const infos = await setConfigAndQuery({ tableId: '0000' });
      const card = infos.find(c => c.title === 'SeaTable Connection');
      return { pass: card?.badge === 'Connected' && card?.isOk, detail: `badge="${card?.badge}" ok=${card?.isOk}` };
    });

    await test('badge / connection — Setup required when tableId empty', async () => {
      const infos = await setConfigAndQuery({ tableId: '' });
      const card = infos.find(c => c.title === 'SeaTable Connection');
      return { pass: card?.badge === 'Setup required' && card?.isOff, detail: `badge="${card?.badge}" off=${card?.isOff}` };
    });

    await test('badge / connection — baseId is irrelevant for SeaTable', async () => {
      const infos = await setConfigAndQuery({ baseId: '', tableId: '0000' });
      const card = infos.find(c => c.title === 'SeaTable Connection');
      return { pass: card?.badge === 'Connected', detail: `badge="${card?.badge}" (expected Connected even though baseId is empty)` };
    });

    // ════════════════════════════════════════════════════════════════
    // Summary
    // ════════════════════════════════════════════════════════════════

    await test('summary / connection — shows filenameField and View filtered', async () => {
      const infos = await setConfigAndQuery({
        tableId: '0000', filenameFieldName: 'Name', viewId: 'view-1',
      });
      const card = infos.find(c => c.title === 'SeaTable Connection');
      const pass = card && card.summary.includes('Name') && card.summary.includes('View filtered');
      return { pass, detail: `summary="${card?.summary}"` };
    });

    await test('summary / connection — empty when not connected', async () => {
      const infos = await setConfigAndQuery({
        tableId: '', filenameFieldName: 'Name', viewId: 'view-1',
      });
      const card = infos.find(c => c.title === 'SeaTable Connection');
      return { pass: card?.summary === '', detail: `summary="${card?.summary}"` };
    });

    // ════════════════════════════════════════════════════════════════
    // Credential add form: SeaTable type
    // ════════════════════════════════════════════════════════════════

    await test('credential / SeaTable type shows API Token + Server URL fields', async () => {
      const r = await run(`(async () => {
        ${HELPERS}
        await openSettingsTab();
        const c = getContainer();
        const addBtn = Array.from(c.querySelectorAll('button')).find(b => b.textContent.includes('Add credential'));
        addBtn?.click();
        await new Promise(r => setTimeout(r, 300));

        const select = c.querySelector('.ani-credential-edit select');
        select.value = 'seatable';
        select.dispatchEvent(new Event('change'));
        await new Promise(r => setTimeout(r, 400));

        const fields = Array.from(c.querySelectorAll('.ani-credential-edit')).map(el =>
          el.querySelector('.setting-item-name')?.textContent || ''
        );
        const saveBtn = Array.from(c.querySelectorAll('button')).find(b => b.textContent === 'Save');
        const testBtn = Array.from(c.querySelectorAll('button')).find(b => b.textContent === 'Test');
        const saveDisabled = !!saveBtn?.disabled;
        const testDisabled = !!testBtn?.disabled;

        const cancelBtn = Array.from(c.querySelectorAll('button')).find(b => b.textContent === 'Cancel');
        cancelBtn?.click();
        await new Promise(r => setTimeout(r, 200));

        return JSON.stringify({ fields, saveDisabled, testDisabled });
      })()`, 10000);
      const hasToken = r.fields.includes('API Token');
      const hasServer = r.fields.includes('Server URL');
      const pass = hasToken && hasServer && !r.saveDisabled && !r.testDisabled;
      return { pass, detail: `fields=[${r.fields.join(',')}] saveDisabled=${r.saveDisabled} testDisabled=${r.testDisabled}` };
    });

    await test('credential / SeaTable description mentions API token', async () => {
      const r = await run(`(async () => {
        ${HELPERS}
        await openSettingsTab();
        const c = getContainer();
        const addBtn = Array.from(c.querySelectorAll('button')).find(b => b.textContent.includes('Add credential'));
        addBtn?.click();
        await new Promise(r => setTimeout(r, 300));

        const select = c.querySelector('.ani-credential-edit select');
        select.value = 'seatable';
        select.dispatchEvent(new Event('change'));
        await new Promise(r => setTimeout(r, 400));

        const desc = Array.from(c.querySelectorAll('.ani-credential-desc'))
          .map(el => el.textContent).join(' | ');

        const cancelBtn = Array.from(c.querySelectorAll('button')).find(b => b.textContent === 'Cancel');
        cancelBtn?.click();
        await new Promise(r => setTimeout(r, 200));

        return JSON.stringify({ desc });
      })()`, 10000);
      return { pass: /api token/i.test(r.desc), detail: `desc="${r.desc}"` };
    });

    await test('credential / edit form for SeaTable shows Test button', async () => {
      const r = await run(`(async () => {
        ${HELPERS}
        const tab = getSettingsTab();
        await openSettingsTab();
        tab.editingCredentialId = '${E2E_CRED_ID}';
        tab.display();
        await new Promise(r => setTimeout(r, 300));

        const c = getContainer();
        const fieldNames = Array.from(c.querySelectorAll('.setting-item-name')).map(el => el.textContent);
        const testBtn = Array.from(c.querySelectorAll('button')).find(b => b.textContent === 'Test');

        tab.editingCredentialId = null;
        tab.display();
        await new Promise(r => setTimeout(r, 200));

        return JSON.stringify({
          hasApiToken: fieldNames.includes('API Token'),
          hasServerUrl: fieldNames.includes('Server URL'),
          hasTestBtn: !!testBtn,
          testBtnDisabled: !!testBtn?.disabled,
        });
      })()`, 10000);
      const pass = r.hasApiToken && r.hasServerUrl && r.hasTestBtn && !r.testBtnDisabled;
      return { pass, detail: `apiToken=${r.hasApiToken} server=${r.hasServerUrl} test=${r.hasTestBtn} disabled=${r.testBtnDisabled}` };
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
    log('   SeaTable Settings UI E2E SUMMARY');
    log('========================================');
    let passCount = 0;
    for (const r of results) {
      const icon = r.pass ? 'PASS' : 'FAIL';
      log(`${icon} | ${r.test}`);
      if (!r.pass) log(`       ${r.detail}`);
      if (r.pass) passCount++;
    }
    log(`\nTotal: ${passCount}/${results.length} passed`);

    process.exit(passCount === results.length ? 0 : 1);
  } catch (e) {
    console.error('FATAL:', e.message);
    process.exit(1);
  }
})();
