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
import { SUPABASE_DEFAULT_SCHEMA, SUPABASE_METADATA_TTL_MS } from '../constants';
import type {
  SupabaseCredential,
  SupabaseColumn,
  SupabaseOpenApiColumnDef,
  SupabaseOpenApiSpec,
  SupabaseTable,
  SupabaseView,
} from '../types';
import { extractApiErrorDetails, normalizeServerUrl } from '../utils';

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
    const url = `${projectUrl}/rest/v1/`;
    const response = await requestUrl({
      url,
      method: 'GET',
      headers: buildHeaders(credential, schema),
    });

    if (response.status !== 200) {
      throw new Error(`Failed to fetch Supabase OpenAPI spec: ${extractApiErrorDetails(response)}`);
    }

    const spec = (response.json ?? {}) as SupabaseOpenApiSpec;
    if (!spec.definitions) {
      throw new Error('Supabase OpenAPI response missing definitions.');
    }
    this.entries.set(key, { spec, fetchedAt: now });
    return spec;
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
