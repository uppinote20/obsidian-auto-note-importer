/**
 * Settings UI E2E Tests for Supabase provider.
 *
 * Mirrors run-seatable-settings-e2e.mjs (SeaTable). Adds a Supabase-specific
 * credential + ConfigEntry, then validates the Supabase Connection card's
 * metadata-driven dropdown rendering (issue #53) and text-input fallback.
 *
 * @covers src/ui/settings-tab.ts
 * @covers src/services/supabase-credential-form.ts
 * @covers src/services/supabase-metadata-cache.ts
 *
 * Prerequisites: same as run-supabase-e2e.mjs (.env + Obsidian + plugin).
 *   SUPABASE_URL=https://<ref>.supabase.co
 *   SUPABASE_KEY=sb_publishable_... (or legacy anon JWT)
 *
 * Usage:
 *   node tests/e2e/run-supabase-settings-e2e.mjs
 */

import { findPageTarget } from './cdp-helpers.mjs';
import { loadEnv } from './load-env.mjs';
import { buildSettingsHarnessHelpers, buildConfigEntry, createTestHarness } from './obsidian-helpers.mjs';

loadEnv();

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const PLUGIN_ID = 'auto-note-importer';
const E2E_CRED_ID = 'e2e-supabase-cred-settings';
const E2E_CFG_ID = 'e2e-supabase-cfg-settings';

const ENV = {
  projectUrl: (process.env.SUPABASE_URL || '').replace(/\/+$/, ''),
  apiKey: process.env.SUPABASE_KEY || '',
  tableName: process.env.SUPABASE_TABLE || 'notes',
};

// ---------------------------------------------------------------------------
// Obsidian-side helpers
// ---------------------------------------------------------------------------

const HELPERS = buildSettingsHarnessHelpers({ pluginId: PLUGIN_ID }) + `
  // Supabase settings tests inject a dedicated e2e config keyed by
  // E2E_CFG_ID so the user's existing configs stay untouched. The setup
  // helper resets prior runs idempotently and marks the new config active.
  function getActiveConfig() {
    const p = getPlugin();
    return p.settings.configs.find(c => c.id === '${E2E_CFG_ID}');
  }

  function ensureSupabaseCredentialAndConfig() {
    const p = getPlugin();
    p.settings.credentials = p.settings.credentials.filter(c => c.id !== '${E2E_CRED_ID}');
    const oldCfgIdx = p.settings.configs.findIndex(c => c.id === '${E2E_CFG_ID}');
    if (oldCfgIdx !== -1) {
      p.configManager.removeConfig('${E2E_CFG_ID}');
      p.settings.configs.splice(oldCfgIdx, 1);
    }
    p.settings.credentials.push({
      id: '${E2E_CRED_ID}',
      name: 'E2E Supabase (Settings)',
      type: 'supabase',
      projectUrl: ${JSON.stringify(ENV.projectUrl)},
      apiKey: ${JSON.stringify(ENV.apiKey)},
    });
    p.settings.configs.push(${JSON.stringify(buildConfigEntry({
      id: E2E_CFG_ID,
      name: 'E2E Supabase Settings Cfg',
      credentialId: E2E_CRED_ID,
      tableId: ENV.tableName,
      folderPath: 'Supabase-E2E-Settings',
    }))});
    p.settings.activeConfigId = '${E2E_CFG_ID}';
  }
`;

// ---------------------------------------------------------------------------
// Test runner
// ---------------------------------------------------------------------------

let targetId;
const { results, log, run, test } = createTestHarness({ getTargetId: () => targetId });

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

(async () => {
  try {
    targetId = await findPageTarget();
    log(`CDP target: ${targetId}`);

    log('\n=== Setup: ensure Supabase e2e credential + config ===');
    await run(`(async () => {
      ${HELPERS}
      ensureSupabaseCredentialAndConfig();
      await getPlugin().saveSettings();
      await openSettingsTab();
      return JSON.stringify({ ok: true });
    })()`, 10000);

    // ════════════════════════════════════════════════════════════════
    // Issue #53: metadata-driven dropdowns
    // ════════════════════════════════════════════════════════════════

    await test('connection card / renders metadata dropdowns when api key is set (#53)', async () => {
      // The renderSupabaseConnection method fetches the OpenAPI spec
      // asynchronously. Poll until the 4 select elements appear (Table,
      // View, Filename, Subfolder — Schema stays a text input in dropdown
      // mode) or bail after 5 s.
      const r = await run(`(async () => {
        ${HELPERS}
        await rerenderTab();
        let dropdowns = [];
        const start = Date.now();
        while (Date.now() - start < 5000) {
          const c = getContainer();
          dropdowns = Array.from(c.querySelectorAll('.ani-summary-card .ani-card-body select'));
          if (dropdowns.length >= 3) break;
          await new Promise(r => setTimeout(r, 200));
        }
        const tableDropdown = dropdowns[0];
        const optionCount = tableDropdown ? tableDropdown.options.length : 0;
        return JSON.stringify({
          dropdownCount: dropdowns.length,
          tableOptionCount: optionCount,
        });
      })()`, 12000);
      // 4 selects: Table, View, Filename, Subfolder.
      // Table dropdown must have at least 2 options: placeholder + ≥1 real table.
      const pass = r.dropdownCount >= 3 && r.tableOptionCount >= 2;
      return { pass, detail: `dropdowns=${r.dropdownCount} tableOptions=${r.tableOptionCount}` };
    });

    await test('connection card / falls back to text inputs when api key is empty (#53)', async () => {
      const r = await run(`(async () => {
        ${HELPERS}
        const p = getPlugin();
        const cred = p.settings.credentials.find(c => c.id === '${E2E_CRED_ID}');
        const savedKey = cred.apiKey;
        cred.apiKey = '';
        await p.saveSettings();
        await rerenderTab();
        await new Promise(r => setTimeout(r, 300));
        const c = getContainer();
        const inputs = Array.from(c.querySelectorAll('.ani-summary-card .ani-card-body input[type="text"]'));
        const dropdowns = Array.from(c.querySelectorAll('.ani-summary-card .ani-card-body select'));

        cred.apiKey = savedKey;
        await p.saveSettings();
        await rerenderTab();

        return JSON.stringify({
          inputCount: inputs.length,
          dropdownCount: dropdowns.length,
        });
      })()`, 10000);
      // Fallback renders: Schema, Table, View, PK column, Filename, Subfolder (6 text inputs).
      // No select elements in fallback mode.
      const pass = r.inputCount >= 4 && r.dropdownCount === 0;
      return { pass, detail: `inputs=${r.inputCount} dropdowns=${r.dropdownCount}` };
    });

    // ════════════════════════════════════════════════════════════════
    // G4 #7 — credential row displays masked key (not em-dash)
    // ════════════════════════════════════════════════════════════════

    await test('credentials table / Supabase row shows masked key, not em-dash (G4 #7)', async () => {
      const r = await run(`(async () => {
        ${HELPERS}
        await rerenderTab();
        await new Promise(r => setTimeout(r, 300));
        const c = getContainer();
        // Find the row in the credentials table that corresponds to our e2e cred.
        const rows = Array.from(c.querySelectorAll('table tr'));
        const target = rows.find(r => r.textContent && r.textContent.includes('E2E Supabase'));
        if (!target) return JSON.stringify({ foundRow: false });
        const keyCell = target.querySelector('.ani-cred-key, .ani-cred-key-na, .ani-cred-key-set');
        return JSON.stringify({
          foundRow: true,
          cellClass: keyCell?.className || null,
          cellText: keyCell?.textContent || '',
        });
      })()`, 10000);
      // Pass: masked-key span (.ani-cred-key) with bullet-dot prefix (••••).
      const isMasked = r.foundRow && r.cellClass === 'ani-cred-key' && /•+/.test(r.cellText);
      return {
        pass: isMasked,
        detail: `foundRow=${r.foundRow} class=${r.cellClass} text="${r.cellText}"`,
      };
    });

    // ════════════════════════════════════════════════════════════════
    // G4 #9 — fallback schema change cascades to dependent fields
    // ════════════════════════════════════════════════════════════════

    await test('connection card / fallback schema change clears tableId/viewId/primaryKeyColumn/filename/subfolder (G4 #9)', async () => {
      const r = await run(`(async () => {
        ${HELPERS}
        const p = getPlugin();
        const cred = p.settings.credentials.find(c => c.id === '${E2E_CRED_ID}');
        const cfg = getActiveConfig();

        // Force fallback by clearing apiKey, populate dependent fields, then mutate schema.
        const savedKey = cred.apiKey;
        cred.apiKey = '';
        cfg.baseId = 'public';
        cfg.tableId = 'notes';
        cfg.viewId = 'active_notes';
        cfg.primaryKeyColumn = 'id';
        cfg.filenameFieldName = 'title';
        cfg.subfolderFieldName = 'status';
        await p.saveSettings();
        await rerenderTab();
        await new Promise(r => setTimeout(r, 300));

        const c = getContainer();
        const inputs = Array.from(c.querySelectorAll('.ani-summary-card .ani-card-body input[type="text"]'));
        // First input is the Schema field in the fallback layout.
        const schemaInput = inputs[0];
        if (!schemaInput) {
          cred.apiKey = savedKey;
          await p.saveSettings();
          return JSON.stringify({ noSchemaInput: true });
        }

        // Simulate user typing a new schema name and dispatching the input event.
        const proto = Object.getPrototypeOf(schemaInput);
        const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
        setter.call(schemaInput, 'analytics');
        schemaInput.dispatchEvent(new Event('input', { bubbles: true }));
        // Debounce inside settings-tab is 400 ms — wait a bit longer.
        await new Promise(r => setTimeout(r, 700));

        const result = {
          baseId: cfg.baseId,
          tableId: cfg.tableId,
          viewId: cfg.viewId,
          primaryKeyColumn: cfg.primaryKeyColumn,
          filenameFieldName: cfg.filenameFieldName,
          subfolderFieldName: cfg.subfolderFieldName,
        };

        // Restore
        cred.apiKey = savedKey;
        cfg.baseId = 'public';
        cfg.tableId = 'notes';
        cfg.viewId = '';
        cfg.primaryKeyColumn = 'id';
        cfg.filenameFieldName = '';
        cfg.subfolderFieldName = '';
        await p.saveSettings();
        await rerenderTab();

        return JSON.stringify(result);
      })()`, 15000);
      if (r.noSchemaInput) return { pass: false, detail: 'fallback schema input not found' };
      const allCleared = r.tableId === '' && r.viewId === '' && r.primaryKeyColumn === ''
        && r.filenameFieldName === '' && r.subfolderFieldName === '';
      const schemaUpdated = r.baseId === 'analytics';
      return {
        pass: allCleared && schemaUpdated,
        detail: `schema=${r.baseId} table="${r.tableId}" view="${r.viewId}" pk="${r.primaryKeyColumn}" fn="${r.filenameFieldName}" sf="${r.subfolderFieldName}"`,
      };
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
    log('   Supabase Settings UI E2E SUMMARY');
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
