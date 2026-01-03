/**
 * Sync queue for managing concurrent sync requests.
 * Prevents race conditions by queuing requests instead of dropping them.
 */

import { generateId } from '../utils';
import type { SyncRequest, SyncMode, SyncScope, QueueStatus } from '../types';

/**
 * Processor function type for handling sync requests.
 */
export type SyncProcessor = (request: SyncRequest) => Promise<void>;

/**
 * Manages sync requests in a queue to prevent race conditions.
 */
export class SyncQueue {
  private queue: SyncRequest[] = [];
  private isProcessing = false;
  private currentRequest: SyncRequest | null = null;
  private processor: SyncProcessor;

  constructor(processor: SyncProcessor) {
    this.processor = processor;
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
      this.currentRequest = this.queue.shift()!;

      try {
        await this.processor(this.currentRequest);
      } catch (error) {
        console.error('Sync request failed:', error);
      }

      this.currentRequest = null;
    }

    this.isProcessing = false;
  }

  /**
   * Gets the current queue status.
   */
  get status(): QueueStatus {
    return {
      isProcessing: this.isProcessing,
      pendingCount: this.queue.length,
      currentRequest: this.currentRequest
    };
  }

  /**
   * Checks if the queue is currently processing.
   */
  get processing(): boolean {
    return this.isProcessing;
  }

  /**
   * Gets the number of pending requests.
   */
  get pendingCount(): number {
    return this.queue.length;
  }

  /**
   * Clears all pending requests.
   */
  clear(): void {
    this.queue = [];
  }

  /**
   * Checks if there's a pending request matching the criteria.
   */
  hasPending(mode: SyncMode, scope?: SyncScope): boolean {
    return this.queue.some(r => r.mode === mode && (!scope || r.scope === scope));
  }
}
