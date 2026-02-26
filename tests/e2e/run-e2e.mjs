/**
 * E2E Test Suite for Auto Note Importer
 *
 * Runs against a live Obsidian instance via Chrome DevTools Protocol (CDP).
 *
 * Prerequisites:
 *   1. Obsidian running with --remote-debugging-port=9222
 *      /Applications/Obsidian.app/Contents/MacOS/Obsidian --remote-debugging-port=9222
 *   2. A vault with the plugin installed and configured (Airtable PAT, base, table)
 *   3. The Airtable table must have: Name (text), Count (number), Status (select), Cal (formula: Count*2)
 *
 * Usage:
 *   node tests/e2e/run-e2e.mjs                          # auto-detect CDP target
 *   node tests/e2e/run-e2e.mjs --cleanup                # run tests then delete test records
 *   CDP_TARGET_ID=<id> node tests/e2e/run-e2e.mjs       # specify CDP page target
 */

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const CDP_PORT = process.env.CDP_PORT || 9222;
const PLUGIN_ID = 'auto-note-importer';

// Test records created during setup — deleted during cleanup
let testRecordIds = [];

// ---------------------------------------------------------------------------
// CDP helpers
// ---------------------------------------------------------------------------

async function findPageTarget() {
  const override = process.env.CDP_TARGET_ID;
  if (override) return override;

  const resp = await fetch(`http://localhost:${CDP_PORT}/json/list`);
  const targets = await resp.json();
  const page = targets.find(t => t.type === 'page' && t.url.includes('obsidian'));
  if (!page) throw new Error('No Obsidian page target found. Is Obsidian running with --remote-debugging-port?');
  return page.id;
}

function evalInObsidian(targetId, expression, timeout = 20000) {
  const wsUrl = `ws://localhost:${CDP_PORT}/devtools/page/${targetId}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout (${timeout}ms)`)), timeout);
    const ws = new WebSocket(wsUrl);
    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({
        id: 1,
        method: 'Runtime.evaluate',
        params: { expression, awaitPromise: true, returnByValue: true }
      }));
    });
    ws.addEventListener('message', (e) => {
      const result = JSON.parse(e.data);
      if (result.id === 1) {
        clearTimeout(timer);
        if (result.result?.exceptionDetails) {
          resolve({ __error: result.result.exceptionDetails.exception?.description || 'Unknown error' });
        } else {
          try { resolve(JSON.parse(result.result.result.value)); }
          catch { resolve(result.result.result.value); }
        }
        ws.close();
      }
    });
    ws.addEventListener('error', (err) => { clearTimeout(timer); reject(err); });
  });
}

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

  function setMode(mode, autoFormula) {
    const p = app.plugins.plugins['${PLUGIN_ID}'];
    p.settings.conflictResolution = mode;
    if (autoFormula !== undefined) p.settings.autoSyncFormulas = autoFormula;
    p.conflictResolver.updateSettings(p.settings);
  }

  async function fetchRecord(recordId) {
    const p = app.plugins.plugins['${PLUGIN_ID}'];
    const base = p.settings.baseId;
    const table = p.settings.tableId;
    const resp = await fetch(
      'https://api.airtable.com/v0/' + base + '/' + table + '/' + recordId,
      { headers: { 'Authorization': 'Bearer ' + p.settings.apiKey } }
    );
    return (await resp.json()).fields;
  }

  function getPlugin() { return app.plugins.plugins['${PLUGIN_ID}']; }
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
    const p = app.plugins.plugins['${PLUGIN_ID}'];
    const base = p.settings.baseId;
    const table = p.settings.tableId;
    const resp = await fetch('https://api.airtable.com/v0/' + base + '/' + table, {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + p.settings.apiKey, 'Content-Type': 'application/json' },
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

async function resetAll() {
  await run(`(async () => {
    ${HELPERS}
    const p = getPlugin();
    const base = p.settings.baseId;
    const table = p.settings.tableId;
    await fetch('https://api.airtable.com/v0/' + base + '/' + table, {
      method: 'PATCH',
      headers: { 'Authorization': 'Bearer ' + p.settings.apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ records: [
        { id: '${() => testRecordIds[0]}', fields: { Name: 'E2E-Pull-Test', Count: 100, Status: 'Todo' } },
        { id: '${() => testRecordIds[1]}', fields: { Name: 'E2E-Push-Test', Count: 200, Status: 'In progress' } },
        { id: '${() => testRecordIds[2]}', fields: { Name: 'E2E-Bidir-Test', Count: 300, Status: 'Done' } }
      ]})
    });
    setMode('manual', false);
    await getPlugin().syncQueue.enqueue('from-airtable', 'all');
    await new Promise(r => setTimeout(r, 5000));
    return '"reset"';
  })()`.replaceAll("${() => testRecordIds[0]}", testRecordIds[0])
      .replaceAll("${() => testRecordIds[1]}", testRecordIds[1])
      .replaceAll("${() => testRecordIds[2]}", testRecordIds[2]),
  20000);
}

function resetExpr() {
  // Build a reset expression using current testRecordIds
  return `(async () => {
    ${HELPERS}
    const p = getPlugin();
    const base = p.settings.baseId;
    const table = p.settings.tableId;
    await fetch('https://api.airtable.com/v0/' + base + '/' + table, {
      method: 'PATCH',
      headers: { 'Authorization': 'Bearer ' + p.settings.apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ records: [
        { id: '${testRecordIds[0]}', fields: { Name: 'E2E-Pull-Test', Count: 100, Status: 'Todo' } },
        { id: '${testRecordIds[1]}', fields: { Name: 'E2E-Push-Test', Count: 200, Status: 'In progress' } },
        { id: '${testRecordIds[2]}', fields: { Name: 'E2E-Bidir-Test', Count: 300, Status: 'Done' } }
      ]})
    });
    setMode('manual', false);
    await getPlugin().syncQueue.enqueue('from-airtable', 'all');
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
    const p = app.plugins.plugins['${PLUGIN_ID}'];
    const base = p.settings.baseId;
    const table = p.settings.tableId;
    const ids = ${JSON.stringify(testRecordIds)};

    // Delete from Airtable
    const params = ids.map(id => 'records[]=' + id).join('&');
    await fetch('https://api.airtable.com/v0/' + base + '/' + table + '?' + params, {
      method: 'DELETE',
      headers: { 'Authorization': 'Bearer ' + p.settings.apiKey }
    });

    // Delete local files
    for (const name of ['E2E-Pull-Test.md', 'E2E-Push-Test.md', 'E2E-Bidir-Test.md']) {
      const file = app.vault.getAbstractFileByPath(p.settings.folderPath + '/' + name);
      if (file) await app.vault.delete(file);
    }
    return '"cleaned"';
  })()`, 15000);
  log('Test records and files cleaned up');
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
        await getPlugin().syncQueue.enqueue('from-airtable', 'all');
        await new Promise(r => setTimeout(r, 5000));
        const files = app.vault.getFiles().filter(f => f.path.startsWith(getPlugin().settings.folderPath + '/'));
        return JSON.stringify({ fileCount: files.length });
      })()`, 15000);
      return { pass: r.fileCount >= 8, detail: `${r.fileCount} files` };
    });

    await test('from-airtable / current', async () => {
      const r = await run(`(async () => {
        ${HELPERS}
        const file = await openAndActivate(getPlugin().settings.folderPath + '/E2E-Pull-Test.md');
        try {
          await getPlugin().syncQueue.enqueue('from-airtable', 'current');
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
        const file = app.vault.getAbstractFileByPath(getPlugin().settings.folderPath + '/E2E-Push-Test.md');
        await modifyCount(file, 555);
        await getPlugin().syncQueue.enqueue('to-airtable', 'all');
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
        const file = await openAndActivate(getPlugin().settings.folderPath + '/E2E-Bidir-Test.md');
        await modifyCount(file, 888);
        await getPlugin().syncQueue.enqueue('to-airtable', 'current');
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
        const file = app.vault.getAbstractFileByPath(getPlugin().settings.folderPath + '/E2E-Pull-Test.md');
        await modifyCount(file, 9999);
        await getPlugin().syncQueue.enqueue('to-airtable', 'all');
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
        const file = await openAndActivate(getPlugin().settings.folderPath + '/E2E-Push-Test.md');
        await modifyCount(file, 7777);
        await getPlugin().syncQueue.enqueue('to-airtable', 'current');
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
        const file = app.vault.getAbstractFileByPath(getPlugin().settings.folderPath + '/E2E-Push-Test.md');
        await modifyCount(file, 7777);
        await getPlugin().syncQueue.enqueue('to-airtable', 'all');
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
        const file = app.vault.getAbstractFileByPath(getPlugin().settings.folderPath + '/E2E-Bidir-Test.md');
        await modifyCount(file, 450);
        await getPlugin().syncQueue.enqueue('bidirectional', 'all');
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
        const file = app.vault.getAbstractFileByPath(getPlugin().settings.folderPath + '/E2E-Bidir-Test.md');
        const before = await app.vault.read(file);
        const oldCal = parseInt(before.match(/Cal: (\\d+)/)?.[1] || '0');
        await modifyCount(file, 333);
        await getPlugin().syncQueue.enqueue('bidirectional', 'all');
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
        const file = await openAndActivate(getPlugin().settings.folderPath + '/E2E-Push-Test.md');
        await modifyCount(file, 123);
        await getPlugin().syncQueue.enqueue('bidirectional', 'current');
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
        const file = await openAndActivate(getPlugin().settings.folderPath + '/E2E-Push-Test.md');
        const before = await app.vault.read(file);
        const oldCal = parseInt(before.match(/Cal: (\\d+)/)?.[1] || '0');
        await modifyCount(file, 777);
        await getPlugin().syncQueue.enqueue('bidirectional', 'current');
        await new Promise(r => setTimeout(r, 5000));
        const updated = await app.vault.read(file);
        const localCal = parseInt(updated.match(/Cal: (\\d+)/)?.[1] || '0');
        const fields = await fetchRecord('${testRecordIds[1]}');
        setMode('manual', false);
        return JSON.stringify({ pass: fields.Count === 777 && localCal === oldCal, localCal, oldCal, airtableCount: fields.Count });
      })()`, 25000);
      return { pass: r.pass, detail: `push=${r.airtableCount}, cal=${r.localCal}(unchanged)` };
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
    } else {
      log('\nTest records left in Airtable. Run with --cleanup to remove them.');
    }

    process.exit(passCount === results.length ? 0 : 1);

  } catch (e) {
    console.error('FATAL:', e.message);
    process.exit(1);
  }
})();
