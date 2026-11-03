/**
 * Issue reproduction harness — checks, against a live Obsidian + SeaTable,
 * whether the behaviour each open issue describes still holds.
 *
 * Unlike the regular e2e suites (which assert the plugin works), every check
 * here asserts the *current gap*: a check reports REPRODUCED while the issue
 * is still valid, and NOT REPRODUCED once the work lands — at which point the
 * check should move into the provider's real e2e suite and leave this file.
 *
 * Checks:
 *   #82  manual mode refuses the push with a Notice and opens no resolution UI
 *        (also: a local-only edit counts as a "conflict" — no base snapshot)
 *   #26  conflict detection issues one fetchRecord() per pushed file
 *   #89  every pull re-fetches the full table (no lastSyncedAt / delta)
 *   #83  fetchNotes() ignores any filter option; config has no filter field
 *   #123 object-shaped (file) column survives a push — guard works, the gap is
 *        only that no e2e suite asserts it
 *   #32  a self-link column pulls as raw values, not [[wikilinks]]
 *        (today the value is the literal "[Object]" — tracked as #133)
 *
 * Provider: SeaTable (reuses SEATABLE_* from the repo-root .env). Uses its own
 * credential/config ids, so it never touches your configs or the SeaTable
 * suite's. Rows and local files are removed at the end unless --keep is
 * passed; columns added to the base persist (SeaTable has no DELETE /columns/).
 *
 * Usage:
 *   node tests/e2e/run-issue-repro.mjs            # Obsidian already on :9222
 *   npm run test:e2e:repro:full                   # build + deploy + run
 *   node tests/e2e/run-issue-repro.mjs --keep     # leave rows/files for manual poking
 */

import { findPageTarget } from './cdp-helpers.mjs';
import { loadEnv } from './load-env.mjs';
import { buildSyncHarnessHelpers, buildConfigEntry, createTestHarness } from './obsidian-helpers.mjs';

loadEnv();

const PLUGIN_ID = 'auto-note-importer';
const CRED_ID = 'e2e-repro-cred';
const CFG_ID = 'e2e-repro-cfg';
const FOLDER = 'ANI-Issue-Repro';

const ENV = {
  apiToken: process.env.SEATABLE_API_TOKEN || '',
  serverUrl: (process.env.SEATABLE_SERVER_URL || 'https://cloud.seatable.io').replace(/\/+$/, ''),
  tableId: process.env.SEATABLE_TABLE_ID || '0000',
};

if (!ENV.apiToken) {
  console.error('SEATABLE_API_TOKEN missing — populate .env (see tests/e2e/.env.example).');
  process.exit(2);
}

const COLUMNS = [
  { name: 'Count',  type: 'number' },
  { name: 'Status', type: 'single-select' },
  { name: 'Files',  type: 'file' },
];
const LINK_COLUMN = 'Related';

const FILE_VALUE = [{ name: 'repro.txt', url: 'https://example.com/repro.txt', type: 'file', size: 1 }];

const ROWS = [
  { Name: 'Repro-A', Count: 10, Status: 'Todo', Files: FILE_VALUE },
  { Name: 'Repro-B', Count: 20, Status: 'Done' },
  { Name: 'Repro-C', Count: 30, Status: 'Done' },
];

// ---------------------------------------------------------------------------
// Obsidian-side helpers
// ---------------------------------------------------------------------------

const HELPERS = buildSyncHarnessHelpers({ pluginId: PLUGIN_ID, e2eCfgId: CFG_ID }) + `
  async function baseToken() {
    if (globalThis.__reproSeaTableToken__) return globalThis.__reproSeaTableToken__;
    const cred = getCredential();
    const r = await fetch(cred.serverUrl.replace(/\\/+$/, '') + '/api/v2.1/dtable/app-access-token/', {
      headers: { 'Authorization': 'Token ' + cred.apiToken },
    });
    if (!r.ok) throw new Error('Base-Token exchange failed: HTTP ' + r.status);
    globalThis.__reproSeaTableToken__ = await r.json();
    return globalThis.__reproSeaTableToken__;
  }

  async function st(path, method, body) {
    const tok = await baseToken();
    const url = tok.dtable_server.replace(/\\/+$/, '') + '/api/v2/dtables/' + tok.dtable_uuid + '/' + path;
    const r = await fetch(url, {
      method: method || 'GET',
      headers: { 'Authorization': 'Bearer ' + tok.access_token, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    const j = await r.json().catch(() => null);
    if (!r.ok) throw new Error(path + ' ' + (method || 'GET') + ' HTTP ' + r.status + ' ' + JSON.stringify(j));
    return j;
  }

  async function targetTable() {
    const meta = await st('metadata/');
    const tbl = meta.metadata.tables.find(t => t._id === getConfig().tableId);
    if (!tbl) throw new Error('table ' + getConfig().tableId + ' not found');
    return tbl;
  }

  async function getRow(rowId) {
    return st('rows/' + rowId + '/?table_id=' + encodeURIComponent(getConfig().tableId) + '&convert_keys=true');
  }

  function provider() { return getInstance().databaseProvider; }

  // Wrap provider methods with call counters. Returns a restore() fn.
  function instrument(names) {
    const prov = provider();
    const counts = Object.fromEntries(names.map(n => [n, 0]));
    const originals = {};
    for (const n of names) {
      originals[n] = prov[n];
      prov[n] = function (...args) { counts[n]++; return originals[n].apply(prov, args); };
    }
    return { counts, restore() { for (const n of names) prov[n] = originals[n]; } };
  }

  function folderFiles() {
    return app.vault.getMarkdownFiles().filter(f => f.path.startsWith('${FOLDER}/'));
  }

  function fileForRow(rowId) {
    return folderFiles().find(f => String(app.metadataCache.getFileCache(f)?.frontmatter?.primaryField) === rowId);
  }

  function visibleNotices() {
    return Array.from(document.querySelectorAll('.notice')).map(n => n.textContent || '');
  }

  function clearNotices() {
    document.querySelectorAll('.notice').forEach(n => n.remove());
  }

  // enqueueSyncRequest() resolves once the queue has processed the request,
  // so no settle delay is needed — Notices are appended synchronously too.
  async function sync(mode, scope) {
    await enqueueSync(mode, scope);
  }
`;

let targetId;
const { results, log, run, test } = createTestHarness({ getTargetId: () => targetId, skipSupported: true });
let rowIds = [];

// ---------------------------------------------------------------------------
// Setup / cleanup
// ---------------------------------------------------------------------------

async function setup() {
  log('=== Setup: credential + config ===');
  await run(`(async () => {
    ${HELPERS}
    const p = getPlugin();
    p.settings.credentials = p.settings.credentials.filter(c => c.id !== '${CRED_ID}');
    const idx = p.settings.configs.findIndex(c => c.id === '${CFG_ID}');
    if (idx !== -1) { p.configManager.removeConfig('${CFG_ID}'); p.settings.configs.splice(idx, 1); }
    p.settings.credentials.push({
      id: '${CRED_ID}', name: 'E2E Repro SeaTable', type: 'seatable',
      apiToken: ${JSON.stringify(ENV.apiToken)}, serverUrl: ${JSON.stringify(ENV.serverUrl)},
    });
    p.settings.configs.push(${JSON.stringify(buildConfigEntry({
      id: CFG_ID,
      name: 'E2E Issue Repro',
      credentialId: CRED_ID,
      tableId: ENV.tableId,
      folderPath: FOLDER,
      bidirectionalSync: true,
    }))});
    await p.saveSettings();
    return JSON.stringify({ ok: true });
  })()`, 15000);

  await run(`(async () => {
    await app.plugins.disablePlugin('${PLUGIN_ID}');
    await app.plugins.enablePlugin('${PLUGIN_ID}');
    return JSON.stringify({ ok: true });
  })()`, 15000);

  log('=== Setup: columns + rows ===');
  const r = await run(`(async () => {
    ${HELPERS}
    const tbl = await targetTable();
    const existing = new Set(tbl.columns.map(c => c.name));
    const added = [];
    for (const col of ${JSON.stringify(COLUMNS)}) {
      if (existing.has(col.name)) continue;
      await st('columns/', 'POST', { table_id: tbl._id, column_name: col.name, column_type: col.type });
      added.push(col.name);
    }
    // Self-link column for #32. Best effort — reported as SKIP if unsupported.
    let linkError = null;
    if (!existing.has('${LINK_COLUMN}')) {
      try {
        await st('columns/', 'POST', {
          table_id: tbl._id, column_name: '${LINK_COLUMN}', column_type: 'link',
          column_data: { table: tbl.name, other_table: tbl.name },
        });
        added.push('${LINK_COLUMN}');
      } catch (e) { linkError = e.message; }
    }
    const ins = await st('rows/', 'POST', { table_id: tbl._id, rows: ${JSON.stringify(ROWS)} });
    const ids = (ins.row_ids || []).map(x => x._id || x);
    return JSON.stringify({ added, linkError, ids });
  })()`, 40000);
  if (!Array.isArray(r.ids) || r.ids.length !== ROWS.length) throw new Error('row insert failed: ' + JSON.stringify(r));
  rowIds = r.ids;
  log(`Columns added: [${r.added.join(', ') || 'none'}]${r.linkError ? ` — link column failed: ${r.linkError}` : ''}`);
  log(`Rows: ${rowIds.join(', ')}`);

  await run(`(async () => {
    ${HELPERS}
    setMode('manual', false);
    await sync('pull', 'all');
    return JSON.stringify({ files: folderFiles().length });
  })()`, 60000);
}

async function cleanup() {
  log('\n=== Cleanup ===');
  const r = await run(`(async () => {
    ${HELPERS}
    const p = getPlugin();
    // Collect failures instead of swallowing them, so the Node side can say
    // what was left behind rather than claiming a clean teardown.
    const failures = [];
    try { await st('rows/', 'DELETE', { table_id: getConfig().tableId, row_ids: ${JSON.stringify(rowIds)} }); }
    catch (e) { failures.push('rows: ' + e.message); }
    for (const f of folderFiles()) await app.vault.delete(f);
    const folder = app.vault.getAbstractFileByPath('${FOLDER}');
    if (folder) {
      try { await app.vault.delete(folder, true); }
      catch (e) { failures.push('folder: ' + e.message); }
    }
    const idx = p.settings.configs.findIndex(c => c.id === '${CFG_ID}');
    if (idx !== -1) { p.configManager.removeConfig('${CFG_ID}'); p.settings.configs.splice(idx, 1); }
    p.settings.credentials = p.settings.credentials.filter(c => c.id !== '${CRED_ID}');
    await p.saveSettings();
    delete globalThis.__reproSeaTableToken__;
    return JSON.stringify({ failures });
  })()`, 30000);
  if (r.failures.length) {
    log(`Cleanup incomplete — clean up manually: ${r.failures.join('; ')} (row ids: ${rowIds.join(', ')})`);
  } else {
    log('Removed repro rows, local files, credential and config (columns kept on base).');
  }
}

// ---------------------------------------------------------------------------
// Checks — pass === "issue reproduced" (still valid)
// ---------------------------------------------------------------------------

async function checks() {
  const [rowA] = rowIds;

  await test('#82 manual mode: local-only edit is rejected, Notice only, no modal', async () => {
    const r = await run(`(async () => {
      ${HELPERS}
      setMode('manual', false);
      clearNotices();
      const file = fileForRow('${rowA}');
      if (!file) throw new Error('no local file for row A');
      await modifyField(file, 'Count', 11);          // remote stays 10 — no remote-side edit
      const spy = instrument(['batchUpdate', 'updateRecord']);
      try { await sync('push', 'all'); } finally { spy.restore(); }
      const remote = await getRow('${rowA}');
      const notices = visibleNotices();
      return JSON.stringify({
        remoteCount: remote.Count,
        writes: spy.counts.batchUpdate + spy.counts.updateRecord,
        conflictNotice: notices.some(t => t.includes('Conflicts detected')),
        modalOpen: document.querySelectorAll('.modal-container').length > 0,
      });
    })()`, 60000);
    const reproduced = r.remoteCount === 10 && r.conflictNotice && !r.modalOpen;
    return { pass: reproduced, detail: JSON.stringify(r) };
  });

  await test('#26 conflict detection: one fetchRecord() per pushed file', async () => {
    const r = await run(`(async () => {
      ${HELPERS}
      setMode('remote-wins', false);
      await sync('pull', 'all');                       // re-align local with remote
      const files = folderFiles().length;
      const spy = instrument(['fetchRecord', 'fetchNotes']);
      try { await sync('push', 'all'); } finally { spy.restore(); }
      return JSON.stringify({ files, ...spy.counts });
    })()`, 90000);
    const reproduced = r.fetchRecord === r.files && r.files > 1;
    return { pass: reproduced, detail: JSON.stringify(r) };
  });

  await test('#89 every pull re-fetches the whole table (no delta)', async () => {
    const r = await run(`(async () => {
      ${HELPERS}
      const prov = provider();
      const sizes = [];
      const orig = prov.fetchNotes;
      prov.fetchNotes = async function (...a) { const n = await orig.apply(prov, a); sizes.push(n.length); return n; };
      try { await sync('pull', 'all'); await sync('pull', 'all'); } finally { prov.fetchNotes = orig; }
      const cfg = getConfig();
      const stateKeys = Object.keys(cfg).filter(k => /sync(ed)?at|since|lastmod/i.test(k));
      return JSON.stringify({ sizes, stateKeys });
    })()`, 90000);
    // Judge by behaviour, not by key names: with no remote change in between,
    // a delta-capable pull would return fewer records the second time.
    // stateKeys stays in the detail as supporting evidence only.
    const reproduced = r.sizes.length === 2 && r.sizes[1] === r.sizes[0] && r.sizes[1] >= 3;
    return { pass: reproduced, detail: JSON.stringify(r) };
  });

  await test('#83 fetchNotes() ignores a filter; config has no filter field', async () => {
    const r = await run(`(async () => {
      ${HELPERS}
      const prov = provider();
      const all = await prov.fetchNotes();
      const filtered = await prov.fetchNotes({ filter: "Status = 'Todo'" });
      return JSON.stringify({ all: all.length, filtered: filtered.length, hasFilterKey: 'filter' in getConfig() });
    })()`, 60000);
    const reproduced = r.all === r.filtered && !r.hasFilterKey;
    return { pass: reproduced, detail: JSON.stringify(r) };
  });

  await test('#123 file column survives push (guard OK — gap is e2e coverage only)', async () => {
    const r = await run(`(async () => {
      ${HELPERS}
      setMode('obsidian-wins', false);                 // skip conflict detection, force a push
      const file = fileForRow('${rowA}');
      await modifyField(file, 'Count', 12);
      const before = (await getRow('${rowA}')).Files;
      await sync('push', 'all');
      const after = await getRow('${rowA}');
      const fm = app.metadataCache.getFileCache(file)?.frontmatter || {};
      return JSON.stringify({
        pushed: after.Count === 12,
        localHasFiles: 'Files' in fm,
        preserved: JSON.stringify(before) === JSON.stringify(after.Files),
        before, after: after.Files,
      });
    })()`, 60000);
    // "Reproduced" here means: behaviour is correct but unasserted by any suite.
    return { pass: r.pushed && r.preserved, detail: JSON.stringify(r) };
  });

  await test('#32 link column pulls as raw values, not [[wikilinks]]', async () => {
    const r = await run(`(async () => {
      ${HELPERS}
      const tbl = await targetTable();
      const col = tbl.columns.find(c => c.name === '${LINK_COLUMN}' && c.type === 'link');
      if (!col || !col.data?.link_id) return JSON.stringify({ skip: true });
      await st('links/', 'POST', {
        table_id: tbl._id, other_table_id: tbl._id, link_id: col.data.link_id,
        other_rows_ids_map: { [${JSON.stringify(rowA)}]: ${JSON.stringify([rowIds[1]])} },
      });
      setMode('remote-wins', false);
      await sync('pull', 'all');
      const file = fileForRow('${rowA}');
      const content = await app.vault.read(file);
      const line = (content.match(/^${LINK_COLUMN}:.*(\\n\\s+-.*)*/m) || [''])[0];
      return JSON.stringify({ line, wikilink: /\\[\\[/.test(line) });
    })()`, 60000);
    if (r.skip) return { skip: true, detail: 'link column unavailable on this base' };
    return { pass: r.line !== '' && !r.wikilink, detail: JSON.stringify(r) };
  });
}

// ---------------------------------------------------------------------------

(async () => {
  try {
    targetId = await findPageTarget();
    log(`Connected to Obsidian target ${targetId}`);
    await setup();
    await checks();

    log('\n========================================');
    log('     ISSUE REPRO SUMMARY');
    log('  (REPRODUCED = issue still valid)');
    log('========================================');
    for (const r of results) {
      const tag = r.skip ? 'SKIP        ' : r.pass ? 'REPRODUCED  ' : 'NOT REPRO.  ';
      log(`${tag}| ${r.test}`);
      // Always print the evidence — the observed values are the point here.
      log(`             ${r.detail}`);
    }

    if (process.argv.includes('--keep')) {
      log('\nRows, files and config left in place (--keep).');
    } else {
      await cleanup();
    }
    process.exit(0);
  } catch (e) {
    console.error('FATAL:', e.message);
    if (rowIds.length && !process.argv.includes('--keep')) {
      try { await cleanup(); }
      catch (ce) { console.error(`Cleanup after FATAL also failed: ${ce.message} (row ids: ${rowIds.join(', ')})`); }
    }
    process.exit(1);
  }
})();
