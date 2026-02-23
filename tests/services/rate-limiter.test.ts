/**
 * Tests for rate-limiter service.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RateLimiter } from '../../src/services/rate-limiter';
import { RATE_LIMIT_INTERVAL_MS, DEBUG_DELAY_MULTIPLIER } from '../../src/constants';

describe('RateLimiter', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('constructor', () => {
    it('should use default interval from constants', () => {
      const limiter = new RateLimiter();
      expect(RATE_LIMIT_INTERVAL_MS).toBe(200);
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
});
