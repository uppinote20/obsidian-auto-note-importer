/**
 * Tests for shared API error / URL helpers.
 * @covers src/utils/api-errors.ts
 */

import { describe, it, expect } from 'vitest';
import {
  extractApiErrorMessage,
  extractApiErrorDetails,
  normalizeServerUrl,
  buildBatchFailures,
  formatBatchLimitError,
} from '../../src/utils/api-errors';
import type { BatchUpdate } from '../../src/types/database.types';

describe('extractApiErrorMessage', () => {
  it('returns body.error_msg first (SeaTable shape)', () => {
    expect(extractApiErrorMessage({ json: { error_msg: 'forbidden' } })).toBe('forbidden');
  });

  it('returns body.error_message before falling through (SeaTable v2 shape)', () => {
    expect(extractApiErrorMessage({ json: { error_message: 'invalid' } })).toBe('invalid');
  });

  it('returns body.error.message (Airtable shape)', () => {
    expect(extractApiErrorMessage({ json: { error: { message: 'auth required' } } })).toBe('auth required');
  });

  it('returns body.error when it is a plain string', () => {
    expect(extractApiErrorMessage({ json: { error: 'rate limited' } })).toBe('rate limited');
  });

  it('prefers error_msg over error_message over error.message when several are present', () => {
    expect(extractApiErrorMessage({
      json: { error_msg: 'first', error_message: 'second', error: { message: 'third' } },
    })).toBe('first');
  });

  it('falls back to response.text when JSON has no recognizable error shape', () => {
    expect(extractApiErrorMessage({ json: { something: 'else' }, text: 'Bad gateway' })).toBe('Bad gateway');
  });

  it('falls back to HTTP status when nothing else is available', () => {
    expect(extractApiErrorMessage({ status: 500 })).toBe('HTTP 500');
  });

  it('returns "Unknown error" when status is missing too', () => {
    expect(extractApiErrorMessage({})).toBe('Unknown error');
  });

  it('ignores empty strings in the error fields', () => {
    expect(extractApiErrorMessage({
      json: { error_msg: '', error_message: '', error: '' },
      text: 'fallback',
    })).toBe('fallback');
  });

  it('treats body.error as object only when it has message', () => {
    expect(extractApiErrorMessage({ json: { error: { code: 42 } as { message?: string }, error_msg: 'x' } })).toBe('x');
  });

  it('falls through to response.text when accessing response.json throws (lazy getter on non-JSON body)', () => {
    // Obsidian's requestUrl exposes `.json` as a lazy getter that parses
    // response.text on access. When the body is HTML (proxy 502 / captive
    // portal), the getter throws SyntaxError. Without the defensive
    // try/catch in extractApiErrorMessage, callers like
    // `extractApiErrorDetails(r)` inside `throw new Error('Failed: ${...}')`
    // would see the SyntaxError replace the intended HTTP-status message.
    const throwingResponse: { status: number; text?: string; json?: unknown } = {
      status: 502,
      text: '<!DOCTYPE html><html>Bad gateway</html>',
      get json() { throw new SyntaxError("Unexpected token '<'"); },
    };
    expect(extractApiErrorMessage(throwingResponse)).toBe('<!DOCTYPE html><html>Bad gateway</html>');
  });

  it('falls through to HTTP status when both json getter throws AND text is empty', () => {
    const throwingResponse: { status: number; text?: string; json?: unknown } = {
      status: 500,
      text: '',
      get json() { throw new SyntaxError('Unexpected end of JSON input'); },
    };
    expect(extractApiErrorMessage(throwingResponse)).toBe('HTTP 500');
  });
});

describe('extractApiErrorDetails', () => {
  it('combines HTTP status with error message', () => {
    expect(extractApiErrorDetails({ status: 422, json: { error_msg: 'invalid field' } }))
      .toBe('HTTP 422: invalid field');
  });

  it('returns just HTTP status when no message is recoverable', () => {
    expect(extractApiErrorDetails({ status: 500 })).toBe('HTTP 500');
  });

  it('uses response.text when json is empty', () => {
    expect(extractApiErrorDetails({ status: 502, text: 'gateway timeout' }))
      .toBe('HTTP 502: gateway timeout');
  });
});

describe('normalizeServerUrl', () => {
  it('strips trailing slashes', () => {
    expect(normalizeServerUrl('https://cloud.seatable.io/', 'fallback'))
      .toBe('https://cloud.seatable.io');
  });

  it('strips multiple trailing slashes', () => {
    expect(normalizeServerUrl('https://example.com///', 'fallback'))
      .toBe('https://example.com');
  });

  it('trims whitespace', () => {
    expect(normalizeServerUrl('  https://example.com  ', 'fallback'))
      .toBe('https://example.com');
  });

  it('uses fallback when url is undefined', () => {
    expect(normalizeServerUrl(undefined, 'https://cloud.seatable.io'))
      .toBe('https://cloud.seatable.io');
  });

  it('uses fallback when url is empty string', () => {
    expect(normalizeServerUrl('', 'https://cloud.seatable.io'))
      .toBe('https://cloud.seatable.io');
  });

  it('returns the url itself when it has no trailing slash already', () => {
    expect(normalizeServerUrl('https://api.airtable.com/v0', 'fallback'))
      .toBe('https://api.airtable.com/v0');
  });

  it('also strips a trailing slash from the fallback when url is missing', () => {
    expect(normalizeServerUrl(undefined, 'https://example.com/'))
      .toBe('https://example.com');
  });
});

describe('formatBatchLimitError', () => {
  it('formats the canonical batch-size message', () => {
    expect(formatBatchLimitError(10)).toBe('Maximum 10 records allowed per batch update');
    expect(formatBatchLimitError(1000)).toBe('Maximum 1000 records allowed per batch update');
  });
});

describe('buildBatchFailures', () => {
  const updates: BatchUpdate[] = [
    { recordId: 'a', fields: { Name: 'A' } },
    { recordId: 'b', fields: { Name: 'B' } },
  ];

  it('produces one failure entry per update with the same error string', () => {
    const results = buildBatchFailures(updates, 'boom');

    expect(results).toEqual([
      { success: false, recordId: 'a', error: 'boom' },
      { success: false, recordId: 'b', error: 'boom' },
    ]);
  });

  it('preserves recordId order', () => {
    const results = buildBatchFailures(updates, 'x');

    expect(results.map(r => r.recordId)).toEqual(['a', 'b']);
  });

  it('returns an empty array for an empty input', () => {
    expect(buildBatchFailures([], 'unused')).toEqual([]);
  });

  it('narrows to the discriminated-union failure variant', () => {
    const [first] = buildBatchFailures(updates, 'oops');

    // success: false → SyncResult should expose `error`, not `updatedFields`
    expect(first.success).toBe(false);
    if (!first.success) {
      expect(first.error).toBe('oops');
    }
  });
});

describe('PostgREST error format', () => {
  it('extracts message + code + hint', () => {
    const response = {
      status: 403,
      json: {
        code: '42501',
        message: 'permission denied for table notes',
        details: null,
        hint: 'Check RLS policies',
      },
    };
    const result = extractApiErrorDetails(response);
    expect(result).toContain('permission denied for table notes');
    expect(result).toContain('42501');
    expect(result).toContain('Check RLS policies');
  });

  it('handles message-only PostgREST error (no hint)', () => {
    const response = {
      status: 409,
      json: { code: '23505', message: 'duplicate key value' },
    };
    expect(extractApiErrorDetails(response)).toContain('duplicate key value');
    expect(extractApiErrorDetails(response)).toContain('23505');
  });

  it('does not collide with airtable/seatable format when keys overlap', () => {
    const response = {
      status: 400,
      json: { error: { message: 'Airtable error' } },
    };
    expect(extractApiErrorDetails(response)).toContain('Airtable error');
  });

  // Kong / GoTrue auth-gateway shape: `message` (and optionally `hint`) with NO `code`.
  // PostgREST proper always sends `code`+`message`; Supabase's auth proxy doesn't.
  it('extracts message from Kong-style auth errors (message only, no code)', () => {
    const response = {
      status: 401,
      json: { message: 'Invalid API key', hint: "Double-check your Supabase 'anon' key." },
    };
    const result = extractApiErrorMessage(response);
    expect(result).toContain('Invalid API key');
    expect(result).toContain('anon');
  });

  it('still prefers structured PostgREST format when both code and message are present', () => {
    const response = {
      status: 409,
      json: { code: 'PGRST116', message: 'No rows returned' },
    };
    expect(extractApiErrorMessage(response)).toContain('PGRST116');
  });
});
