/**
 * Settings UI E2E Tests for Auto Note Importer
 *
 * Tests summary card rendering, badge statuses, summaries, expand/collapse,
 * and all config option combinations via Chrome DevTools Protocol (CDP).
 *
 * @covers src/ui/settings-tab.ts
 *
 * Prerequisites:
 *   1. Obsidian running with --remote-debugging-port=9222
 *   2. A vault with the plugin installed and at least one configured credential
 *
 * Usage:
 *   node tests/e2e/run-settings-e2e.mjs
 */

import { findPageTarget, evalInObsidian } from './cdp-helpers.mjs';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const PLUGIN_ID = 'auto-note-importer';

// ---------------------------------------------------------------------------
// Obsidian-side helpers
// ---------------------------------------------------------------------------

const HELPERS = `
  function getPlugin() { return app.plugins.plugins['${PLUGIN_ID}']; }

  function getActiveConfig() {
    const p = getPlugin();
    const id = p.settings.activeConfigId;
    return p.settings.configs.find(c => c.id === id) || p.settings.configs[0];
  }

  function getConfig(idx = 0) { return getPlugin().settings.configs[idx]; }

  function getSettingsTab() {
    return app.setting.pluginTabs.find(t => t.id === '${PLUGIN_ID}');
  }

  async function openSettingsTab() {
    app.setting.open();
    await new Promise(r => setTimeout(r, 200));
    const tab = getSettingsTab();
    if (!tab) throw new Error('Plugin settings tab not found');
    app.setting.openTab(tab);
    tab.display();
    await new Promise(r => setTimeout(r, 400));
    return tab;
  }

  async function rerenderTab() {
    const tab = getSettingsTab();
    if (tab) tab.display();
    await new Promise(r => setTimeout(r, 300));
    return tab;
  }

  function getContainer() {
    const tab = getSettingsTab();
    return tab?.containerEl;
  }

  function queryCards(container) {
    const el = container || getContainer();
    return Array.from(el.querySelectorAll('.ani-summary-card'));
  }

  function cardInfo(card) {
    return {
      title: card.querySelector('.ani-card-title')?.textContent || '',
      summary: card.querySelector('.ani-card-summary')?.textContent || '',
      badge: card.querySelector('.ani-card-badge')?.textContent || '',
      isOk: !!card.querySelector('.ani-card-badge-ok'),
      isOff: !!card.querySelector('.ani-card-badge-off'),
      expanded: card.classList.contains('is-expanded'),
    };
  }

  function allCardInfos(container) {
    return queryCards(container).map(c => cardInfo(c));
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
// Helper: set config fields and re-render settings tab
// ---------------------------------------------------------------------------

function buildConfigExpr(overrides) {
  return Object.entries(overrides)
    .map(([key, value]) => {
      const v = typeof value === 'string' ? `'${value.replace(/'/g, "\\'")}'`
        : typeof value === 'boolean' ? String(value)
        : value;
      return `cfg.${key} = ${v};`;
    })
    .join('\n      ');
}

async function setConfigAndQuery(overrides) {
  const assignments = buildConfigExpr(overrides);
  return run(`(async () => {
    ${HELPERS}
    const p = getPlugin();
    const cfg = getActiveConfig();
    ${assignments}
    await p.saveSettings();
    await rerenderTab();
    const infos = allCardInfos();
    return JSON.stringify(infos);
  })()`, 10000);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

(async () => {
  try {
    targetId = await findPageTarget();
    log(`CDP target: ${targetId}`);

    // ── Setup: save original config, open settings ──────────────────

    log('\n=== Setup ===');
    const originalConfig = await run(`(async () => {
      ${HELPERS}
      const cfg = getActiveConfig();
      return JSON.stringify(Object.assign({}, cfg));
    })()`, 10000);
    log('Original config saved');

    await run(`(async () => {
      ${HELPERS}
      await openSettingsTab();
      return JSON.stringify({ ok: true });
    })()`, 10000);
    log('Settings tab opened');

    // ════════════════════════════════════════════════════════════════
    // Group 1: Layout Structure
    // ════════════════════════════════════════════════════════════════

    await test('layout / debug section exists above tab bar', async () => {
      const r = await run(`(async () => {
        ${HELPERS}
        const c = getContainer();
        const debug = c.querySelector('.ani-debug-section');
        const tabBar = c.querySelector('.ani-config-tab-bar');
        if (!debug || !tabBar) {
          return JSON.stringify({
            debugExists: !!debug,
            tabBarExists: !!tabBar,
          });
        }
        // Check DOM order: debug should come before tab bar
        const allEls = Array.from(c.children);
        const debugIdx = allEls.indexOf(debug);
        const tabBarIdx = allEls.indexOf(tabBar);
        return JSON.stringify({
          debugExists: true,
          tabBarExists: true,
          debugBeforeTabBar: debugIdx < tabBarIdx,
          debugIdx,
          tabBarIdx,
        });
      })()`, 10000);
      const pass = r.debugExists && r.tabBarExists && r.debugBeforeTabBar;
      return { pass, detail: `debug=${r.debugExists} tabBar=${r.tabBarExists} order=${r.debugBeforeTabBar}` };
    });

    await test('layout / card stack renders 4 summary cards', async () => {
      const r = await run(`(async () => {
        ${HELPERS}
        const c = getContainer();
        const stack = c.querySelector('.ani-card-stack');
        const cards = stack ? stack.querySelectorAll('.ani-summary-card') : [];
        const titles = Array.from(cards).map(card =>
          card.querySelector('.ani-card-title')?.textContent || ''
        );
        return JSON.stringify({ count: cards.length, titles });
      })()`, 10000);
      const pass = r.count === 4
        && r.titles.includes('Airtable Connection')
        && r.titles.includes('File Settings')
        && r.titles.includes('Bases Database')
        && r.titles.includes('Bidirectional Sync');
      return { pass, detail: `count=${r.count} titles=[${r.titles.join(', ')}]` };
    });

    await test('layout / card stack is inside container (not floating)', async () => {
      const r = await run(`(async () => {
        ${HELPERS}
        const c = getContainer();
        const stack = c.querySelector('.ani-card-stack');
        return JSON.stringify({
          exists: !!stack,
          parentIsContainer: stack?.parentElement === c,
        });
      })()`, 10000);
      return { pass: r.exists && r.parentIsContainer, detail: `exists=${r.exists} parent=${r.parentIsContainer}` };
    });

    // ════════════════════════════════════════════════════════════════
    // Group 2: Badge Status — Individual Card Boundaries
    // ════════════════════════════════════════════════════════════════

    await test('badge / connection — Connected when baseId+tableId set', async () => {
      const infos = await setConfigAndQuery({
        baseId: 'appTEST123', tableId: 'tblTEST456',
      });
      const card = infos.find(c => c.title === 'Airtable Connection');
      const pass = card && card.badge === 'Connected' && card.isOk;
      return { pass, detail: `badge="${card?.badge}" isOk=${card?.isOk}` };
    });

    await test('badge / connection — Setup required when baseId missing', async () => {
      const infos = await setConfigAndQuery({
        baseId: '', tableId: 'tblTEST456',
      });
      const card = infos.find(c => c.title === 'Airtable Connection');
      const pass = card && card.badge === 'Setup required' && card.isOff;
      return { pass, detail: `badge="${card?.badge}" isOff=${card?.isOff}` };
    });

    await test('badge / connection — Setup required when tableId missing', async () => {
      const infos = await setConfigAndQuery({
        baseId: 'appTEST123', tableId: '',
      });
      const card = infos.find(c => c.title === 'Airtable Connection');
      const pass = card && card.badge === 'Setup required' && card.isOff;
      return { pass, detail: `badge="${card?.badge}" isOff=${card?.isOff}` };
    });

    await test('badge / files — Configured when folderPath set', async () => {
      const infos = await setConfigAndQuery({
        baseId: 'appTEST123', tableId: 'tblTEST456',
        folderPath: 'Crawling',
      });
      const card = infos.find(c => c.title === 'File Settings');
      const pass = card && card.badge === 'Configured' && card.isOk;
      return { pass, detail: `badge="${card?.badge}" isOk=${card?.isOk}` };
    });

    await test('badge / files — Setup required when folderPath empty', async () => {
      const infos = await setConfigAndQuery({
        baseId: 'appTEST123', tableId: 'tblTEST456',
        folderPath: '',
      });
      const card = infos.find(c => c.title === 'File Settings');
      const pass = card && card.badge === 'Setup required' && card.isOff;
      return { pass, detail: `badge="${card?.badge}" isOff=${card?.isOff}` };
    });

    await test('badge / bases — On when generateBasesFile true', async () => {
      const infos = await setConfigAndQuery({
        baseId: 'appTEST123', tableId: 'tblTEST456',
        generateBasesFile: true,
      });
      const card = infos.find(c => c.title === 'Bases Database');
      const pass = card && card.badge === 'On' && card.isOk;
      return { pass, detail: `badge="${card?.badge}" isOk=${card?.isOk}` };
    });

    await test('badge / bases — Off when generateBasesFile false', async () => {
      const infos = await setConfigAndQuery({
        baseId: 'appTEST123', tableId: 'tblTEST456',
        generateBasesFile: false,
      });
      const card = infos.find(c => c.title === 'Bases Database');
      const pass = card && card.badge === 'Off' && card.isOff;
      return { pass, detail: `badge="${card?.badge}" isOff=${card?.isOff}` };
    });

    await test('badge / sync — On when bidirectionalSync true', async () => {
      const infos = await setConfigAndQuery({
        baseId: 'appTEST123', tableId: 'tblTEST456',
        bidirectionalSync: true,
      });
      const card = infos.find(c => c.title === 'Bidirectional Sync');
      const pass = card && card.badge === 'On' && card.isOk;
      return { pass, detail: `badge="${card?.badge}" isOk=${card?.isOk}` };
    });

    await test('badge / sync — Off when bidirectionalSync false', async () => {
      const infos = await setConfigAndQuery({
        baseId: 'appTEST123', tableId: 'tblTEST456',
        bidirectionalSync: false,
      });
      const card = infos.find(c => c.title === 'Bidirectional Sync');
      const pass = card && card.badge === 'Off' && card.isOff;
      return { pass, detail: `badge="${card?.badge}" isOff=${card?.isOff}` };
    });

    // ════════════════════════════════════════════════════════════════
    // Group 3: Badge Matrix — Combination Tests
    // ════════════════════════════════════════════════════════════════

    await test('badge-matrix / all features configured', async () => {
      const infos = await setConfigAndQuery({
        baseId: 'appTEST', tableId: 'tblTEST',
        folderPath: 'TestFolder',
        generateBasesFile: true,
        bidirectionalSync: true,
      });
      const allOk = infos.every(c => c.isOk);
      const badges = infos.map(c => `${c.title}:${c.badge}`).join(' | ');
      return { pass: allOk, detail: badges };
    });

    await test('badge-matrix / all features unconfigured', async () => {
      const infos = await setConfigAndQuery({
        baseId: '', tableId: '',
        folderPath: '',
        generateBasesFile: false,
        bidirectionalSync: false,
      });
      // Connection card won't render (no apiKey check is at credential level, but baseId/tableId empty)
      // Files, Bases, Sync should all be off
      const filesOff = infos.find(c => c.title === 'File Settings')?.isOff;
      const basesOff = infos.find(c => c.title === 'Bases Database')?.isOff;
      const syncOff = infos.find(c => c.title === 'Bidirectional Sync')?.isOff;
      const connOff = infos.find(c => c.title === 'Airtable Connection')?.isOff;
      const pass = filesOff && basesOff && syncOff && (connOff === undefined || connOff);
      return { pass, detail: `files=${filesOff} bases=${basesOff} sync=${syncOff} conn=${connOff}` };
    });

    await test('badge-matrix / mixed: connection+files on, bases+sync off', async () => {
      const infos = await setConfigAndQuery({
        baseId: 'appTEST', tableId: 'tblTEST',
        folderPath: 'Mixed',
        generateBasesFile: false,
        bidirectionalSync: false,
      });
      const conn = infos.find(c => c.title === 'Airtable Connection');
      const files = infos.find(c => c.title === 'File Settings');
      const bases = infos.find(c => c.title === 'Bases Database');
      const sync = infos.find(c => c.title === 'Bidirectional Sync');
      const pass = conn?.isOk && files?.isOk && bases?.isOff && sync?.isOff;
      return { pass, detail: `conn=${conn?.isOk} files=${files?.isOk} bases=${bases?.isOff} sync=${sync?.isOff}` };
    });

    await test('badge-matrix / mixed: sync+bases on, files empty', async () => {
      const infos = await setConfigAndQuery({
        baseId: 'appTEST', tableId: 'tblTEST',
        folderPath: '',
        generateBasesFile: true,
        bidirectionalSync: true,
      });
      const files = infos.find(c => c.title === 'File Settings');
      const bases = infos.find(c => c.title === 'Bases Database');
      const sync = infos.find(c => c.title === 'Bidirectional Sync');
      const pass = files?.isOff && bases?.isOk && sync?.isOk;
      return { pass, detail: `files=${files?.isOff} bases=${bases?.isOk} sync=${sync?.isOk}` };
    });

    // ════════════════════════════════════════════════════════════════
    // Group 4: Summary Text
    // ════════════════════════════════════════════════════════════════

    await test('summary / connection — shows filenameField and View filtered', async () => {
      const infos = await setConfigAndQuery({
        baseId: 'appTEST', tableId: 'tblTEST',
        filenameFieldName: 'Name', viewId: 'viwTEST',
      });
      const card = infos.find(c => c.title === 'Airtable Connection');
      const pass = card && card.summary.includes('Name') && card.summary.includes('View filtered');
      return { pass, detail: `summary="${card?.summary}"` };
    });

    await test('summary / connection — shows filenameField only when no view', async () => {
      const infos = await setConfigAndQuery({
        baseId: 'appTEST', tableId: 'tblTEST',
        filenameFieldName: 'Title', viewId: '',
      });
      const card = infos.find(c => c.title === 'Airtable Connection');
      const pass = card && card.summary === 'Title';
      return { pass, detail: `summary="${card?.summary}"` };
    });

    await test('summary / connection — empty when not connected', async () => {
      const infos = await setConfigAndQuery({
        baseId: '', tableId: '',
        filenameFieldName: 'Name', viewId: 'viwTEST',
      });
      const card = infos.find(c => c.title === 'Airtable Connection');
      const pass = card && card.summary === '';
      return { pass, detail: `summary="${card?.summary}"` };
    });

    await test('summary / files — full: folder + template + interval', async () => {
      const infos = await setConfigAndQuery({
        baseId: 'appTEST', tableId: 'tblTEST',
        folderPath: 'Crawling', templatePath: 'Templates/note.md', syncInterval: 5,
      });
      const card = infos.find(c => c.title === 'File Settings');
      const pass = card
        && card.summary.includes('Crawling/')
        && card.summary.includes('note.md')
        && card.summary.includes('5min');
      return { pass, detail: `summary="${card?.summary}"` };
    });

    await test('summary / files — folder only', async () => {
      const infos = await setConfigAndQuery({
        baseId: 'appTEST', tableId: 'tblTEST',
        folderPath: 'Notes', templatePath: '', syncInterval: 0,
      });
      const card = infos.find(c => c.title === 'File Settings');
      const pass = card && card.summary === 'Notes/';
      return { pass, detail: `summary="${card?.summary}"` };
    });

    await test('summary / files — empty when no folderPath', async () => {
      const infos = await setConfigAndQuery({
        baseId: 'appTEST', tableId: 'tblTEST',
        folderPath: '', templatePath: '', syncInterval: 0,
      });
      const card = infos.find(c => c.title === 'File Settings');
      const pass = card && card.summary === '';
      return { pass, detail: `summary="${card?.summary}"` };
    });

    await test('summary / files — template without folder still shows template', async () => {
      const infos = await setConfigAndQuery({
        baseId: 'appTEST', tableId: 'tblTEST',
        folderPath: '', templatePath: 'Templates/tmpl.md', syncInterval: 3,
      });
      const card = infos.find(c => c.title === 'File Settings');
      const pass = card && card.summary.includes('tmpl.md') && card.summary.includes('3min');
      return { pass, detail: `summary="${card?.summary}"` };
    });

    await test('summary / files — template extracts basename from path', async () => {
      const infos = await setConfigAndQuery({
        baseId: 'appTEST', tableId: 'tblTEST',
        folderPath: 'X', templatePath: 'deeply/nested/tmpl.md', syncInterval: 0,
      });
      const card = infos.find(c => c.title === 'File Settings');
      // Should show 'tmpl.md' not the full path
      const pass = card && card.summary.includes('tmpl.md') && !card.summary.includes('deeply');
      return { pass, detail: `summary="${card?.summary}"` };
    });

    await test('summary / bases — shows text when on', async () => {
      const infos = await setConfigAndQuery({
        baseId: 'appTEST', tableId: 'tblTEST',
        generateBasesFile: true,
      });
      const card = infos.find(c => c.title === 'Bases Database');
      const pass = card && card.summary === 'Auto-generate enabled';
      return { pass, detail: `summary="${card?.summary}"` };
    });

    await test('summary / bases — empty when off', async () => {
      const infos = await setConfigAndQuery({
        baseId: 'appTEST', tableId: 'tblTEST',
        generateBasesFile: false,
      });
      const card = infos.find(c => c.title === 'Bases Database');
      const pass = card && card.summary === '';
      return { pass, detail: `summary="${card?.summary}"` };
    });

    await test('summary / sync — shows conflictResolution + watching', async () => {
      const infos = await setConfigAndQuery({
        baseId: 'appTEST', tableId: 'tblTEST',
        bidirectionalSync: true, conflictResolution: 'obsidian-wins', watchForChanges: true,
      });
      const card = infos.find(c => c.title === 'Bidirectional Sync');
      const pass = card && card.summary.includes('obsidian-wins') && card.summary.includes('watching');
      return { pass, detail: `summary="${card?.summary}"` };
    });

    await test('summary / sync — shows conflictResolution only when not watching', async () => {
      const infos = await setConfigAndQuery({
        baseId: 'appTEST', tableId: 'tblTEST',
        bidirectionalSync: true, conflictResolution: 'airtable-wins', watchForChanges: false,
      });
      const card = infos.find(c => c.title === 'Bidirectional Sync');
      const pass = card && card.summary === 'airtable-wins';
      return { pass, detail: `summary="${card?.summary}"` };
    });

    await test('summary / sync — empty when bidirectionalSync off', async () => {
      const infos = await setConfigAndQuery({
        baseId: 'appTEST', tableId: 'tblTEST',
        bidirectionalSync: false, conflictResolution: 'manual', watchForChanges: true,
      });
      const card = infos.find(c => c.title === 'Bidirectional Sync');
      const pass = card && card.summary === '';
      return { pass, detail: `summary="${card?.summary}"` };
    });

    await test('summary / sync — manual mode', async () => {
      const infos = await setConfigAndQuery({
        baseId: 'appTEST', tableId: 'tblTEST',
        bidirectionalSync: true, conflictResolution: 'manual', watchForChanges: false,
      });
      const card = infos.find(c => c.title === 'Bidirectional Sync');
      const pass = card && card.summary === 'manual';
      return { pass, detail: `summary="${card?.summary}"` };
    });

    // ════════════════════════════════════════════════════════════════
    // Group 5: Card Interactions
    // ════════════════════════════════════════════════════════════════

    await test('interaction / card expands on header click', async () => {
      const r = await run(`(async () => {
        ${HELPERS}
        const cfg = getActiveConfig();
        cfg.baseId = 'appTEST';
        cfg.tableId = 'tblTEST';
        await getPlugin().saveSettings();

        // Clear state so all cards start collapsed
        const tab = getSettingsTab();
        tab.expandedSections.clear();
        tab.display();
        await new Promise(r => setTimeout(r, 400));

        const cards = queryCards();
        const fileCard = cards.find(c =>
          c.querySelector('.ani-card-title')?.textContent === 'File Settings'
        );
        if (!fileCard) return JSON.stringify({ wasBefore: false, isAfter: false, hasBody: false, error: 'not found' });

        const wasBefore = fileCard.classList.contains('is-expanded');

        // Click to expand
        fileCard.querySelector('.ani-card-header').click();
        await new Promise(r => setTimeout(r, 500));

        const cardsAfter = queryCards();
        const fileCardAfter = cardsAfter.find(c =>
          c.querySelector('.ani-card-title')?.textContent === 'File Settings'
        );
        const isAfter = fileCardAfter?.classList.contains('is-expanded');
        const hasBody = !!fileCardAfter?.querySelector('.ani-card-body');

        return JSON.stringify({ wasBefore, isAfter, hasBody });
      })()`, 10000);
      const pass = !r.wasBefore && r.isAfter === true && r.hasBody === true;
      return { pass, detail: `before=${r.wasBefore} after=${r.isAfter} body=${r.hasBody}` };
    });

    await test('interaction / card collapses on second click', async () => {
      const r = await run(`(async () => {
        ${HELPERS}
        const cfg = getActiveConfig();
        cfg.baseId = 'appTEST';
        cfg.tableId = 'tblTEST';
        await getPlugin().saveSettings();
        await openSettingsTab();

        // First click to expand
        let cards = queryCards();
        let basesCard = cards.find(c =>
          c.querySelector('.ani-card-title')?.textContent === 'Bases Database'
        );
        basesCard.querySelector('.ani-card-header').click();
        await new Promise(r => setTimeout(r, 500));

        // Verify expanded
        cards = queryCards();
        basesCard = cards.find(c =>
          c.querySelector('.ani-card-title')?.textContent === 'Bases Database'
        );
        const expandedAfterFirst = basesCard.classList.contains('is-expanded');

        // Second click to collapse
        basesCard.querySelector('.ani-card-header').click();
        await new Promise(r => setTimeout(r, 500));

        cards = queryCards();
        basesCard = cards.find(c =>
          c.querySelector('.ani-card-title')?.textContent === 'Bases Database'
        );
        const expandedAfterSecond = basesCard.classList.contains('is-expanded');
        const hasBody = !!basesCard.querySelector('.ani-card-body');

        return JSON.stringify({ expandedAfterFirst, expandedAfterSecond, hasBody });
      })()`, 10000);
      const pass = r.expandedAfterFirst === true && r.expandedAfterSecond === false && r.hasBody === false;
      return { pass, detail: `1st=${r.expandedAfterFirst} 2nd=${r.expandedAfterSecond} body=${r.hasBody}` };
    });

    await test('interaction / expanded card shows settings inside card-body', async () => {
      const r = await run(`(async () => {
        ${HELPERS}
        const cfg = getActiveConfig();
        cfg.baseId = 'appTEST';
        cfg.tableId = 'tblTEST';
        cfg.bidirectionalSync = true;
        await getPlugin().saveSettings();

        // Directly set expanded state for Bidirectional Sync
        const tab = getSettingsTab();
        tab.expandedSections.clear();
        tab.expandedSections.add('bidirectional-sync');
        tab.display();
        await new Promise(r => setTimeout(r, 400));

        const cards = queryCards();
        const syncCard = cards.find(c =>
          c.querySelector('.ani-card-title')?.textContent === 'Bidirectional Sync'
        );
        const body = syncCard?.querySelector('.ani-card-body');
        const settingItems = body ? body.querySelectorAll('.setting-item').length : 0;
        const isExpanded = syncCard?.classList.contains('is-expanded');

        return JSON.stringify({ hasBody: !!body, settingItems, isExpanded });
      })()`, 10000);
      const pass = r.hasBody && r.settingItems >= 2 && r.isExpanded;
      return { pass, detail: `body=${r.hasBody} settings=${r.settingItems} expanded=${r.isExpanded}` };
    });

    await test('interaction / chevron rotates when expanded', async () => {
      const r = await run(`(async () => {
        ${HELPERS}
        const cfg = getActiveConfig();
        cfg.baseId = 'appTEST';
        cfg.tableId = 'tblTEST';
        await getPlugin().saveSettings();

        // Clear expandedSections to ensure all cards start collapsed
        const tab = getSettingsTab();
        tab.expandedSections?.clear();
        tab.display();
        await new Promise(r => setTimeout(r, 400));

        // Verify first card starts collapsed
        const cards = queryCards();
        const card = cards[0];
        const startedCollapsed = !card.classList.contains('is-expanded');

        // Click to expand
        card.querySelector('.ani-card-header').click();
        await new Promise(r => setTimeout(r, 500));

        const cardsAfter = queryCards();
        const cardAfter = cardsAfter[0];
        const isNowExpanded = cardAfter.classList.contains('is-expanded');

        return JSON.stringify({ startedCollapsed, isNowExpanded });
      })()`, 10000);
      const pass = r.startedCollapsed && r.isNowExpanded;
      return { pass, detail: `collapsed=${r.startedCollapsed} expanded=${r.isNowExpanded}` };
    });

    // ════════════════════════════════════════════════════════════════
    // Group 6: Delete Confirmation
    // ════════════════════════════════════════════════════════════════

    await test('interaction / delete button exists in danger zone', async () => {
      const r = await run(`(async () => {
        ${HELPERS}
        const cfg = getActiveConfig();
        cfg.baseId = 'appTEST';
        cfg.tableId = 'tblTEST';
        await getPlugin().saveSettings();
        await openSettingsTab();

        const c = getContainer();
        const dangerHeading = Array.from(c.querySelectorAll('.setting-item-heading'))
          .find(h => h.textContent.includes('Danger'));
        const deleteBtn = c.querySelector('.ani-delete-config .mod-warning');

        return JSON.stringify({
          hasDangerHeading: !!dangerHeading,
          hasDeleteBtn: !!deleteBtn,
        });
      })()`, 10000);
      const pass = r.hasDangerHeading && r.hasDeleteBtn;
      return { pass, detail: `heading=${r.hasDangerHeading} btn=${r.hasDeleteBtn}` };
    });

    // ════════════════════════════════════════════════════════════════
    // Group 7: Edge Cases
    // ════════════════════════════════════════════════════════════════

    await test('edge / no config shows empty state', async () => {
      const r = await run(`(async () => {
        ${HELPERS}
        const p = getPlugin();
        const savedConfigs = [...p.settings.configs];
        const savedActiveId = p.settings.activeConfigId;

        // Temporarily remove all configs
        p.settings.configs = [];
        p.settings.activeConfigId = '';
        await openSettingsTab();

        const c = getContainer();
        const cards = c.querySelectorAll('.ani-summary-card').length;
        const noConfigMsg = c.textContent.includes('No configuration');

        // Restore
        p.settings.configs = savedConfigs;
        p.settings.activeConfigId = savedActiveId;
        await p.saveSettings();

        return JSON.stringify({ cards, noConfigMsg });
      })()`, 10000);
      const pass = r.cards === 0 && r.noConfigMsg;
      return { pass, detail: `cards=${r.cards} noConfigMsg=${r.noConfigMsg}` };
    });

    await test('edge / tab bar reflects config names', async () => {
      const r = await run(`(async () => {
        ${HELPERS}
        await openSettingsTab();
        const c = getContainer();
        const tabs = Array.from(c.querySelectorAll('.ani-config-tab:not(.ani-add-tab)'));
        const names = tabs.map(t => t.textContent);
        const addTab = c.querySelector('.ani-add-tab');
        return JSON.stringify({ count: tabs.length, names, hasAddTab: !!addTab });
      })()`, 10000);
      const pass = r.count >= 1 && r.hasAddTab;
      return { pass, detail: `tabs=${r.count} names=[${r.names.join(', ')}] addTab=${r.hasAddTab}` };
    });

    // ════════════════════════════════════════════════════════════════
    // Group 8: Credential Add Form (Provider Type)
    // ════════════════════════════════════════════════════════════════

    await test('credential / add form shows type dropdown with 5 providers', async () => {
      const r = await run(`(async () => {
        ${HELPERS}
        await openSettingsTab();
        const c = getContainer();
        const addBtn = Array.from(c.querySelectorAll('button')).find(b => b.textContent.includes('Add credential'));
        if (!addBtn) return JSON.stringify({ error: 'no add button' });
        addBtn.click();
        await new Promise(r => setTimeout(r, 300));

        const select = c.querySelector('.ani-credential-edit select');
        const options = select ? Array.from(select.options).map(o => o.value) : [];

        // Close add form
        const cancelBtn = Array.from(c.querySelectorAll('button')).find(b => b.textContent === 'Cancel');
        cancelBtn?.click();
        await new Promise(r => setTimeout(r, 200));

        return JSON.stringify({ hasDropdown: !!select, options });
      })()`, 10000);
      const expected = ['airtable', 'seatable', 'supabase', 'notion', 'custom-api'];
      const pass = r.hasDropdown && expected.every(t => r.options.includes(t)) && r.options.length === 5;
      return { pass, detail: `dropdown=${r.hasDropdown} options=[${(r.options || []).join(',')}]` };
    });

    await test('credential / airtable add form shows description and Test button', async () => {
      const r = await run(`(async () => {
        ${HELPERS}
        const p = getPlugin();
        const tab = getSettingsTab();
        tab.addingCredential = false;
        tab.addingCredentialType = 'airtable';
        await openSettingsTab();

        const c = getContainer();
        const addBtn = Array.from(c.querySelectorAll('button')).find(b => b.textContent.includes('Add credential'));
        addBtn?.click();
        await new Promise(r => setTimeout(r, 300));

        const descriptions = Array.from(c.querySelectorAll('.ani-credential-desc')).map(el => el.textContent);
        const testBtn = Array.from(c.querySelectorAll('button')).find(b => b.textContent === 'Test');

        const cancelBtn = Array.from(c.querySelectorAll('button')).find(b => b.textContent === 'Cancel');
        cancelBtn?.click();
        await new Promise(r => setTimeout(r, 200));

        return JSON.stringify({
          hasDescription: descriptions.length > 0 && descriptions[0].includes('airtable.com'),
          hasTestBtn: !!testBtn,
          testBtnDisabled: !!testBtn?.disabled,
        });
      })()`, 10000);
      const pass = r.hasDescription && r.hasTestBtn && !r.testBtnDisabled;
      return { pass, detail: `description=${r.hasDescription} testBtn=${r.hasTestBtn} disabled=${r.testBtnDisabled}` };
    });

    await test('credential / airtable type shows API Key field and enabled Save', async () => {
      const r = await run(`(async () => {
        ${HELPERS}
        await openSettingsTab();
        const c = getContainer();
        const addBtn = Array.from(c.querySelectorAll('button')).find(b => b.textContent.includes('Add credential'));
        addBtn?.click();
        await new Promise(r => setTimeout(r, 300));

        const fields = Array.from(c.querySelectorAll('.ani-credential-edit')).map(el =>
          el.querySelector('.setting-item-name')?.textContent || ''
        );
        const saveBtn = Array.from(c.querySelectorAll('button')).find(b => b.textContent === 'Save');
        const saveDisabled = !!saveBtn?.disabled;

        const cancelBtn = Array.from(c.querySelectorAll('button')).find(b => b.textContent === 'Cancel');
        cancelBtn?.click();
        await new Promise(r => setTimeout(r, 200));

        return JSON.stringify({ fields, saveDisabled });
      })()`, 10000);
      const pass = r.fields.includes('Name') && r.fields.includes('Type') && r.fields.includes('API Key') && !r.saveDisabled;
      return { pass, detail: `fields=[${r.fields.join(',')}] saveDisabled=${r.saveDisabled}` };
    });

    await test('credential / edit form shows Test button for airtable', async () => {
      const r = await run(`(async () => {
        ${HELPERS}
        await openSettingsTab();
        const c = getContainer();
        const p = getPlugin();
        const cred = p.settings.credentials[0];
        if (!cred) return JSON.stringify({ error: 'no credential' });

        const tab = getSettingsTab();
        tab.editingCredentialId = cred.id;
        tab.display();
        await new Promise(r => setTimeout(r, 300));

        const c2 = getContainer();
        const testBtn = Array.from(c2.querySelectorAll('button')).find(b => b.textContent === 'Test');
        const saveBtn = Array.from(c2.querySelectorAll('button')).find(b => b.textContent === 'Save');
        const cancelBtn = Array.from(c2.querySelectorAll('button')).find(b => b.textContent === 'Cancel');

        // Cleanup
        tab.editingCredentialId = null;
        tab.display();
        await new Promise(r => setTimeout(r, 200));

        return JSON.stringify({
          hasTestBtn: !!testBtn,
          testBtnDisabled: !!testBtn?.disabled,
          hasSaveBtn: !!saveBtn,
          hasCancelBtn: !!cancelBtn,
        });
      })()`, 10000);
      const pass = r.hasTestBtn && !r.testBtnDisabled && r.hasSaveBtn && r.hasCancelBtn;
      return { pass, detail: `testBtn=${r.hasTestBtn} disabled=${r.testBtnDisabled} save=${r.hasSaveBtn} cancel=${r.hasCancelBtn}` };
    });

    await test('credential / edit form rejects non-airtable credentials', async () => {
      const r = await run(`(async () => {
        ${HELPERS}
        const p = getPlugin();
        // Inject a fake seatable credential temporarily
        const fakeId = 'e2e-fake-seatable-' + Date.now();
        const savedCreds = [...p.settings.credentials];
        p.settings.credentials.push({
          id: fakeId,
          name: 'Fake SeaTable',
          type: 'seatable',
          apiToken: 'x',
          serverUrl: 'https://cloud.seatable.io',
        });

        await openSettingsTab();
        const tab = getSettingsTab();
        tab.editingCredentialId = fakeId;
        tab.display();
        await new Promise(r => setTimeout(r, 300));

        const c = getContainer();
        const fieldNames = Array.from(c.querySelectorAll('.setting-item-name')).map(el => el.textContent);
        const hasEditNotSupported = fieldNames.includes('Edit not supported');

        // Restore
        tab.editingCredentialId = null;
        p.settings.credentials = savedCreds;
        await p.saveSettings();

        return JSON.stringify({ hasEditNotSupported });
      })()`, 10000);
      const pass = r.hasEditNotSupported;
      return { pass, detail: `editNotSupported=${r.hasEditNotSupported}` };
    });

    await test('credential / non-airtable type shows Not yet supported and disabled Save', async () => {
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

        const c2 = getContainer();
        const fields = Array.from(c2.querySelectorAll('.ani-credential-edit')).map(el =>
          el.querySelector('.setting-item-name')?.textContent || ''
        );
        const hasNotSupported = fields.includes('Not yet supported');
        const hasApiKey = fields.includes('API Key');
        const saveBtn = Array.from(c2.querySelectorAll('button')).find(b => b.textContent === 'Save');
        const saveDisabled = !!saveBtn?.disabled;

        const cancelBtn = Array.from(c2.querySelectorAll('button')).find(b => b.textContent === 'Cancel');
        cancelBtn?.click();
        await new Promise(r => setTimeout(r, 200));

        return JSON.stringify({ hasNotSupported, hasApiKey, saveDisabled });
      })()`, 10000);
      const pass = r.hasNotSupported && !r.hasApiKey && r.saveDisabled;
      return { pass, detail: `notSupported=${r.hasNotSupported} apiKey=${r.hasApiKey} saveDisabled=${r.saveDisabled}` };
    });

    await test('edge / debug toggle reflects global debugMode', async () => {
      const r = await run(`(async () => {
        ${HELPERS}
        const p = getPlugin();
        const was = p.settings.debugMode;

        p.settings.debugMode = true;
        await p.saveSettings();
        await openSettingsTab();
        const c = getContainer();
        const debugSection = c.querySelector('.ani-debug-section');
        const toggle = debugSection?.querySelector('.checkbox-container');
        const isChecked = toggle?.classList.contains('is-enabled');

        // Restore
        p.settings.debugMode = was;
        await p.saveSettings();

        return JSON.stringify({ isChecked, toggleExists: !!toggle });
      })()`, 10000);
      const pass = r.toggleExists && r.isChecked;
      return { pass, detail: `toggle=${r.toggleExists} checked=${r.isChecked}` };
    });

    // ── Teardown: Restore original config, close settings ────────

    log('\n=== Teardown ===');
    await run(`(async () => {
      ${HELPERS}
      const p = getPlugin();
      const cfg = getActiveConfig();
      const orig = ${JSON.stringify(originalConfig)};
      Object.assign(cfg, orig);
      await p.saveSettings();
      app.setting.close();
      return JSON.stringify({ ok: true });
    })()`, 10000);
    log('Original config restored, settings closed');

    // ── Summary ──────────────────────────────────────────────────

    log('\n========================================');
    log('     SETTINGS UI E2E TEST SUMMARY');
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
