/**
 * Supabase credential form renderer + key-type auto-detection helper.
 *
 * The detected key kind is derived from the input value each render and is
 * not persisted on SupabaseCredential. The UI just surfaces a security hint
 * (RLS protected vs RLS bypassed) based on the prefix or decoded JWT role.
 *
 * @handbook 4.4-provider-abstraction
 * @handbook 5.1-ui-components
 * @tested tests/services/supabase-credential-form.test.ts
 */

import { Setting, requestUrl } from 'obsidian';
import type {
  ConnectionTestResult,
  Credential,
  CredentialBuildResult,
  CredentialFormRenderer,
  CredentialFormState,
} from '../types';
import { extractApiErrorMessage, normalizeServerUrl } from '../utils';
import { SUPABASE_RPC_SCHEMA_FN } from '../constants';

export type KeyKind =
  | 'publishable-new'
  | 'secret-new'
  | 'anon-legacy'
  | 'service-legacy'
  | 'unknown-jwt'
  | 'unknown';

export type KeyTone = 'ok' | 'warn' | 'neutral';

export interface KeyTypeInfo {
  kind: KeyKind;
  label: string;
  tone: KeyTone;
}

function decodeJwtPayload(token: string): { role?: string } | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    // `atob` returns a binary string where each character holds one byte; if
    // the payload contains UTF-8 multi-byte characters (Unicode display names,
    // non-ASCII custom claims) the resulting string corrupts the JSON. Route
    // through TextDecoder so multi-byte sequences are decoded correctly.
    if (typeof atob === 'function') {
      const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
      return JSON.parse(new TextDecoder().decode(bytes));
    }
    return JSON.parse(Buffer.from(base64, 'base64').toString('utf8'));
  } catch {
    return null;
  }
}

export function detectKeyType(key: string): KeyTypeInfo {
  if (key.startsWith('sb_publishable_')) {
    return { kind: 'publishable-new', label: 'Publishable key - RLS protected', tone: 'ok' };
  }
  if (key.startsWith('sb_secret_')) {
    return { kind: 'secret-new', label: 'Secret key - RLS bypassed, full DB access', tone: 'warn' };
  }
  if (key.startsWith('eyJ')) {
    const payload = decodeJwtPayload(key);
    if (payload?.role === 'anon') {
      return { kind: 'anon-legacy', label: 'Legacy anon key - RLS protected', tone: 'ok' };
    }
    if (payload?.role === 'service_role') {
      return { kind: 'service-legacy', label: 'Legacy service_role key - RLS bypassed', tone: 'warn' };
    }
    return { kind: 'unknown-jwt', label: 'Unrecognized JWT key', tone: 'neutral' };
  }
  return { kind: 'unknown', label: 'Unrecognized key format', tone: 'neutral' };
}

const PROJECT_URL_KEY = 'projectUrl';
const API_KEY_KEY = 'apiKey';

class SupabaseCredentialFormRendererImpl implements CredentialFormRenderer {
  readonly type = 'supabase' as const;
  readonly label = 'Supabase';
  readonly description = 'PostgREST endpoint URL + publishable or secret key';

  renderFields(
    containerEl: HTMLElement,
    state: CredentialFormState,
    initial?: Credential,
  ): void {
    if (initial?.type === 'supabase') {
      if (state[PROJECT_URL_KEY] === undefined) state[PROJECT_URL_KEY] = initial.projectUrl;
      if (state[API_KEY_KEY] === undefined) state[API_KEY_KEY] = initial.apiKey;
    }

    const urlSetting = new Setting(containerEl)
      .setName('Project URL')
      .setDesc('e.g. https://<ref>.supabase.co')
      .addText(text => text
        .setValue(state[PROJECT_URL_KEY] ?? '')
        .setPlaceholder('https://abc.supabase.co')
        .onChange(value => { state[PROJECT_URL_KEY] = value; }));
    urlSetting.settingEl.addClass('ani-credential-edit');

    const hintEl = containerEl.createDiv({ cls: 'ani-credential-hint' });
    const updateHint = (key: string) => {
      hintEl.empty();
      if (!key) { hintEl.setText(''); return; }
      const info = detectKeyType(key);
      hintEl.setText(info.label);
      hintEl.removeClass('ani-tone-ok', 'ani-tone-warn', 'ani-tone-neutral');
      hintEl.addClass(`ani-tone-${info.tone}`);
    };

    const keySetting = new Setting(containerEl)
      .setName('API Key')
      .setDesc('Publishable (sb_publishable_...) or legacy anon JWT recommended. Secret/service_role bypass RLS.')
      .addText(text => {
        text
          .setValue(state[API_KEY_KEY] ?? '')
          .setPlaceholder('sb_publishable_... or eyJ...')
          .onChange(value => {
            state[API_KEY_KEY] = value;
            updateHint(value);
          });
        text.inputEl.type = 'password';
      });
    keySetting.settingEl.addClass('ani-credential-edit');
    updateHint(state[API_KEY_KEY] ?? '');
  }

  build(name: string, state: CredentialFormState, id: string): CredentialBuildResult {
    const trimmedName = name.trim();
    if (!trimmedName) return { ok: false, error: 'Credential name cannot be empty.' };

    const projectUrl = normalizeServerUrl(state[PROJECT_URL_KEY], '');
    if (!projectUrl) return { ok: false, error: 'Project URL cannot be empty.' };
    if (!/^https?:\/\//.test(projectUrl)) {
      return { ok: false, error: 'Project URL must start with http:// or https://' };
    }

    const apiKey = (state[API_KEY_KEY] ?? '').trim();
    if (!apiKey) return { ok: false, error: 'API key cannot be empty.' };

    return {
      ok: true,
      credential: { id, name: trimmedName, type: 'supabase', projectUrl, apiKey },
    };
  }

  async testConnection(credential: Credential): Promise<ConnectionTestResult> {
    if (credential.type !== 'supabase') {
      return { success: false, error: `Expected supabase credential, got ${credential.type}` };
    }
    const projectUrl = normalizeServerUrl(credential.projectUrl, '');
    if (!projectUrl) return { success: false, error: 'Project URL is empty.' };
    const baseHeaders = {
      'apikey': credential.apiKey,
      'Authorization': `Bearer ${credential.apiKey}`,
    };

    // Step 1: prefer the native OpenAPI endpoint (legacy anon JWT / secret).
    try {
      const response = await requestUrl({
        url: `${projectUrl}/rest/v1/`,
        method: 'GET',
        headers: { ...baseHeaders, 'Accept': 'application/openapi+json' },
        throw: false,
      });
      if (response.status === 200) {
        const spec = response.json as { definitions?: Record<string, unknown> } | undefined;
        const tableCount = spec?.definitions ? Object.keys(spec.definitions).length : 0;
        return { success: true, detail: `Connected - ${tableCount} endpoints visible` };
      }
      if (response.status !== 401) {
        return { success: false, error: `HTTP ${response.status}: ${extractApiErrorMessage(response)}` };
      }
      // 401 → fall through to RPC fallback (publishable-key path).
    } catch (error) {
      // Older Obsidian builds reject on 4xx ignoring throw:false. Fall
      // through to RPC unless it's clearly a non-HTTP failure.
      const err = error as { status?: number; message?: string };
      if (typeof err.status !== 'number') {
        return { success: false, error: err.message ?? 'Network error' };
      }
      if (err.status !== 401) {
        return { success: false, error: `HTTP ${err.status}: ${err.message ?? 'unknown'}` };
      }
    }

    // Step 2: publishable-key path — call the RPC fallback. 200 = installed,
    // 4xx with PGRST202 / "function does not exist" = key works but RPC not
    // installed yet (still a successful auth test).
    try {
      const rpc = await requestUrl({
        url: `${projectUrl}/rest/v1/rpc/${SUPABASE_RPC_SCHEMA_FN}`,
        method: 'POST',
        headers: { ...baseHeaders, 'Accept': 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ p_schema: 'public' }),
        throw: false,
      });
      if (rpc.status === 200) {
        const defs = rpc.json as Record<string, unknown> | undefined;
        const tableCount = defs && typeof defs === 'object' && !Array.isArray(defs) ? Object.keys(defs).length : 0;
        return { success: true, detail: `Connected via RPC - ${tableCount} endpoints visible` };
      }
      const body = rpc.json as { code?: string; message?: string } | undefined;
      const rpcMissing = body?.code === 'PGRST202' ||
        (typeof body?.message === 'string' && /function .* does not exist/i.test(body.message));
      if (rpcMissing) {
        return {
          success: true,
          detail: 'Publishable key authenticates — run the setup SQL (settings card) to enable schema introspection.',
        };
      }
      return { success: false, error: `HTTP ${rpc.status}: ${extractApiErrorMessage(rpc)}` };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Network error' };
    }
  }
}

export const supabaseCredentialFormRenderer: CredentialFormRenderer =
  new SupabaseCredentialFormRendererImpl();
