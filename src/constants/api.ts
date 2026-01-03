/**
 * API-related constants.
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
 * Default delay for file change debouncing (in milliseconds).
 */
export const FILE_CHANGE_DEBOUNCE_MS = 2000;

/**
 * Default delay for formula sync (in milliseconds).
 */
export const DEFAULT_FORMULA_SYNC_DELAY_MS = 1500;

/**
 * Maximum folder depth for recursive scanning.
 */
export const MAX_FOLDER_DEPTH = 10;

/**
 * Airtable API base URL.
 */
export const AIRTABLE_API_BASE_URL = 'https://api.airtable.com/v0';

/**
 * Airtable Meta API base URL.
 */
export const AIRTABLE_META_API_URL = 'https://api.airtable.com/v0/meta';
