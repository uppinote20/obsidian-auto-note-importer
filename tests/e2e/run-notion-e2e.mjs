/**
 * E2E Test Suite for Notion provider.
 *
 * Talks to a live Notion data source via the Notion REST API through Chrome
 * DevTools Protocol (CDP) — the same pattern as run-supabase-e2e.mjs.
 *
 * @covers src/services/notion-client.ts
 * @covers src/services/notion-field-mapper.ts
 * @covers src/services/notion-value-converter.ts
 * @covers src/services/notion-schema-cache.ts
 * @covers src/core/sync-orchestrator.ts
 *
 * Prerequisites:
 *   1. Obsidian running with --remote-debugging-port=9222
 *   2. The plugin built and installed in your test vault
 *   3. A `.env` file at the repo root with:
 *        NOTION_TOKEN=ntn_...
 *        NOTION_DATA_SOURCE_ID=<data source id>
 *      See tests/e2e/.env.example.
 *   4. A Notion data source shared with the integration, with this schema:
 *        Name      title
 *        Notes     rich_text
 *        Score     number
 *        Category  select
 *        Tags      multi_select
 *        Due       date
 *        Done      checkbox
 *        Link      url
 *        Doubled   formula  =  prop("Score") * 2
 *      The data source must already contain at least one row/page — this
 *      harness does not seed rows (unlike run-supabase-e2e.mjs). It reads
 *      and mutates whatever the integration can see, and asserts
 *      *relationships* (Doubled === 2 × Score) rather than fixed seed
 *      values, since the row's prior contents are arbitrary.
 *
 * Usage:
 *   node tests/e2e/run-notion-e2e.mjs              # leaves rows in place
 *   node tests/e2e/run-notion-e2e.mjs --cleanup    # also removes local config
 */

import { findPageTarget } from './cdp-helpers.mjs';
import { loadEnv } from './load-env.mjs';
import { buildSyncHarnessHelpers, buildConfigEntry, createTestHarness } from './obsidian-helpers.mjs';

loadEnv();

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const PLUGIN_ID = 'auto-note-importer';
const E2E_CRED_ID = 'e2e-notion-cred';
const E2E_CFG_ID = 'e2e-notion-cfg';

const ENV = {
  token: process.env.NOTION_TOKEN || '',
  dataSourceId: process.env.NOTION_DATA_SOURCE_ID || '',
  databaseId: process.env.NOTION_DATABASE_ID || '',
  folderPath: process.env.NOTION_FOLDER_PATH || 'NotionE2E',
};

if (!ENV.token || !ENV.dataSourceId) {
  console.error('Missing NOTION_TOKEN or NOTION_DATA_SOURCE_ID in .env (see tests/e2e/.env.example).');
  process.exit(2);
}

// ---------------------------------------------------------------------------
// Obsidian-side helpers (injected into eval expressions)
// ---------------------------------------------------------------------------

const HELPERS = buildSyncHarnessHelpers({ pluginId: PLUGIN_ID, e2eCfgId: E2E_CFG_ID }) + `
  function targetFolderFiles() {
    const cfg = getConfig();
    return app.vault.getFiles().filter(f =>
      f.path.startsWith(cfg.folderPath + '/') && f.extension === 'md'
    );
  }
`;

// ---------------------------------------------------------------------------
// Test runner
// ---------------------------------------------------------------------------

let targetId;
const { results, log, run, test } = createTestHarness({ getTargetId: () => targetId });

// The .md path exercised by the round-trip / read-only tests, discovered
// from the first pull rather than seeded — the data source's prior
// contents are arbitrary (see file header).
let targetNotePath = null;

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

async function setup() {
  log('=== Setup: Add Notion credential + config (idempotent) ===');
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
      name: 'E2E Notion',
      type: 'notion',
      integrationToken: ${JSON.stringify(ENV.token)},
    });

    p.settings.configs.push(${JSON.stringify(buildConfigEntry({
      id: E2E_CFG_ID,
      name: 'E2E Notion Cfg',
      credentialId: E2E_CRED_ID,
      tableId: ENV.dataSourceId,
      baseId: ENV.databaseId,
      folderPath: ENV.folderPath,
      filenameFieldName: 'Name',
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
}

async function doPullAll() {
  await run(`(async () => {
    ${HELPERS}
    setMode('manual', false);
    await enqueueSync('pull', 'all');
    await new Promise(r => setTimeout(r, 6000));
    return JSON.stringify({ ok: true });
  })()`, 25000);
}

async function cleanup() {
  log('\n=== Cleanup: Remove local files + e2e config (remote data left as the tests set it) ===');
  await run(`(async () => {
    ${HELPERS}
    const p = getPlugin();
    const cfg = getConfig();

    if (cfg) {
      const folder = cfg.folderPath;
      const files = app.vault.getFiles().filter(f => f.path.startsWith(folder + '/'));
      for (const f of files) await app.vault.delete(f);
      const folderEntry = app.vault.getAbstractFileByPath(folder);
      if (folderEntry) {
        try { await app.vault.delete(folderEntry, true); } catch {}
      }
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
  log('Cleaned up local files + e2e config. Remote Notion rows were not deleted — only the Score/Notes/Doubled fields the tests round-trip may have changed.');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

(async () => {
  try {
    targetId = await findPageTarget();
    log(`CDP target: ${targetId}`);

    await setup();
    await doPullAll();

    // ── Pull ─────────────────────────────────────────────────────────

    await test('pull / all creates .md files with primaryField + expected property keys', async () => {
      const r = await run(`(async () => {
        ${HELPERS}
        const files = targetFolderFiles();
        if (files.length === 0) return JSON.stringify({ count: 0 });
        const file = files[0];
        const fm = app.metadataCache.getFileCache(file)?.frontmatter || {};
        return JSON.stringify({
          count: files.length,
          path: file.path,
          basename: file.basename,
          primaryField: fm.primaryField || null,
          hasScore: 'Score' in fm,
          hasCategory: 'Category' in fm,
          hasDoubled: 'Doubled' in fm,
        });
      })()`, 15000);
      if (r.count > 0) targetNotePath = r.path;
      // primaryField is a Notion page id (uuid, dashed or not).
      const primaryFieldLooksLikeUuid = typeof r.primaryField === 'string'
        && /^[0-9a-f]{32}$|^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(r.primaryField);
      const pass = r.count > 0 && primaryFieldLooksLikeUuid && r.hasScore && r.hasCategory && r.hasDoubled;
      return {
        pass,
        detail: `count=${r.count} basename="${r.basename}" primaryField=${r.primaryField} hasScore=${r.hasScore} hasCategory=${r.hasCategory} hasDoubled=${r.hasDoubled}`,
      };
    });

    // ── Push + bidirectional round-trip ─────────────────────────────

    await test('push / round-trips Score + Notes; Doubled formula recomputes server-side', async () => {
      if (!targetNotePath) throw new Error('No target note discovered by the pull test — cannot continue.');
      const r = await run(`(async () => {
        ${HELPERS}
        setMode('obsidian-wins');
        const file = app.vault.getAbstractFileByPath(${JSON.stringify(targetNotePath)});
        if (!file) return JSON.stringify({ noFile: true });
        await modifyField(file, 'Score', 4242);
        await modifyField(file, 'Notes', 'e2e round-trip ' + Date.now());
        await enqueueSync('push', 'all');
        await new Promise(r => setTimeout(r, 6000));
        await enqueueSync('pull', 'all');
        await new Promise(r => setTimeout(r, 6000));
        setMode('manual');
        const fm = app.metadataCache.getFileCache(file)?.frontmatter || {};
        return JSON.stringify({ score: fm.Score, doubled: fm.Doubled, notes: fm.Notes });
      })()`, 35000);
      if (r.noFile) return { pass: false, detail: 'target note not found' };
      const pass = r.score === 4242 && r.doubled === 8484;
      return { pass, detail: `score=${r.score} doubled=${r.doubled} notes="${r.notes}" (expected score=4242 doubled=8484)` };
    });

    // ── Read-only / object-shaped protection ─────────────────────────

    await test('push / local edit to Doubled (formula) is not pushed — recomputes from Score, not the forged value', async () => {
      if (!targetNotePath) throw new Error('No target note discovered by the pull test — cannot continue.');
      const r = await run(`(async () => {
        ${HELPERS}
        setMode('obsidian-wins');
        const file = app.vault.getAbstractFileByPath(${JSON.stringify(targetNotePath)});
        if (!file) return JSON.stringify({ noFile: true });
        const beforeFm = app.metadataCache.getFileCache(file)?.frontmatter || {};
        const score = beforeFm.Score;
        await modifyField(file, 'Doubled', 999999);
        await enqueueSync('push', 'all');
        await new Promise(r => setTimeout(r, 6000));
        await enqueueSync('pull', 'all');
        await new Promise(r => setTimeout(r, 6000));
        setMode('manual');
        const afterFm = app.metadataCache.getFileCache(file)?.frontmatter || {};
        return JSON.stringify({ score, doubledAfter: afterFm.Doubled });
      })()`, 35000);
      if (r.noFile) return { pass: false, detail: 'target note not found' };
      const expectedDoubled = r.score * 2;
      const pass = r.doubledAfter === expectedDoubled && r.doubledAfter !== 999999;
      return { pass, detail: `score=${r.score} doubledAfter=${r.doubledAfter} (expected ${expectedDoubled}, not 999999)` };
    });

    // ── Summary ─────────────────────────────────────────────────────

    log('\n========================================');
    log('     Notion E2E TEST SUMMARY');
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
      log('\nLocal config left in place. Run with --cleanup to remove it.');
    }

    process.exit(passCount === results.length ? 0 : 1);
  } catch (e) {
    console.error('FATAL:', e.message);
    process.exit(1);
  }
})();
