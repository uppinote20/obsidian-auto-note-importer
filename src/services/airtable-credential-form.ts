/**
 * Airtable credential form renderer.
 *
 * Draws the API Key input, validates user input, and tests the credential
 * by calling Airtable's Meta API `/v0/meta/bases` endpoint. Registered
 * with the provider registry as the built-in 'airtable' renderer.
 *
 * @handbook 4.4-provider-abstraction
 * @handbook 5.1-ui-components
 * @tested tests/services/airtable-credential-form.test.ts
 */

import { Setting, requestUrl } from "obsidian";
import { AIRTABLE_META_API_URL } from '../constants';
import type {
  CredentialFormRenderer,
  CredentialFormState,
  CredentialBuildResult,
  ConnectionTestResult,
  Credential,
} from '../types';

const STATE_KEY = 'apiKey';

class AirtableCredentialFormRendererImpl implements CredentialFormRenderer {
  readonly type = 'airtable' as const;
  readonly label = 'Airtable';
  readonly description = 'Personal access token from airtable.com/create/tokens';

  renderFields(
    containerEl: HTMLElement,
    state: CredentialFormState,
    initial?: Credential,
  ): void {
    if (initial?.type === 'airtable' && state[STATE_KEY] === undefined) {
      state[STATE_KEY] = initial.apiKey;
    }

    const setting = new Setting(containerEl)
      .setName('API Key')
      .addText(text => {
        text
          .setValue(state[STATE_KEY] ?? '')
          .setPlaceholder('pat-xxx...')
          .onChange(value => { state[STATE_KEY] = value; });
        text.inputEl.type = 'password';
      });
    setting.settingEl.addClass('ani-credential-edit');
  }

  build(name: string, state: CredentialFormState, id: string): CredentialBuildResult {
    const trimmedName = name.trim();
    if (!trimmedName) {
      return { ok: false, error: 'Credential name cannot be empty.' };
    }
    const apiKey = (state[STATE_KEY] ?? '').trim();
    if (!apiKey) {
      return { ok: false, error: 'API key cannot be empty.' };
    }
    return {
      ok: true,
      credential: {
        id,
        name: trimmedName,
        type: 'airtable',
        apiKey,
      },
    };
  }

  async testConnection(credential: Credential): Promise<ConnectionTestResult> {
    if (credential.type !== 'airtable') {
      return { success: false, error: `Expected airtable credential, got ${credential.type}` };
    }
    try {
      const response = await requestUrl({
        url: `${AIRTABLE_META_API_URL}/bases`,
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${credential.apiKey}`,
          'Content-Type': 'application/json',
        },
      });
      if (response.status !== 200) {
        return {
          success: false,
          error: `HTTP ${response.status}: ${this.extractErrorMessage(response)}`,
        };
      }
      const baseCount = Array.isArray(response.json?.bases) ? response.json.bases.length : 0;
      return {
        success: true,
        detail: baseCount > 0 ? `${baseCount} base(s) accessible` : 'Authenticated (no bases found)',
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Network error';
      return { success: false, error: message };
    }
  }

  private extractErrorMessage(response: { json?: unknown }): string {
    const json = response.json as { error?: { message?: string } | string } | undefined;
    if (typeof json?.error === 'string') return json.error;
    if (json?.error && typeof json.error === 'object' && json.error.message) {
      return json.error.message;
    }
    return 'Unknown error';
  }
}

export const airtableCredentialFormRenderer: CredentialFormRenderer = new AirtableCredentialFormRendererImpl();
