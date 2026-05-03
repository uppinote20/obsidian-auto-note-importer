/**
 * SeaTable credential form renderer.
 *
 * Draws the API Token + Server URL inputs, validates user input, and tests
 * the credential by exchanging the API-Token for a Base-Token via
 * /api/v2.1/dtable/app-access-token/. Self-hosted users override the default
 * cloud.seatable.io server URL.
 *
 * @handbook 4.4-provider-abstraction
 * @handbook 5.1-ui-components
 * @tested tests/services/seatable-credential-form.test.ts
 * @tested e2e:tests/e2e/run-seatable-e2e.mjs
 * @tested e2e:tests/e2e/run-seatable-settings-e2e.mjs
 */

import { Setting, requestUrl } from "obsidian";
import { SEATABLE_DEFAULT_SERVER_URL } from '../constants';
import type {
  ConnectionTestResult,
  Credential,
  CredentialBuildResult,
  CredentialFormRenderer,
  CredentialFormState,
} from '../types';
import { extractApiErrorMessage, normalizeServerUrl } from '../utils';

const TOKEN_KEY = 'apiToken';
const SERVER_KEY = 'serverUrl';

class SeaTableCredentialFormRendererImpl implements CredentialFormRenderer {
  readonly type = 'seatable' as const;
  readonly label = 'SeaTable';
  readonly description = 'API token created from Base settings → Advanced → API Tokens';

  renderFields(
    containerEl: HTMLElement,
    state: CredentialFormState,
    initial?: Credential,
  ): void {
    if (initial?.type === 'seatable') {
      if (state[TOKEN_KEY] === undefined) state[TOKEN_KEY] = initial.apiToken;
      if (state[SERVER_KEY] === undefined) state[SERVER_KEY] = initial.serverUrl;
    }

    const tokenSetting = new Setting(containerEl)
      .setName('API Token')
      .addText(text => {
        text
          .setValue(state[TOKEN_KEY] ?? '')
          .setPlaceholder('Base-specific API token')
          .onChange(value => { state[TOKEN_KEY] = value; });
        text.inputEl.type = 'password';
      });
    tokenSetting.settingEl.addClass('ani-credential-edit');

    const serverSetting = new Setting(containerEl)
      .setName('Server URL')
      .setDesc('Leave default for SeaTable Cloud. Self-hosted users enter their server URL.')
      .addText(text => text
        .setValue(state[SERVER_KEY] ?? '')
        .setPlaceholder(SEATABLE_DEFAULT_SERVER_URL)
        .onChange(value => { state[SERVER_KEY] = value; }));
    serverSetting.settingEl.addClass('ani-credential-edit');
  }

  build(name: string, state: CredentialFormState, id: string): CredentialBuildResult {
    const trimmedName = name.trim();
    if (!trimmedName) {
      return { ok: false, error: 'Credential name cannot be empty.' };
    }
    const apiToken = (state[TOKEN_KEY] ?? '').trim();
    if (!apiToken) {
      return { ok: false, error: 'API token cannot be empty.' };
    }
    const serverUrl = (state[SERVER_KEY] ?? '').trim() || SEATABLE_DEFAULT_SERVER_URL;
    if (!/^https?:\/\//.test(serverUrl)) {
      return { ok: false, error: 'Server URL must start with http:// or https://' };
    }
    return {
      ok: true,
      credential: {
        id,
        name: trimmedName,
        type: 'seatable',
        apiToken,
        serverUrl,
      },
    };
  }

  async testConnection(credential: Credential): Promise<ConnectionTestResult> {
    if (credential.type !== 'seatable') {
      return { success: false, error: `Expected seatable credential, got ${credential.type}` };
    }
    const serverUrl = normalizeServerUrl(credential.serverUrl, SEATABLE_DEFAULT_SERVER_URL);
    try {
      const response = await requestUrl({
        url: `${serverUrl}/api/v2.1/dtable/app-access-token/`,
        method: 'GET',
        headers: {
          'Authorization': `Token ${credential.apiToken}`,
          'Accept': 'application/json',
        },
      });
      if (response.status !== 200) {
        return {
          success: false,
          error: `HTTP ${response.status}: ${this.extractErrorMessage(response)}`,
        };
      }
      const json = response.json as { dtable_uuid?: string; access_token?: string } | undefined;
      if (!json?.access_token || !json?.dtable_uuid) {
        return { success: false, error: 'Authenticated but response missing dtable_uuid.' };
      }
      return {
        success: true,
        detail: `Base ${json.dtable_uuid.slice(0, 8)}… accessible`,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Network error';
      return { success: false, error: message };
    }
  }

  private extractErrorMessage(response: { json?: unknown; text?: string }): string {
    return extractApiErrorMessage(response);
  }
}

export const seatableCredentialFormRenderer: CredentialFormRenderer =
  new SeaTableCredentialFormRendererImpl();
