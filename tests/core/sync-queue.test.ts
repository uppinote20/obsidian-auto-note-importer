/**
 * Tests for sync-queue service.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SyncQueue, SyncProcessor } from '../../src/core/sync-queue';
import type { SyncMode, SyncScope, SyncRequest } from '../../src/types';

describe('SyncQueue', () => {
  let mockProcessor: SyncProcessor;
  let processedRequests: SyncRequest[];

  beforeEach(() => {
    processedRequests = [];
    mockProcessor = vi.fn(async (request: SyncRequest) => {
      processedRequests.push(request);
      // Simulate async processing
      await new Promise(resolve => setTimeout(resolve, 10));
    });
  });

  describe('enqueue', () => {
    it('should process single request immediately', async () => {
      const queue = new SyncQueue(mockProcessor);

      await queue.enqueue('to-airtable', 'current');

      expect(mockProcessor).toHaveBeenCalledTimes(1);
      expect(processedRequests[0].mode).toBe('to-airtable');
      expect(processedRequests[0].scope).toBe('current');
    });

    it('should queue request while processing (SQ-1.1)', async () => {
      let resolveFirst: () => void;
      const firstPromise = new Promise<void>(resolve => {
        resolveFirst = resolve;
      });

      const slowProcessor: SyncProcessor = vi.fn(async (request: SyncRequest) => {
        processedRequests.push(request);
        if (processedRequests.length === 1) {
          await firstPromise;
        }
      });

      const queue = new SyncQueue(slowProcessor);

      // Start first request (will wait)
      const firstEnqueue = queue.enqueue('to-airtable', 'current');

      // Second request should be queued
      const secondEnqueue = queue.enqueue('from-airtable', 'all');

      // First still processing
      expect(queue.processing).toBe(true);
      expect(queue.pendingCount).toBe(1);

      // Complete first
      resolveFirst!();
      await firstEnqueue;
      await secondEnqueue;

      expect(processedRequests.length).toBe(2);
      expect(processedRequests[0].mode).toBe('to-airtable');
      expect(processedRequests[1].mode).toBe('from-airtable');
    });

    it('should merge duplicate requests with same mode/scope (SQ-1.2)', async () => {
      let resolveFirst: () => void;
      const firstPromise = new Promise<void>(resolve => {
        resolveFirst = resolve;
      });

      const slowProcessor: SyncProcessor = vi.fn(async (request: SyncRequest) => {
        processedRequests.push(request);
        if (processedRequests.length === 1) {
          await firstPromise;
        }
      });

      const queue = new SyncQueue(slowProcessor);

      // Start first request (will start processing immediately)
      const firstEnqueue = queue.enqueue('to-airtable', 'current');

      // Queue second request while first is processing
      queue.enqueue('to-airtable', 'modified', ['file1.md']);

      // Queue third request with same mode/scope as second - should merge
      queue.enqueue('to-airtable', 'modified', ['file2.md']);

      // Should have 1 pending (merged request)
      expect(queue.pendingCount).toBe(1);

      // Complete first
      resolveFirst!();
      await firstEnqueue;

      // Wait for queue to process
      await new Promise(resolve => setTimeout(resolve, 20));

      expect(processedRequests.length).toBe(2);
      // The merged request should have both file paths
      expect(processedRequests[1].filePaths).toContain('file1.md');
      expect(processedRequests[1].filePaths).toContain('file2.md');
    });

    it('should deduplicate file paths in merged requests (SQ-1.3)', async () => {
      let resolveFirst: () => void;
      const firstPromise = new Promise<void>(resolve => {
        resolveFirst = resolve;
      });

      const slowProcessor: SyncProcessor = vi.fn(async (request: SyncRequest) => {
        processedRequests.push(request);
        if (processedRequests.length === 1) {
          await firstPromise;
        }
      });

      const queue = new SyncQueue(slowProcessor);

      // Start first request (will start processing immediately)
      const firstEnqueue = queue.enqueue('to-airtable', 'current');

      // Queue second request while first is processing
      queue.enqueue('to-airtable', 'modified', ['file1.md', 'file2.md']);

      // Add overlapping paths - should deduplicate
      queue.enqueue('to-airtable', 'modified', ['file2.md', 'file3.md']);

      // Complete first
      resolveFirst!();
      await firstEnqueue;

      // Wait for queue to process
      await new Promise(resolve => setTimeout(resolve, 20));

      const mergedRequest = processedRequests[1];
      expect(mergedRequest.filePaths).toHaveLength(3);
      expect(mergedRequest.filePaths).toContain('file1.md');
      expect(mergedRequest.filePaths).toContain('file2.md');
      expect(mergedRequest.filePaths).toContain('file3.md');
    });

    it('should process requests sequentially for rapid calls (SQ-1.4)', async () => {
      const executionOrder: number[] = [];
      let callCount = 0;

      const trackingProcessor: SyncProcessor = vi.fn(async () => {
        const myOrder = ++callCount;
        await new Promise(resolve => setTimeout(resolve, 5));
        executionOrder.push(myOrder);
      });

      const queue = new SyncQueue(trackingProcessor);

      // Rapid fire requests with different modes to prevent merging
      const promises = [
        queue.enqueue('to-airtable', 'current'),
        queue.enqueue('from-airtable', 'current'),
        queue.enqueue('bidirectional', 'current')
      ];

      await Promise.all(promises);

      expect(executionOrder).toEqual([1, 2, 3]);
    });
  });

  describe('status', () => {
    it('should report isProcessing correctly', async () => {
      const queue = new SyncQueue(mockProcessor);

      expect(queue.status.isProcessing).toBe(false);

      const enqueuePromise = queue.enqueue('to-airtable', 'current');

      // During processing
      expect(queue.status.isProcessing).toBe(true);

      await enqueuePromise;

      expect(queue.status.isProcessing).toBe(false);
    });

    it('should report pendingCount correctly', async () => {
      let resolveFirst: () => void;
      const firstPromise = new Promise<void>(resolve => {
        resolveFirst = resolve;
      });

      const slowProcessor: SyncProcessor = vi.fn(async () => {
        await firstPromise;
      });

      const queue = new SyncQueue(slowProcessor);

      expect(queue.status.pendingCount).toBe(0);

      queue.enqueue('to-airtable', 'current');
      queue.enqueue('from-airtable', 'all');
      queue.enqueue('bidirectional', 'modified');

      expect(queue.status.pendingCount).toBe(2);

      resolveFirst!();
    });

    it('should report currentRequest correctly', async () => {
      let resolveFirst: () => void;
      const firstPromise = new Promise<void>(resolve => {
        resolveFirst = resolve;
      });

      const slowProcessor: SyncProcessor = vi.fn(async () => {
        await firstPromise;
      });

      const queue = new SyncQueue(slowProcessor);

      expect(queue.status.currentRequest).toBeNull();

      queue.enqueue('to-airtable', 'current');

      expect(queue.status.currentRequest?.mode).toBe('to-airtable');
      expect(queue.status.currentRequest?.scope).toBe('current');

      resolveFirst!();
    });
  });

  describe('hasPending (SQ-2.1)', () => {
    it('should return true when matching request is pending', async () => {
      let resolveFirst: () => void;
      const firstPromise = new Promise<void>(resolve => {
        resolveFirst = resolve;
      });

      const slowProcessor: SyncProcessor = vi.fn(async () => {
        await firstPromise;
      });

      const queue = new SyncQueue(slowProcessor);

      queue.enqueue('to-airtable', 'current');
      queue.enqueue('from-airtable', 'all');

      expect(queue.hasPending('from-airtable')).toBe(true);
      expect(queue.hasPending('from-airtable', 'all')).toBe(true);

      resolveFirst!();
    });

    it('should return false when no matching request is pending', async () => {
      let resolveFirst: () => void;
      const firstPromise = new Promise<void>(resolve => {
        resolveFirst = resolve;
      });

      const slowProcessor: SyncProcessor = vi.fn(async () => {
        await firstPromise;
      });

      const queue = new SyncQueue(slowProcessor);

      queue.enqueue('to-airtable', 'current');
      queue.enqueue('from-airtable', 'all');

      expect(queue.hasPending('bidirectional')).toBe(false);
      expect(queue.hasPending('from-airtable', 'current')).toBe(false);

      resolveFirst!();
    });

    it('should work without scope filter', async () => {
      let resolveFirst: () => void;
      const firstPromise = new Promise<void>(resolve => {
        resolveFirst = resolve;
      });

      const slowProcessor: SyncProcessor = vi.fn(async () => {
        await firstPromise;
      });

      const queue = new SyncQueue(slowProcessor);

      queue.enqueue('to-airtable', 'current');
      queue.enqueue('to-airtable', 'all');

      expect(queue.hasPending('to-airtable')).toBe(true);

      resolveFirst!();
    });
  });

  describe('clear (SQ-2.2)', () => {
    it('should clear all pending requests', async () => {
      let resolveFirst: () => void;
      const firstPromise = new Promise<void>(resolve => {
        resolveFirst = resolve;
      });

      const slowProcessor: SyncProcessor = vi.fn(async () => {
        await firstPromise;
      });

      const queue = new SyncQueue(slowProcessor);

      queue.enqueue('to-airtable', 'current');
      queue.enqueue('from-airtable', 'all');
      queue.enqueue('bidirectional', 'modified');

      expect(queue.pendingCount).toBe(2);

      queue.clear();

      expect(queue.pendingCount).toBe(0);

      resolveFirst!();
    });

    it('should not affect currently processing request', async () => {
      let resolveFirst: () => void;
      const firstPromise = new Promise<void>(resolve => {
        resolveFirst = resolve;
      });

      const slowProcessor: SyncProcessor = vi.fn(async (request: SyncRequest) => {
        processedRequests.push(request);
        await firstPromise;
      });

      const queue = new SyncQueue(slowProcessor);

      const firstEnqueue = queue.enqueue('to-airtable', 'current');
      queue.enqueue('from-airtable', 'all');

      expect(queue.processing).toBe(true);

      queue.clear();

      expect(queue.pendingCount).toBe(0);
      expect(queue.processing).toBe(true);

      resolveFirst!();
      await firstEnqueue;

      expect(processedRequests.length).toBe(1);
      expect(processedRequests[0].mode).toBe('to-airtable');
    });
  });

  describe('error handling', () => {
    it('should continue processing after error', async () => {
      const errorProcessor: SyncProcessor = vi.fn(async (request: SyncRequest) => {
        processedRequests.push(request);
        if (request.mode === 'to-airtable') {
          throw new Error('Sync failed');
        }
      });

      const queue = new SyncQueue(errorProcessor);

      // Queue multiple requests
      await queue.enqueue('to-airtable', 'current'); // Will error
      await queue.enqueue('from-airtable', 'all');   // Should still run

      expect(processedRequests.length).toBe(2);
    });
  });
});
