/**
 * Tests for sync-queue service.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SyncQueue, SyncProcessor } from '../../src/core/sync-queue';
import type { SyncRequest } from '../../src/types';

describe('SyncQueue', () => {
  let mockProcessor: SyncProcessor;
  let processedRequests: SyncRequest[];

  beforeEach(() => {
    processedRequests = [];
    mockProcessor = vi.fn(async (request: SyncRequest) => {
      processedRequests.push(request);
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

      const firstEnqueue = queue.enqueue('to-airtable', 'current');
      const secondEnqueue = queue.enqueue('from-airtable', 'all');

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

      const firstEnqueue = queue.enqueue('to-airtable', 'current');
      queue.enqueue('to-airtable', 'modified', ['file1.md']);
      queue.enqueue('to-airtable', 'modified', ['file2.md']);

      resolveFirst!();
      await firstEnqueue;

      await new Promise(resolve => setTimeout(resolve, 20));

      expect(processedRequests.length).toBe(2);
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

      const firstEnqueue = queue.enqueue('to-airtable', 'current');
      queue.enqueue('to-airtable', 'modified', ['file1.md', 'file2.md']);
      queue.enqueue('to-airtable', 'modified', ['file2.md', 'file3.md']);

      resolveFirst!();
      await firstEnqueue;

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

      const promises = [
        queue.enqueue('to-airtable', 'current'),
        queue.enqueue('from-airtable', 'current'),
        queue.enqueue('bidirectional', 'current')
      ];

      await Promise.all(promises);

      expect(executionOrder).toEqual([1, 2, 3]);
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

      await queue.enqueue('to-airtable', 'current');
      await queue.enqueue('from-airtable', 'all');

      expect(processedRequests.length).toBe(2);
    });

    it('should call onError callback when processor throws', async () => {
      const onError = vi.fn();
      const errorProcessor: SyncProcessor = vi.fn(async () => {
        throw new Error('Test error');
      });

      const queue = new SyncQueue(errorProcessor, onError);

      await queue.enqueue('to-airtable', 'current');

      expect(onError).toHaveBeenCalledTimes(1);
      expect(onError.mock.calls[0][0]).toBeInstanceOf(Error);
      expect((onError.mock.calls[0][0] as Error).message).toBe('Test error');
    });
  });
});
