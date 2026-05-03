/**
 * E2E Test Suite for Auto Note Importer
 *
 * Runs against a live Obsidian instance via Chrome DevTools Protocol (CDP).
 *
 * @covers src/core/sync-orchestrator.ts
 * @covers src/core/config-manager.ts
 * @covers src/core/config-instance.ts
 * @covers src/core/conflict-resolver.ts
 * @covers src/services/airtable-client.ts
 * @covers src/builders/bases-file-generator.ts
 * @covers src/main.ts
 *
 * Prerequisites:
 *   1. Obsidian running with --remote-debugging-port=9222
 *      /Applications/Obsidian.app/Contents/MacOS/Obsidian --remote-debugging-port=9222
 *   2. A vault with the plugin installed and configured (Airtable PAT, base, table)
 *   3. The Airtable table must have at minimum: Name (text), E2ECount (number),
 *      Status (singleSelect with Todo/In progress/Done), Cal (formula:
 *      `{E2ECount}*2`). Description (multilineText), DueDate (date, ISO),
 *      Done (checkbox) are added automatically by ensureFields if the PAT
 *      has the schema.bases:write scope. Without that scope the harness
 *      surfaces a clear error so you can either grant the scope or pre-add
 *      the fields manually.
 *   4. For multi-config tests: a second table 'E2E-MultiConfig' (tblZO35AeSdSmI3rr)
 *      with fields: Name (text), Value (number), Tag (singleSelect)
 *
 * Usage:
 *   node tests/e2e/run-e2e.mjs                          # auto-detect CDP target
 *   node tests/e2e/run-e2e.mjs --cleanup                # run tests then delete test records
 *   CDP_TARGET_ID=<id> node tests/e2e/run-e2e.mjs       # specify CDP page target
 */

import { findPageTarget, evalInObsidian } from './cdp-helpers.mjs';
import { loadEnv } from './load-env.mjs';

loadEnv();

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const PLUGIN_ID = 'auto-note-importer';
const MULTI_CONFIG_TABLE_ID = 'tblZO35AeSdSmI3rr';
const MULTI_CONFIG_FOLDER = 'E2E-Multi';
const MULTI_CONFIG_ID = 'e2e-cfg-2';

// Dedicated e2e credential + config so the harness never touches the
// user's active production config. The credentialId reuses whatever PAT
// the user already has registered in plugin settings (it must have
// schema.bases:write to allow ensureFields).
const E2E_AT_CRED_ID = 'e2e-airtable-cred';
const E2E_AT_CFG_ID = 'e2e-airtable-cfg';

const ENV = {
  baseId: process.env.AIRTABLE_E2E_BASE_ID || '',
  tableId: process.env.AIRTABLE_E2E_TABLE_ID || '',
  folderPath: process.env.AIRTABLE_E2E_FOLDER_PATH || 'Airtable-E2E',
};

if (!ENV.baseId || !ENV.tableId) {
  console.error('AIRTABLE_E2E_BASE_ID and AIRTABLE_E2E_TABLE_ID must be set in .env (see tests/e2e/.env.example).');
  process.exit(2);
}

// Fields the harness auto-adds to the target table (idempotent). Six
// writable types — formula is intentionally NOT here because Airtable's
// Meta API rejects formula creation (UNSUPPORTED_FIELD_TYPE_FOR_CREATE).
//
// For the formula path we reuse Demo's stock 'Calculation' column
// (auto-seeded with `IF({Single line text}, {Single line text} & " - added text", "")`).
// The harness pushes 'Single line text' values so 'Calculation' becomes
// deterministic for assertions.
const ENSURED_FIELDS = [
  { name: 'Name',        type: 'singleLineText' },
  { name: 'E2ECount',    type: 'number', options: { precision: 0 } },
  {
    name: 'Status',
    type: 'singleSelect',
    options: { choices: [{ name: 'Todo' }, { name: 'In progress' }, { name: 'Done' }] },
  },
  { name: 'Description', type: 'multilineText' },
  { name: 'DueDate',     type: 'date', options: { dateFormat: { name: 'iso', format: 'YYYY-MM-DD' } } },
  { name: 'Done',        type: 'checkbox', options: { icon: 'check', color: 'greenBright' } },
];

const CALCULATION_FIELD = 'Calculation';
const CALCULATION_SOURCE = 'Single line text';
const CALCULATION_SUFFIX = ' - added text';
const expectedCalc = (src) => src ? src + CALCULATION_SUFFIX : '';

// Test records created during setup — deleted during cleanup
let testRecordIds = [];
let multiConfigRecordIds = [];
// Whether Demo's stock 'Calculation' formula field is detectable on the
// target table — set in setup() so formula-dependent cases skip cleanly
// if the column was renamed/removed.
let hasCalField = false;

// ---------------------------------------------------------------------------
// Obsidian-side helpers (injected into eval expressions)
// ---------------------------------------------------------------------------

const HELPERS = `
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
    const leaf = app.workspace.getLeaf(false);
    await leaf.openFile(file);
    await new Promise(r => setTimeout(r, 800));
    return file;
  }

  async function modifyCount(file, newCount) {
    let content = await app.vault.read(file);
    content = content.replace(/E2ECount: \\d+/, 'E2ECount: ' + newCount);
    await app.vault.modify(file, content);
    await waitForCache(file, 'E2ECount', newCount);
  }

  /**
   * Generic frontmatter field editor. Replaces an existing 'key: value'
   * line in-place, or appends one before the closing --- if absent.
   * Strings containing colon/hash/hyphen are JSON.stringify-quoted to
   * keep YAML happy.
   */
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

  async function ensureFields(required) {
    const cfg = getConfig();
    const cred = getCredential();
    const metaRes = await fetch(
      'https://api.airtable.com/v0/meta/bases/' + cfg.baseId + '/tables',
      { headers: { 'Authorization': 'Bearer ' + cred.apiKey } }
    );
    if (!metaRes.ok) throw new Error('meta/tables failed: HTTP ' + metaRes.status);
    const metaJson = await metaRes.json();
    const table = (metaJson.tables || []).find(t => t.id === cfg.tableId);
    if (!table) throw new Error('Target table ' + cfg.tableId + ' not found in metadata');
    const existing = new Set(table.fields.map(f => f.name));

    const added = [];
    const skipped = [];
    const unsupported = [];
    for (const f of required) {
      if (existing.has(f.name)) { skipped.push(f.name); continue; }
      const body = { name: f.name, type: f.type };
      if (f.options) body.options = f.options;
      const r = await fetch(
        'https://api.airtable.com/v0/meta/bases/' + cfg.baseId + '/tables/' + cfg.tableId + '/fields',
        {
          method: 'POST',
          headers: { 'Authorization': 'Bearer ' + cred.apiKey, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }
      );
      if (!r.ok) {
        const err = await r.json().catch(() => null);
        // /meta/tables sometimes lags behind base edits, so POST against
        // an existing field name returns 422 even when our snapshot didn't
        // list it. Treat as "already present".
        if (r.status === 422 && err?.error?.type === 'DUPLICATE_OR_EMPTY_FIELD_NAME') {
          skipped.push(f.name);
          continue;
        }
        // Airtable's Meta API rejects formula/rollup/lookup creation —
        // those types can only be defined in the web UI. Surface as a
        // skip so dependent tests can downgrade gracefully instead of
        // crashing setup.
        if (r.status === 422 && err?.error?.type === 'UNSUPPORTED_FIELD_TYPE_FOR_CREATE') {
          unsupported.push(f.name);
          continue;
        }
        const msg = err?.error?.message
          || (typeof err?.error === 'string' ? err.error : null)
          || (err ? JSON.stringify(err) : null)
          || 'HTTP ' + r.status;
        throw new Error('Failed to add field ' + f.name + ' (HTTP ' + r.status + '): ' + msg
          + (r.status === 403 ? ' (does the PAT have schema.bases:write?)' : ''));
      }
      added.push(f.name);
    }
    return { added, skipped, unsupported };
  }

  function getPlugin() { return app.plugins.plugins['${PLUGIN_ID}']; }

  // Default getConfig() returns the dedicated e2e config (added during
  // setup). Pass an explicit numeric index only if you really need the
  // user's first non-e2e config — none of our suites do.
  function getConfig(idx) {
    const p = getPlugin();
    if (idx === undefined) {
      return p.settings.configs.find(c => c.id === '${E2E_AT_CFG_ID}') || p.settings.configs[0];
    }
    return p.settings.configs[idx];
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

  async function fetchRecord(recordId, config) {
    const cfg = config || getConfig();
    const cred = getCredential(cfg);
    const resp = await fetch(
      'https://api.airtable.com/v0/' + cfg.baseId + '/' + cfg.tableId + '/' + recordId,
      { headers: { 'Authorization': 'Bearer ' + cred.apiKey } }
    );
    return (await resp.json()).fields;
  }

  async function enqueueSync(mode, scope, config) {
    const cfg = config || getConfig();
    const inst = getInstance(cfg);
    // SyncQueue.enqueue returns immediately when another request is
    // already processing (so it can merge), which means awaiting the
    // returned promise alone is not enough. Poll until the queue drains
    // and isProcessing flips back to false.
    inst.enqueueSyncRequest(mode, scope);
    const sq = inst.syncQueue;
    for (let i = 0; i < 600; i++) {
      if (!sq.isProcessing && sq.queue.length === 0) return;
      await new Promise(r => setTimeout(r, 50));
    }
    throw new Error('SyncQueue did not drain within 30s');
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
  if (r && typeof r === 'object' && r.__error) throw new Error(r.__error);
  return r;
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

async function setup() {
  log('=== Setup: Add Airtable e2e credential + config (idempotent) ===');
  await run(`(async () => {
    const p = app.plugins.plugins['${PLUGIN_ID}'];
    const credId = '${E2E_AT_CRED_ID}';
    const cfgId = '${E2E_AT_CFG_ID}';

    // Reuse the user's first existing Airtable credential's PAT — that
    // way the user doesn't need to copy their token into .env. The
    // selected PAT must have schema.bases:write so ensureFields can
    // auto-add columns.
    const sourceCred = p.settings.credentials.find(c => c.type === 'airtable');
    if (!sourceCred) {
      throw new Error('No Airtable credential found in plugin settings to reuse for e2e.');
    }

    // Reset prior runs so we always start clean.
    p.settings.credentials = p.settings.credentials.filter(c => c.id !== credId);
    const oldCfgIdx = p.settings.configs.findIndex(c => c.id === cfgId);
    if (oldCfgIdx !== -1) {
      p.configManager.removeConfig(cfgId);
      p.settings.configs.splice(oldCfgIdx, 1);
    }

    p.settings.credentials.push({
      id: credId,
      name: 'E2E Airtable',
      type: 'airtable',
      apiKey: sourceCred.apiKey,
    });

    p.settings.configs.push({
      id: cfgId,
      name: 'E2E Airtable Cfg',
      enabled: true,
      credentialId: credId,
      baseId: ${JSON.stringify(ENV.baseId)},
      tableId: ${JSON.stringify(ENV.tableId)},
      viewId: '',
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
    return '"ok"';
  })()`, 10000);

  log('=== Setup: Wipe Airtable records + vault folder (e2e-owned table) ===');
  await run(`(async () => {
    ${HELPERS}
    const p = getPlugin();
    const cfg = getConfig();
    const cred = getCredential();

    // Drain every record from the e2e table. Airtable's PATCH is atomic
    // per batch, so any leftover record with an invalid value (from prior
    // runs or the Demo sample row) would silently reject the whole batch.
    let offset;
    do {
      const listUrl = 'https://api.airtable.com/v0/' + cfg.baseId + '/' + cfg.tableId
        + (offset ? '?offset=' + encodeURIComponent(offset) : '');
      const r = await fetch(listUrl, { headers: { Authorization: 'Bearer ' + cred.apiKey } });
      const j = await r.json();
      const ids = (j.records || []).map(rec => rec.id);
      while (ids.length > 0) {
        const chunk = ids.splice(0, 10);
        const params = chunk.map(id => 'records[]=' + id).join('&');
        await fetch('https://api.airtable.com/v0/' + cfg.baseId + '/' + cfg.tableId + '?' + params, {
          method: 'DELETE',
          headers: { Authorization: 'Bearer ' + cred.apiKey },
        });
      }
      offset = j.offset;
    } while (offset);

    // Wipe local folder so leftover files don't get pushed.
    const folder = app.vault.getAbstractFileByPath(cfg.folderPath);
    if (folder?.children) {
      for (const child of [...folder.children]) {
        try { await app.vault.delete(child); } catch {}
      }
    }
    return JSON.stringify({ ok: true });
  })()`, 30000);

  log('=== Setup: Ensure optional per-column-type fields ===');
  const ensured = await run(`(async () => {
    ${HELPERS}
    const r = await ensureFields(${JSON.stringify(ENSURED_FIELDS)});
    return JSON.stringify(r);
  })()`, 30000);
  log(`Fields added: [${ensured.added.join(', ') || 'none'}]; reused: [${ensured.skipped.join(', ') || 'none'}]; unsupported: [${(ensured.unsupported || []).join(', ') || 'none'}]`);

  // Detect Demo's stock 'Calculation' formula field. Airtable's Meta
  // API can't create formula fields, so we rely on the seeded one.
  const calcCheck = await run(`(async () => {
    ${HELPERS}
    const cfg = getConfig();
    const cred = getCredential();
    const meta = await fetch('https://api.airtable.com/v0/meta/bases/' + cfg.baseId + '/tables', {
      headers: { 'Authorization': 'Bearer ' + cred.apiKey },
    }).then(r => r.json());
    const tbl = (meta.tables || []).find(t => t.id === cfg.tableId);
    const calc = tbl?.fields?.find(f => f.name === ${JSON.stringify(CALCULATION_FIELD)} && f.type === 'formula');
    return JSON.stringify({ found: !!calc });
  })()`, 15000);
  hasCalField = calcCheck.found;
  if (!hasCalField) {
    log(`  ⚠️  Demo's stock "${CALCULATION_FIELD}" formula field not detected on the target table.`);
    log('     Add a formula column with the seeded formula:');
    log(`       IF({${CALCULATION_SOURCE}}, {${CALCULATION_SOURCE}} & "${CALCULATION_SUFFIX}", "")`);
    log('     Calculation-dependent test cases will be skipped until then.');
  }

  log('=== Setup: Create test records ===');
  const r = await run(`(async () => {
    ${HELPERS}
    const cfg = getConfig();
    const cred = getCredential();
    const resp = await fetch('https://api.airtable.com/v0/' + cfg.baseId + '/' + cfg.tableId, {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + cred.apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        // typecast: true lets Airtable coerce ISO date strings, boolean
        // checkbox values, etc. Without it a freshly-added field can
        // reject our payload with TYPECAST_ERROR.
        typecast: true,
        records: [
          { fields: { Name: 'E2E-Pull-Test',  'Single line text': 'pull-src',  E2ECount: 100, Status: 'Todo',        Description: 'pull desc',  DueDate: '2026-12-01', Done: true  } },
          { fields: { Name: 'E2E-Push-Test',  'Single line text': 'push-src',  E2ECount: 200, Status: 'In progress', Description: 'push desc',  DueDate: '2026-12-02', Done: false } },
          { fields: { Name: 'E2E-Bidir-Test', 'Single line text': 'bidir-src', E2ECount: 300, Status: 'Done',        Description: 'bidir desc', DueDate: '2026-12-03', Done: true  } },
        ],
      }),
    });
    const data = await resp.json();
    if (!resp.ok || !Array.isArray(data?.records)) {
      throw new Error('Create test records failed (HTTP ' + resp.status + '): ' + JSON.stringify(data));
    }
    return JSON.stringify(data.records.map(r => ({ id: r.id, name: r.fields.Name })));
  })()`, 15000);

  testRecordIds = r.map(rec => rec.id);
  log(`Created ${r.length} test records: ${testRecordIds.join(', ')}`);
}

function resetExpr() {
  // Build a reset expression using current testRecordIds
  return `(async () => {
    ${HELPERS}
    const cfg = getConfig();
    const cred = getCredential();
    await fetch('https://api.airtable.com/v0/' + cfg.baseId + '/' + cfg.tableId, {
      method: 'PATCH',
      headers: { 'Authorization': 'Bearer ' + cred.apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ records: [
        { id: '${testRecordIds[0]}', fields: { Name: 'E2E-Pull-Test',  'Single line text': 'pull-src',  E2ECount: 100, Status: 'Todo',        Description: 'pull desc',  DueDate: '2026-12-01', Done: true  } },
        { id: '${testRecordIds[1]}', fields: { Name: 'E2E-Push-Test',  'Single line text': 'push-src',  E2ECount: 200, Status: 'In progress', Description: 'push desc',  DueDate: '2026-12-02', Done: false } },
        { id: '${testRecordIds[2]}', fields: { Name: 'E2E-Bidir-Test', 'Single line text': 'bidir-src', E2ECount: 300, Status: 'Done',        Description: 'bidir desc', DueDate: '2026-12-03', Done: true  } }
      ]})
    });
    setMode('manual', false);
    await enqueueSync('pull', 'all');
    await new Promise(r => setTimeout(r, 5000));
    return '"reset"';
  })()`;
}

async function doReset() {
  await run(resetExpr(), 20000);
}

async function cleanup() {
  log('\n=== Cleanup: Delete test records + e2e config ===');
  await run(`(async () => {
    ${HELPERS}
    const p = getPlugin();
    const cfg = getConfig();
    const cred = getCredential();
    const ids = ${JSON.stringify(testRecordIds)};

    // Delete from Airtable
    if (cfg && cred && ids.length > 0) {
      const params = ids.map(id => 'records[]=' + id).join('&');
      await fetch('https://api.airtable.com/v0/' + cfg.baseId + '/' + cfg.tableId + '?' + params, {
        method: 'DELETE',
        headers: { 'Authorization': 'Bearer ' + cred.apiKey }
      });
    }

    // Delete local files
    if (cfg) {
      for (const name of ['E2E-Pull-Test.md', 'E2E-Push-Test.md', 'E2E-Bidir-Test.md']) {
        const file = app.vault.getAbstractFileByPath(cfg.folderPath + '/' + name);
        if (file) await app.vault.delete(file);
      }
      // Folder cleanup
      const folder = app.vault.getAbstractFileByPath(cfg.folderPath);
      if (folder) {
        try { await app.vault.delete(folder, true); } catch {}
      }
    }

    // Delete any .base files created during tests
    const basesFiles = app.vault.getFiles().filter(f => f.extension === 'base' && f.basename.includes('E2E'));
    for (const f of basesFiles) await app.vault.delete(f);

    // Detach the e2e credential + config (idempotent). Schema columns
    // added by ensureFields stay on the base — DELETE field is not used.
    const cfgIdx = p.settings.configs.findIndex(c => c.id === '${E2E_AT_CFG_ID}');
    if (cfgIdx !== -1) {
      p.configManager.removeConfig('${E2E_AT_CFG_ID}');
      p.settings.configs.splice(cfgIdx, 1);
    }
    p.settings.credentials = p.settings.credentials.filter(c => c.id !== '${E2E_AT_CRED_ID}');
    await p.saveSettings();

    return '"cleaned"';
  })()`, 20000);
  log('Test records, files, and e2e config cleaned up (columns kept on base).');
}

async function cleanupMultiConfig() {
  log('\n=== Cleanup: Multi-config test data ===');
  await run(`(async () => {
    ${HELPERS}
    const p = getPlugin();
    const cred = getCredential();
    const mcIds = ${JSON.stringify(multiConfigRecordIds)};

    // Delete records from second table
    if (mcIds.length > 0) {
      const params = mcIds.map(id => 'records[]=' + id).join('&');
      await fetch('https://api.airtable.com/v0/' + getConfig().baseId + '/${MULTI_CONFIG_TABLE_ID}?' + params, {
        method: 'DELETE',
        headers: { 'Authorization': 'Bearer ' + cred.apiKey }
      });
    }

    // Delete files in E2E-Multi/ folder
    const mcFiles = app.vault.getFiles().filter(f => f.path.startsWith('${MULTI_CONFIG_FOLDER}/'));
    for (const f of mcFiles) await app.vault.delete(f);

    // Delete E2E-Multi folder itself
    const mcFolder = app.vault.getAbstractFileByPath('${MULTI_CONFIG_FOLDER}');
    if (mcFolder) await app.vault.delete(mcFolder);

    // Remove second config from settings
    const cfgIdx = p.settings.configs.findIndex(c => c.id === '${MULTI_CONFIG_ID}');
    if (cfgIdx !== -1) {
      p.configManager.removeConfig('${MULTI_CONFIG_ID}');
      p.settings.configs.splice(cfgIdx, 1);
      await p.saveSettings();
    }

    return '"mc-cleaned"';
  })()`, 15000);
  log('Multi-config test data cleaned up');
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function test(name, fn) {
  log(`\n=== ${name} ===`);
  try {
    const result = await fn();
    if (result?.skip) {
      results.push({ test: name, pass: true, skip: true, detail: result.detail || 'skipped' });
      log(`SKIP - ${result.detail || 'skipped'}`);
      return;
    }
    const { pass, detail } = result;
    results.push({ test: name, pass, detail });
    log(pass ? 'PASS' : `FAIL - ${detail}`);
  } catch (e) {
    results.push({ test: name, pass: false, detail: e.message });
    log(`FAIL - ${e.message}`);
  }
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

    await test('pull / all', async () => {
      const r = await run(`(async () => {
        ${HELPERS}
        await enqueueSync('pull', 'all');
        const files = app.vault.getFiles().filter(f => f.path.startsWith(getConfig().folderPath + '/') && f.extension === 'md');
        return JSON.stringify({ count: files.length, names: files.map(f => f.basename) });
      })()`, 30000);
      const expected = ['E2E-Pull-Test', 'E2E-Push-Test', 'E2E-Bidir-Test'];
      const pass = expected.every(n => (r.names || []).includes(n));
      return { pass, detail: `count=${r.count} names=[${(r.names || []).join(',')}]` };
    });

    await test('pull / bases file generation', async () => {
      const r = await run(`(async () => {
        ${HELPERS}
        const p = getPlugin();
        const cfg = getConfig();
        const cred = getCredential();
        const folderPath = cfg.folderPath;

        // Enable bases generation, vault-root location
        cfg.generateBasesFile = true;
        cfg.basesFileLocation = 'vault-root';
        cfg.basesRegenerateOnSync = false;
        getInstance().updateSettings(cfg, cred);

        // Delete existing .base file if any (find by table name or folder name)
        const existingBases = app.vault.getFiles().filter(f => f.extension === 'base');
        for (const f of existingBases) await app.vault.delete(f);

        // Sync from Airtable
        await enqueueSync('pull', 'all');
        await new Promise(r => setTimeout(r, 6000));

        // Check .base file was created
        const basesFiles = app.vault.getFiles().filter(f => f.extension === 'base');
        if (basesFiles.length === 0) {
          return JSON.stringify({ pass: false, detail: 'No .base file created' });
        }

        const baseFile = basesFiles[0];
        const content = await app.vault.read(baseFile);

        // Verify YAML structure
        const hasFilter = content.includes('file.inFolder("' + folderPath + '")');
        const hasTableView = content.includes('type: table');
        const hasFileName = content.includes('file.name');
        const hasNotePrefix = content.includes('note.');

        // Verify regenerate=false skips existing file
        const contentBefore = content;
        await enqueueSync('pull', 'all');
        await new Promise(r => setTimeout(r, 6000));
        const contentAfter = await app.vault.read(baseFile);
        const skipWorks = contentBefore === contentAfter;

        // Cleanup
        await app.vault.delete(baseFile);
        cfg.generateBasesFile = true;

        return JSON.stringify({
          pass: hasFilter && hasTableView && hasFileName && hasNotePrefix && skipWorks,
          detail: 'filter=' + hasFilter + ' table=' + hasTableView + ' fileName=' + hasFileName + ' notePrefix=' + hasNotePrefix + ' skipExisting=' + skipWorks,
          path: baseFile.path
        });
      })()`, 30000);
      return { pass: r.pass, detail: r.detail || 'ok' };
    });

    await test('pull / view filter', async () => {
      const r = await run(`(async () => {
        ${HELPERS}
        const p = getPlugin();
        const cfg = getConfig();
        const cred = getCredential();

        // 1. Verify fetchViews returns available views
        const views = await p.fieldCache.fetchViews(
          cred.apiKey, cfg.baseId, cfg.tableId
        );
        if (!views || views.length === 0) {
          return JSON.stringify({ pass: false, detail: 'No views found in table' });
        }

        // 2. Pick the first non-default view (Grid views are usually the default)
        const nonDefault = views.find(v => v.name !== 'Grid view') || views[0];

        // 3. Sync with view filter
        const oldViewId = cfg.viewId;
        cfg.viewId = nonDefault.id;
        getInstance().updateSettings(cfg, cred);

        await enqueueSync('pull', 'all');
        await new Promise(r => setTimeout(r, 5000));
        const viewFiles = app.vault.getFiles().filter(
          f => f.path.startsWith(cfg.folderPath + '/') && f.extension === 'md'
        );
        const viewCount = viewFiles.length;

        // 4. Sync without view filter
        cfg.viewId = '';
        cfg.allowOverwrite = true;
        getInstance().updateSettings(cfg, cred);

        await enqueueSync('pull', 'all');
        await new Promise(r => setTimeout(r, 5000));
        const allFiles = app.vault.getFiles().filter(
          f => f.path.startsWith(cfg.folderPath + '/') && f.extension === 'md'
        );
        const allCount = allFiles.length;

        // Restore
        cfg.viewId = oldViewId;
        getInstance().updateSettings(cfg, cred);

        return JSON.stringify({
          pass: views.length > 0 && allCount > 0 && allCount >= viewCount,
          detail: 'views=' + views.length + ', viewFiltered=' + viewCount + ', allRecords=' + allCount + ', selectedView=' + nonDefault.name,
          viewName: nonDefault.name
        });
      })()`, 30000);
      return { pass: r.pass, detail: r.detail || 'ok' };
    });

    await test('pull / current', async () => {
      const r = await run(`(async () => {
        ${HELPERS}
        const file = await openAndActivate(getConfig().folderPath + '/E2E-Pull-Test.md');
        try {
          await enqueueSync('pull', 'current');
          await new Promise(r => setTimeout(r, 3000));
          const content = await app.vault.read(file);
          return JSON.stringify({ pass: content.includes('${testRecordIds[0]}') });
        } catch(e) {
          return JSON.stringify({ pass: false, detail: e.message });
        }
      })()`, 15000);
      return { pass: r.pass, detail: r.detail || 'ok' };
    });

    await test('pull / writes all column types into frontmatter', async () => {
      // Verifies fetchNotes correctly normalizes every supported writable
      // type (text / number / singleSelect / multilineText / date /
      // checkbox / formula).
      const r = await run(`(async () => {
        ${HELPERS}
        const file = app.vault.getAbstractFileByPath(getConfig().folderPath + '/E2E-Pull-Test.md');
        const fm = app.metadataCache.getFileCache(file)?.frontmatter || {};
        return JSON.stringify({
          Name: fm.Name,
          Source: fm[${JSON.stringify(CALCULATION_SOURCE)}],
          E2ECount: fm.E2ECount,
          Status: fm.Status,
          Description: fm.Description,
          DueDate: typeof fm.DueDate === 'string' ? fm.DueDate.slice(0, 10) : null,
          Done: fm.Done,
          Calculation: fm[${JSON.stringify(CALCULATION_FIELD)}],
        });
      })()`, 10000);
      const expectedCalcVal = expectedCalc('pull-src');
      const calcOk = !hasCalField || r.Calculation === expectedCalcVal;
      const pass = r.Name === 'E2E-Pull-Test'
        && r.Source === 'pull-src'
        && r.E2ECount === 100
        && r.Status === 'Todo'
        && r.Description === 'pull desc'
        && r.DueDate === '2026-12-01'
        && r.Done === true
        && calcOk;
      return { pass, detail: `name=${r.Name} src=${r.Source} count=${r.E2ECount} status=${r.Status} done=${r.Done} calc="${r.Calculation}"${hasCalField ? '' : ' [no formula field]'}` };
    });

    // -- Push tests --

    await test('push / all / obsidian-wins', async () => {
      await doReset();
      const r = await run(`(async () => {
        ${HELPERS}
        setMode('obsidian-wins');
        const file = app.vault.getAbstractFileByPath(getConfig().folderPath + '/E2E-Push-Test.md');
        await modifyCount(file, 555);
        await enqueueSync('push', 'all');
        const fields = await fetchRecord('${testRecordIds[1]}');
        setMode('manual');
        return JSON.stringify({ pass: fields.E2ECount === 555, count: fields.E2ECount });
      })()`, 30000);
      return { pass: r.pass, detail: `E2ECount=${r.count}` };
    });

    await test('push / current / obsidian-wins', async () => {
      await doReset();
      const r = await run(`(async () => {
        ${HELPERS}
        setMode('obsidian-wins');
        const file = await openAndActivate(getConfig().folderPath + '/E2E-Bidir-Test.md');
        await modifyCount(file, 888);
        await enqueueSync('push', 'current');
        await new Promise(r => setTimeout(r, 5000));
        const fields = await fetchRecord('${testRecordIds[2]}');
        setMode('manual');
        return JSON.stringify({ pass: fields.E2ECount === 888, count: fields.E2ECount });
      })()`, 25000);
      return { pass: r.pass, detail: `E2ECount=${r.count}` };
    });

    await test('push / all / remote-wins', async () => {
      await doReset();
      const r = await run(`(async () => {
        ${HELPERS}
        setMode('remote-wins');
        const file = app.vault.getAbstractFileByPath(getConfig().folderPath + '/E2E-Pull-Test.md');
        await modifyCount(file, 9999);
        await enqueueSync('push', 'all');
        await new Promise(r => setTimeout(r, 5000));
        const fields = await fetchRecord('${testRecordIds[0]}');
        setMode('manual');
        return JSON.stringify({ pass: fields.E2ECount === 100, count: fields.E2ECount });
      })()`, 25000);
      return { pass: r.pass, detail: `E2ECount=${r.count} (expected 100)` };
    });

    await test('push / current / remote-wins', async () => {
      await doReset();
      const r = await run(`(async () => {
        ${HELPERS}
        setMode('remote-wins');
        const file = await openAndActivate(getConfig().folderPath + '/E2E-Push-Test.md');
        await modifyCount(file, 7777);
        await enqueueSync('push', 'current');
        await new Promise(r => setTimeout(r, 5000));
        const fields = await fetchRecord('${testRecordIds[1]}');
        setMode('manual');
        return JSON.stringify({ pass: fields.E2ECount === 200, count: fields.E2ECount });
      })()`, 25000);
      return { pass: r.pass, detail: `E2ECount=${r.count} (expected 200)` };
    });

    await test('push / all / manual (conflict blocks)', async () => {
      await doReset();
      const r = await run(`(async () => {
        ${HELPERS}
        setMode('manual');
        const file = app.vault.getAbstractFileByPath(getConfig().folderPath + '/E2E-Push-Test.md');
        await modifyCount(file, 7777);
        await enqueueSync('push', 'all');
        const fields = await fetchRecord('${testRecordIds[1]}');
        return JSON.stringify({ pass: fields.E2ECount === 200, count: fields.E2ECount });
      })()`, 60000);
      return { pass: r.pass, detail: `E2ECount=${r.count} (expected 200)` };
    });

    // -- Per-column-type push tests --

    await test('push / multilineText column (Description)', async () => {
      await doReset();
      const r = await run(`(async () => {
        ${HELPERS}
        setMode('obsidian-wins');
        const file = app.vault.getAbstractFileByPath(getConfig().folderPath + '/E2E-Push-Test.md');
        await modifyField(file, 'Description', 'updated long-text');
        await enqueueSync('push', 'all');
        await new Promise(r => setTimeout(r, 5000));
        const fields = await fetchRecord('${testRecordIds[1]}');
        setMode('manual');
        return JSON.stringify({ remoteDesc: fields.Description });
      })()`, 25000);
      return { pass: r.remoteDesc === 'updated long-text', detail: `Description="${r.remoteDesc}"` };
    });

    await test('push / date column (DueDate)', async () => {
      await doReset();
      const r = await run(`(async () => {
        ${HELPERS}
        setMode('obsidian-wins');
        const file = app.vault.getAbstractFileByPath(getConfig().folderPath + '/E2E-Push-Test.md');
        await modifyField(file, 'DueDate', '2027-01-15');
        await enqueueSync('push', 'all');
        await new Promise(r => setTimeout(r, 5000));
        const fields = await fetchRecord('${testRecordIds[1]}');
        setMode('manual');
        return JSON.stringify({ remoteDate: fields.DueDate });
      })()`, 25000);
      const pass = typeof r.remoteDate === 'string' && r.remoteDate.startsWith('2027-01-15');
      return { pass, detail: `DueDate="${r.remoteDate}"` };
    });

    await test('push / checkbox column (Done)', async () => {
      await doReset();
      const r = await run(`(async () => {
        ${HELPERS}
        setMode('obsidian-wins');
        const file = app.vault.getAbstractFileByPath(getConfig().folderPath + '/E2E-Push-Test.md');
        await modifyField(file, 'Done', true);
        await enqueueSync('push', 'all');
        await new Promise(r => setTimeout(r, 5000));
        const fields = await fetchRecord('${testRecordIds[1]}');
        setMode('manual');
        return JSON.stringify({ remoteDone: fields.Done });
      })()`, 25000);
      return { pass: r.remoteDone === true, detail: `Done=${r.remoteDone}` };
    });

    await test('push / singleSelect column (Status)', async () => {
      await doReset();
      const r = await run(`(async () => {
        ${HELPERS}
        setMode('obsidian-wins');
        const file = app.vault.getAbstractFileByPath(getConfig().folderPath + '/E2E-Push-Test.md');
        await modifyField(file, 'Status', 'Done');
        await enqueueSync('push', 'all');
        await new Promise(r => setTimeout(r, 5000));
        const fields = await fetchRecord('${testRecordIds[1]}');
        setMode('manual');
        return JSON.stringify({ remoteStatus: fields.Status });
      })()`, 25000);
      return { pass: r.remoteStatus === 'Done', detail: `Status="${r.remoteStatus}"` };
    });

    await test('push / formula column edits are silently dropped (read-only)', async () => {
      if (!hasCalField) return { skip: true, detail: 'Calculation formula field not present — see setup notes' };
      await doReset();
      const r = await run(`(async () => {
        ${HELPERS}
        setMode('obsidian-wins');
        const file = app.vault.getAbstractFileByPath(getConfig().folderPath + '/E2E-Pull-Test.md');
        // User manually edits the local formula value; frontmatter-parser
        // must skip computed fields so Airtable keeps recomputing it.
        await modifyField(file, ${JSON.stringify(CALCULATION_FIELD)}, 'spoofed');
        await enqueueSync('push', 'all');
        const fields = await fetchRecord('${testRecordIds[0]}');
        setMode('manual');
        return JSON.stringify({ remoteCalc: fields[${JSON.stringify(CALCULATION_FIELD)}] });
      })()`, 30000);
      const expected = expectedCalc('pull-src');
      return { pass: r.remoteCalc === expected, detail: `Calc="${r.remoteCalc}" (expected "${expected}")` };
    });

    // -- Bidirectional tests --

    await test('bidirectional / all / autoSyncComputedFields=true', async () => {
      if (!hasCalField) return { skip: true, detail: 'Calculation formula field not present — see setup notes' };
      await doReset();
      const r = await run(`(async () => {
        ${HELPERS}
        setMode('obsidian-wins', true);
        const file = app.vault.getAbstractFileByPath(getConfig().folderPath + '/E2E-Bidir-Test.md');
        await modifyField(file, ${JSON.stringify(CALCULATION_SOURCE)}, 'bidir-450');
        await enqueueSync('bidirectional', 'all');
        const fmAfter = app.metadataCache.getFileCache(file)?.frontmatter || {};
        const fields = await fetchRecord('${testRecordIds[2]}');
        setMode('manual', false);
        return JSON.stringify({
          localSource: fmAfter[${JSON.stringify(CALCULATION_SOURCE)}],
          localCalc: fmAfter[${JSON.stringify(CALCULATION_FIELD)}],
          remoteSource: fields[${JSON.stringify(CALCULATION_SOURCE)}],
          remoteCalc: fields[${JSON.stringify(CALCULATION_FIELD)}],
        });
      })()`, 60000);
      const expected = expectedCalc('bidir-450');
      const pass = r.localSource === 'bidir-450'
        && r.localCalc === expected
        && r.remoteSource === 'bidir-450'
        && r.remoteCalc === expected;
      return { pass, detail: `localCalc="${r.localCalc}" remoteCalc="${r.remoteCalc}" (expected "${expected}")` };
    });

    await test('bidirectional / all / autoSyncComputedFields=false', async () => {
      if (!hasCalField) return { skip: true, detail: 'Calculation formula field not present — see setup notes' };
      await doReset();
      const r = await run(`(async () => {
        ${HELPERS}
        setMode('obsidian-wins', false);
        const file = app.vault.getAbstractFileByPath(getConfig().folderPath + '/E2E-Bidir-Test.md');
        const fmBefore = app.metadataCache.getFileCache(file)?.frontmatter || {};
        const oldCalc = fmBefore[${JSON.stringify(CALCULATION_FIELD)}];
        await modifyField(file, ${JSON.stringify(CALCULATION_SOURCE)}, 'bidir-stale');
        await enqueueSync('bidirectional', 'all');
        const fmAfter = app.metadataCache.getFileCache(file)?.frontmatter || {};
        const localCalc = fmAfter[${JSON.stringify(CALCULATION_FIELD)}];
        const fields = await fetchRecord('${testRecordIds[2]}');
        setMode('manual', false);
        return JSON.stringify({
          oldCalc, localCalc,
          calcUnchanged: localCalc === oldCalc,
          remoteSource: fields[${JSON.stringify(CALCULATION_SOURCE)}],
        });
      })()`, 30000);
      const pass = r.calcUnchanged && r.remoteSource === 'bidir-stale';
      return { pass, detail: `remoteSrc=${r.remoteSource}, calc=${r.localCalc} (oldCalc=${r.oldCalc})` };
    });

    await test('bidirectional / current / autoSyncComputedFields=true', async () => {
      if (!hasCalField) return { skip: true, detail: 'Calculation formula field not present — see setup notes' };
      await doReset();
      const r = await run(`(async () => {
        ${HELPERS}
        setMode('obsidian-wins', true);
        const file = await openAndActivate(getConfig().folderPath + '/E2E-Push-Test.md');
        await modifyField(file, ${JSON.stringify(CALCULATION_SOURCE)}, 'cur-123');
        await enqueueSync('bidirectional', 'current');
        const fmAfter = app.metadataCache.getFileCache(file)?.frontmatter || {};
        setMode('manual', false);
        return JSON.stringify({ localCalc: fmAfter[${JSON.stringify(CALCULATION_FIELD)}] });
      })()`, 60000);
      const expected = expectedCalc('cur-123');
      return { pass: r.localCalc === expected, detail: `Calc="${r.localCalc}" (expected "${expected}")` };
    });

    await test('bidirectional / current / autoSyncComputedFields=false', async () => {
      if (!hasCalField) return { skip: true, detail: 'Calculation formula field not present — see setup notes' };
      await doReset();
      const r = await run(`(async () => {
        ${HELPERS}
        setMode('obsidian-wins', false);
        const file = await openAndActivate(getConfig().folderPath + '/E2E-Push-Test.md');
        const fmBefore = app.metadataCache.getFileCache(file)?.frontmatter || {};
        const oldCalc = fmBefore[${JSON.stringify(CALCULATION_FIELD)}];
        await modifyField(file, ${JSON.stringify(CALCULATION_SOURCE)}, 'cur-stale');
        await enqueueSync('bidirectional', 'current');
        const fmAfter = app.metadataCache.getFileCache(file)?.frontmatter || {};
        const localCalc = fmAfter[${JSON.stringify(CALCULATION_FIELD)}];
        const fields = await fetchRecord('${testRecordIds[1]}');
        setMode('manual', false);
        return JSON.stringify({
          oldCalc, localCalc,
          calcUnchanged: localCalc === oldCalc,
          remoteSource: fields[${JSON.stringify(CALCULATION_SOURCE)}],
        });
      })()`, 30000);
      const pass = r.calcUnchanged && r.remoteSource === 'cur-stale';
      return { pass, detail: `remoteSrc=${r.remoteSource}, calc=${r.localCalc} (oldCalc=${r.oldCalc})` };
    });

    // -- Multi-Config tests --

    await test('multi-config / migration preserves settings', async () => {
      const r = await run(`(async () => {
        ${HELPERS}
        const p = getPlugin();
        const cfg = getConfig();
        const cred = getCredential();

        const hasVersion = p.settings.version === 3;
        const hasConfigs = p.settings.configs.length >= 1;
        const hasCreds = p.settings.credentials.length >= 1;
        const hasBaseId = cfg.baseId && cfg.baseId.length > 0;
        const hasTableId = cfg.tableId && cfg.tableId.length > 0;
        const hasFolderPath = cfg.folderPath && cfg.folderPath.length > 0;
        const hasApiKey = cred.apiKey && cred.apiKey.length > 0;
        const credLinked = cfg.credentialId === cred.id;

        return JSON.stringify({
          pass: hasVersion && hasConfigs && hasCreds && hasBaseId && hasTableId && hasFolderPath && hasApiKey && credLinked,
          detail: 'version=' + p.settings.version
            + ' configs=' + p.settings.configs.length
            + ' creds=' + p.settings.credentials.length
            + ' baseId=' + hasBaseId
            + ' tableId=' + hasTableId
            + ' folderPath=' + hasFolderPath
            + ' apiKey=' + hasApiKey
            + ' credLinked=' + credLinked
        });
      })()`, 10000);
      return { pass: r.pass, detail: r.detail || 'ok' };
    });

    await test('multi-config / independent sync', async () => {
      // Setup: add second config and create records in second table
      const mcSetup = await run(`(async () => {
        ${HELPERS}
        const p = getPlugin();
        const cfg = getConfig();
        const cred = getCredential();

        // Add second config
        const secondConfig = {
          id: '${MULTI_CONFIG_ID}',
          name: 'E2E Multi',
          enabled: true,
          credentialId: cred.id,
          baseId: cfg.baseId,
          tableId: '${MULTI_CONFIG_TABLE_ID}',
          viewId: '',
          folderPath: '${MULTI_CONFIG_FOLDER}',
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
          formulaSyncDelay: 3000,
          generateBasesFile: false,
          basesFileLocation: 'vault-root',
          basesCustomPath: '',
          basesRegenerateOnSync: false,
        };

        // Remove existing if present (idempotent)
        const existIdx = p.settings.configs.findIndex(c => c.id === '${MULTI_CONFIG_ID}');
        if (existIdx !== -1) {
          p.configManager.removeConfig('${MULTI_CONFIG_ID}');
          p.settings.configs.splice(existIdx, 1);
        }

        p.settings.configs.push(secondConfig);
        await p.saveSettings();

        // Create records in second table
        const resp = await fetch('https://api.airtable.com/v0/' + cfg.baseId + '/${MULTI_CONFIG_TABLE_ID}', {
          method: 'POST',
          headers: { 'Authorization': 'Bearer ' + cred.apiKey, 'Content-Type': 'application/json' },
          body: JSON.stringify({ records: [
            { fields: { Name: 'MC-Test-1', Value: 42, Tag: 'alpha' } },
            { fields: { Name: 'MC-Test-2', Value: 99, Tag: 'alpha' } }
          ]})
        });
        const data = await resp.json();
        return JSON.stringify(data.records.map(r => ({ id: r.id, name: r.fields.Name })));
      })()`, 15000);

      multiConfigRecordIds = mcSetup.map(rec => rec.id);
      log(`Created ${mcSetup.length} multi-config records: ${multiConfigRecordIds.join(', ')}`);

      // Record config 1 file state before config 2 sync
      const r = await run(`(async () => {
        ${HELPERS}
        const p = getPlugin();
        const cfg1 = getConfig(0);
        const cfg2 = p.settings.configs.find(c => c.id === '${MULTI_CONFIG_ID}');
        if (!cfg2) return JSON.stringify({ pass: false, detail: 'Second config not found' });

        // Record config 1 files before
        const cfg1FilesBefore = app.vault.getFiles()
          .filter(f => f.path.startsWith(cfg1.folderPath + '/') && f.extension === 'md')
          .map(f => f.path);

        // Sync config 2
        await enqueueSync('pull', 'all', cfg2);
        await new Promise(r => setTimeout(r, 5000));

        // Check config 2 files created in its folder
        const cfg2Files = app.vault.getFiles()
          .filter(f => f.path.startsWith('${MULTI_CONFIG_FOLDER}/') && f.extension === 'md');
        const hasTestFile = cfg2Files.some(f => f.basename === 'MC-Test-1');

        // Check config 1 files unchanged
        const cfg1FilesAfter = app.vault.getFiles()
          .filter(f => f.path.startsWith(cfg1.folderPath + '/') && f.extension === 'md')
          .map(f => f.path);
        const cfg1Unchanged = cfg1FilesBefore.length === cfg1FilesAfter.length
          && cfg1FilesBefore.every(p => cfg1FilesAfter.includes(p));

        return JSON.stringify({
          pass: hasTestFile && cfg1Unchanged && cfg2Files.length >= 2,
          detail: 'cfg2Files=' + cfg2Files.length
            + ' hasTestFile=' + hasTestFile
            + ' cfg1Unchanged=' + cfg1Unchanged
            + ' cfg1Before=' + cfg1FilesBefore.length
            + ' cfg1After=' + cfg1FilesAfter.length
        });
      })()`, 20000);
      return { pass: r.pass, detail: r.detail || 'ok' };
    });

    await test('multi-config / folder isolation', async () => {
      const r = await run(`(async () => {
        ${HELPERS}
        const p = getPlugin();
        const cfg1 = getConfig(0);
        const cfg2 = p.settings.configs.find(c => c.id === '${MULTI_CONFIG_ID}');
        if (!cfg2) return JSON.stringify({ pass: false, detail: 'Second config not found' });

        // Config 1 files
        const cfg1Files = app.vault.getFiles()
          .filter(f => f.path.startsWith(cfg1.folderPath + '/') && f.extension === 'md');

        // Config 2 files
        const cfg2Files = app.vault.getFiles()
          .filter(f => f.path.startsWith('${MULTI_CONFIG_FOLDER}/') && f.extension === 'md');

        // No config 2 content (MC-Test) in config 1 folder
        const crossContamination1 = cfg1Files.some(f => f.basename.startsWith('MC-Test'));

        // No config 1 content (E2E-Pull/Push/Bidir) in config 2 folder
        const crossContamination2 = cfg2Files.some(f =>
          f.basename.startsWith('E2E-Pull') ||
          f.basename.startsWith('E2E-Push') ||
          f.basename.startsWith('E2E-Bidir')
        );

        return JSON.stringify({
          pass: !crossContamination1 && !crossContamination2 && cfg1Files.length > 0 && cfg2Files.length > 0,
          detail: 'cfg1Count=' + cfg1Files.length
            + ' cfg2Count=' + cfg2Files.length
            + ' crossContam1=' + crossContamination1
            + ' crossContam2=' + crossContamination2
        });
      })()`, 10000);
      return { pass: r.pass, detail: r.detail || 'ok' };
    });

    // -- Summary --

    log('\n========================================');
    log('         E2E TEST SUMMARY');
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

    // -- Cleanup --
    if (process.argv.includes('--cleanup')) {
      await cleanup();
      await cleanupMultiConfig();
    } else {
      log('\nTest records left in Airtable. Run with --cleanup to remove them.');
    }

    process.exit(passCount === results.length ? 0 : 1);

  } catch (e) {
    console.error('FATAL:', e.message);
    process.exit(1);
  }
})();
