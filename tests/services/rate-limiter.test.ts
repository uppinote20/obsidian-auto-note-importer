/**
 * Tests for rate-limiter service.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RateLimiter } from '../../src/services/rate-limiter';
import {
  RATE_LIMIT_INTERVAL_MS,
  DEBUG_DELAY_MULTIPLIER,
  DEFAULT_RETRY_DELAY_MS,
} from '../../src/constants';

describe('RateLimiter', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('constructor', () => {
    it('should use default interval from constants', async () => {
      const limiter = new RateLimiter();
      const mockFn = vi.fn().mockResolvedValue('result');

      await limiter.execute(mockFn);
      const secondPromise = limiter.execute(mockFn);

      await vi.advanceTimersByTimeAsync(RATE_LIMIT_INTERVAL_MS);
      await secondPromise;

      expect(mockFn).toHaveBeenCalledTimes(2);
    });

    it('should accept custom interval and enforce it', async () => {
      const limiter = new RateLimiter(500);
      const mockFn = vi.fn().mockResolvedValue('result');

      await limiter.execute(mockFn);
      const secondPromise = limiter.execute(mockFn);

      // Should NOT complete after 200ms (default interval)
      await vi.advanceTimersByTimeAsync(200);
      expect(mockFn).toHaveBeenCalledTimes(1);

      // Should complete after 500ms (custom interval)
      await vi.advanceTimersByTimeAsync(300);
      await secondPromise;
      expect(mockFn).toHaveBeenCalledTimes(2);
    });
  });

  describe('execute', () => {
    it('should execute request immediately on first call', async () => {
      const limiter = new RateLimiter(200);
      const mockFn = vi.fn().mockResolvedValue('result');

      const resultPromise = limiter.execute(mockFn);
      await vi.runAllTimersAsync();
      const result = await resultPromise;

      expect(mockFn).toHaveBeenCalledTimes(1);
      expect(result).toBe('result');
    });

    it('should delay subsequent calls to respect interval', async () => {
      const limiter = new RateLimiter(200);
      const mockFn = vi.fn().mockResolvedValue('result');

      // First call
      await limiter.execute(mockFn);

      // Second call should be delayed
      const secondPromise = limiter.execute(mockFn);

      // Before timer advances, should still be 1 call
      expect(mockFn).toHaveBeenCalledTimes(1);

      // Advance time
      await vi.advanceTimersByTimeAsync(200);
      await secondPromise;

      expect(mockFn).toHaveBeenCalledTimes(2);
    });

    it('should return request function result', async () => {
      const limiter = new RateLimiter(200);
      const mockFn = vi.fn().mockResolvedValue({ data: 'test' });

      const result = await limiter.execute(mockFn);

      expect(result).toEqual({ data: 'test' });
    });

    it('should propagate errors from request function', async () => {
      const limiter = new RateLimiter(200);
      const error = new Error('Request failed');
      const mockFn = vi.fn().mockRejectedValue(error);

      await expect(limiter.execute(mockFn)).rejects.toThrow('Request failed');
    });

    it('should not delay if enough time has passed (RL-2.1)', async () => {
      const limiter = new RateLimiter(200);
      const mockFn = vi.fn().mockResolvedValue('result');

      // First call
      await limiter.execute(mockFn);

      // Wait more than interval
      await vi.advanceTimersByTimeAsync(300);

      // Second call should be immediate
      const startTime = Date.now();
      await limiter.execute(mockFn);

      expect(mockFn).toHaveBeenCalledTimes(2);
    });
  });

  describe('setDebugMode', () => {
    it('should use base interval when debug mode is disabled (RL-1.1)', async () => {
      const limiter = new RateLimiter(200);
      limiter.setDebugMode(false);

      const mockFn = vi.fn().mockResolvedValue('result');

      await limiter.execute(mockFn);
      const secondPromise = limiter.execute(mockFn);

      // Should complete after 200ms
      await vi.advanceTimersByTimeAsync(200);
      await secondPromise;

      expect(mockFn).toHaveBeenCalledTimes(2);
    });

    it('should use multiplied interval when debug mode is enabled (RL-1.2)', async () => {
      const limiter = new RateLimiter(200);
      limiter.setDebugMode(true);

      const mockFn = vi.fn().mockResolvedValue('result');

      await limiter.execute(mockFn);
      const secondPromise = limiter.execute(mockFn);

      // Should NOT complete after 200ms
      await vi.advanceTimersByTimeAsync(200);
      expect(mockFn).toHaveBeenCalledTimes(1);

      // Should complete after total of 1000ms (200 * 5)
      await vi.advanceTimersByTimeAsync(800);
      await secondPromise;

      expect(mockFn).toHaveBeenCalledTimes(2);
    });

    it('should apply correct multiplier from constants', () => {
      expect(DEBUG_DELAY_MULTIPLIER).toBe(5);
    });

    it('should toggle between debug and normal mode', async () => {
      const limiter = new RateLimiter(200);
      const mockFn = vi.fn().mockResolvedValue('result');

      limiter.setDebugMode(true);

      await limiter.execute(mockFn);
      expect(mockFn).toHaveBeenCalledTimes(1);

      // Wait for debug interval to elapse
      await vi.advanceTimersByTimeAsync(1000);

      limiter.setDebugMode(false);

      await limiter.execute(mockFn);
      expect(mockFn).toHaveBeenCalledTimes(2);
    });
  });

  describe('429 retry', () => {
    it('should retry on 429 and respect Retry-After header', async () => {
      const limiter = new RateLimiter(200, 3);
      const response429 = { status: 429, headers: { 'Retry-After': '2' } };
      const responseOk = { status: 200, headers: {}, data: 'success' };

      const mockFn = vi.fn()
        .mockResolvedValueOnce(response429)
        .mockResolvedValueOnce(responseOk);

      const resultPromise = limiter.execute(mockFn);

      // First call returns 429 → waits 2s
      await vi.advanceTimersByTimeAsync(2000);
      // Rate-limit interval for retry
      await vi.advanceTimersByTimeAsync(200);

      const result = await resultPromise;

      expect(mockFn).toHaveBeenCalledTimes(2);
      expect(result).toEqual(responseOk);
    });

    it('should use default delay when Retry-After header is absent', async () => {
      const limiter = new RateLimiter(200, 3);
      const response429 = { status: 429, headers: {} };
      const responseOk = { status: 200, headers: {}, data: 'ok' };

      const mockFn = vi.fn()
        .mockResolvedValueOnce(response429)
        .mockResolvedValueOnce(responseOk);

      const resultPromise = limiter.execute(mockFn);

      // Should use DEFAULT_RETRY_DELAY_MS (30s)
      await vi.advanceTimersByTimeAsync(DEFAULT_RETRY_DELAY_MS);
      await vi.advanceTimersByTimeAsync(200);

      const result = await resultPromise;

      expect(mockFn).toHaveBeenCalledTimes(2);
      expect(result).toEqual(responseOk);
    });

    it('should return 429 response after exceeding max retries', async () => {
      const limiter = new RateLimiter(200, 2);
      const response429 = { status: 429, headers: { 'Retry-After': '1' } };

      const mockFn = vi.fn().mockResolvedValue(response429);

      const resultPromise = limiter.execute(mockFn);

      // 1st call → 429, wait 1s
      await vi.advanceTimersByTimeAsync(1000);
      await vi.advanceTimersByTimeAsync(200);
      // 2nd call → 429, wait 1s
      await vi.advanceTimersByTimeAsync(1000);
      await vi.advanceTimersByTimeAsync(200);
      // 3rd call → 429, maxRetries (2) exceeded → return

      const result = await resultPromise;

      // 1 initial + 2 retries = 3 calls
      expect(mockFn).toHaveBeenCalledTimes(3);
      expect(result).toEqual(response429);
    });

    it('should not retry non-429 responses', async () => {
      const limiter = new RateLimiter(200, 3);
      const response500 = { status: 500, headers: {} };

      const mockFn = vi.fn().mockResolvedValue(response500);

      const result = await limiter.execute(mockFn);

      expect(mockFn).toHaveBeenCalledTimes(1);
      expect(result).toEqual(response500);
    });

    it('should not inspect non-object return values', async () => {
      const limiter = new RateLimiter(200, 3);
      const mockFn = vi.fn().mockResolvedValue('plain string');

      const result = await limiter.execute(mockFn);

      expect(mockFn).toHaveBeenCalledTimes(1);
      expect(result).toBe('plain string');
    });

    it('should handle case-insensitive Retry-After header', async () => {
      const limiter = new RateLimiter(200, 3);
      const response429 = { status: 429, headers: { 'retry-after': '3' } };
      const responseOk = { status: 200, headers: {} };

      const mockFn = vi.fn()
        .mockResolvedValueOnce(response429)
        .mockResolvedValueOnce(responseOk);

      const resultPromise = limiter.execute(mockFn);

      // Wait 3s (retry-after) + rate-limit interval
      await vi.advanceTimersByTimeAsync(3000);
      await vi.advanceTimersByTimeAsync(200);

      const result = await resultPromise;

      expect(mockFn).toHaveBeenCalledTimes(2);
      expect(result).toEqual(responseOk);
    });

    it('should handle mixed-case Retry-After header', async () => {
      const limiter = new RateLimiter(200, 3);
      const response429 = { status: 429, headers: { 'RETRY-AFTER': '1' } };
      const responseOk = { status: 200, headers: {} };

      const mockFn = vi.fn()
        .mockResolvedValueOnce(response429)
        .mockResolvedValueOnce(responseOk);

      const resultPromise = limiter.execute(mockFn);

      await vi.advanceTimersByTimeAsync(1000);
      await vi.advanceTimersByTimeAsync(200);

      const result = await resultPromise;

      expect(mockFn).toHaveBeenCalledTimes(2);
      expect(result).toEqual(responseOk);
    });

    it('should pass through null return values without retry', async () => {
      const limiter = new RateLimiter(200, 3);
      const mockFn = vi.fn().mockResolvedValue(null);

      const result = await limiter.execute(mockFn);

      expect(mockFn).toHaveBeenCalledTimes(1);
      expect(result).toBeNull();
    });

    it('should use default delay for invalid Retry-After value', async () => {
      const limiter = new RateLimiter(200, 3);
      const response429 = { status: 429, headers: { 'Retry-After': 'invalid' } };
      const responseOk = { status: 200, headers: {} };

      const mockFn = vi.fn()
        .mockResolvedValueOnce(response429)
        .mockResolvedValueOnce(responseOk);

      const resultPromise = limiter.execute(mockFn);

      await vi.advanceTimersByTimeAsync(DEFAULT_RETRY_DELAY_MS);
      await vi.advanceTimersByTimeAsync(200);

      const result = await resultPromise;

      expect(mockFn).toHaveBeenCalledTimes(2);
      expect(result).toEqual(responseOk);
    });
  });
});
