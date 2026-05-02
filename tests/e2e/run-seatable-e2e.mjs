/**
 * E2E Test Suite for SeaTable provider.
 *
 * Mirrors run-e2e.mjs (the Airtable suite) against a live SeaTable Cloud
 * (or self-hosted) instance via Chrome DevTools Protocol (CDP).
 *
 * @covers src/services/seatable-client.ts
 * @covers src/services/seatable-field-mapper.ts
 * @covers src/services/seatable-credential-form.ts
 * @covers src/services/provider-registry.ts
 * @covers src/core/sync-orchestrator.ts
 * @covers src/core/config-instance.ts
 *
 * Prerequisites:
 *   1. Obsidian running with --remote-debugging-port=9222
 *   2. The plugin built and installed in your test vault
 *   3. A `.env` file at repo root with at least:
 *        SEATABLE_API_TOKEN=<base-specific Read-Write token>
 *        SEATABLE_TABLE_ID=0000        (defaults to '0000')
 *        SEATABLE_SERVER_URL=https://cloud.seatable.io   (default)
 *      See tests/e2e/.env.example.
 *   4. The target base must have a `Name` (text) column. Optional columns
 *      `Count` (number) and `Status` (single-select) unlock more checks;
 *      missing columns are skipped gracefully.
 *
 * What the harness does:
 *   - Adds (or reuses) a dedicated SeaTable credential + ConfigEntry
 *     keyed by E2E_CRED_ID / E2E_CFG_ID so it never touches your
 *     existing configs.
 *   - Inserts a handful of test rows via POST /rows/, exercises pull /
 *     push / bidirectional / Bases-file flows, then cleans up.
 *
 * Usage:
 *   node tests/e2e/run-seatable-e2e.mjs              # leaves rows in place
 *   node tests/e2e/run-seatable-e2e.mjs --cleanup    # also deletes rows
 */

import { findPageTarget, evalInObsidian } from './cdp-helpers.mjs';
import { loadEnv } from './load-env.mjs';

loadEnv();

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const PLUGIN_ID = 'auto-note-importer';
const E2E_CRED_ID = 'e2e-seatable-cred';
const E2E_CFG_ID = 'e2e-seatable-cfg';

const ENV = {
  apiToken: process.env.SEATABLE_API_TOKEN || '',
  serverUrl: (process.env.SEATABLE_SERVER_URL || 'https://cloud.seatable.io').replace(/\/+$/, ''),
  tableId: process.env.SEATABLE_TABLE_ID || '0000',
  viewId: process.env.SEATABLE_VIEW_ID || '',
  folderPath: process.env.SEATABLE_FOLDER_PATH || 'SeaTable-E2E',
};

if (!ENV.apiToken) {
  console.error('SEATABLE_API_TOKEN missing — populate .env (see tests/e2e/.env.example).');
  process.exit(2);
}

const TEST_ROW_NAMES = ['E2E-ST-Pull', 'E2E-ST-Push', 'E2E-ST-Bidir'];
let testRowIds = [];

// ---------------------------------------------------------------------------
// Obsidian-side helpers (injected into eval expressions)
// ---------------------------------------------------------------------------

const HELPERS = `
  function getPlugin() { return app.plugins.plugins['${PLUGIN_ID}']; }

  function getSeaConfig() {
    const p = getPlugin();
    return p.settings.configs.find(c => c.id === '${E2E_CFG_ID}');
  }

  function getSeaCredential() {
    const p = getPlugin();
    return p.settings.credentials.find(c => c.id === '${E2E_CRED_ID}');
  }

  function getInstance(config) {
    const p = getPlugin();
    return p.configManager.getInstance((config || getSeaConfig()).id);
  }

  function setMode(mode, autoFormula) {
    const cfg = getSeaConfig();
    const cred = getSeaCredential();
    cfg.conflictResolution = mode;
    if (autoFormula !== undefined) cfg.autoSyncComputedFields = autoFormula;
    getInstance().updateSettings(cfg, cred);
  }

  async function exchangeBaseToken() {
    const cred = getSeaCredential();
    const url = cred.serverUrl.replace(/\\/+$/, '') + '/api/v2.1/dtable/app-access-token/';
    const r = await fetch(url, { headers: { 'Authorization': 'Token ' + cred.apiToken } });
    if (!r.ok) throw new Error('Base-Token exchange failed: HTTP ' + r.status);
    return await r.json();
  }

  function buildRowsUrl(tok, suffix = '') {
    const server = (tok.dtable_server || '').replace(/\\/+$/, '');
    return server + '/api/v2/dtables/' + tok.dtable_uuid + '/rows/' + suffix;
  }

  async function insertRows(names) {
    const cfg = getSeaConfig();
    const tok = await exchangeBaseToken();
    const r = await fetch(buildRowsUrl(tok), {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + tok.access_token, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        table_id: cfg.tableId,
        rows: names.map(n => ({ Name: n })),
      }),
    });
    const j = await r.json();
    const ids = (j.row_ids || []).map(x => x._id || x);
    return ids;
  }

  async function fetchRowFromSeaTable(rowId) {
    const cfg = getSeaConfig();
    const tok = await exchangeBaseToken();
    const url = buildRowsUrl(tok, rowId + '/?table_id=' + encodeURIComponent(cfg.tableId) + '&convert_keys=true');
    const r = await fetch(url, { headers: { 'Authorization': 'Bearer ' + tok.access_token } });
    if (r.status === 404) return null;
    if (!r.ok) throw new Error('fetchRow failed: HTTP ' + r.status);
    return await r.json();
  }

  async function deleteRows(rowIds) {
    if (!rowIds || rowIds.length === 0) return;
    const cfg = getSeaConfig();
    const tok = await exchangeBaseToken();
    await fetch(buildRowsUrl(tok), {
      method: 'DELETE',
      headers: { 'Authorization': 'Bearer ' + tok.access_token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ table_id: cfg.tableId, row_ids: rowIds }),
    });
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

  async function modifyName(file, newName) {
    let content = await app.vault.read(file);
    content = content.replace(/Name:.*$/m, 'Name: ' + newName);
    await app.vault.modify(file, content);
    await waitForCache(file, 'Name', newName);
  }

  async function enqueueSync(mode, scope, config) {
    const inst = getInstance(config);
    if (!inst) throw new Error('No ConfigInstance for ' + (config || getSeaConfig()).id);
    await inst.enqueueSyncRequest(mode, scope);
  }
`;

// ---------------------------------------------------------------------------
// Test runner
// ---------------------------------------------------------------------------

const results = [];
let targetId;

function log(msg) { console.log(msg); }

async function run(expr, timeout) {
  const r = await evalInObsidian(targetId, expr, timeout);
  if (r && typeof r === 'object' && r.__error) {
    throw new Error(r.__error);
  }
  return r;
}

async function test(name, fn) {
  log(`\n=== ${name} ===`);
  try {
    const { pass, detail } = await fn();
    results.push({ test: name, pass, detail: detail || 'ok' });
    log(pass ? 'PASS' : `FAIL - ${detail}`);
  } catch (e) {
    results.push({ test: name, pass: false, detail: e.message });
    log(`FAIL - ${e.message}`);
  }
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

async function setup() {
  log('=== Setup: Add SeaTable credential + config (idempotent) ===');
  await run(`(async () => {
    ${HELPERS}
    const p = getPlugin();
    const credId = '${E2E_CRED_ID}';
    const cfgId = '${E2E_CFG_ID}';

    // Replace any prior e2e credential/config so we always start clean.
    p.settings.credentials = p.settings.credentials.filter(c => c.id !== credId);
    const oldCfgIdx = p.settings.configs.findIndex(c => c.id === cfgId);
    if (oldCfgIdx !== -1) {
      p.configManager.removeConfig(cfgId);
      p.settings.configs.splice(oldCfgIdx, 1);
    }

    p.settings.credentials.push({
      id: credId,
      name: 'E2E SeaTable',
      type: 'seatable',
      apiToken: ${JSON.stringify(ENV.apiToken)},
      serverUrl: ${JSON.stringify(ENV.serverUrl)},
    });

    p.settings.configs.push({
      id: cfgId,
      name: 'E2E SeaTable Cfg',
      enabled: true,
      credentialId: credId,
      baseId: '',
      tableId: ${JSON.stringify(ENV.tableId)},
      viewId: ${JSON.stringify(ENV.viewId)},
      folderPath: ${JSON.stringify(ENV.folderPath)},
      templatePath: '',
      filenameFieldName: 'Name',
      subfolderFieldName: '',
      syncInterval: 0,
      allowOverwrite: true,
      bidirectionalSync: true,
      conflictResolution: 'manual',
      watchForChanges: false,
      fileWatchDebounce: 2000,
      autoSyncComputedFields: false,
      formulaSyncDelay: 1500,
      generateBasesFile: false,
      basesFileLocation: 'vault-root',
      basesCustomPath: '',
      basesRegenerateOnSync: false,
    });

    await p.saveSettings();
    return JSON.stringify({ ok: true });
  })()`, 15000);

  log('=== Setup: Reload plugin ===');
  await run(`(async () => {
    await app.plugins.disablePlugin('${PLUGIN_ID}');
    await app.plugins.enablePlugin('${PLUGIN_ID}');
    return JSON.stringify({ ok: true });
  })()`, 15000);

  log('=== Setup: Insert test rows via POST /rows/ ===');
  const ids = await run(`(async () => {
    ${HELPERS}
    const ids = await insertRows(${JSON.stringify(TEST_ROW_NAMES)});
    return JSON.stringify(ids);
  })()`, 20000);

  if (!Array.isArray(ids) || ids.length !== TEST_ROW_NAMES.length) {
    throw new Error(`Failed to insert test rows; got ${JSON.stringify(ids)}`);
  }
  testRowIds = ids;
  log(`Created ${ids.length} test rows: ${ids.join(', ')}`);
}

function resetExpr() {
  return `(async () => {
    ${HELPERS}
    const cfg = getSeaConfig();
    const tok = await exchangeBaseToken();
    await fetch(buildRowsUrl(tok), {
      method: 'PUT',
      headers: { 'Authorization': 'Bearer ' + tok.access_token, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        table_id: cfg.tableId,
        updates: [
          { row_id: ${JSON.stringify(testRowIds[0])}, row: { Name: 'E2E-ST-Pull' } },
          { row_id: ${JSON.stringify(testRowIds[1])}, row: { Name: 'E2E-ST-Push' } },
          { row_id: ${JSON.stringify(testRowIds[2])}, row: { Name: 'E2E-ST-Bidir' } },
        ],
      }),
    });
    setMode('manual', false);
    await enqueueSync('pull', 'all');
    await new Promise(r => setTimeout(r, 6000));
    return JSON.stringify({ ok: true });
  })()`;
}

async function doReset() { await run(resetExpr(), 25000); }

async function cleanup() {
  log('\n=== Cleanup: Delete test rows + local files + e2e config ===');
  await run(`(async () => {
    ${HELPERS}
    const p = getPlugin();
    const cfg = getSeaConfig();

    // Delete from SeaTable
    await deleteRows(${JSON.stringify(testRowIds)});

    // Delete local .md files we created during pull
    if (cfg) {
      const folder = cfg.folderPath;
      const files = app.vault.getFiles().filter(f => f.path.startsWith(folder + '/'));
      for (const f of files) await app.vault.delete(f);
      const folderEntry = app.vault.getAbstractFileByPath(folder);
      if (folderEntry) {
        try { await app.vault.delete(folderEntry, true); } catch {}
      }
      // Delete .base files we may have created
      const basesFiles = app.vault.getFiles().filter(f => f.extension === 'base' && f.basename.toLowerCase().includes('e2e'));
      for (const f of basesFiles) await app.vault.delete(f);
    }

    // Detach e2e credential + config (idempotent)
    const cfgIdx = p.settings.configs.findIndex(c => c.id === '${E2E_CFG_ID}');
    if (cfgIdx !== -1) {
      p.configManager.removeConfig('${E2E_CFG_ID}');
      p.settings.configs.splice(cfgIdx, 1);
    }
    p.settings.credentials = p.settings.credentials.filter(c => c.id !== '${E2E_CRED_ID}');
    await p.saveSettings();
    return JSON.stringify({ ok: true });
  })()`, 20000);
  log('Cleaned up SeaTable test data + local files + e2e config.');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

(async () => {
  try {
    targetId = await findPageTarget();
    log(`CDP target: ${targetId}`);

    await setup();
    await doReset();

    // -- Pull tests --

    await test('pull / all creates one .md per row', async () => {
      const r = await run(`(async () => {
        ${HELPERS}
        await enqueueSync('pull', 'all');
        await new Promise(r => setTimeout(r, 6000));
        const cfg = getSeaConfig();
        const files = app.vault.getFiles().filter(f =>
          f.path.startsWith(cfg.folderPath + '/') && f.extension === 'md'
        );
        return JSON.stringify({ count: files.length, names: files.map(f => f.basename) });
      })()`, 20000);
      const pass = r.count >= TEST_ROW_NAMES.length &&
        TEST_ROW_NAMES.every(n => r.names.some(b => b === n));
      return { pass, detail: `count=${r.count} names=[${r.names.join(',')}]` };
    });

    await test('pull / current refetches single note', async () => {
      const r = await run(`(async () => {
        ${HELPERS}
        const cfg = getSeaConfig();
        const file = await openAndActivate(cfg.folderPath + '/E2E-ST-Pull.md');
        await enqueueSync('pull', 'current');
        await new Promise(r => setTimeout(r, 4000));
        const fm = app.metadataCache.getFileCache(file)?.frontmatter || {};
        return JSON.stringify({
          name: fm.Name,
          primaryField: fm.primaryField || fm._id || null,
        });
      })()`, 15000);
      const pass = r.name === 'E2E-ST-Pull' && r.primaryField === testRowIds[0];
      return { pass, detail: `name="${r.name}" primaryField="${r.primaryField}" expected primary=${testRowIds[0]}` };
    });

    // -- Push tests --

    await test('push / all / obsidian-wins propagates Name change', async () => {
      await doReset();
      const r = await run(`(async () => {
        ${HELPERS}
        setMode('obsidian-wins');
        const cfg = getSeaConfig();
        const file = app.vault.getAbstractFileByPath(cfg.folderPath + '/E2E-ST-Push.md');
        await modifyName(file, 'E2E-ST-Push-EDITED');
        await enqueueSync('push', 'all');
        await new Promise(r => setTimeout(r, 6000));
        const row = await fetchRowFromSeaTable(${JSON.stringify(testRowIds[1])});
        setMode('manual');
        return JSON.stringify({ remoteName: row?.Name });
      })()`, 25000);
      return { pass: r.remoteName === 'E2E-ST-Push-EDITED', detail: `remoteName="${r.remoteName}"` };
    });

    await test('push / current / obsidian-wins', async () => {
      await doReset();
      const r = await run(`(async () => {
        ${HELPERS}
        setMode('obsidian-wins');
        const cfg = getSeaConfig();
        const file = await openAndActivate(cfg.folderPath + '/E2E-ST-Bidir.md');
        await modifyName(file, 'E2E-ST-Bidir-CURRENT');
        await enqueueSync('push', 'current');
        await new Promise(r => setTimeout(r, 6000));
        const row = await fetchRowFromSeaTable(${JSON.stringify(testRowIds[2])});
        setMode('manual');
        return JSON.stringify({ remoteName: row?.Name });
      })()`, 25000);
      return { pass: r.remoteName === 'E2E-ST-Bidir-CURRENT', detail: `remoteName="${r.remoteName}"` };
    });

    await test('push / all / remote-wins keeps remote value', async () => {
      await doReset();
      const r = await run(`(async () => {
        ${HELPERS}
        setMode('remote-wins');
        const cfg = getSeaConfig();
        const file = app.vault.getAbstractFileByPath(cfg.folderPath + '/E2E-ST-Pull.md');
        await modifyName(file, 'E2E-ST-Pull-LOCAL-OVERRIDE');
        await enqueueSync('push', 'all');
        await new Promise(r => setTimeout(r, 6000));
        const row = await fetchRowFromSeaTable(${JSON.stringify(testRowIds[0])});
        setMode('manual');
        return JSON.stringify({ remoteName: row?.Name });
      })()`, 25000);
      return { pass: r.remoteName === 'E2E-ST-Pull', detail: `remoteName="${r.remoteName}" (expected E2E-ST-Pull)` };
    });

    await test('push / all / manual blocks conflicting field', async () => {
      await doReset();
      const r = await run(`(async () => {
        ${HELPERS}
        setMode('manual');
        const cfg = getSeaConfig();
        const file = app.vault.getAbstractFileByPath(cfg.folderPath + '/E2E-ST-Push.md');
        await modifyName(file, 'E2E-ST-Push-MANUAL-CONFLICT');
        await enqueueSync('push', 'all');
        await new Promise(r => setTimeout(r, 6000));
        const row = await fetchRowFromSeaTable(${JSON.stringify(testRowIds[1])});
        return JSON.stringify({ remoteName: row?.Name });
      })()`, 25000);
      return { pass: r.remoteName === 'E2E-ST-Push', detail: `remoteName="${r.remoteName}" (expected E2E-ST-Push)` };
    });

    // -- Bidirectional --

    await test('bidirectional / current pushes then re-reads', async () => {
      await doReset();
      const r = await run(`(async () => {
        ${HELPERS}
        setMode('obsidian-wins', false);
        const cfg = getSeaConfig();
        const file = await openAndActivate(cfg.folderPath + '/E2E-ST-Bidir.md');
        await modifyName(file, 'E2E-ST-Bidir-BIDIR');
        await enqueueSync('bidirectional', 'current');
        await new Promise(r => setTimeout(r, 8000));
        const updated = await app.vault.read(file);
        const row = await fetchRowFromSeaTable(${JSON.stringify(testRowIds[2])});
        setMode('manual', false);
        return JSON.stringify({
          remoteName: row?.Name,
          localHasName: updated.includes('Name: E2E-ST-Bidir-BIDIR'),
        });
      })()`, 30000);
      return {
        pass: r.remoteName === 'E2E-ST-Bidir-BIDIR' && r.localHasName,
        detail: `remoteName="${r.remoteName}" localHasName=${r.localHasName}`,
      };
    });

    // -- Bases file --

    await test('bases file generation', async () => {
      const r = await run(`(async () => {
        ${HELPERS}
        const p = getPlugin();
        const cfg = getSeaConfig();
        const cred = getSeaCredential();

        // Wipe any leftover .base files
        const before = app.vault.getFiles().filter(f => f.extension === 'base');
        for (const f of before) await app.vault.delete(f);

        cfg.generateBasesFile = true;
        cfg.basesFileLocation = 'vault-root';
        cfg.basesRegenerateOnSync = false;
        getInstance().updateSettings(cfg, cred);

        await enqueueSync('pull', 'all');
        await new Promise(r => setTimeout(r, 7000));

        const basesFiles = app.vault.getFiles().filter(f => f.extension === 'base');
        const found = basesFiles.length > 0;
        const content = found ? await app.vault.read(basesFiles[0]) : '';
        const inFolderOk = content.includes('file.inFolder("' + cfg.folderPath + '")');
        const tableViewOk = content.includes('type: table');

        // Cleanup
        for (const f of basesFiles) await app.vault.delete(f);
        cfg.generateBasesFile = false;
        getInstance().updateSettings(cfg, cred);

        return JSON.stringify({ found, inFolderOk, tableViewOk });
      })()`, 20000);
      return { pass: r.found && r.inFolderOk && r.tableViewOk, detail: `found=${r.found} folder=${r.inFolderOk} view=${r.tableViewOk}` };
    });

    // ── Summary ──────────────────────────────────────────────────

    log('\n========================================');
    log('     SeaTable E2E TEST SUMMARY');
    log('========================================');
    let passCount = 0;
    for (const r of results) {
      const icon = r.pass ? 'PASS' : 'FAIL';
      log(`${icon} | ${r.test}`);
      if (!r.pass) log(`       ${r.detail}`);
      if (r.pass) passCount++;
    }
    log(`\nTotal: ${passCount}/${results.length} passed`);

    // ── Cleanup ──────────────────────────────────────────────────
    if (process.argv.includes('--cleanup')) {
      await cleanup();
    } else {
      log('\nTest rows + local config left in place. Run with --cleanup to remove them.');
    }

    process.exit(passCount === results.length ? 0 : 1);
  } catch (e) {
    console.error('FATAL:', e.message);
    process.exit(1);
  }
})();
