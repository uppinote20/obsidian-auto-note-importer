/**
 * @covers src/ui/settings-tab.ts
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CredentialFormRenderer, SupabaseCredential } from '../../src/types';
import { DEFAULT_SETTINGS } from '../../src/types';
import { AutoNoteImporterSettingTab } from '../../src/ui/settings-tab';
import { FieldCache, SeaTableMetadataCache, SupabaseMetadataCache } from '../../src/services';

type TestableSettingsTab = {
  resetCredentialFormUi(): void;
  runConnectionTest(
    renderer: CredentialFormRenderer,
    credential: SupabaseCredential,
    formHostEl: HTMLElement,
  ): Promise<void>;
  verifyCredentialBeforeSave(
    renderer: CredentialFormRenderer,
    credential: SupabaseCredential,
    formHostEl: HTMLElement,
  ): Promise<'proceed' | 'blocked'>;
  invalidateCredentialFormVerification(): void;
};

function createTab(): TestableSettingsTab {
  const plugin = {
    settings: { ...DEFAULT_SETTINGS },
    saveSettings: vi.fn(),
  };
  const tab = new AutoNoteImporterSettingTab(
    {} as never,
    plugin as never,
    new FieldCache(),
    new SeaTableMetadataCache(),
    new SupabaseMetadataCache(),
  ) as unknown as TestableSettingsTab;
  tab.resetCredentialFormUi();
  return tab;
}

function createRenderer(): CredentialFormRenderer {
  return {
    type: 'supabase',
    label: 'Supabase',
    renderFields: vi.fn(),
    build: vi.fn(),
    testConnection: vi.fn().mockResolvedValue({ success: true }),
    verifySetup: vi.fn().mockResolvedValue({ success: true }),
  };
}

function createCredential(overrides: Partial<SupabaseCredential> = {}): SupabaseCredential {
  return {
    id: 'cred-1',
    name: 'Supabase',
    type: 'supabase',
    projectUrl: ' https://example.supabase.co ',
    apiKey: ' publishable-key ',
    ...overrides,
  };
}

function mockNow(value: number): { advance(ms: number): void } {
  let now = value;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  return {
    advance(ms: number): void {
      now += ms;
    },
  };
}

describe('settings-tab setup verification freshness cache', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('skips save-time verifySetup after successful Test within the freshness window', async () => {
    mockNow(1_000);
    const tab = createTab();
    const renderer = createRenderer();

    await tab.runConnectionTest(renderer, createCredential(), {} as HTMLElement);
    const gate = await tab.verifyCredentialBeforeSave(
      renderer,
      createCredential({ projectUrl: 'https://example.supabase.co', apiKey: 'publishable-key' }),
      {} as HTMLElement,
    );

    expect(gate).toBe('proceed');
    expect(renderer.testConnection).toHaveBeenCalledTimes(1);
    expect(renderer.verifySetup).not.toHaveBeenCalled();
  });

  it('runs save-time verifySetup after the freshness window expires', async () => {
    const clock = mockNow(1_000);
    const tab = createTab();
    const renderer = createRenderer();

    await tab.runConnectionTest(renderer, createCredential(), {} as HTMLElement);
    clock.advance(60_001);
    const gate = await tab.verifyCredentialBeforeSave(renderer, createCredential(), {} as HTMLElement);

    expect(gate).toBe('proceed');
    expect(renderer.testConnection).toHaveBeenCalledTimes(1);
    expect(renderer.verifySetup).toHaveBeenCalledTimes(1);
  });

  it('runs save-time verifySetup when credential fingerprint changes', async () => {
    mockNow(1_000);
    const tab = createTab();
    const renderer = createRenderer();

    await tab.runConnectionTest(renderer, createCredential(), {} as HTMLElement);
    const gate = await tab.verifyCredentialBeforeSave(
      renderer,
      createCredential({ apiKey: 'changed-key' }),
      {} as HTMLElement,
    );

    expect(gate).toBe('proceed');
    expect(renderer.verifySetup).toHaveBeenCalledTimes(1);
  });

  it('runs save-time verifySetup after field-edit invalidation', async () => {
    mockNow(1_000);
    const tab = createTab();
    const renderer = createRenderer();

    await tab.runConnectionTest(renderer, createCredential(), {} as HTMLElement);
    tab.invalidateCredentialFormVerification();
    const gate = await tab.verifyCredentialBeforeSave(renderer, createCredential(), {} as HTMLElement);

    expect(gate).toBe('proceed');
    expect(renderer.testConnection).toHaveBeenCalledTimes(1);
    expect(renderer.verifySetup).toHaveBeenCalledTimes(1);
  });
});
