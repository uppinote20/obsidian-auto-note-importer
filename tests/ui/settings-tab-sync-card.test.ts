/**
 * The sync card's conflict-mode setting: pull uses the mode too, so it must
 * render for pull-only configs.
 *
 * @covers src/ui/settings-tab.ts
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { Setting } from 'obsidian';
import type { ConfigEntry } from '../../src/types';
import { DEFAULT_CONFIG_ENTRY } from '../../src/types';
import { createSettingsTabHarness } from './settings-tab-test-utils';

type TestableSettingsTab = {
  renderBidirectionalSyncSettings(containerEl: HTMLElement, config: ConfigEntry): void;
};

function render(bidirectionalSync: boolean): { names: unknown[]; descs: unknown[] } {
  const setName = vi.spyOn(Setting.prototype, 'setName');
  const setDesc = vi.spyOn(Setting.prototype, 'setDesc');
  const config: ConfigEntry = { ...DEFAULT_CONFIG_ENTRY, id: 'cfg-1', name: 'C', credentialId: 'cred-1', bidirectionalSync };
  const { tab } = createSettingsTabHarness({ configs: [config], credentials: [] });
  (tab as TestableSettingsTab).renderBidirectionalSyncSettings({} as HTMLElement, config);
  return { names: setName.mock.calls.map(c => c[0]), descs: setDesc.mock.calls.map(c => c[0]) };
}

describe('renderBidirectionalSyncSettings — conflict mode', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('shows the conflict-mode setting when bidirectional sync is off', () => {
    const { names, descs } = render(false);
    expect(names).toContain('Conflict resolution');
    expect(descs.some(d => typeof d === 'string' && /bidirectional sync is on/i.test(d))).toBe(true);
  });

  it('shows the conflict-mode setting when bidirectional sync is on', () => {
    const { names, descs } = render(true);
    expect(names).toContain('Conflict resolution');
    expect(descs.some(d => typeof d === 'string' && /bidirectional sync is on/i.test(d))).toBe(false);
  });
});
