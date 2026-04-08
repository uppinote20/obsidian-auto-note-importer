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
 *   3. The Airtable table must have: Name (text), Count (number), Status (select), Cal (formula: Count*2)
 *   4. For multi-config tests: a second table 'E2E-MultiConfig' (tblZO35AeSdSmI3rr)
 *      with fields: Name (text), Value (number), Tag (singleSelect)
 *
 * Usage:
 *   node tests/e2e/run-e2e.mjs                          # auto-detect CDP target
 *   node tests/e2e/run-e2e.mjs --cleanup                # run tests then delete test records
 *   CDP_TARGET_ID=<id> node tests/e2e/run-e2e.mjs       # specify CDP page target
 */

import { findPageTarget, evalInObsidian } from './cdp-helpers.mjs';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const PLUGIN_ID = 'auto-note-importer';
const MULTI_CONFIG_TABLE_ID = 'tblZO35AeSdSmI3rr';
const MULTI_CONFIG_FOLDER = 'E2E-Multi';
const MULTI_CONFIG_ID = 'e2e-cfg-2';

// Test records created during setup — deleted during cleanup
let testRecordIds = [];
let multiConfigRecordIds = [];

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
    content = content.replace(/Count: \\d+/, 'Count: ' + newCount);
    await app.vault.modify(file, content);
    await waitForCache(file, 'Count', newCount);
  }

  function getPlugin() { return app.plugins.plugins['${PLUGIN_ID}']; }

  function getConfig(idx = 0) {
    const p = getPlugin();
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
    if (autoFormula !== undefined) cfg.autoSyncFormulas = autoFormula;
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
  return evalInObsidian(targetId, expr, timeout);
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

async function setup() {
  log('=== Setup: Reload plugin ===');
  await run(`(async () => {
    await app.plugins.disablePlugin('${PLUGIN_ID}');
    await app.plugins.enablePlugin('${PLUGIN_ID}');
    return '"ok"';
  })()`, 10000);

  log('=== Setup: Create test records ===');
  const r = await run(`(async () => {
    ${HELPERS}
    const cfg = getConfig();
    const cred = getCredential();
    const resp = await fetch('https://api.airtable.com/v0/' + cfg.baseId + '/' + cfg.tableId, {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + cred.apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ records: [
        { fields: { Name: 'E2E-Pull-Test', Count: 100, Status: 'Todo' } },
        { fields: { Name: 'E2E-Push-Test', Count: 200, Status: 'In progress' } },
        { fields: { Name: 'E2E-Bidir-Test', Count: 300, Status: 'Done' } }
      ]})
    });
    const data = await resp.json();
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
        { id: '${testRecordIds[0]}', fields: { Name: 'E2E-Pull-Test', Count: 100, Status: 'Todo' } },
        { id: '${testRecordIds[1]}', fields: { Name: 'E2E-Push-Test', Count: 200, Status: 'In progress' } },
        { id: '${testRecordIds[2]}', fields: { Name: 'E2E-Bidir-Test', Count: 300, Status: 'Done' } }
      ]})
    });
    setMode('manual', false);
    await enqueueSync('from-airtable', 'all');
    await new Promise(r => setTimeout(r, 5000));
    return '"reset"';
  })()`;
}

async function doReset() {
  await run(resetExpr(), 20000);
}

async function cleanup() {
  log('\n=== Cleanup: Delete test records ===');
  await run(`(async () => {
    ${HELPERS}
    const cfg = getConfig();
    const cred = getCredential();
    const ids = ${JSON.stringify(testRecordIds)};

    // Delete from Airtable
    const params = ids.map(id => 'records[]=' + id).join('&');
    await fetch('https://api.airtable.com/v0/' + cfg.baseId + '/' + cfg.tableId + '?' + params, {
      method: 'DELETE',
      headers: { 'Authorization': 'Bearer ' + cred.apiKey }
    });

    // Delete local files
    for (const name of ['E2E-Pull-Test.md', 'E2E-Push-Test.md', 'E2E-Bidir-Test.md']) {
      const file = app.vault.getAbstractFileByPath(cfg.folderPath + '/' + name);
      if (file) await app.vault.delete(file);
    }

    // Delete any .base files created during tests
    const basesFiles = app.vault.getFiles().filter(f => f.extension === 'base' && f.basename.includes('E2E'));
    for (const f of basesFiles) await app.vault.delete(f);
    return '"cleaned"';
  })()`, 15000);
  log('Test records and files cleaned up');
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
    const { pass, detail } = await fn();
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

    await test('from-airtable / all', async () => {
      const r = await run(`(async () => {
        ${HELPERS}
        await enqueueSync('from-airtable', 'all');
        await new Promise(r => setTimeout(r, 5000));
        const files = app.vault.getFiles().filter(f => f.path.startsWith(getConfig().folderPath + '/'));
        return JSON.stringify({ fileCount: files.length });
      })()`, 15000);
      return { pass: r.fileCount >= 8, detail: `${r.fileCount} files` };
    });

    await test('from-airtable / bases file generation', async () => {
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
        await enqueueSync('from-airtable', 'all');
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
        await enqueueSync('from-airtable', 'all');
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

    await test('from-airtable / view filter', async () => {
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

        await enqueueSync('from-airtable', 'all');
        await new Promise(r => setTimeout(r, 5000));
        const viewFiles = app.vault.getFiles().filter(
          f => f.path.startsWith(cfg.folderPath + '/') && f.extension === 'md'
        );
        const viewCount = viewFiles.length;

        // 4. Sync without view filter
        cfg.viewId = '';
        cfg.allowOverwrite = true;
        getInstance().updateSettings(cfg, cred);

        await enqueueSync('from-airtable', 'all');
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

    await test('from-airtable / current', async () => {
      const r = await run(`(async () => {
        ${HELPERS}
        const file = await openAndActivate(getConfig().folderPath + '/E2E-Pull-Test.md');
        try {
          await enqueueSync('from-airtable', 'current');
          await new Promise(r => setTimeout(r, 3000));
          const content = await app.vault.read(file);
          return JSON.stringify({ pass: content.includes('${testRecordIds[0]}') });
        } catch(e) {
          return JSON.stringify({ pass: false, detail: e.message });
        }
      })()`, 15000);
      return { pass: r.pass, detail: r.detail || 'ok' };
    });

    // -- Push tests --

    await test('to-airtable / all / obsidian-wins', async () => {
      await doReset();
      const r = await run(`(async () => {
        ${HELPERS}
        setMode('obsidian-wins');
        const file = app.vault.getAbstractFileByPath(getConfig().folderPath + '/E2E-Push-Test.md');
        await modifyCount(file, 555);
        await enqueueSync('to-airtable', 'all');
        await new Promise(r => setTimeout(r, 5000));
        const fields = await fetchRecord('${testRecordIds[1]}');
        setMode('manual');
        return JSON.stringify({ pass: fields.Count === 555, count: fields.Count });
      })()`, 25000);
      return { pass: r.pass, detail: `Count=${r.count}` };
    });

    await test('to-airtable / current / obsidian-wins', async () => {
      await doReset();
      const r = await run(`(async () => {
        ${HELPERS}
        setMode('obsidian-wins');
        const file = await openAndActivate(getConfig().folderPath + '/E2E-Bidir-Test.md');
        await modifyCount(file, 888);
        await enqueueSync('to-airtable', 'current');
        await new Promise(r => setTimeout(r, 5000));
        const fields = await fetchRecord('${testRecordIds[2]}');
        setMode('manual');
        return JSON.stringify({ pass: fields.Count === 888, count: fields.Count });
      })()`, 25000);
      return { pass: r.pass, detail: `Count=${r.count}` };
    });

    await test('to-airtable / all / airtable-wins', async () => {
      await doReset();
      const r = await run(`(async () => {
        ${HELPERS}
        setMode('airtable-wins');
        const file = app.vault.getAbstractFileByPath(getConfig().folderPath + '/E2E-Pull-Test.md');
        await modifyCount(file, 9999);
        await enqueueSync('to-airtable', 'all');
        await new Promise(r => setTimeout(r, 5000));
        const fields = await fetchRecord('${testRecordIds[0]}');
        setMode('manual');
        return JSON.stringify({ pass: fields.Count === 100, count: fields.Count });
      })()`, 25000);
      return { pass: r.pass, detail: `Count=${r.count} (expected 100)` };
    });

    await test('to-airtable / current / airtable-wins', async () => {
      await doReset();
      const r = await run(`(async () => {
        ${HELPERS}
        setMode('airtable-wins');
        const file = await openAndActivate(getConfig().folderPath + '/E2E-Push-Test.md');
        await modifyCount(file, 7777);
        await enqueueSync('to-airtable', 'current');
        await new Promise(r => setTimeout(r, 5000));
        const fields = await fetchRecord('${testRecordIds[1]}');
        setMode('manual');
        return JSON.stringify({ pass: fields.Count === 200, count: fields.Count });
      })()`, 25000);
      return { pass: r.pass, detail: `Count=${r.count} (expected 200)` };
    });

    await test('to-airtable / all / manual (conflict blocks)', async () => {
      await doReset();
      const r = await run(`(async () => {
        ${HELPERS}
        setMode('manual');
        const file = app.vault.getAbstractFileByPath(getConfig().folderPath + '/E2E-Push-Test.md');
        await modifyCount(file, 7777);
        await enqueueSync('to-airtable', 'all');
        await new Promise(r => setTimeout(r, 5000));
        const fields = await fetchRecord('${testRecordIds[1]}');
        return JSON.stringify({ pass: fields.Count === 200, count: fields.Count });
      })()`, 25000);
      return { pass: r.pass, detail: `Count=${r.count} (expected 200)` };
    });

    // -- Bidirectional tests --

    await test('bidirectional / all / autoSyncFormulas=true', async () => {
      await doReset();
      const r = await run(`(async () => {
        ${HELPERS}
        setMode('obsidian-wins', true);
        const file = app.vault.getAbstractFileByPath(getConfig().folderPath + '/E2E-Bidir-Test.md');
        await modifyCount(file, 450);
        await enqueueSync('bidirectional', 'all');
        await new Promise(r => setTimeout(r, 10000));
        const updated = await app.vault.read(file);
        const calMatch = updated.match(/Cal: (\\d+)/);
        const localCal = calMatch ? parseInt(calMatch[1]) : 0;
        const fields = await fetchRecord('${testRecordIds[2]}');
        setMode('manual', false);
        return JSON.stringify({ pass: localCal === 900 && fields.Cal === 900, localCal, airtableCal: fields.Cal });
      })()`, 30000);
      return { pass: r.pass, detail: `localCal=${r.localCal}, airtableCal=${r.airtableCal}` };
    });

    await test('bidirectional / all / autoSyncFormulas=false', async () => {
      await doReset();
      const r = await run(`(async () => {
        ${HELPERS}
        setMode('obsidian-wins', false);
        const file = app.vault.getAbstractFileByPath(getConfig().folderPath + '/E2E-Bidir-Test.md');
        const before = await app.vault.read(file);
        const oldCal = parseInt(before.match(/Cal: (\\d+)/)?.[1] || '0');
        await modifyCount(file, 333);
        await enqueueSync('bidirectional', 'all');
        await new Promise(r => setTimeout(r, 5000));
        const updated = await app.vault.read(file);
        const localCal = parseInt(updated.match(/Cal: (\\d+)/)?.[1] || '0');
        const fields = await fetchRecord('${testRecordIds[2]}');
        setMode('manual', false);
        return JSON.stringify({ pass: fields.Count === 333 && localCal === oldCal, localCal, oldCal, airtableCount: fields.Count });
      })()`, 25000);
      return { pass: r.pass, detail: `push=${r.airtableCount}, cal=${r.localCal}(unchanged from ${r.oldCal})` };
    });

    await test('bidirectional / current / autoSyncFormulas=true', async () => {
      await doReset();
      const r = await run(`(async () => {
        ${HELPERS}
        setMode('obsidian-wins', true);
        const file = await openAndActivate(getConfig().folderPath + '/E2E-Push-Test.md');
        await modifyCount(file, 123);
        await enqueueSync('bidirectional', 'current');
        await new Promise(r => setTimeout(r, 10000));
        const updated = await app.vault.read(file);
        const localCal = parseInt(updated.match(/Cal: (\\d+)/)?.[1] || '0');
        setMode('manual', false);
        return JSON.stringify({ pass: localCal === 246, localCal });
      })()`, 30000);
      return { pass: r.pass, detail: `Cal=${r.localCal} (expected 246)` };
    });

    await test('bidirectional / current / autoSyncFormulas=false', async () => {
      await doReset();
      const r = await run(`(async () => {
        ${HELPERS}
        setMode('obsidian-wins', false);
        const file = await openAndActivate(getConfig().folderPath + '/E2E-Push-Test.md');
        const before = await app.vault.read(file);
        const oldCal = parseInt(before.match(/Cal: (\\d+)/)?.[1] || '0');
        await modifyCount(file, 777);
        await enqueueSync('bidirectional', 'current');
        await new Promise(r => setTimeout(r, 5000));
        const updated = await app.vault.read(file);
        const localCal = parseInt(updated.match(/Cal: (\\d+)/)?.[1] || '0');
        const fields = await fetchRecord('${testRecordIds[1]}');
        setMode('manual', false);
        return JSON.stringify({ pass: fields.Count === 777 && localCal === oldCal, localCal, oldCal, airtableCount: fields.Count });
      })()`, 25000);
      return { pass: r.pass, detail: `push=${r.airtableCount}, cal=${r.localCal}(unchanged)` };
    });

    // -- Multi-Config tests --

    await test('multi-config / migration preserves settings', async () => {
      const r = await run(`(async () => {
        ${HELPERS}
        const p = getPlugin();
        const cfg = getConfig();
        const cred = getCredential();

        const hasVersion = p.settings.version === 2;
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
          autoSyncFormulas: false,
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
        await enqueueSync('from-airtable', 'all', cfg2);
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
    for (const r of results) {
      const icon = r.pass ? 'PASS' : 'FAIL';
      log(`${icon} | ${r.test}`);
      if (!r.pass) log(`       ${r.detail}`);
      if (r.pass) passCount++;
    }
    log(`\nTotal: ${passCount}/${results.length} passed`);

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
