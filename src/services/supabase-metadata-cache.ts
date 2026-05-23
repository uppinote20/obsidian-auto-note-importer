/**
 * Per-credential per-schema OpenAPI metadata cache.
 *
 * The settings tab needs metadata before any ConfigInstance exists for that
 * credential, so this cache is a SharedServices-owned singleton (parallel to
 * SeaTableMetadataCache).
 *
 * @handbook 4.4-provider-abstraction
 * @handbook 9.6-api-patterns
 * @tested tests/services/supabase-metadata-cache.test.ts
 */

import { requestUrl } from 'obsidian';
import {
  SUPABASE_DEFAULT_SCHEMA,
  SUPABASE_METADATA_TTL_MS,
  SUPABASE_RPC_SCHEMA_FN,
} from '../constants';
import type {
  SupabaseCredential,
  SupabaseColumn,
  SupabaseOpenApiColumnDef,
  SupabaseOpenApiSpec,
  SupabaseTable,
  SupabaseView,
} from '../types';
import { extractApiErrorDetails, normalizeServerUrl } from '../utils';

/**
 * Error subclass thrown when neither OpenAPI nor the RPC fallback can return
 * a schema spec — used by the settings UI to render the "Run this SQL" banner
 * specifically (instead of a generic network-failure message).
 */
export class SupabaseSchemaRpcMissingError extends Error {
  readonly kind = 'rpc-missing' as const;
  constructor(message: string) { super(message); this.name = 'SupabaseSchemaRpcMissingError'; }
}

interface CacheEntry {
  spec: SupabaseOpenApiSpec;
  fetchedAt: number;
}

const PK_MARKER = '<pk/>';

function buildKey(credentialId: string, schema: string): string {
  return `${credentialId}:${schema}`;
}

function buildHeaders(credential: SupabaseCredential, schema: string): Record<string, string> {
  const headers: Record<string, string> = {
    'apikey': credential.apiKey,
    'Authorization': `Bearer ${credential.apiKey}`,
    'Accept': 'application/openapi+json',
  };
  if (schema && schema !== SUPABASE_DEFAULT_SCHEMA) {
    headers['Accept-Profile'] = schema;
  }
  return headers;
}

function hasPkColumn(def: { properties?: Record<string, SupabaseOpenApiColumnDef> }): boolean {
  for (const col of Object.values(def.properties ?? {})) {
    if (typeof col.description === 'string' && col.description.includes(PK_MARKER)) {
      return true;
    }
  }
  return false;
}

function composeProviderType(col: SupabaseOpenApiColumnDef): string {
  if (col.type === 'array') {
    const elemType = col.items?.type ?? 'unknown';
    return `array:${elemType}${col.readOnly ? ':readonly' : ''}`;
  }
  const type = col.type ?? 'unknown';
  const format = col.format ? `:${col.format}` : '';
  const ro = col.readOnly ? ':readonly' : '';
  return `${type}${format}${ro}`;
}

function extractColumns(def: { properties?: Record<string, SupabaseOpenApiColumnDef> }): SupabaseColumn[] {
  const out: SupabaseColumn[] = [];
  for (const [name, col] of Object.entries(def.properties ?? {})) {
    out.push({
      name,
      providerType: composeProviderType(col),
      isPk: typeof col.description === 'string' && col.description.includes(PK_MARKER),
      default: col.default !== undefined ? String(col.default) : undefined,
    });
  }
  return out;
}

export class SupabaseMetadataCache {
  private entries = new Map<string, CacheEntry>();

  async getSpec(credential: SupabaseCredential, schema: string): Promise<SupabaseOpenApiSpec> {
    const key = buildKey(credential.id, schema);
    const now = Date.now();
    const cached = this.entries.get(key);
    if (cached && now - cached.fetchedAt < SUPABASE_METADATA_TTL_MS) {
      return cached.spec;
    }

    const projectUrl = normalizeServerUrl(credential.projectUrl, '');
    if (!projectUrl) {
      throw new Error('Supabase projectUrl must be set.');
    }

    // Step 1: try the native OpenAPI endpoint. Works for legacy anon JWT keys
    // and (server-side) secret keys; new publishable keys get HTTP 401 by
    // Supabase's intended policy.
    let response: Awaited<ReturnType<typeof requestUrl>>;
    try {
      response = await requestUrl({
        url: `${projectUrl}/rest/v1/`,
        method: 'GET',
        headers: buildHeaders(credential, schema),
        throw: false,
      });
    } catch (e) {
      // Older Obsidian builds ignore `throw: false` and reject on 4xx/5xx.
      // Recover the response shape the rest of this method expects.
      const err = e as { status?: number; headers?: Record<string, string>; json?: unknown; text?: string };
      if (typeof err.status !== 'number') throw e;
      response = {
        status: err.status,
        headers: err.headers ?? {},
        json: err.json,
        text: err.text ?? '',
        arrayBuffer: new ArrayBuffer(0),
      } as Awaited<ReturnType<typeof requestUrl>>;
    }

    if (response.status === 200) {
      const spec = (response.json ?? {}) as SupabaseOpenApiSpec;
      if (!spec.definitions) {
        throw new Error('Supabase OpenAPI response missing definitions.');
      }
      this.entries.set(key, { spec, fetchedAt: now });
      return spec;
    }

    // Step 2: 401 → publishable-key path. Fall back to the user-installed
    // SECURITY DEFINER RPC that exposes information_schema in OpenAPI shape.
    // Any other status is a real error (network, projectUrl typo, etc.).
    if (response.status !== 401) {
      throw new Error(`Failed to fetch Supabase OpenAPI spec: ${extractApiErrorDetails(response)}`);
    }

    const spec = await this.fetchSpecViaRpc(credential, schema, projectUrl);
    this.entries.set(key, { spec, fetchedAt: now });
    return spec;
  }

  private async fetchSpecViaRpc(
    credential: SupabaseCredential,
    schema: string,
    projectUrl: string,
  ): Promise<SupabaseOpenApiSpec> {
    const rpcUrl = `${projectUrl}/rest/v1/rpc/${SUPABASE_RPC_SCHEMA_FN}`;
    let rpcResponse: Awaited<ReturnType<typeof requestUrl>>;
    try {
      rpcResponse = await requestUrl({
        url: rpcUrl,
        method: 'POST',
        headers: {
          // Reuse the apikey/Authorization/Accept-Profile from buildHeaders
          // but override Accept — RPC returns plain JSON, not the OpenAPI
          // media type, and PostgREST returns 406 PGRST107 otherwise.
          ...buildHeaders(credential, schema),
          'Accept': 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ p_schema: schema }),
        throw: false,
      });
    } catch (e) {
      const err = e as { status?: number; headers?: Record<string, string>; json?: unknown; text?: string };
      if (typeof err.status !== 'number') throw e;
      rpcResponse = {
        status: err.status,
        headers: err.headers ?? {},
        json: err.json,
        text: err.text ?? '',
        arrayBuffer: new ArrayBuffer(0),
      } as Awaited<ReturnType<typeof requestUrl>>;
    }

    if (rpcResponse.status === 404 || rpcResponse.status === 400) {
      // 404 = function not yet installed in this project.
      // 400 = some Supabase deployments surface "function does not exist" as 400.
      throw new SupabaseSchemaRpcMissingError(
        `Supabase schema introspection unavailable. Run the one-time setup SQL ` +
        `(Settings → Supabase Connection → "Copy SQL") in your Supabase SQL Editor.`,
      );
    }

    if (rpcResponse.status !== 200) {
      throw new Error(`Failed to fetch Supabase schema via RPC: ${extractApiErrorDetails(rpcResponse)}`);
    }

    const definitions = rpcResponse.json as Record<string, unknown> | undefined;
    if (!definitions || typeof definitions !== 'object') {
      throw new Error('Supabase RPC schema response was not a JSON object.');
    }
    return { definitions } as SupabaseOpenApiSpec;
  }

  async refresh(credential: SupabaseCredential, schema: string): Promise<void> {
    this.entries.delete(buildKey(credential.id, schema));
    await this.getSpec(credential, schema);
  }

  clearForCred(credentialId: string): void {
    for (const key of [...this.entries.keys()]) {
      if (key.startsWith(`${credentialId}:`)) {
        this.entries.delete(key);
      }
    }
  }

  clear(): void {
    this.entries.clear();
  }

  getTables(spec: SupabaseOpenApiSpec): SupabaseTable[] {
    return this.classify(spec, 'table');
  }

  getViews(spec: SupabaseOpenApiSpec): SupabaseView[] {
    return this.classify(spec, 'view');
  }

  getColumns(spec: SupabaseOpenApiSpec, name: string): SupabaseColumn[] {
    const def = spec.definitions?.[name];
    if (!def) return [];
    return extractColumns(def);
  }

  detectPrimaryKey(spec: SupabaseOpenApiSpec, table: string): string | null {
    const def = spec.definitions?.[table];
    if (!def) return null;

    for (const [name, col] of Object.entries(def.properties ?? {})) {
      if (typeof col.description === 'string' && col.description.includes(PK_MARKER)) {
        return name;
      }
    }
    // No `required[0]` fallback: OpenAPI `required` is an unordered set of
    // NOT NULL columns, not an ordered PK list. Views never have <pk/>
    // markers, so trusting `required[0]` would auto-save a wrong PK and
    // cause on_conflict failures or duplicate rows on every upsert.
    if (def.properties?.['id']) return 'id';
    if (def.properties?.['uuid']) return 'uuid';
    return null;
  }

  private classify(spec: SupabaseOpenApiSpec, want: 'table' | 'view'): SupabaseTable[] {
    const out: SupabaseTable[] = [];
    for (const [name, def] of Object.entries(spec.definitions ?? {})) {
      const isTable = hasPkColumn(def);
      if ((want === 'table') === isTable) {
        out.push({ name, columns: extractColumns(def) });
      }
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }
}
