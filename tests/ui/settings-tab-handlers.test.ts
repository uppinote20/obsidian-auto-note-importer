/**
 * Handler-body unit tests for the click callbacks extracted from inline
 * async listeners in PR #115 (scanner rule obsidianmd/no-misused-promises).
 *
 * The extraction moved the bodies behind a `void` at the call site, which
 * hides rejections — so these lock in that every failure path still reaches
 * a user-visible channel (onVerifyFailure / Notice) and that the button
 * state is always restored.
 *
 * @covers src/ui/settings-tab.ts
 */

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Notice } from 'obsidian';
import type { AutoNoteImporterSettings, Credential, CredentialFormRenderer, SupabaseCredential } from '../../src/types';
import type { SettingsTabHarness } from './settings-tab-test-utils';
import { getCredentialFormRenderer, registerCredentialFormRenderer } from '../../src/services';
import { createSettingsTabHarness } from './settings-tab-test-utils';

const VERIFY_LABEL = 'I’ve run it — Verify';

// `registerRenderer` swaps the real Supabase renderer out of the module-level
// provider registry. Vitest isolates modules per file, so this cannot leak into
// other specs — but restore it anyway so a future describe block in this file
// starts from the production registration rather than the last mock.
const realSupabaseRenderer = getCredentialFormRenderer('supabase');
afterAll(() => {
  registerCredentialFormRenderer('supabase', realSupabaseRenderer);
});

type TestableSettingsTab = {
  display: () => void;
  pendingDeleteCredentialId: string | null;
  handleRpcVerifyClick(
    verifyBtn: HTMLButtonElement,
    credential: SupabaseCredential,
    onVerifySuccess: () => void,
    onVerifyFailure: (error: string) => void,
  ): Promise<void>;
  handleCredentialDeleteClick(cred: Credential, isPendingDelete: boolean): Promise<void>;
};

function createTab(settings: Partial<AutoNoteImporterSettings> = {}): {
  tab: TestableSettingsTab;
  plugin: SettingsTabHarness['plugin'];
} {
  const { tab, plugin } = createSettingsTabHarness(settings);
  const testable = tab as TestableSettingsTab;
  // The real display() renders the whole settings panel through Obsidian's
  // DOM helpers, which the node test environment does not provide.
  testable.display = vi.fn();
  return { tab: testable, plugin };
}

/** Only `.disabled` / `.textContent` are touched — no DOM needed. */
function createVerifyButton(): HTMLButtonElement {
  return { disabled: false, textContent: VERIFY_LABEL } as unknown as HTMLButtonElement;
}

function registerRenderer(overrides: Partial<CredentialFormRenderer> = {}): CredentialFormRenderer {
  const renderer: CredentialFormRenderer = {
    type: 'supabase',
    label: 'Supabase',
    renderFields: vi.fn(),
    build: vi.fn(),
    testConnection: vi.fn().mockResolvedValue({ success: true }),
    verifySetup: vi.fn().mockResolvedValue({ success: true }),
    ...overrides,
  };
  registerCredentialFormRenderer('supabase', renderer);
  return renderer;
}

function createCredential(): SupabaseCredential {
  return {
    id: 'cred-1',
    name: 'Supabase',
    type: 'supabase',
    projectUrl: 'https://example.supabase.co',
    apiKey: 'publishable-key',
  };
}

describe('handleRpcVerifyClick', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('routes a clean verify to onVerifySuccess and restores the button', async () => {
    const { tab } = createTab();
    registerRenderer();
    const btn = createVerifyButton();
    const onSuccess = vi.fn();
    const onFailure = vi.fn();

    await tab.handleRpcVerifyClick(btn, createCredential(), onSuccess, onFailure);

    expect(onSuccess).toHaveBeenCalledTimes(1);
    expect(onFailure).not.toHaveBeenCalled();
    expect(btn.disabled).toBe(false);
    expect(btn.textContent).toBe(VERIFY_LABEL);
  });

  it('reports a still-missing RPC as a failure with remediation hints', async () => {
    const { tab } = createTab();
    registerRenderer({
      verifySetup: vi.fn().mockResolvedValue({ success: true, needsSetup: { kind: 'supabase-rpc' } }),
    });
    const onSuccess = vi.fn();
    const onFailure = vi.fn();

    await tab.handleRpcVerifyClick(createVerifyButton(), createCredential(), onSuccess, onFailure);

    expect(onSuccess).not.toHaveBeenCalled();
    expect(onFailure).toHaveBeenCalledTimes(1);
    expect(onFailure.mock.calls[0][0]).toContain('RPC still not installed');
  });

  it('forwards a failed verify result verbatim', async () => {
    const { tab } = createTab();
    registerRenderer({ verifySetup: vi.fn().mockResolvedValue({ success: false, error: 'invalid api key' }) });
    const onFailure = vi.fn();

    await tab.handleRpcVerifyClick(createVerifyButton(), createCredential(), vi.fn(), onFailure);

    expect(onFailure).toHaveBeenCalledWith('invalid api key');
  });

  // Regression guard for PR #115: the call site `void`s this promise, so a
  // thrown network error used to escape as an unhandled rejection and the
  // banner stayed silent.
  it('routes a thrown network error to onVerifyFailure instead of rejecting', async () => {
    const { tab } = createTab();
    registerRenderer({ verifySetup: vi.fn().mockRejectedValue(new Error('net::ERR_NAME_NOT_RESOLVED')) });
    const btn = createVerifyButton();
    const onSuccess = vi.fn();
    const onFailure = vi.fn();

    await expect(
      tab.handleRpcVerifyClick(btn, createCredential(), onSuccess, onFailure),
    ).resolves.toBeUndefined();

    expect(onSuccess).not.toHaveBeenCalled();
    expect(onFailure).toHaveBeenCalledWith('net::ERR_NAME_NOT_RESOLVED');
    expect(btn.disabled).toBe(false);
    expect(btn.textContent).toBe(VERIFY_LABEL);
  });

  it('falls back to a generic message when a non-Error is thrown', async () => {
    const { tab } = createTab();
    registerRenderer({ verifySetup: vi.fn().mockRejectedValue('socket hang up') });
    const onFailure = vi.fn();

    await tab.handleRpcVerifyClick(createVerifyButton(), createCredential(), vi.fn(), onFailure);

    expect(onFailure).toHaveBeenCalledWith('Unknown error');
  });

  it('fails loudly when the provider does not implement verifySetup', async () => {
    const { tab } = createTab();
    registerRenderer({ verifySetup: undefined });
    const btn = createVerifyButton();
    const onFailure = vi.fn();

    await tab.handleRpcVerifyClick(btn, createCredential(), vi.fn(), onFailure);

    expect(onFailure).toHaveBeenCalledTimes(1);
    expect(onFailure.mock.calls[0][0]).toContain('verifySetup');
    expect(btn.disabled).toBe(false);
  });
});

describe('handleCredentialDeleteClick', () => {
  const cred: Credential = { id: 'cred-1', name: 'Supabase', type: 'supabase', projectUrl: 'u', apiKey: 'k' };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('refuses to arm delete for a credential still referenced by a config', async () => {
    const { tab, plugin } = createTab({
      credentials: [cred],
      configs: [{ id: 'cfg-1', name: 'Config 1', credentialId: 'cred-1' } as never],
    });

    await tab.handleCredentialDeleteClick(cred, false);

    expect(Notice).toHaveBeenCalledTimes(1);
    expect(tab.pendingDeleteCredentialId).toBeNull();
    expect(plugin.settings.credentials).toHaveLength(1);
    expect(plugin.saveSettings).not.toHaveBeenCalled();
  });

  it('arms the confirm state on the first click without deleting', async () => {
    const { tab, plugin } = createTab({ credentials: [cred], configs: [] });

    await tab.handleCredentialDeleteClick(cred, false);

    expect(tab.pendingDeleteCredentialId).toBe('cred-1');
    expect(plugin.settings.credentials).toHaveLength(1);
    expect(plugin.saveSettings).not.toHaveBeenCalled();
    expect(tab.display).toHaveBeenCalled();
  });

  it('deletes and persists on the confirming second click', async () => {
    const other: Credential = { id: 'cred-2', name: 'Airtable', type: 'airtable', apiKey: 'k' } as Credential;
    const { tab, plugin } = createTab({ credentials: [cred, other], configs: [] });

    await tab.handleCredentialDeleteClick(cred, true);

    expect(plugin.settings.credentials).toEqual([other]);
    expect(plugin.saveSettings).toHaveBeenCalledTimes(1);
    expect(tab.pendingDeleteCredentialId).toBeNull();
  });
});
