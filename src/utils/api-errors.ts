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
  code?: string;
  message?: string;
  hint?: string;
  details?: string;
}

interface ApiErrorResponse {
  status?: number;
  json?: unknown;
  text?: string;
}

export function extractApiErrorMessage(response: ApiErrorResponse): string {
  // Obsidian `requestUrl` exposes `.json` as a LAZY getter that runs
  // `JSON.parse(response.text)` on access — it throws SyntaxError when
  // the body is non-JSON (HTML 502 from a proxy, captive portal page,
  // empty body, etc.). Without this guard, every caller that passes a
  // raw RequestUrlResponse here would see the SyntaxError bubble out of
  // their `throw new Error('Failed: ${extractApiErrorDetails(r)}')`
  // and replace the intended HTTP-status message.
  let body: ApiErrorBody | undefined;
  try {
    body = response.json as ApiErrorBody | undefined;
  } catch {
    body = undefined;
  }
  if (body) {
    // PostgREST proper: code + message (both strings) is the most structured form
    if (typeof body.code === 'string' && typeof body.message === 'string') {
      const hint = typeof body.hint === 'string' && body.hint ? ` (hint: ${body.hint})` : '';
      return `${body.message}${hint} [${body.code}]`;
    }
    // Provider-specific shapes go before the generic `message` fallback so
    // a proxy that wraps a SeaTable / Airtable error in {message: 'OK', error_msg: '...'}
    // keeps surfacing the actionable inner message.
    if (typeof body.error_msg === 'string' && body.error_msg) return body.error_msg;
    if (typeof body.error_message === 'string' && body.error_message) return body.error_message;
    if (typeof body.error === 'string' && body.error) return body.error;
    if (body.error && typeof body.error === 'object' && body.error.message) return body.error.message;
    // Kong / GoTrue auth-gateway proxy: top-level `message` (and optional hint) WITHOUT a `code`.
    // Without this branch, Supabase auth failures fall through to raw response.text
    // or doubled "HTTP 401" output, hiding the actionable hint.
    if (typeof body.message === 'string' && body.message) {
      const hint = typeof body.hint === 'string' && body.hint ? ` (hint: ${body.hint})` : '';
      return `${body.message}${hint}`;
    }
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
