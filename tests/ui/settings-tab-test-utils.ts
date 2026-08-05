/**
 * Shared construction for AutoNoteImporterSettingTab specs.
 *
 * The tab is returned untyped: each spec casts it to the private surface it
 * exercises, so the harness does not have to know every method under test.
 * Not a spec itself — vitest only collects `tests/**\/*.test.ts`.
 */

import { vi } from 'vitest';
import type { AutoNoteImporterSettings } from '../../src/types';
import { DEFAULT_SETTINGS } from '../../src/types';
import { AutoNoteImporterSettingTab } from '../../src/ui/settings-tab';
import { FieldCache, SeaTableMetadataCache, SupabaseMetadataCache } from '../../src/services';

export interface SettingsTabHarness {
  tab: unknown;
  plugin: {
    settings: AutoNoteImporterSettings;
    saveSettings: ReturnType<typeof vi.fn>;
  };
}

export function createSettingsTabHarness(
  settings: Partial<AutoNoteImporterSettings> = {},
): SettingsTabHarness {
  const plugin = {
    settings: { ...DEFAULT_SETTINGS, ...settings },
    saveSettings: vi.fn().mockResolvedValue(undefined),
  };
  const tab = new AutoNoteImporterSettingTab(
    {} as never,
    plugin as never,
    new FieldCache(),
    new SeaTableMetadataCache(),
    new SupabaseMetadataCache(),
  );
  return { tab, plugin };
}
