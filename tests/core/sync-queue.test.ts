/**
 * Tests for sync-queue service.
 * @covers src/core/sync-queue.ts
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

      await queue.enqueue('push', 'current');

      expect(mockProcessor).toHaveBeenCalledTimes(1);
      expect(processedRequests[0].mode).toBe('push');
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

      const firstEnqueue = queue.enqueue('push', 'current');
      const secondEnqueue = queue.enqueue('pull', 'all');

      resolveFirst!();
      await firstEnqueue;
      await secondEnqueue;

      expect(processedRequests.length).toBe(2);
      expect(processedRequests[0].mode).toBe('push');
      expect(processedRequests[1].mode).toBe('pull');
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

      const firstEnqueue = queue.enqueue('push', 'current');
      queue.enqueue('push', 'modified', ['file1.md']);
      queue.enqueue('push', 'modified', ['file2.md']);

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

      const firstEnqueue = queue.enqueue('push', 'current');
      queue.enqueue('push', 'modified', ['file1.md', 'file2.md']);
      queue.enqueue('push', 'modified', ['file2.md', 'file3.md']);

      resolveFirst!();
      await firstEnqueue;

      await new Promise(resolve => setTimeout(resolve, 20));

      const mergedRequest = processedRequests[1];
      expect(mergedRequest.filePaths).toHaveLength(3);
      expect(mergedRequest.filePaths).toContain('file1.md');
      expect(mergedRequest.filePaths).toContain('file2.md');
      expect(mergedRequest.filePaths).toContain('file3.md');
    });

    it('tags requests with the given trigger and defaults to user', async () => {
      const queue = new SyncQueue(mockProcessor);

      await queue.enqueue('push', 'current');
      await queue.enqueue('pull', 'all', undefined, 'auto');

      expect(processedRequests[0].trigger).toBe('user');
      expect(processedRequests[1].trigger).toBe('auto');
    });

    it('merges auto and user requests into one run with trigger user', async () => {
      let resolveFirst: () => void;
      const firstPromise = new Promise<void>(resolve => {
        resolveFirst = resolve;
      });
      const slowProcessor: SyncProcessor = vi.fn(async (request: SyncRequest) => {
        processedRequests.push(request);
        if (processedRequests.length === 1) await firstPromise;
      });
      const queue = new SyncQueue(slowProcessor);

      const firstEnqueue = queue.enqueue('push', 'current');
      queue.enqueue('push', 'modified', ['a.md'], 'auto');
      queue.enqueue('push', 'modified', ['b.md'], 'user');
      queue.enqueue('push', 'modified', ['c.md'], 'auto');

      resolveFirst!();
      await firstEnqueue;
      await new Promise(resolve => setTimeout(resolve, 20));

      expect(processedRequests).toHaveLength(2);
      expect(processedRequests[1].trigger).toBe('user');
      expect(processedRequests[1].filePaths).toEqual(['a.md', 'b.md', 'c.md']);
    });

    it('keeps trigger auto when every merged request is auto', async () => {
      let resolveFirst: () => void;
      const firstPromise = new Promise<void>(resolve => {
        resolveFirst = resolve;
      });
      const slowProcessor: SyncProcessor = vi.fn(async (request: SyncRequest) => {
        processedRequests.push(request);
        if (processedRequests.length === 1) await firstPromise;
      });
      const queue = new SyncQueue(slowProcessor);

      const firstEnqueue = queue.enqueue('push', 'current');
      queue.enqueue('push', 'modified', ['a.md'], 'auto');
      queue.enqueue('push', 'modified', ['b.md'], 'auto');

      resolveFirst!();
      await firstEnqueue;
      await new Promise(resolve => setTimeout(resolve, 20));

      expect(processedRequests[1].trigger).toBe('auto');
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
        queue.enqueue('push', 'current'),
        queue.enqueue('pull', 'current'),
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
        if (request.mode === 'push') {
          throw new Error('Sync failed');
        }
      });

      const queue = new SyncQueue(errorProcessor);

      await queue.enqueue('push', 'current');
      await queue.enqueue('pull', 'all');

      expect(processedRequests.length).toBe(2);
    });

    it('should call onError callback when processor throws', async () => {
      const onError = vi.fn();
      const errorProcessor: SyncProcessor = vi.fn(async () => {
        throw new Error('Test error');
      });

      const queue = new SyncQueue(errorProcessor, onError);

      await queue.enqueue('push', 'current');

      expect(onError).toHaveBeenCalledTimes(1);
      expect(onError.mock.calls[0][0]).toBeInstanceOf(Error);
      expect((onError.mock.calls[0][0] as Error).message).toBe('Test error');
    });
  });
  describe('runExclusive', () => {
    function deferred(): { promise: Promise<void>; resolve: () => void } {
      let resolve!: () => void;
      const promise = new Promise<void>(r => { resolve = r; });
      return { promise, resolve };
    }

    it('runs only after the in-flight request resolves', async () => {
      const gate = deferred();
      const events: string[] = [];
      const queue = new SyncQueue(async (request) => {
        events.push(`start ${request.mode}`);
        await gate.promise;
        events.push(`end ${request.mode}`);
      });

      const sync = queue.enqueue('pull', 'all');
      const exclusive = queue.runExclusive(async () => { events.push('apply'); return 7; });
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(events).toEqual(['start pull']);

      gate.resolve();
      await expect(exclusive).resolves.toBe(7);
      await sync;
      expect(events).toEqual(['start pull', 'end pull', 'apply']);
    });

    it('runs before requests enqueued after it, which never merge into earlier ones', async () => {
      const gate = deferred();
      const events: string[] = [];
      const queue = new SyncQueue(async (request) => {
        events.push(`${request.mode}:${(request.filePaths ?? []).join(',')}`);
        if (events.length === 1) await gate.promise;
      });

      void queue.enqueue('pull', 'all');
      void queue.enqueue('push', 'modified', ['a.md']);
      const exclusive = queue.runExclusive(async () => { events.push('apply'); });
      void queue.enqueue('push', 'modified', ['b.md']);
      gate.resolve();
      await exclusive;
      await vi.waitFor(() => expect(events).toHaveLength(4));
      expect(events).toEqual(['pull:', 'push:a.md', 'apply', 'push:b.md']);
    });

    it('rejects with the task error and keeps processing later requests', async () => {
      const queue = new SyncQueue(mockProcessor);
      await expect(queue.runExclusive(async () => { throw new Error('nope'); })).rejects.toThrow('nope');
      await queue.enqueue('pull', 'all');
      expect(mockProcessor).toHaveBeenCalledTimes(1);
    });
  });
});
