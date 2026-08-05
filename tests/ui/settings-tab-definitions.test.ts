/**
 * Contract tests for the declarative settings definitions (Obsidian 1.13+).
 *
 * Two invariants matter and neither is visible from the rendered UI:
 *   1. The array must be non-empty — that is precisely what makes Obsidian
 *      render declaratively and skip display(). An empty array silently
 *      falls back to the imperative path and the settings-search entry
 *      disappears again.
 *   2. Building the definitions must be side-effect free — the host also
 *      calls this once at tab registration purely to build the search
 *      index, with no render to follow. Any teardown or generation bump
 *      here would fire against live UI state.
 *
 * @covers src/ui/settings-tab.ts
 */

import { describe, expect, it, vi } from 'vitest';
import type { SettingDefinitionItem } from 'obsidian';
import type { AutoNoteImporterSettings, Credential, ConfigEntry } from '../../src/types';
import { createSettingsTabHarness } from './settings-tab-test-utils';

type TestableSettingsTab = {
  getSettingDefinitions(): SettingDefinitionItem[];
  renderGeneration: number;
  display: () => void;
};

const CREDENTIAL: Credential = {
  id: 'cred-1',
  name: 'Airtable',
  type: 'airtable',
  apiKey: 'key',
} as Credential;

const CONFIG = { id: 'cfg-1', name: 'Config 1', credentialId: 'cred-1' } as ConfigEntry;

function createTab(settings: Partial<AutoNoteImporterSettings> = {}): TestableSettingsTab {
  const { tab } = createSettingsTabHarness(settings);
  const testable = tab as TestableSettingsTab;
  testable.display = vi.fn();
  return testable;
}

/** Group definitions carry `items`; leaf definitions carry `name`. */
function leafNames(defs: SettingDefinitionItem[]): string[] {
  return defs.flatMap(d => ('items' in d && d.items ? d.items : []).map(i => ('name' in i ? i.name : '')));
}

describe('getSettingDefinitions', () => {
  it('returns a non-empty array so Obsidian renders declaratively', () => {
    expect(createTab().getSettingDefinitions().length).toBeGreaterThan(0);
  });

  it('names every leaf item so settings search can index it', () => {
    const names = leafNames(createTab().getSettingDefinitions());

    expect(names.length).toBeGreaterThan(0);
    expect(names.every(n => n.trim().length > 0)).toBe(true);
  });

  it('stays non-empty with no configs — the empty state must still be searchable', () => {
    const defs = createTab({ credentials: [], configs: [] }).getSettingDefinitions();

    expect(defs.length).toBeGreaterThan(0);
    expect(leafNames(defs)).toContain('Credentials');
  });

  // The host calls this at tab registration purely for search indexing, with
  // no render to follow. Side effects there would hit live UI state.
  it('does not touch render state when only building definitions', () => {
    const tab = createTab({ credentials: [CREDENTIAL], configs: [CONFIG], activeConfigId: 'cfg-1' });
    const before = tab.renderGeneration;

    tab.getSettingDefinitions();

    expect(tab.renderGeneration).toBe(before);
    expect(tab.display).not.toHaveBeenCalled();
  });

  it('is idempotent — repeated indexing yields the same shape', () => {
    const tab = createTab({ credentials: [CREDENTIAL], configs: [CONFIG], activeConfigId: 'cfg-1' });

    expect(leafNames(tab.getSettingDefinitions())).toEqual(leafNames(tab.getSettingDefinitions()));
  });

  it('omits group headings so the imperative renderers own their own', () => {
    // renderCredentialsSection() and friends draw their own headings; a group
    // heading would render a second copy above them (observed on 1.13.4).
    const defs = createTab().getSettingDefinitions();

    for (const def of defs) {
      if ('heading' in def) expect(def.heading).toBeUndefined();
    }
  });
});
