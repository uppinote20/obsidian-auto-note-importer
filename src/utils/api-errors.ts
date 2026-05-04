/**
 * API error message extraction shared by Airtable and SeaTable clients
 * + their credential-form renderers.
 *
 * Both providers stick error info under different keys
 * (`error.message`, `error_msg`, `error_message`, plain string `error`),
 * so the helper checks each in priority order and falls back to the raw
 * response text or the HTTP status as a last resort.
 *
 * Also hosts the shared `buildBatchFailures` / `formatBatchLimitError` helpers
 * that every `DatabaseProvider.batchUpdate()` failure path goes through —
 * keeps the per-record SyncResult[] shape consistent across providers.
 * See handbook §6.1 "Uniform failure shape".
 *
 * @handbook 6.1-error-handling
 * @handbook 4.4-provider-abstraction
 * @tested tests/utils/api-errors.test.ts
 */

import type { BatchUpdate, SyncResult } from '../types/database.types';

interface ApiErrorBody {
  error?: string | { message?: string };
  error_msg?: string;
  error_message?: string;
}

interface ApiErrorResponse {
  status?: number;
  json?: unknown;
  text?: string;
}

export function extractApiErrorMessage(response: ApiErrorResponse): string {
  const body = response.json as ApiErrorBody | undefined;
  if (body) {
    if (typeof body.error_msg === 'string' && body.error_msg) return body.error_msg;
    if (typeof body.error_message === 'string' && body.error_message) return body.error_message;
    if (typeof body.error === 'string' && body.error) return body.error;
    if (body.error && typeof body.error === 'object' && body.error.message) return body.error.message;
  }
  if (response.text) return response.text;
  return response.status !== undefined ? `HTTP ${response.status}` : 'Unknown error';
}

export function extractApiErrorDetails(response: { status: number; json?: unknown; text?: string }): string {
  const message = extractApiErrorMessage(response);
  const prefix = `HTTP ${response.status}`;
  return message === prefix ? prefix : `${prefix}: ${message}`;
}

export function normalizeServerUrl(url: string | undefined, fallback: string): string {
  return (url || fallback).trim().replace(/\/+$/, '');
}

export const formatBatchLimitError = (maxSize: number): string =>
  `Maximum ${maxSize} records allowed per batch update`;

export function buildBatchFailures(updates: BatchUpdate[], error: string): SyncResult[] {
  return updates.map(u => ({
    success: false as const,
    recordId: u.recordId,
    error,
  }));
}
