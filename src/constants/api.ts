/**
 * API-related constants.
 * @handbook 9.6-api-patterns
 */

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
