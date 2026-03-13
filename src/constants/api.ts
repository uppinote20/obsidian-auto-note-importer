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
 * Maximum number of retry attempts for 429 (rate-limited) responses.
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
