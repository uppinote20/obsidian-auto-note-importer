/**
 * Rate limiter service to prevent overwhelming the Airtable API.
 */

import { RATE_LIMIT_INTERVAL_MS, DEBUG_DELAY_MULTIPLIER } from '../constants';

/**
 * Rate limiter for API requests.
 * Ensures a minimum interval between consecutive requests.
 */
export class RateLimiter {
  private lastRequest = 0;
  private baseInterval: number;
  private minInterval: number;
  private debugMode = false;

  /**
   * Creates a new RateLimiter.
   * @param minInterval Minimum interval between requests in milliseconds
   */
  constructor(minInterval: number = RATE_LIMIT_INTERVAL_MS) {
    this.baseInterval = minInterval;
    this.minInterval = minInterval;
  }

  /**
   * Sets debug mode which multiplies all delays.
   * @param enabled Whether debug mode is enabled
   */
  setDebugMode(enabled: boolean): void {
    this.debugMode = enabled;
    this.minInterval = enabled
      ? this.baseInterval * DEBUG_DELAY_MULTIPLIER
      : this.baseInterval;
  }

  /**
   * Executes a request function with rate limiting.
   * Waits if necessary to respect the minimum interval.
   * @param requestFn Function that makes the actual request
   * @returns Promise resolving to the request result
   */
  async execute<T>(requestFn: () => Promise<T>): Promise<T> {
    const now = Date.now();
    const timeSinceLastRequest = now - this.lastRequest;

    if (timeSinceLastRequest < this.minInterval) {
      const delay = this.minInterval - timeSinceLastRequest;
      await this.sleep(delay);
    }

    this.lastRequest = Date.now();
    return await requestFn();
  }

  /**
   * Utility function to sleep for a given duration.
   * @param ms Milliseconds to sleep
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Resets the rate limiter state.
   */
  reset(): void {
    this.lastRequest = 0;
  }
}

/**
 * Singleton instance for shared rate limiting.
 */
let defaultRateLimiter: RateLimiter | null = null;

/**
 * Gets the default rate limiter instance.
 */
export function getDefaultRateLimiter(): RateLimiter {
  if (!defaultRateLimiter) {
    defaultRateLimiter = new RateLimiter();
  }
  return defaultRateLimiter;
}
