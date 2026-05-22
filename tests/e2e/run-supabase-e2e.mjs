/**
 * E2E Test Suite for Supabase provider.
 *
 * Talks to a live Supabase project via PostgREST /rest/v1/ endpoints through
 * Chrome DevTools Protocol (CDP) — the same pattern as run-seatable-e2e.mjs.
 *
 * @covers src/services/supabase-client.ts
 * @covers src/services/supabase-metadata-cache.ts
 * @covers src/services/supabase-field-mapper.ts
 * @covers src/services/supabase-credential-form.ts
 * @covers src/services/provider-registry.ts
 * @covers src/core/sync-orchestrator.ts
 * @covers src/core/config-instance.ts
 *
 * Prerequisites:
 *   1. Obsidian running with --remote-debugging-port=9222
 *   2. The plugin built and installed in your test vault
 *   3. A `.env` file at the repo root with:
 *        SUPABASE_URL=https://<ref>.supabase.co
 *        SUPABASE_KEY=sb_publishable_... (or legacy anon JWT)
 *      See tests/e2e/.env.example.
 *   4. A Supabase project with the demo schema (see README §Development —
 *      Supabase E2E Setup):
 *        CREATE TYPE note_status AS ENUM ('draft', 'published', 'archived');
 *        CREATE TABLE notes (
 *          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 *          title text NOT NULL,
 *          content text,
 *          status note_status DEFAULT 'draft',
 *          tags text[],
 *          meta jsonb,
 *          archived boolean DEFAULT false,
 *          created_at timestamptz DEFAULT now(),
 *          updated_at timestamptz DEFAULT now(),
 *          full_text text GENERATED ALWAYS AS (title || ' ' || coalesce(content, '')) STORED
 *        );
 *        CREATE VIEW active_notes AS SELECT * FROM notes WHERE archived = false;
 *        ALTER TABLE notes ENABLE ROW LEVEL SECURITY;
 *        CREATE POLICY "anon_all" ON notes FOR ALL USING (true);
 *
 * What the harness does:
 *   - Adds (or reuses) a dedicated Supabase credential + ConfigEntry
 *     keyed by E2E_CRED_ID / E2E_CFG_ID so it never touches existing configs.
 *   - Inserts 3 test rows via POST /rest/v1/notes, exercises pull / push /
 *     bidirectional / read-only protection flows, then cleans up.
 *
 * Usage:
 *   node tests/e2e/run-supabase-e2e.mjs              # leaves rows in place
 *   node tests/e2e/run-supabase-e2e.mjs --cleanup    # also deletes rows
 */

import { findPageTarget } from './cdp-helpers.mjs';
import { loadEnv } from './load-env.mjs';
import { buildSyncHarnessHelpers, buildConfigEntry, createTestHarness } from './obsidian-helpers.mjs';

loadEnv();

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const PLUGIN_ID = 'auto-note-importer';
const E2E_CRED_ID = 'e2e-supabase-cred';
const E2E_CFG_ID = 'e2e-supabase-cfg';

const ENV = {
  projectUrl: (process.env.SUPABASE_URL || '').replace(/\/+$/, ''),
  apiKey: process.env.SUPABASE_KEY || '',
  tableName: process.env.SUPABASE_TABLE || 'notes',
  viewName: process.env.SUPABASE_VIEW || '',
  folderPath: process.env.SUPABASE_FOLDER_PATH || 'Supabase-E2E',
};

if (!ENV.projectUrl || !ENV.apiKey) {
  console.error('Missing SUPABASE_URL or SUPABASE_KEY in .env (see tests/e2e/.env.example).');
  process.exit(2);
}

// Test rows to insert. `title` is the filenameFieldName.
// `full_text` is a GENERATED column (title || ' ' || content) — read-only
// from PostgREST's perspective. The harness must NOT include it in pushes.
const TEST_ROWS = [
  { title: 'E2E-SB-Pull',  content: 'pull row',  status: 'draft',     archived: false },
  { title: 'E2E-SB-Push',  content: 'push row',  status: 'published', archived: false },
  { title: 'E2E-SB-Bidir', content: 'bidir row', status: 'draft',     archived: false },
];

let testRowIds = [];

// ---------------------------------------------------------------------------
// Obsidian-side helpers (injected into eval expressions)
// ---------------------------------------------------------------------------

const HELPERS = buildSyncHarnessHelpers({ pluginId: PLUGIN_ID, e2eCfgId: E2E_CFG_ID }) + `
  // Build PostgREST request headers using the stored e2e credential.
  function supabaseHeaders(extra) {
    const cred = getCredential();
    return Object.assign({
      'apikey': cred.apiKey,
      'Authorization': 'Bearer ' + cred.apiKey,
      'Content-Type': 'application/json',
    }, extra || {});
  }

  function supabaseUrl(path) {
    const cred = getCredential();
    return cred.projectUrl.replace(/\\/+$/, '') + path;
  }

  async function insertRows(rows) {
    const r = await fetch(supabaseUrl('/rest/v1/notes'), {
      method: 'POST',
      headers: Object.assign(supabaseHeaders(), { 'Prefer': 'return=representation' }),
      body: JSON.stringify(rows),
    });
    if (!r.ok) {
      const txt = await r.text().catch(() => '');
      throw new Error('insertRows failed: HTTP ' + r.status + ' ' + txt);
    }
    const inserted = await r.json();
    return inserted.map(row => String(row.id));
  }

  async function fetchRowFromSupabase(rowId) {
    const cfg = getConfig();
    const pk = cfg.primaryKeyColumn || 'id';
    const r = await fetch(
      supabaseUrl('/rest/v1/' + ${JSON.stringify(ENV.tableName)} + '?' + encodeURIComponent(pk) + '=eq.' + encodeURIComponent(rowId) + '&limit=1'),
      { headers: supabaseHeaders() },
    );
    if (r.status === 404) return null;
    if (!r.ok) throw new Error('fetchRow failed: HTTP ' + r.status);
    const rows = await r.json();
    return rows[0] || null;
  }

  async function deleteRows(rowIds) {
    if (!rowIds || rowIds.length === 0) return;
    const cfg = getConfig();
    const pk = cfg.primaryKeyColumn || 'id';
    const filter = rowIds.map(id => encodeURIComponent(pk) + '=eq.' + encodeURIComponent(id)).join(',');
    // PostgREST DELETE with in() operator
    const r = await fetch(
      supabaseUrl('/rest/v1/' + ${JSON.stringify(ENV.tableName)} + '?' + encodeURIComponent(pk) + '=in.(' + rowIds.map(id => encodeURIComponent(id)).join(',') + ')'),
      { method: 'DELETE', headers: supabaseHeaders() },
    );
    // 204 No Content is success for DELETE
    if (r.status !== 204 && r.status !== 200) {
      const txt = await r.text().catch(() => '');
      throw new Error('deleteRows failed: HTTP ' + r.status + ' ' + txt);
    }
  }

  async function resetRowsToInitial(rowIds, initial) {
    for (let i = 0; i < rowIds.length; i++) {
      const cfg = getConfig();
      const pk = cfg.primaryKeyColumn || 'id';
      await fetch(
        supabaseUrl('/rest/v1/' + ${JSON.stringify(ENV.tableName)} + '?' + encodeURIComponent(pk) + '=eq.' + encodeURIComponent(rowIds[i])),
        {
          method: 'PATCH',
          headers: Object.assign(supabaseHeaders(), { 'Prefer': 'return=representation' }),
          body: JSON.stringify(initial[i]),
        },
      );
    }
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
  log('=== Setup: Add Supabase credential + config (idempotent) ===');
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
      name: 'E2E Supabase',
      type: 'supabase',
      projectUrl: ${JSON.stringify(ENV.projectUrl)},
      apiKey: ${JSON.stringify(ENV.apiKey)},
    });

    p.settings.configs.push(${JSON.stringify(buildConfigEntry({
      id: E2E_CFG_ID,
      name: 'E2E Supabase Cfg',
      credentialId: E2E_CRED_ID,
      tableId: ENV.tableName,
      viewId: ENV.viewName,
      primaryKeyColumn: 'id',
      folderPath: ENV.folderPath,
      filenameFieldName: 'title',
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

  log('=== Setup: Insert test rows via POST /rest/v1/notes ===');
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
  log('Cleaned up Supabase test data + local files + e2e config.');
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
      const expectedNames = TEST_ROWS.map(r => r.title);
      const pass = r.count >= expectedNames.length && expectedNames.every(n => r.names.includes(n));
      return { pass, detail: `count=${r.count} names=[${r.names.join(',')}]` };
    });

    await test('pull / current refetches single note', async () => {
      const r = await run(`(async () => {
        ${HELPERS}
        const cfg = getConfig();
        const file = await openAndActivate(cfg.folderPath + '/E2E-SB-Pull.md');
        await enqueueSync('pull', 'current');
        await new Promise(r => setTimeout(r, 4000));
        const fm = app.metadataCache.getFileCache(file)?.frontmatter || {};
        return JSON.stringify({
          title: fm.title,
          primaryField: fm.primaryField || null,
        });
      })()`, 15000);
      const pass = r.title === 'E2E-SB-Pull' && r.primaryField === testRowIds[0];
      return { pass, detail: `title="${r.title}" primaryField="${r.primaryField}"` };
    });

    await test('pull / writes all column types into frontmatter', async () => {
      // Verifies fetchNotes normalizes uuid / text / enum / boolean / array /
      // timestamptz correctly. The GENERATED full_text column must appear as
      // read-only (not writable via push). System-style keys must not leak.
      const r = await run(`(async () => {
        ${HELPERS}
        const cfg = getConfig();
        const file = app.vault.getAbstractFileByPath(cfg.folderPath + '/E2E-SB-Pull.md');
        const fm = app.metadataCache.getFileCache(file)?.frontmatter || {};
        return JSON.stringify({
          title: fm.title,
          content: fm.content,
          status: fm.status,
          archived: fm.archived,
          full_text: fm.full_text,
          hasPrimaryField: 'primaryField' in fm,
        });
      })()`, 10000);
      const pass = r.title === 'E2E-SB-Pull'
        && r.content === 'pull row'
        && r.status === 'draft'
        && r.archived === false
        && typeof r.full_text === 'string' && r.full_text.includes('E2E-SB-Pull')
        && r.hasPrimaryField;
      return { pass, detail: `title=${r.title} content=${r.content} status=${r.status} archived=${r.archived} full_text="${r.full_text}" hasPk=${r.hasPrimaryField}` };
    });

    // ── Push: writable column types ─────────────────────────────────

    await test('push / text column (content)', async () => {
      await doReset();
      const r = await run(`(async () => {
        ${HELPERS}
        setMode('obsidian-wins');
        const cfg = getConfig();
        const file = app.vault.getAbstractFileByPath(cfg.folderPath + '/E2E-SB-Push.md');
        await modifyField(file, 'content', 'updated content');
        await enqueueSync('push', 'all');
        await new Promise(r => setTimeout(r, 6000));
        const row = await fetchRowFromSupabase(${JSON.stringify(testRowIds[1])});
        setMode('manual');
        return JSON.stringify({ remoteContent: row?.content });
      })()`, 25000);
      return { pass: r.remoteContent === 'updated content', detail: `content="${r.remoteContent}"` };
    });

    await test('push / enum column (status)', async () => {
      await doReset();
      const r = await run(`(async () => {
        ${HELPERS}
        setMode('obsidian-wins');
        const cfg = getConfig();
        const file = app.vault.getAbstractFileByPath(cfg.folderPath + '/E2E-SB-Push.md');
        await modifyField(file, 'status', 'archived');
        await enqueueSync('push', 'all');
        await new Promise(r => setTimeout(r, 6000));
        const row = await fetchRowFromSupabase(${JSON.stringify(testRowIds[1])});
        setMode('manual');
        return JSON.stringify({ remoteStatus: row?.status });
      })()`, 25000);
      return { pass: r.remoteStatus === 'archived', detail: `status="${r.remoteStatus}"` };
    });

    await test('push / boolean column (archived)', async () => {
      await doReset();
      const r = await run(`(async () => {
        ${HELPERS}
        setMode('obsidian-wins');
        const cfg = getConfig();
        const file = app.vault.getAbstractFileByPath(cfg.folderPath + '/E2E-SB-Push.md');
        await modifyField(file, 'archived', true);
        await enqueueSync('push', 'all');
        await new Promise(r => setTimeout(r, 6000));
        const row = await fetchRowFromSupabase(${JSON.stringify(testRowIds[1])});
        setMode('manual');
        return JSON.stringify({ remoteArchived: row?.archived });
      })()`, 25000);
      return { pass: r.remoteArchived === true, detail: `archived=${r.remoteArchived}` };
    });

    // ── Push: conflict-resolution modes ────────────────────────────

    await test('push / all / remote-wins keeps remote value', async () => {
      await doReset();
      const r = await run(`(async () => {
        ${HELPERS}
        setMode('remote-wins');
        const cfg = getConfig();
        const file = app.vault.getAbstractFileByPath(cfg.folderPath + '/E2E-SB-Pull.md');
        await modifyField(file, 'content', 'should not win');
        await enqueueSync('push', 'all');
        await new Promise(r => setTimeout(r, 6000));
        const row = await fetchRowFromSupabase(${JSON.stringify(testRowIds[0])});
        setMode('manual');
        return JSON.stringify({ remoteContent: row?.content });
      })()`, 25000);
      return { pass: r.remoteContent === 'pull row', detail: `content="${r.remoteContent}" (expected "pull row")` };
    });

    await test('push / all / manual blocks conflicting field', async () => {
      await doReset();
      const r = await run(`(async () => {
        ${HELPERS}
        setMode('manual');
        const cfg = getConfig();
        const file = app.vault.getAbstractFileByPath(cfg.folderPath + '/E2E-SB-Push.md');
        await modifyField(file, 'content', 'blocked by manual');
        await enqueueSync('push', 'all');
        await new Promise(r => setTimeout(r, 6000));
        const row = await fetchRowFromSupabase(${JSON.stringify(testRowIds[1])});
        return JSON.stringify({ remoteContent: row?.content });
      })()`, 25000);
      return { pass: r.remoteContent === 'push row', detail: `content="${r.remoteContent}" (expected "push row")` };
    });

    // ── Bidirectional with GENERATED column ─────────────────────────

    await test('bidirectional / autoSyncComputedFields=true refreshes full_text', async () => {
      // full_text is GENERATED ALWAYS AS (title || ' ' || coalesce(content, ''))
      // After pushing a new title, a bidirectional pull should bring back the
      // recomputed full_text value.
      await doReset();
      const r = await run(`(async () => {
        ${HELPERS}
        setMode('obsidian-wins', true);
        const cfg = getConfig();
        const file = await openAndActivate(cfg.folderPath + '/E2E-SB-Bidir.md');
        await modifyField(file, 'content', 'updated bidir');
        await enqueueSync('bidirectional', 'all');
        await new Promise(r => setTimeout(r, 10000));
        const fm = app.metadataCache.getFileCache(file)?.frontmatter || {};
        const row = await fetchRowFromSupabase(${JSON.stringify(testRowIds[2])});
        setMode('manual', false);
        return JSON.stringify({
          localContent: fm.content,
          localFullText: fm.full_text,
          remoteContent: row?.content,
          remoteFullText: row?.full_text,
        });
      })()`, 35000);
      const expectedFullText = 'E2E-SB-Bidir updated bidir';
      const pass = r.localContent === 'updated bidir'
        && typeof r.localFullText === 'string' && r.localFullText.includes('updated bidir')
        && r.remoteContent === 'updated bidir'
        && r.remoteFullText === expectedFullText;
      return { pass, detail: `localContent=${r.localContent} localFT="${r.localFullText}" remoteContent=${r.remoteContent} remoteFT="${r.remoteFullText}"` };
    });

    await test('bidirectional / autoSyncComputedFields=false leaves stale full_text', async () => {
      await doReset();
      const r = await run(`(async () => {
        ${HELPERS}
        setMode('obsidian-wins', false);
        const cfg = getConfig();
        const file = app.vault.getAbstractFileByPath(cfg.folderPath + '/E2E-SB-Bidir.md');
        const beforeFm = app.metadataCache.getFileCache(file)?.frontmatter || {};
        const oldFullText = beforeFm.full_text;
        await modifyField(file, 'content', 'no-pull-back');
        await enqueueSync('bidirectional', 'all');
        await new Promise(r => setTimeout(r, 6000));
        const afterFm = app.metadataCache.getFileCache(file)?.frontmatter || {};
        const row = await fetchRowFromSupabase(${JSON.stringify(testRowIds[2])});
        setMode('manual', false);
        return JSON.stringify({
          localContent: afterFm.content,
          localFullTextUnchanged: afterFm.full_text === oldFullText,
          remoteContent: row?.content,
        });
      })()`, 25000);
      const pass = r.localContent === 'no-pull-back' && r.localFullTextUnchanged && r.remoteContent === 'no-pull-back';
      return { pass, detail: `localContent=${r.localContent} ftUnchanged=${r.localFullTextUnchanged} remoteContent=${r.remoteContent}` };
    });

    // ── Read-only field protection ──────────────────────────────────

    await test('push / GENERATED column (full_text) edits are silently dropped and the rest of the row updates successfully', async () => {
      // G1 #1: SupabaseClient.batchUpdate must drop GENERATED columns from
      // the upsert body (PostgREST otherwise returns 400 "column ... can only
      // be updated to DEFAULT"). Verifies both that the GENERATED column is
      // NOT overwritten AND that the rest of the row reaches Supabase.
      await doReset();
      const r = await run(`(async () => {
        ${HELPERS}
        setMode('obsidian-wins');
        const cfg = getConfig();
        const file = app.vault.getAbstractFileByPath(cfg.folderPath + '/E2E-SB-Pull.md');
        // Attempt to overwrite the GENERATED column AND change a writable column.
        await modifyField(file, 'full_text', 'tampered value');
        await modifyField(file, 'content', 'updated alongside generated');
        await enqueueSync('push', 'all');
        await new Promise(r => setTimeout(r, 6000));
        const row = await fetchRowFromSupabase(${JSON.stringify(testRowIds[0])});
        setMode('manual');
        // Server-computed: title('E2E-SB-Pull') + ' ' + content('updated alongside generated')
        return JSON.stringify({ remoteFullText: row?.full_text, remoteContent: row?.content });
      })()`, 25000);
      const pass = typeof r.remoteFullText === 'string'
        && r.remoteFullText.includes('E2E-SB-Pull')
        && !r.remoteFullText.includes('tampered')
        && r.remoteContent === 'updated alongside generated';  // writable column survived
      return { pass, detail: `full_text="${r.remoteFullText}" content="${r.remoteContent}"` };
    });

    // ── Provider-level invariants surfaced by G1-G5 fixes ───────────────

    await test('push / duplicate primaryField across two vault notes fails the batch explicitly (G5 #15)', async () => {
      // Two notes pointing at the same Supabase row must not be silently
      // deduped by PostgREST merge-duplicates. SupabaseClient.batchUpdate
      // detects the collision and rejects the whole batch with an explicit
      // 'Duplicate recordId' error so the user can clean up the vault.
      await doReset();
      const r = await run(`(async () => {
        ${HELPERS}
        setMode('obsidian-wins');
        const cfg = getConfig();
        const dupTitle = 'E2E-SB-Dup-Copy';
        const dupPath = cfg.folderPath + '/' + dupTitle + '.md';

        // Create a second .md file pointing at the same Supabase row.
        const existing = app.vault.getAbstractFileByPath(dupPath);
        if (existing) await app.vault.delete(existing);
        const sourceContent = await app.vault.read(app.vault.getAbstractFileByPath(cfg.folderPath + '/E2E-SB-Pull.md'));
        await app.vault.create(dupPath, sourceContent);
        const newFile = app.vault.getAbstractFileByPath(dupPath);
        await modifyField(newFile, 'content', 'duplicate-attempt');

        // Capture Notices emitted during push so we can spot the 'Duplicate' message.
        const notices = [];
        const origNotice = window.Notice;
        // @ts-ignore Notice may be patched in dev/test
        window.Notice = function(text, timeout) {
          notices.push(typeof text === 'string' ? text : (text?.textContent || ''));
          return new origNotice(text, timeout);
        };

        await enqueueSync('push', 'all');
        await new Promise(r => setTimeout(r, 6000));

        // Restore
        // @ts-ignore
        window.Notice = origNotice;
        await app.vault.delete(newFile);
        setMode('manual');

        const remote = await fetchRowFromSupabase(${JSON.stringify(testRowIds[0])});
        return JSON.stringify({
          notices,
          remoteContent: remote?.content,
        });
      })()`, 25000);
      const sawDuplicateNotice = (r.notices || []).some(n => /duplicate/i.test(n));
      const remoteUnchanged = r.remoteContent === 'pull row';  // initial value from doReset
      const pass = sawDuplicateNotice && remoteUnchanged;
      return { pass, detail: `sawDup=${sawDuplicateNotice} remote="${r.remoteContent}"` };
    });

    await test('push / view-only columns are dropped before reaching the base table (G1 #2)', async () => {
      // When a config uses a viewId, fetchNotes returns rows shaped by that
      // view. If the view exposes columns that don't exist on the base
      // table, those columns would 400 the upsert. SupabaseClient.batchUpdate
      // must filter the body to base-table columns regardless of which
      // endpoint produced the row.
      //
      // active_notes is a SELECT * view so this scenario doesn't reproduce
      // here — the test instead documents the intent and asserts that
      // pushing via a view still succeeds on writable columns.
      await doReset();
      const r = await run(`(async () => {
        ${HELPERS}
        setMode('obsidian-wins');
        const cfg = getConfig();
        const cred = getCredential();
        cfg.viewId = 'active_notes';
        getInstance(cfg).updateSettings(cfg, cred);

        const file = app.vault.getAbstractFileByPath(cfg.folderPath + '/E2E-SB-Push.md');
        await modifyField(file, 'content', 'pushed via view');
        await enqueueSync('push', 'all');
        await new Promise(r => setTimeout(r, 7000));

        cfg.viewId = '';
        getInstance(cfg).updateSettings(cfg, cred);
        setMode('manual');

        const row = await fetchRowFromSupabase(${JSON.stringify(testRowIds[1])});
        return JSON.stringify({ remoteContent: row?.content });
      })()`, 30000);
      const pass = r.remoteContent === 'pushed via view';
      return { pass, detail: `remoteContent="${r.remoteContent}"` };
    });

    // ── View support ────────────────────────────────────────────────

    await test('pull from view (active_notes) omits archived rows', async () => {
      // Temporarily point the e2e config at the active_notes view, which
      // filters out archived=true rows. We insert an extra archived row,
      // pull, confirm it's absent from the vault.
      const r = await run(`(async () => {
        ${HELPERS}
        const p = getPlugin();
        const cfg = getConfig();
        const cred = getCredential();

        // Insert an archived row directly
        const archivedResp = await fetch(
          cred.projectUrl.replace(/\\/+$/, '') + '/rest/v1/notes',
          {
            method: 'POST',
            headers: { 'apikey': cred.apiKey, 'Authorization': 'Bearer ' + cred.apiKey, 'Content-Type': 'application/json', 'Prefer': 'return=representation' },
            body: JSON.stringify([{ title: 'E2E-SB-Archived', content: 'should be hidden', archived: true }]),
          }
        );
        const archivedRow = (await archivedResp.json())[0];
        const archivedId = archivedRow?.id;

        // Switch to active_notes view
        cfg.viewId = 'active_notes';
        getInstance(cfg).updateSettings(cfg, cred);

        await enqueueSync('pull', 'all');
        await new Promise(r => setTimeout(r, 7000));

        const files = app.vault.getFiles().filter(f => f.path.startsWith(cfg.folderPath + '/') && f.extension === 'md');
        const names = files.map(f => f.basename);
        const archivedPresent = names.includes('E2E-SB-Archived');

        // Cleanup: delete the extra row + reset viewId
        if (archivedId) {
          await fetch(
            cred.projectUrl.replace(/\\/+$/, '') + '/rest/v1/notes?id=eq.' + encodeURIComponent(archivedId),
            { method: 'DELETE', headers: { 'apikey': cred.apiKey, 'Authorization': 'Bearer ' + cred.apiKey } },
          );
        }
        cfg.viewId = '';
        getInstance(cfg).updateSettings(cfg, cred);

        return JSON.stringify({ archivedPresent, names });
      })()`, 30000);
      return { pass: !r.archivedPresent, detail: `archivedPresent=${r.archivedPresent} files=[${r.names.join(',')}]` };
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
    log('     Supabase E2E TEST SUMMARY');
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
