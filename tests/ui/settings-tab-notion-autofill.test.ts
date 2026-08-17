/**
 * Regression test for the A→B fast-switch race in the Notion filename
 * auto-fill (PR #125 Codex P2): selecting data source A then quickly
 * switching to B must not let A's stale async schema resolution overwrite
 * B's filenameFieldName.
 *
 * @covers src/ui/settings-tab.ts
 */

import { describe, it, expect, vi } from 'vitest';
import type { ConfigEntry, NotionCredential } from '../../src/types';
import { DEFAULT_CONFIG_ENTRY } from '../../src/types';
import type { SettingsTabHarness } from './settings-tab-test-utils';
import { createSettingsTabHarness } from './settings-tab-test-utils';

type TestableSettingsTab = {
  notionSchemaCache: { getSchema: (...args: unknown[]) => Promise<Map<string, string>> };
  debounceDisplay: () => void;
  autoFillNotionFilenameField(
    config: ConfigEntry,
    credential: NotionCredential,
    dataSourceId: string,
  ): Promise<void>;
};

function createTab(): { tab: TestableSettingsTab; plugin: SettingsTabHarness['plugin'] } {
  const { tab, plugin } = createSettingsTabHarness();
  const testable = tab as unknown as TestableSettingsTab;
  testable.debounceDisplay = vi.fn();
  return { tab: testable, plugin };
}

const cred: NotionCredential = { id: 'c1', name: 'X', type: 'notion', integrationToken: 'ntn_test' };

function makeConfig(overrides: Partial<ConfigEntry> = {}): ConfigEntry {
  return { ...DEFAULT_CONFIG_ENTRY, id: 'cfg1', name: 'D', credentialId: 'c1', ...overrides };
}

describe('autoFillNotionFilenameField', () => {
  it('does not apply a stale schema result once config.tableId has moved on to a different data source', async () => {
    const { tab } = createTab();
    const config = makeConfig({ tableId: 'ds-B', filenameFieldName: '' });

    // Simulate a getSchema call kicked off for data source A that resolves
    // AFTER the user already switched the select to B.
    const schemaA = new Map([['Title A', 'title']]);
    vi.spyOn(tab.notionSchemaCache, 'getSchema').mockResolvedValue(schemaA);

    await tab.autoFillNotionFilenameField(config, cred, 'ds-A');

    expect(config.filenameFieldName).toBe('');
  });

  it('still applies the schema result when tableId matches the requested data source', async () => {
    const { tab } = createTab();
    const config = makeConfig({ tableId: 'ds-A', filenameFieldName: '' });

    const schemaA = new Map([['Title A', 'title']]);
    vi.spyOn(tab.notionSchemaCache, 'getSchema').mockResolvedValue(schemaA);

    await tab.autoFillNotionFilenameField(config, cred, 'ds-A');

    expect(config.filenameFieldName).toBe('Title A');
  });
});
