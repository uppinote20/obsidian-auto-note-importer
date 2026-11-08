/**
 * Sync queue for managing concurrent sync requests.
 * Prevents race conditions by queuing requests instead of dropping them.
 *
 * @handbook 6.2-state-management
 * @handbook 9.1-sync-flow
 * @tested tests/core/sync-queue.test.ts
 */

import { generateId } from '../utils';
import type { SyncRequest, SyncMode, SyncScope, SyncTrigger } from '../types';

/**
 * Processor function type for handling sync requests.
 */
export type SyncProcessor = (request: SyncRequest) => Promise<void>;

/**
 * Error callback type for sync failures.
 */
export type SyncErrorCallback = (error: unknown, request: SyncRequest) => void;

/** A non-sync task run in sequence with the queued sync requests. */
interface ExclusiveTask {
  kind: 'exclusive';
  run: () => Promise<void>;
}

type QueueItem = SyncRequest | ExclusiveTask;

function isExclusive(item: QueueItem): item is ExclusiveTask {
  return 'kind' in item && item.kind === 'exclusive';
}

/**
 * Manages sync requests in a queue to prevent race conditions.
 */
export class SyncQueue {
  private queue: QueueItem[] = [];
  private isProcessing = false;
  private processor: SyncProcessor;
  private onError?: SyncErrorCallback;

  constructor(processor: SyncProcessor, onError?: SyncErrorCallback) {
    this.processor = processor;
    this.onError = onError;
  }

  /**
   * Enqueues a new sync request.
   * Merges with existing requests of the same type if possible.
   */
  async enqueue(
    mode: SyncMode,
    scope: SyncScope,
    filePaths?: string[],
    trigger: SyncTrigger = 'user'
  ): Promise<void> {
    const request: SyncRequest = {
      id: generateId(),
      mode,
      scope,
      filePaths,
      timestamp: Date.now(),
      trigger
    };

    // Try to merge with an existing request of the same type — only one queued
    // after the last exclusive task, so a later request never jumps ahead of it.
    const lastExclusive = this.queue.map(isExclusive).lastIndexOf(true);
    const existingIndex = this.queue.findIndex(
      (r, i) => i > lastExclusive && !isExclusive(r) && r.mode === mode && r.scope === scope
    );

    if (existingIndex >= 0 && filePaths) {
      // Merge file paths
      const existing = this.queue[existingIndex] as SyncRequest;
      const mergedPaths = new Set([
        ...(existing.filePaths || []),
        ...filePaths
      ]);
      this.queue[existingIndex] = {
        ...existing,
        filePaths: Array.from(mergedPaths),
        timestamp: Date.now(),
        // A user request merged with an auto one must still count as user-triggered.
        trigger: existing.trigger === 'user' || trigger === 'user' ? 'user' : 'auto'
      };
    } else {
      this.queue.push(request);
    }

    await this.processQueue();
  }

  /**
   * Runs `fn` on the same sequential chain as sync requests: after any
   * in-flight or queued request, before requests enqueued later. Resolves or
   * rejects with `fn`'s outcome.
   */
  runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.queue.push({
        kind: 'exclusive',
        run: () => Promise.resolve().then(fn).then(resolve, reject),
      });
      void this.processQueue();
    });
  }

  /**
   * Processes the queue sequentially.
   */
  private async processQueue(): Promise<void> {
    if (this.isProcessing) {
      return;
    }

    this.isProcessing = true;

    while (this.queue.length > 0) {
      const request = this.queue.shift();
      if (!request) break;

      if (isExclusive(request)) {
        // Settles its own promise; never throws.
        await request.run();
        continue;
      }

      try {
        await this.processor(request);
      } catch (error) {
        this.onError?.(error, request);
      }
    }

    this.isProcessing = false;
  }

}
