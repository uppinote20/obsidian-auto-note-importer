/**
 * Notion credential form renderer.
 *
 * Single field (integrationToken). testConnection reuses NotionSchemaCache's
 * already-tested listDataSources pagination instead of duplicating raw
 * requestUrl calls — unlike the Supabase/SeaTable forms (which have no
 * shared cache to call into and so probe the API directly), a
 * NotionSchemaCache instance is cheap to construct here without adding a
 * construction-order dependency on ConfigManager. listDataSources() now
 * caches per credential.id, so testConnection clears that entry first —
 * a "Test connection" click means "probe right now", not "read a
 * potentially-stale cached list".
 *
 * This form-local instance is a DIFFERENT NotionSchemaCache object than
 * main.ts's SharedServices one, but both default-construct their pacing
 * through `defaultRateLimiters` (services/rate-limiter.ts), a module-level
 * Map keyed by credential.id — so requests fired from here and from sync
 * still share one RateLimiter per credential (PR #125 Codex P2).
 *
 * @handbook 4.4-provider-abstraction
 * @handbook 5.1-ui-components
 * @tested tests/services/notion-credential-form.test.ts
 * @tested e2e:tests/e2e/run-notion-settings-e2e.mjs
 */

import { Setting } from 'obsidian';
import type {
  ConnectionTestResult,
  Credential,
  CredentialBuildResult,
  CredentialFormRenderer,
  CredentialFormState,
} from '../types';
import { NotionSchemaCache } from './notion-schema-cache';

const INTEGRATION_TOKEN_KEY = 'integrationToken';

const schemaCache = new NotionSchemaCache();

function detectTokenHint(token: string): { label: string; tone: 'ok' | 'warn' | 'neutral' } {
  if (!token) return { label: '', tone: 'neutral' };
  if (token.startsWith('ntn_') || token.startsWith('secret_')) {
    return { label: 'Notion internal integration token', tone: 'ok' };
  }
  return { label: 'Doesn’t look like a Notion integration token (ntn_…)', tone: 'warn' };
}

class NotionCredentialFormRendererImpl implements CredentialFormRenderer {
  readonly type = 'notion' as const;
  readonly label = 'Notion';
  readonly description =
    'Create an internal integration at notion.so/profile/integrations, then share each database you want to sync with it via ••• → Connections.';

  renderFields(
    containerEl: HTMLElement,
    state: CredentialFormState,
    initial?: Credential,
  ): void {
    if (initial?.type === 'notion') {
      if (state[INTEGRATION_TOKEN_KEY] === undefined) state[INTEGRATION_TOKEN_KEY] = initial.integrationToken;
    }

    const hintEl = containerEl.createDiv({ cls: 'ani-credential-hint' });
    const updateHint = (token: string) => {
      hintEl.empty();
      if (!token) { hintEl.setText(''); return; }
      const info = detectTokenHint(token);
      hintEl.setText(info.label);
      hintEl.removeClass('ani-tone-ok', 'ani-tone-warn', 'ani-tone-neutral');
      hintEl.addClass(`ani-tone-${info.tone}`);
    };

    const tokenSetting = new Setting(containerEl)
      .setName('Integration token')
      .setDesc('Internal integration secret from your Notion integration settings.')
      .addText(text => {
        text
          .setValue(state[INTEGRATION_TOKEN_KEY] ?? '')
          .setPlaceholder('ntn_... or secret_...')
          .onChange(value => {
            state[INTEGRATION_TOKEN_KEY] = value;
            updateHint(value);
          });
        text.inputEl.type = 'password';
      });
    tokenSetting.settingEl.addClass('ani-credential-edit');
    updateHint(state[INTEGRATION_TOKEN_KEY] ?? '');
  }

  build(name: string, state: CredentialFormState, id: string): CredentialBuildResult {
    const trimmedName = name.trim();
    if (!trimmedName) return { ok: false, error: 'Credential name cannot be empty.' };

    const integrationToken = (state[INTEGRATION_TOKEN_KEY] ?? '').trim();
    if (!integrationToken) return { ok: false, error: 'Integration token cannot be empty.' };

    return {
      ok: true,
      credential: { id, name: trimmedName, type: 'notion', integrationToken },
    };
  }

  async testConnection(credential: Credential): Promise<ConnectionTestResult> {
    if (credential.type !== 'notion') {
      return { success: false, error: `Expected notion credential, got ${credential.type}` };
    }
    try {
      schemaCache.clearForCred(credential.id);
      const dataSources = await schemaCache.listDataSources(credential);
      if (dataSources.length === 0) {
        return {
          success: true,
          detail: 'Connected, but no data sources are shared with this integration yet — open your database in Notion → ••• → Connections → add this integration.',
        };
      }
      const count = dataSources.length;
      return { success: true, detail: `Connected — ${count} data source${count === 1 ? '' : 's'} shared with this integration` };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Network error' };
    }
  }
}

export const notionCredentialFormRenderer: CredentialFormRenderer =
  new NotionCredentialFormRendererImpl();
