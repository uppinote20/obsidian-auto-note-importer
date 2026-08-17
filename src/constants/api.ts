/**
 * API-related constants.
 * @handbook 9.6-api-patterns
 */

import type { CredentialType } from '../types/credential.types';

/**
 * Airtable API batch size limit.
 */
export const AIRTABLE_BATCH_SIZE = 10;

/**
 * Minimum interval between API requests (in milliseconds).
 */
export const RATE_LIMIT_INTERVAL_MS = 200;

/**
 * Delay multiplier for debug/test mode.
 * All timing-related delays are multiplied by this value when debugMode is enabled.
 */
export const DEBUG_DELAY_MULTIPLIER = 5;

/**
 * Maximum folder depth for recursive scanning.
 */
export const MAX_FOLDER_DEPTH = 10;

/**
 * Maximum number of retry attempts for 429 responses and transient network errors.
 */
export const MAX_RETRY_ATTEMPTS = 3;

/**
 * Default delay when Retry-After header is absent (in milliseconds).
 */
export const DEFAULT_RETRY_DELAY_MS = 30_000;

/**
 * Base delay for network error retries with exponential backoff (in milliseconds).
 * Delay for attempt N: NETWORK_RETRY_BASE_DELAY_MS * 2^N
 * (e.g., 1s, 2s, 4s with MAX_RETRY_ATTEMPTS=3).
 */
export const NETWORK_RETRY_BASE_DELAY_MS = 1_000;

/**
 * Airtable API base URL.
 */
export const AIRTABLE_API_BASE_URL = 'https://api.airtable.com/v0';

/**
 * Airtable Meta API base URL.
 */
export const AIRTABLE_META_API_URL = 'https://api.airtable.com/v0/meta';

/**
 * SeaTable Cloud default server URL. Self-hosted users override this via
 * the SeaTableCredential.serverUrl field.
 */
export const SEATABLE_DEFAULT_SERVER_URL = 'https://cloud.seatable.io';

/**
 * SeaTable batch-update endpoint accepts up to 1000 rows per request.
 * @see https://api.seatable.com/reference/update-rows
 */
export const SEATABLE_BATCH_SIZE = 1000;

/**
 * Default page size for SeaTable list-rows pagination. The API caps
 * a single response at 1000 rows; we use that ceiling so each page
 * pulls the maximum allowed.
 */
export const SEATABLE_PAGE_SIZE = 1000;

/**
 * Safety margin (ms) subtracted from the Base-Token TTL before forcing
 * a refresh. SeaTable Base-Tokens issued via /api/v2.1/dtable/app-access-token/
 * are valid for 3 days; we refresh ~5 minutes before expiry to avoid using
 * a token that expires mid-request.
 */
export const SEATABLE_BASE_TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000;

/**
 * Default Base-Token TTL (3 days) used when the app-access-token response
 * does not include an explicit expiry.
 */
export const SEATABLE_BASE_TOKEN_TTL_MS = 3 * 24 * 60 * 60 * 1000;

/**
 * TTL for the cached column-name → column-type map (loadColumnTypes).
 */
export const SEATABLE_METADATA_TTL_MS = 10 * 60 * 1000;

/**
 * Default PostgreSQL schema exposed by Supabase. Most user tables live here.
 */
export const SUPABASE_DEFAULT_SCHEMA = 'public';

/**
 * Maximum rows per batchUpdate (PostgREST POST upsert).
 * PostgREST itself accepts more; we cap to keep single transactions short.
 */
export const SUPABASE_DEFAULT_BATCH_SIZE = 100;

/**
 * Default page size for fetchNotes Range-header pagination.
 * PostgREST caps a single response at db-pool max-rows (default 1000).
 */
export const SUPABASE_PAGE_SIZE = 1000;

/**
 * TTL for the cached OpenAPI spec per (credential, schema) tuple.
 */
export const SUPABASE_METADATA_TTL_MS = 10 * 60 * 1000;

/**
 * Notion REST API base URL.
 */
export const NOTION_API_BASE_URL = 'https://api.notion.com/v1';

/**
 * Notion-Version header value. Pinned so API responses don't shift under us.
 */
export const NOTION_VERSION = '2025-09-03';

/**
 * Minimum interval between Notion API requests (in milliseconds).
 * Notion enforces an average rate limit of ~3 requests/second per
 * integration; 334ms keeps us just under that.
 */
export const NOTION_RATE_LIMIT_INTERVAL_MS = 334;

/**
 * Default page size for Notion query/search pagination (API maximum).
 */
export const NOTION_PAGE_SIZE = 100;

/**
 * Notion has no native batch-update endpoint; pages are updated one at a
 * time via PATCH /pages/{id}. This caps how many concurrent in-flight
 * updates the client issues per batchUpdate() call.
 */
export const NOTION_BATCH_SIZE = 10;

/**
 * TTL for the cached data-source schema (property name → type map).
 */
export const NOTION_SCHEMA_TTL_MS = 10 * 60 * 1000;

/**
 * Notion rich_text content blocks are capped at 2000 characters each;
 * longer strings must be chunked into multiple segments.
 */
export const NOTION_RICH_TEXT_MAX_LEN = 2000;

/**
 * Per-provider override for the default RATE_LIMIT_INTERVAL_MS. Providers
 * not listed here fall back to the shared default in rate-limiter.ts.
 */
export const PROVIDER_RATE_LIMIT_INTERVALS: Partial<Record<CredentialType, number>> = {
  notion: NOTION_RATE_LIMIT_INTERVAL_MS,
};
