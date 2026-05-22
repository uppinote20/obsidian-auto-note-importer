/**
 * Supabase / PostgREST OpenAPI 2.0 metadata types.
 *
 * Parsed subset of the spec returned by GET {projectUrl}/rest/v1/
 * (with `Accept: application/openapi+json`).
 *
 * @handbook 4.4-provider-abstraction
 */

export type SupabaseProviderType = string;

export interface SupabaseColumn {
  name: string;
  providerType: SupabaseProviderType;
  isPk: boolean;
  default?: string;
}

export interface SupabaseTable {
  name: string;
  columns: SupabaseColumn[];
}

export type SupabaseView = SupabaseTable;

export interface SupabaseOpenApiColumnDef {
  type?: string;
  format?: string;
  description?: string;
  readOnly?: boolean;
  default?: unknown;
  items?: { type?: string; format?: string };
}

export interface SupabaseOpenApiDefinition {
  description?: string;
  required?: string[];
  properties?: Record<string, SupabaseOpenApiColumnDef>;
}

export interface SupabaseOpenApiSpec {
  swagger?: string;
  info?: { title?: string; version?: string };
  definitions: Record<string, SupabaseOpenApiDefinition>;
  paths?: Record<string, unknown>;
}
