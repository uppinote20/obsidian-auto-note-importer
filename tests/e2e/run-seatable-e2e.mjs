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
 *   4. The target table needs a `Name` (text) column — that's it. The
 *      harness ensures the rest (Count number / Description long-text /
 *      DueDate date / Done checkbox / Status single-select / Cal formula
 *      computed from `{Count} * 2`) idempotently. Existing schema is
 *      preserved; only missing columns are added.
 *
 * What the harness does:
 *   - Adds (or reuses) a dedicated SeaTable credential + ConfigEntry
 *     keyed by E2E_CRED_ID / E2E_CFG_ID so it never touches your
 *     existing configs.
 *   - Ensures all required columns exist on the target table (POST
 *     /columns/, idempotent). SeaTable's API Gateway v2 doesn't expose
 *     a working DELETE /columns/ endpoint, so columns added by the
 *     harness persist on your base after the run — that's intentional.
 *   - Inserts 3 test rows via POST /rows/, exercises pull / push /
 *     bidirectional / Bases-file / read-only protection flows across
 *     every supported writable column type, then cleans up rows.
 *
 * Usage:
 *   node tests/e2e/run-seatable-e2e.mjs              # leaves rows in place
 *   node tests/e2e/run-seatable-e2e.mjs --cleanup    # also deletes rows
 */

import { findPageTarget } from './cdp-helpers.mjs';
import { loadEnv } from './load-env.mjs';
import { buildSyncHarnessHelpers, buildConfigEntry, createTestHarness } from './obsidian-helpers.mjs';

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

// Schema the harness ensures exists on the target table. Order matters
// only for human readability of the resulting SeaTable view.
const REQUIRED_COLUMNS = [
  { name: 'Count',       type: 'number'        },
  { name: 'Description', type: 'long-text'     },
  { name: 'DueDate',     type: 'date'          },
  { name: 'Done',        type: 'checkbox'      },
  { name: 'Status',      type: 'single-select' },
  // Formula columns reference earlier columns by name, so Count must
  // already be present before this is added.
  { name: 'Cal',         type: 'formula', column_data: { formula: '{Count} * 2', result_type: 'number' } },
];

const TEST_ROWS = [
  { Name: 'E2E-ST-Pull',  Count: 100, Description: 'pull row',  DueDate: '2026-12-01', Done: false, Status: 'Todo'        },
  { Name: 'E2E-ST-Push',  Count: 200, Description: 'push row',  DueDate: '2026-12-02', Done: false, Status: 'In progress' },
  { Name: 'E2E-ST-Bidir', Count: 300, Description: 'bidir row', DueDate: '2026-12-03', Done: true,  Status: 'Done'         },
];

let testRowIds = [];

// ---------------------------------------------------------------------------
// Obsidian-side helpers (injected into eval expressions)
// ---------------------------------------------------------------------------

const HELPERS = buildSyncHarnessHelpers({ pluginId: PLUGIN_ID, e2eCfgId: E2E_CFG_ID }) + `
  // SeaTable Base-Token exchange with cross-eval cache to dodge
  // rate-limit and connection-pool exhaustion. The base-token has
  // a 3-day TTL so the cache stays valid for the entire e2e
  // session. globalThis persists across every run() eval block,
  // unlike module-local consts which the eval wrapper rebuilds.
  async function exchangeBaseToken() {
    if (globalThis.__e2eSeaTableToken__) return globalThis.__e2eSeaTableToken__;
    const cred = getCredential();
    const url = cred.serverUrl.replace(/\\/+$/, '') + '/api/v2.1/dtable/app-access-token/';
    const r = await fetch(url, { headers: { 'Authorization': 'Token ' + cred.apiToken } });
    if (!r.ok) throw new Error('Base-Token exchange failed: HTTP ' + r.status);
    globalThis.__e2eSeaTableToken__ = await r.json();
    return globalThis.__e2eSeaTableToken__;
  }

  function buildBaseUrl(tok, path) {
    const server = (tok.dtable_server || '').replace(/\\/+$/, '');
    return server + '/api/v2/dtables/' + tok.dtable_uuid + '/' + path;
  }

  async function fetchMetadata() {
    const tok = await exchangeBaseToken();
    const r = await fetch(buildBaseUrl(tok, 'metadata/'), {
      headers: { 'Authorization': 'Bearer ' + tok.access_token },
    });
    if (!r.ok) throw new Error('metadata failed: HTTP ' + r.status);
    return await r.json();
  }

  // SeaTable-specific: idempotent column creation. SeaTable's API Gateway
  // doesn't expose a usable DELETE /columns/, so columns added persist on
  // the base after the run — intentional.
  async function ensureColumns(required) {
    const cfg = getConfig();
    const meta = await fetchMetadata();
    const tbl = meta.metadata.tables.find(t => t._id === cfg.tableId);
    if (!tbl) throw new Error('Target table ' + cfg.tableId + ' not found in metadata');
    const existing = new Set(tbl.columns.map(c => c.name));

    const tok = await exchangeBaseToken();
    const headers = { 'Authorization': 'Bearer ' + tok.access_token, 'Content-Type': 'application/json' };
    const url = buildBaseUrl(tok, 'columns/');

    const added = [];
    const skipped = [];
    for (const col of required) {
      if (existing.has(col.name)) { skipped.push(col.name); continue; }
      const body = { table_id: cfg.tableId, column_name: col.name, column_type: col.type };
      if (col.column_data) body.column_data = col.column_data;
      const r = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
      if (!r.ok) {
        const j = await r.json().catch(() => null);
        throw new Error('Failed to add column ' + col.name + ': HTTP ' + r.status + ' ' + (j?.error_msg || j?.error_message || ''));
      }
      added.push(col.name);
    }
    return { added, skipped };
  }

  async function insertRows(rows) {
    const cfg = getConfig();
    const tok = await exchangeBaseToken();
    const r = await fetch(buildBaseUrl(tok, 'rows/'), {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + tok.access_token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ table_id: cfg.tableId, rows }),
    });
    const j = await r.json();
    return (j.row_ids || []).map(x => x._id || x);
  }

  async function fetchRowFromSeaTable(rowId) {
    const cfg = getConfig();
    const tok = await exchangeBaseToken();
    const url = buildBaseUrl(tok, 'rows/' + rowId + '/?table_id=' + encodeURIComponent(cfg.tableId) + '&convert_keys=true');
    const r = await fetch(url, { headers: { 'Authorization': 'Bearer ' + tok.access_token } });
    if (r.status === 404) return null;
    if (!r.ok) throw new Error('fetchRow failed: HTTP ' + r.status);
    return await r.json();
  }

  async function deleteRows(rowIds) {
    if (!rowIds || rowIds.length === 0) return;
    const cfg = getConfig();
    const tok = await exchangeBaseToken();
    await fetch(buildBaseUrl(tok, 'rows/'), {
      method: 'DELETE',
      headers: { 'Authorization': 'Bearer ' + tok.access_token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ table_id: cfg.tableId, row_ids: rowIds }),
    });
  }

  async function resetRowsToInitial(rowIds, initial) {
    const cfg = getConfig();
    const tok = await exchangeBaseToken();
    await fetch(buildBaseUrl(tok, 'rows/'), {
      method: 'PUT',
      headers: { 'Authorization': 'Bearer ' + tok.access_token, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        table_id: cfg.tableId,
        updates: rowIds.map((rid, i) => ({ row_id: rid, row: initial[i] })),
      }),
    });
  }
`;

// ---------------------------------------------------------------------------
// Test runner
// ---------------------------------------------------------------------------

let targetId;
const { results, log, run, test } = createTestHarness({ getTargetId: () => targetId });

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

    p.settings.configs.push(${JSON.stringify(buildConfigEntry({
      id: E2E_CFG_ID,
      name: 'E2E SeaTable Cfg',
      credentialId: E2E_CRED_ID,
      tableId: ENV.tableId,
      viewId: ENV.viewId,
      folderPath: ENV.folderPath,
      bidirectionalSync: true,
    }))});

    await p.saveSettings();
    return JSON.stringify({ ok: true });
  })()`, 15000);

  log('=== Setup: Reload plugin ===');
  await run(`(async () => {
    await app.plugins.disablePlugin('${PLUGIN_ID}');
    await app.plugins.enablePlugin('${PLUGIN_ID}');
    return JSON.stringify({ ok: true });
  })()`, 15000);

  log('=== Setup: Ensure required columns ===');
  const ensured = await run(`(async () => {
    ${HELPERS}
    const r = await ensureColumns(${JSON.stringify(REQUIRED_COLUMNS)});
    return JSON.stringify(r);
  })()`, 30000);
  log(`Columns added: [${ensured.added.join(', ') || 'none'}]; reused: [${ensured.skipped.join(', ')}]`);

  log('=== Setup: Insert test rows via POST /rows/ ===');
  const ids = await run(`(async () => {
    ${HELPERS}
    const ids = await insertRows(${JSON.stringify(TEST_ROWS)});
    return JSON.stringify(ids);
  })()`, 20000);

  if (!Array.isArray(ids) || ids.length !== TEST_ROWS.length) {
    throw new Error(`Failed to insert test rows; got ${JSON.stringify(ids)}`);
  }
  testRowIds = ids;
  log(`Created ${ids.length} test rows: ${ids.join(', ')}`);
}

function resetExpr() {
  return `(async () => {
    ${HELPERS}
    await resetRowsToInitial(${JSON.stringify(testRowIds)}, ${JSON.stringify(TEST_ROWS)});
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
    const cfg = getConfig();

    await deleteRows(${JSON.stringify(testRowIds)});

    if (cfg) {
      const folder = cfg.folderPath;
      const files = app.vault.getFiles().filter(f => f.path.startsWith(folder + '/'));
      for (const f of files) await app.vault.delete(f);
      const folderEntry = app.vault.getAbstractFileByPath(folder);
      if (folderEntry) {
        try { await app.vault.delete(folderEntry, true); } catch {}
      }
      const basesFiles = app.vault.getFiles().filter(f => f.extension === 'base' && f.basename.toLowerCase().includes('e2e'));
      for (const f of basesFiles) await app.vault.delete(f);
    }

    const cfgIdx = p.settings.configs.findIndex(c => c.id === '${E2E_CFG_ID}');
    if (cfgIdx !== -1) {
      p.configManager.removeConfig('${E2E_CFG_ID}');
      p.settings.configs.splice(cfgIdx, 1);
    }
    p.settings.credentials = p.settings.credentials.filter(c => c.id !== '${E2E_CRED_ID}');
    await p.saveSettings();
    return JSON.stringify({ ok: true });
  })()`, 20000);
  log('Cleaned up SeaTable test data + local files + e2e config (columns kept on base).');
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

    // ── Pull tests ──────────────────────────────────────────────────

    await test('pull / all creates one .md per row', async () => {
      const r = await run(`(async () => {
        ${HELPERS}
        await enqueueSync('pull', 'all');
        await new Promise(r => setTimeout(r, 6000));
        const cfg = getConfig();
        const files = app.vault.getFiles().filter(f =>
          f.path.startsWith(cfg.folderPath + '/') && f.extension === 'md'
        );
        return JSON.stringify({ count: files.length, names: files.map(f => f.basename) });
      })()`, 20000);
      const expectedNames = TEST_ROWS.map(r => r.Name);
      const pass = r.count >= expectedNames.length && expectedNames.every(n => r.names.includes(n));
      return { pass, detail: `count=${r.count} names=[${r.names.join(',')}]` };
    });

    await test('pull / current refetches single note', async () => {
      const r = await run(`(async () => {
        ${HELPERS}
        const cfg = getConfig();
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
      return { pass, detail: `name="${r.name}" primaryField="${r.primaryField}"` };
    });

    await test('pull / writes all column types into frontmatter', async () => {
      // Verifies fetchNotes correctly normalizes every supported type
      // (text / number / long-text / date / boolean / single-select /
      // formula). System fields (_locked, _ctime, …) must be stripped.
      const r = await run(`(async () => {
        ${HELPERS}
        const cfg = getConfig();
        const file = app.vault.getAbstractFileByPath(cfg.folderPath + '/E2E-ST-Pull.md');
        const fm = app.metadataCache.getFileCache(file)?.frontmatter || {};
        const leakedSystemKey = Object.keys(fm).some(k => k.startsWith('_'));
        return JSON.stringify({
          Name: fm.Name,
          Count: fm.Count,
          Description: fm.Description,
          DueDate: typeof fm.DueDate === 'string' ? fm.DueDate.slice(0, 10) : null,
          Done: fm.Done,
          Status: fm.Status,
          Cal: fm.Cal,
          leakedSystemKey,
        });
      })()`, 10000);
      const pass = r.Name === 'E2E-ST-Pull'
        && r.Count === 100
        && r.Description === 'pull row'
        && r.DueDate === '2026-12-01'
        && r.Done === false
        && r.Status === 'Todo'
        && r.Cal === 200
        && !r.leakedSystemKey;
      return { pass, detail: `name=${r.Name} count=${r.Count} desc=${r.Description} date=${r.DueDate} done=${r.Done} status=${r.Status} cal=${r.Cal} leak=${r.leakedSystemKey}` };
    });

    // ── Push: per-column type ───────────────────────────────────────

    await test('push / number column (Count)', async () => {
      await doReset();
      const r = await run(`(async () => {
        ${HELPERS}
        setMode('obsidian-wins');
        const cfg = getConfig();
        const file = app.vault.getAbstractFileByPath(cfg.folderPath + '/E2E-ST-Push.md');
        await modifyField(file, 'Count', 555);
        await enqueueSync('push', 'all');
        await new Promise(r => setTimeout(r, 6000));
        const row = await fetchRowFromSeaTable(${JSON.stringify(testRowIds[1])});
        setMode('manual');
        return JSON.stringify({ remoteCount: row?.Count });
      })()`, 25000);
      return { pass: r.remoteCount === 555, detail: `Count=${r.remoteCount}` };
    });

    await test('push / long-text column (Description)', async () => {
      await doReset();
      const r = await run(`(async () => {
        ${HELPERS}
        setMode('obsidian-wins');
        const cfg = getConfig();
        const file = app.vault.getAbstractFileByPath(cfg.folderPath + '/E2E-ST-Push.md');
        await modifyField(file, 'Description', 'updated long-text');
        await enqueueSync('push', 'all');
        await new Promise(r => setTimeout(r, 6000));
        const row = await fetchRowFromSeaTable(${JSON.stringify(testRowIds[1])});
        setMode('manual');
        return JSON.stringify({ remoteDesc: row?.Description });
      })()`, 25000);
      return { pass: r.remoteDesc === 'updated long-text', detail: `Description="${r.remoteDesc}"` };
    });

    await test('push / date column (DueDate)', async () => {
      await doReset();
      const r = await run(`(async () => {
        ${HELPERS}
        setMode('obsidian-wins');
        const cfg = getConfig();
        const file = app.vault.getAbstractFileByPath(cfg.folderPath + '/E2E-ST-Push.md');
        await modifyField(file, 'DueDate', '2027-01-15');
        await enqueueSync('push', 'all');
        await new Promise(r => setTimeout(r, 6000));
        const row = await fetchRowFromSeaTable(${JSON.stringify(testRowIds[1])});
        setMode('manual');
        return JSON.stringify({ remoteDate: row?.DueDate });
      })()`, 25000);
      const pass = typeof r.remoteDate === 'string' && r.remoteDate.startsWith('2027-01-15');
      return { pass, detail: `DueDate="${r.remoteDate}"` };
    });

    await test('push / checkbox column (Done)', async () => {
      await doReset();
      const r = await run(`(async () => {
        ${HELPERS}
        setMode('obsidian-wins');
        const cfg = getConfig();
        const file = app.vault.getAbstractFileByPath(cfg.folderPath + '/E2E-ST-Push.md');
        await modifyField(file, 'Done', true);
        await enqueueSync('push', 'all');
        await new Promise(r => setTimeout(r, 6000));
        const row = await fetchRowFromSeaTable(${JSON.stringify(testRowIds[1])});
        setMode('manual');
        return JSON.stringify({ remoteDone: row?.Done });
      })()`, 25000);
      return { pass: r.remoteDone === true, detail: `Done=${r.remoteDone}` };
    });

    await test('push / single-select column (Status)', async () => {
      await doReset();
      const r = await run(`(async () => {
        ${HELPERS}
        setMode('obsidian-wins');
        const cfg = getConfig();
        const file = app.vault.getAbstractFileByPath(cfg.folderPath + '/E2E-ST-Push.md');
        await modifyField(file, 'Status', 'Done');
        await enqueueSync('push', 'all');
        await new Promise(r => setTimeout(r, 6000));
        const row = await fetchRowFromSeaTable(${JSON.stringify(testRowIds[1])});
        setMode('manual');
        return JSON.stringify({ remoteStatus: row?.Status });
      })()`, 25000);
      return { pass: r.remoteStatus === 'Done', detail: `Status="${r.remoteStatus}"` };
    });

    // ── Push: conflict-resolution modes (using number column) ──────

    await test('push / all / remote-wins keeps remote value', async () => {
      await doReset();
      const r = await run(`(async () => {
        ${HELPERS}
        setMode('remote-wins');
        const cfg = getConfig();
        const file = app.vault.getAbstractFileByPath(cfg.folderPath + '/E2E-ST-Pull.md');
        await modifyField(file, 'Count', 9999);
        await enqueueSync('push', 'all');
        await new Promise(r => setTimeout(r, 6000));
        const row = await fetchRowFromSeaTable(${JSON.stringify(testRowIds[0])});
        setMode('manual');
        return JSON.stringify({ remoteCount: row?.Count });
      })()`, 25000);
      return { pass: r.remoteCount === 100, detail: `Count=${r.remoteCount} (expected 100)` };
    });

    await test('push / all / manual blocks conflicting field', async () => {
      await doReset();
      const r = await run(`(async () => {
        ${HELPERS}
        setMode('manual');
        const cfg = getConfig();
        const file = app.vault.getAbstractFileByPath(cfg.folderPath + '/E2E-ST-Push.md');
        await modifyField(file, 'Count', 7777);
        await enqueueSync('push', 'all');
        await new Promise(r => setTimeout(r, 6000));
        const row = await fetchRowFromSeaTable(${JSON.stringify(testRowIds[1])});
        return JSON.stringify({ remoteCount: row?.Count });
      })()`, 25000);
      return { pass: r.remoteCount === 200, detail: `Count=${r.remoteCount} (expected 200)` };
    });

    // ── Bidirectional with formula ──────────────────────────────────

    await test('bidirectional / autoSyncComputedFields=true refreshes Cal', async () => {
      await doReset();
      const r = await run(`(async () => {
        ${HELPERS}
        setMode('obsidian-wins', true);
        const cfg = getConfig();
        const file = await openAndActivate(cfg.folderPath + '/E2E-ST-Bidir.md');
        await modifyField(file, 'Count', 450);
        await enqueueSync('bidirectional', 'all');
        await new Promise(r => setTimeout(r, 10000));
        const fm = app.metadataCache.getFileCache(file)?.frontmatter || {};
        const row = await fetchRowFromSeaTable(${JSON.stringify(testRowIds[2])});
        setMode('manual', false);
        return JSON.stringify({
          localCount: fm.Count,
          localCal: fm.Cal,
          remoteCount: row?.Count,
          remoteCal: row?.Cal,
        });
      })()`, 35000);
      const pass = r.localCount === 450 && r.localCal === 900 && r.remoteCount === 450 && r.remoteCal === 900;
      return { pass, detail: `localCount=${r.localCount} localCal=${r.localCal} remoteCount=${r.remoteCount} remoteCal=${r.remoteCal}` };
    });

    await test('bidirectional / autoSyncComputedFields=false leaves stale Cal', async () => {
      await doReset();
      const r = await run(`(async () => {
        ${HELPERS}
        setMode('obsidian-wins', false);
        const cfg = getConfig();
        const file = app.vault.getAbstractFileByPath(cfg.folderPath + '/E2E-ST-Bidir.md');
        const beforeFm = app.metadataCache.getFileCache(file)?.frontmatter || {};
        const oldCal = beforeFm.Cal;
        await modifyField(file, 'Count', 333);
        await enqueueSync('bidirectional', 'all');
        await new Promise(r => setTimeout(r, 6000));
        const afterFm = app.metadataCache.getFileCache(file)?.frontmatter || {};
        const row = await fetchRowFromSeaTable(${JSON.stringify(testRowIds[2])});
        setMode('manual', false);
        return JSON.stringify({
          localCount: afterFm.Count,
          localCalUnchanged: afterFm.Cal === oldCal,
          remoteCount: row?.Count,
        });
      })()`, 25000);
      const pass = r.localCount === 333 && r.localCalUnchanged && r.remoteCount === 333;
      return { pass, detail: `localCount=${r.localCount} calUnchanged=${r.localCalUnchanged} remoteCount=${r.remoteCount}` };
    });

    // ── Read-only field protection ──────────────────────────────────

    await test('push / formula column edits are silently dropped (read-only)', async () => {
      await doReset();
      const r = await run(`(async () => {
        ${HELPERS}
        setMode('obsidian-wins');
        const cfg = getConfig();
        const file = app.vault.getAbstractFileByPath(cfg.folderPath + '/E2E-ST-Pull.md');
        // Local Cal value is a formula; the user might "edit" it manually.
        await modifyField(file, 'Cal', 1);
        await enqueueSync('push', 'all');
        await new Promise(r => setTimeout(r, 6000));
        const row = await fetchRowFromSeaTable(${JSON.stringify(testRowIds[0])});
        setMode('manual');
        // Cal is server-computed: Count(100) * 2 = 200, regardless of local.
        return JSON.stringify({ remoteCal: row?.Cal, remoteCount: row?.Count });
      })()`, 25000);
      return { pass: r.remoteCal === 200, detail: `Cal=${r.remoteCal} Count=${r.remoteCount}` };
    });

    // ── Bases file generation ───────────────────────────────────────

    await test('bases file generation', async () => {
      const r = await run(`(async () => {
        ${HELPERS}
        const p = getPlugin();
        const cfg = getConfig();
        const cred = getCredential();

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

        for (const f of basesFiles) await app.vault.delete(f);
        cfg.generateBasesFile = false;
        getInstance().updateSettings(cfg, cred);

        return JSON.stringify({ found, inFolderOk, tableViewOk });
      })()`, 20000);
      return { pass: r.found && r.inFolderOk && r.tableViewOk, detail: `found=${r.found} folder=${r.inFolderOk} view=${r.tableViewOk}` };
    });

    // ── Summary ─────────────────────────────────────────────────────

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
