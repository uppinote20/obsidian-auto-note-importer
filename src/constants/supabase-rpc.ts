/**
 * Schema-introspection RPC fallback used when Supabase blocks OpenAPI access
 * for publishable keys (the new key system's intended policy).
 *
 * The SQL below defines a SECURITY DEFINER function that anon/authenticated
 * roles can EXECUTE to read information_schema. The response is shaped to
 * match PostgREST's OpenAPI `definitions` so the rest of SupabaseMetadataCache
 * (getTables / getColumns / detectPrimaryKey) keeps working unchanged.
 *
 * @handbook 4.4-provider-abstraction
 * @handbook 9.7-field-cache
 */

/** PostgREST RPC name (kept short + plugin-prefixed to avoid collisions). */
export const SUPABASE_RPC_SCHEMA_FN = 'ani_supabase_schema';

/**
 * One-time setup SQL the user runs in Supabase SQL Editor when their key
 * cannot read /rest/v1/ (i.e., publishable / new key system). Granting
 * EXECUTE to anon + authenticated lets the same RPC serve every key kind.
 *
 * The function:
 *  - lists every table + view in p_schema (defaults to 'public')
 *  - emits per-column { type, format, items, readOnly, description } shaped
 *    to mirror PostgREST's OpenAPI output exactly — so existing parsing
 *    (FieldTypeMapper, detectPrimaryKey) needs no provider-specific branch
 *  - marks GENERATED / non-updatable columns with `readOnly: true`
 *  - marks PK columns with `description: '<pk/>'` (the same hint PostgREST uses)
 *
 * Hardening notes:
 *  - `SET search_path = ''` prevents search-path hijacking — required for
 *    SECURITY DEFINER (every reference qualifies the schema explicitly)
 *  - parameters are bound, not interpolated — no SQL-injection surface
 *  - returns '{}' for an empty/unknown schema rather than NULL
 */
export const SUPABASE_RPC_SCHEMA_SQL = `\
-- Run once in Supabase SQL Editor. Re-running is safe (CREATE OR REPLACE).
-- Auto Note Importer uses this when the publishable key can't read
-- /rest/v1/ (Supabase's new key system blocks OpenAPI for publishable keys).
CREATE OR REPLACE FUNCTION public.${SUPABASE_RPC_SCHEMA_FN}(p_schema text DEFAULT 'public')
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
STABLE
AS $$
  WITH cols AS (
    SELECT
      c.table_name,
      c.column_name,
      c.data_type,
      c.is_generated,
      c.is_updatable,
      c.is_nullable
    FROM information_schema.columns c
    JOIN information_schema.tables t
      ON c.table_catalog = t.table_catalog
     AND c.table_schema  = t.table_schema
     AND c.table_name    = t.table_name
    WHERE c.table_schema = p_schema
      AND t.table_type IN ('BASE TABLE', 'VIEW')
  ),
  pks AS (
    SELECT kcu.table_name, kcu.column_name
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu
      ON tc.constraint_schema = kcu.constraint_schema
     AND tc.constraint_name   = kcu.constraint_name
    WHERE tc.constraint_type = 'PRIMARY KEY'
      AND tc.table_schema = p_schema
  )
  SELECT COALESCE(jsonb_object_agg(t.table_name, t.table_def), '{}'::jsonb)
  FROM (
    SELECT
      c.table_name,
      jsonb_build_object(
        'properties', jsonb_object_agg(c.column_name,
          jsonb_strip_nulls(jsonb_build_object(
            'type', CASE
              WHEN c.data_type = 'uuid' THEN 'string'
              WHEN c.data_type IN ('text','character varying','character','name','citext') THEN 'string'
              WHEN c.data_type IN ('smallint','integer','bigint','smallserial','serial','bigserial') THEN 'integer'
              WHEN c.data_type IN ('numeric','real','double precision','money') THEN 'number'
              WHEN c.data_type = 'boolean' THEN 'boolean'
              WHEN c.data_type = 'date' THEN 'string'
              WHEN c.data_type LIKE 'timestamp%' THEN 'string'
              WHEN c.data_type LIKE 'time%' THEN 'string'
              WHEN c.data_type IN ('json','jsonb') THEN 'string'
              WHEN c.data_type = 'ARRAY' THEN 'array'
              -- USER-DEFINED covers PostgreSQL enums, domains, and composite
              -- types. PostgREST serializes all of them as JSON strings, so
              -- map to 'string' here — otherwise the fail-closed
              -- FieldTypeMapper would treat them as read-only and drop them
              -- from upsert bodies.
              WHEN c.data_type = 'USER-DEFINED' THEN 'string'
              ELSE c.data_type
            END,
            'format', CASE
              WHEN c.data_type = 'uuid' THEN 'uuid'
              WHEN c.data_type IN ('integer','serial') THEN 'int32'
              WHEN c.data_type IN ('bigint','bigserial') THEN 'int64'
              WHEN c.data_type = 'date' THEN 'date'
              WHEN c.data_type LIKE 'timestamp%' THEN 'date-time'
              WHEN c.data_type = 'jsonb' THEN 'jsonb'
              WHEN c.data_type = 'json' THEN 'json'
              ELSE NULL
            END,
            'items', CASE
              WHEN c.data_type = 'ARRAY' THEN jsonb_build_object('type', 'string')
              ELSE NULL
            END,
            'readOnly', CASE
              WHEN c.is_generated = 'ALWAYS' OR c.is_updatable = 'NO' THEN true
              ELSE NULL
            END,
            'description', CASE
              WHEN EXISTS (SELECT 1 FROM pks p WHERE p.table_name = c.table_name AND p.column_name = c.column_name)
              THEN '<pk/>'
              ELSE NULL
            END
          ))
        ),
        'required', COALESCE(
          (SELECT jsonb_agg(c2.column_name)
           FROM cols c2 WHERE c2.table_name = c.table_name AND c2.is_nullable = 'NO'),
          '[]'::jsonb
        )
      ) AS table_def
    FROM cols c
    GROUP BY c.table_name
  ) t;
$$;

GRANT EXECUTE ON FUNCTION public.${SUPABASE_RPC_SCHEMA_FN}(text) TO anon, authenticated;
`;
