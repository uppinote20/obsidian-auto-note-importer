/**
 * Rate limiter service to prevent overwhelming the Airtable API.
 *
 * @handbook 9.6-api-patterns
 */

import {
  RATE_LIMIT_INTERVAL_MS,
  DEBUG_DELAY_MULTIPLIER,
  MAX_RETRY_ATTEMPTS,
  DEFAULT_RETRY_DELAY_MS,
  NETWORK_RETRY_BASE_DELAY_MS,
} from '../constants';

/** Shape of a response that can be checked for 429 status. */
interface RetryableResponse {
  status: number;
  headers: Record<string, string>;
}

/**
 * Classifies whether a thrown error is transient (worth retrying) or permanent.
 * - No status property → network error (DNS, timeout, connection reset) → transient
 * - 408/429 → transient
 * - 4xx → permanent (auth, validation errors)
 * - 5xx and others → transient
 */
function isTransientError(error: unknown): boolean {
  const status = (error as Record<string, unknown>)?.status;
  if (typeof status !== 'number') return true;
  if (status === 408 || status === 429) return true;
  return status < 400 || status >= 500;
}

/** Duck-type check: does the value look like an HTTP response with status and headers? */
function isRetryableResponse(value: unknown): value is RetryableResponse {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v['status'] === 'number' && typeof v['headers'] === 'object' && v['headers'] !== null;
}

/**
 * Parses the Retry-After header value into milliseconds.
 * Handles case-insensitive header lookup.
 * Returns DEFAULT_RETRY_DELAY_MS when header is absent or unparseable.
 *
 * Note: Only supports delay-seconds format (e.g. "30").
 * HTTP-date format (RFC 7231 §7.1.3) falls back to DEFAULT_RETRY_DELAY_MS.
 */
function parseRetryAfter(headers: Record<string, string>): number {
  const key = Object.keys(headers).find(k => k.toLowerCase() === 'retry-after');
  if (!key) return DEFAULT_RETRY_DELAY_MS;

  const seconds = Number(headers[key]);
  return Number.isNaN(seconds) || seconds <= 0 ? DEFAULT_RETRY_DELAY_MS : seconds * 1000;
}

/**
 * Rate limiter for API requests.
 * Ensures a minimum interval between consecutive requests
 * and retries on 429 (Too Many Requests) responses.
 */
export class RateLimiter {
  private lastRequest = 0;
  private baseInterval: number;
  private minInterval: number;
  private maxRetries: number;

  /**
   * Creates a new RateLimiter.
   * @param minInterval Minimum interval between requests in milliseconds
   * @param maxRetries Maximum retry attempts for 429 responses
   */
  constructor(
    minInterval: number = RATE_LIMIT_INTERVAL_MS,
    maxRetries: number = MAX_RETRY_ATTEMPTS,
  ) {
    this.baseInterval = minInterval;
    this.minInterval = minInterval;
    this.maxRetries = maxRetries;
  }

  /**
   * Sets debug mode which multiplies all delays.
   * @param enabled Whether debug mode is enabled
   */
  setDebugMode(enabled: boolean): void {
    this.minInterval = enabled
      ? this.baseInterval * DEBUG_DELAY_MULTIPLIER
      : this.baseInterval;
  }

  /**
   * Executes a request function with rate limiting and 429 retry.
   * Waits if necessary to respect the minimum interval.
   * On 429 responses, waits for the Retry-After duration and retries.
   * @param requestFn Function that makes the actual request
   * @returns Promise resolving to the request result
   */
  async execute<T>(requestFn: () => Promise<T>): Promise<T> {
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      const now = Date.now();
      const timeSinceLastRequest = now - this.lastRequest;

      if (timeSinceLastRequest < this.minInterval) {
        const delay = this.minInterval - timeSinceLastRequest;
        await this.sleep(delay);
      }

      this.lastRequest = Date.now();

      try {
        const result = await requestFn();

        if (isRetryableResponse(result) && result.status === 429) {
          if (attempt >= this.maxRetries) return result;
          await this.sleep(parseRetryAfter(result.headers));
          continue;
        }

        return result;
      } catch (error) {
        if (!isTransientError(error) || attempt >= this.maxRetries) {
          throw error;
        }
        const backoffDelay = NETWORK_RETRY_BASE_DELAY_MS * Math.pow(2, attempt);
        await this.sleep(backoffDelay);
      }
    }

    /* istanbul ignore next -- unreachable: loop always returns or throws */
    throw new Error('Unexpected state in rate limiter retry loop');
  }

  /**
   * Utility function to sleep for a given duration.
   * @param ms Milliseconds to sleep
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

}
