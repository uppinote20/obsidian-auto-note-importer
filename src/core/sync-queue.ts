/**
 * Sync queue for managing concurrent sync requests.
 * Prevents race conditions by queuing requests instead of dropping them.
 *
 * @handbook 6.2-state-management
 * @handbook 9.1-sync-flow
 */

import { generateId } from '../utils';
import type { SyncRequest, SyncMode, SyncScope } from '../types';

/**
 * Processor function type for handling sync requests.
 */
export type SyncProcessor = (request: SyncRequest) => Promise<void>;

/**
 * Error callback type for sync failures.
 */
export type SyncErrorCallback = (error: unknown, request: SyncRequest) => void;

/**
 * Manages sync requests in a queue to prevent race conditions.
 */
export class SyncQueue {
  private queue: SyncRequest[] = [];
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
    filePaths?: string[]
  ): Promise<void> {
    const request: SyncRequest = {
      id: generateId(),
      mode,
      scope,
      filePaths,
      timestamp: Date.now()
    };

    // Try to merge with existing request of the same type
    const existingIndex = this.queue.findIndex(
      r => r.mode === mode && r.scope === scope
    );

    if (existingIndex >= 0 && filePaths) {
      // Merge file paths
      const existing = this.queue[existingIndex];
      const mergedPaths = new Set([
        ...(existing.filePaths || []),
        ...filePaths
      ]);
      this.queue[existingIndex] = {
        ...existing,
        filePaths: Array.from(mergedPaths),
        timestamp: Date.now()
      };
    } else {
      this.queue.push(request);
    }

    await this.processQueue();
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
      const request = this.queue.shift()!;

      try {
        await this.processor(request);
      } catch (error) {
        this.onError?.(error, request);
      }
    }

    this.isProcessing = false;
  }

}
