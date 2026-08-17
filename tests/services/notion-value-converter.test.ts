/**
 * Tests for Notion property value flatten/wrap converters.
 * @covers src/services/notion-value-converter.ts
 */

import { describe, it, expect } from 'vitest';
import {
  flattenNotionProperties,
  wrapForNotionPush,
} from '../../src/services/notion-value-converter';
import type { NotionPropertyValue } from '../../src/types';

describe('flattenNotionProperties', () => {
  it('flattens title/rich_text arrays into joined plain_text', () => {
    const props: Record<string, NotionPropertyValue> = {
      Name: { type: 'title', title: [{ plain_text: 'Hello ' }, { plain_text: 'World' }] },
      Notes: { type: 'rich_text', rich_text: [{ plain_text: 'foo' }] },
    };
    expect(flattenNotionProperties(props)).toEqual({ Name: 'Hello World', Notes: 'foo' });
  });

  it('flattens empty title/rich_text arrays to null', () => {
    const props: Record<string, NotionPropertyValue> = {
      Name: { type: 'title', title: [] },
      Notes: { type: 'rich_text', rich_text: [] },
    };
    expect(flattenNotionProperties(props)).toEqual({ Name: null, Notes: null });
  });

  it('flattens number, preserving null', () => {
    expect(flattenNotionProperties({ Count: { type: 'number', number: 5 } })).toEqual({ Count: 5 });
    expect(flattenNotionProperties({ Count: { type: 'number', number: null } })).toEqual({ Count: null });
  });

  it('flattens checkbox, never producing null (false stays false)', () => {
    expect(flattenNotionProperties({ Done: { type: 'checkbox', checkbox: false } })).toEqual({ Done: false });
    expect(flattenNotionProperties({ Done: { type: 'checkbox', checkbox: true } })).toEqual({ Done: true });
  });

  it('flattens select/status to name or null', () => {
    expect(flattenNotionProperties({ S: { type: 'select', select: { name: 'A' } } })).toEqual({ S: 'A' });
    expect(flattenNotionProperties({ S: { type: 'select', select: null } })).toEqual({ S: null });
    expect(flattenNotionProperties({ St: { type: 'status', status: { name: 'Done' } } })).toEqual({ St: 'Done' });
  });

  it('flattens multi_select to a names array, empty → null', () => {
    expect(flattenNotionProperties({
      Tags: { type: 'multi_select', multi_select: [{ name: 'a' }, { name: 'b' }] },
    })).toEqual({ Tags: ['a', 'b'] });
    expect(flattenNotionProperties({ Tags: { type: 'multi_select', multi_select: [] } })).toEqual({ Tags: null });
  });

  it('flattens date to null | start | start/end', () => {
    expect(flattenNotionProperties({ D: { type: 'date', date: null } })).toEqual({ D: null });
    expect(flattenNotionProperties({ D: { type: 'date', date: { start: '2026-01-01', end: null } } })).toEqual({ D: '2026-01-01' });
    expect(flattenNotionProperties({ D: { type: 'date', date: { start: '2026-01-01', end: '2026-01-05' } } })).toEqual({ D: '2026-01-01/2026-01-05' });
  });

  it('flattens url/email/phone_number as-is', () => {
    expect(flattenNotionProperties({ U: { type: 'url', url: 'https://x.com' } })).toEqual({ U: 'https://x.com' });
    expect(flattenNotionProperties({ U: { type: 'url', url: null } })).toEqual({ U: null });
    expect(flattenNotionProperties({ E: { type: 'email', email: 'a@b.com' } })).toEqual({ E: 'a@b.com' });
    expect(flattenNotionProperties({ P: { type: 'phone_number', phone_number: '123' } })).toEqual({ P: '123' });
  });

  it('flattens people to name-or-id array, empty → null', () => {
    expect(flattenNotionProperties({
      Owner: { type: 'people', people: [{ id: 'u1', name: 'Alice' }, { id: 'u2' }] },
    })).toEqual({ Owner: ['Alice', 'u2'] });
    expect(flattenNotionProperties({ Owner: { type: 'people', people: [] } })).toEqual({ Owner: null });
  });

  it('flattens files to name/url array, empty → null', () => {
    expect(flattenNotionProperties({
      Attachments: {
        type: 'files',
        files: [
          { name: 'a.pdf', file: { url: 'https://x/a.pdf' } },
          { name: null, external: { url: 'https://x/b.pdf' } },
        ],
      },
    })).toEqual({ Attachments: ['a.pdf', 'https://x/b.pdf'] });
    expect(flattenNotionProperties({ Attachments: { type: 'files', files: [] } })).toEqual({ Attachments: null });
  });

  it('flattens relation to id array, empty → null', () => {
    expect(flattenNotionProperties({
      Related: { type: 'relation', relation: [{ id: 'r1' }, { id: 'r2' }] },
    })).toEqual({ Related: ['r1', 'r2'] });
    expect(flattenNotionProperties({ Related: { type: 'relation', relation: [] } })).toEqual({ Related: null });
  });

  it('flattens formula by its inner type', () => {
    expect(flattenNotionProperties({ F: { type: 'formula', formula: { type: 'number', number: 42 } } })).toEqual({ F: 42 });
    expect(flattenNotionProperties({ F: { type: 'formula', formula: { type: 'string', string: 'hi' } } })).toEqual({ F: 'hi' });
    expect(flattenNotionProperties({ F: { type: 'formula', formula: { type: 'boolean', boolean: true } } })).toEqual({ F: true });
    expect(flattenNotionProperties({ F: { type: 'formula', formula: { type: 'date', date: { start: '2026-01-01', end: null } } } })).toEqual({ F: '2026-01-01' });
  });

  it('flattens rollup by inner type, including array rollups', () => {
    expect(flattenNotionProperties({ R: { type: 'rollup', rollup: { type: 'number', number: 7 } } })).toEqual({ R: 7 });
    expect(flattenNotionProperties({
      R: {
        type: 'rollup',
        rollup: {
          type: 'array',
          array: [
            { type: 'title', title: [{ plain_text: 'X' }] },
            { type: 'number', number: 3 },
          ],
        },
      },
    })).toEqual({ R: ['X', '3'] });
  });

  it('flattens created_time/last_edited_time as strings', () => {
    expect(flattenNotionProperties({ C: { type: 'created_time', created_time: '2026-01-01T00:00:00Z' } })).toEqual({ C: '2026-01-01T00:00:00Z' });
    expect(flattenNotionProperties({ L: { type: 'last_edited_time', last_edited_time: '2026-01-02T00:00:00Z' } })).toEqual({ L: '2026-01-02T00:00:00Z' });
  });

  it('flattens created_by/last_edited_by to name-or-id', () => {
    expect(flattenNotionProperties({ C: { type: 'created_by', created_by: { id: 'u1', name: 'Alice' } } })).toEqual({ C: 'Alice' });
    expect(flattenNotionProperties({ C: { type: 'created_by', created_by: { id: 'u1' } } })).toEqual({ C: 'u1' });
  });

  it('flattens unique_id with optional prefix', () => {
    expect(flattenNotionProperties({ ID: { type: 'unique_id', unique_id: { prefix: 'TASK', number: 12 } } })).toEqual({ ID: 'TASK-12' });
    expect(flattenNotionProperties({ ID: { type: 'unique_id', unique_id: { prefix: null, number: 12 } } })).toEqual({ ID: 12 });
  });

  it('flattens unknown type to null, still present in output', () => {
    expect(flattenNotionProperties({ V: { type: 'verification', verification: { state: 'verified' } } })).toEqual({ V: null });
  });

  it('every input property key is present in the output (column-drift rule)', () => {
    const props: Record<string, NotionPropertyValue> = {
      A: { type: 'title', title: [] },
      B: { type: 'checkbox', checkbox: false },
      C: { type: 'relation', relation: [] },
    };
    const out = flattenNotionProperties(props);
    expect(Object.keys(out).sort()).toEqual(['A', 'B', 'C']);
  });
});

describe('wrapForNotionPush', () => {
  it('wraps title/rich_text into chunked rich-text segments', () => {
    expect(wrapForNotionPush('title', 'Hello')).toEqual({
      ok: true,
      payload: { title: [{ text: { content: 'Hello' } }] },
    });
    expect(wrapForNotionPush('rich_text', '')).toEqual({
      ok: true,
      payload: { rich_text: [] },
    });
  });

  it('refuses empty/null title (would clear the Notion page name) but still clears rich_text', () => {
    expect(wrapForNotionPush('title', '')).toEqual({
      ok: false,
      reason: expect.any(String),
    });
    expect(wrapForNotionPush('title', null)).toEqual({
      ok: false,
      reason: expect.any(String),
    });
    expect(wrapForNotionPush('rich_text', null)).toEqual({
      ok: true,
      payload: { rich_text: [] },
    });
  });

  it('chunks long text at the 2000-char boundary', () => {
    const long = 'a'.repeat(4500);
    const result = wrapForNotionPush('rich_text', long);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const segments = result.payload.rich_text as { text: { content: string } }[];
      expect(segments).toHaveLength(3);
      expect(segments[0].text.content).toHaveLength(2000);
      expect(segments[1].text.content).toHaveLength(2000);
      expect(segments[2].text.content).toHaveLength(500);
      expect(segments.map(s => s.text.content).join('')).toBe(long);
    }
  });

  it('wraps number, coercing numeric strings', () => {
    expect(wrapForNotionPush('number', 5)).toEqual({ ok: true, payload: { number: 5 } });
    expect(wrapForNotionPush('number', '5')).toEqual({ ok: true, payload: { number: 5 } });
    expect(wrapForNotionPush('number', 'not-a-number')).toEqual({ ok: false, reason: expect.any(String) });
  });

  it('wraps checkbox, false stays false (never dropped)', () => {
    expect(wrapForNotionPush('checkbox', false)).toEqual({ ok: true, payload: { checkbox: false } });
    expect(wrapForNotionPush('checkbox', true)).toEqual({ ok: true, payload: { checkbox: true } });
    expect(wrapForNotionPush('checkbox', 'true')).toEqual({ ok: true, payload: { checkbox: true } });
    expect(wrapForNotionPush('checkbox', 'false')).toEqual({ ok: true, payload: { checkbox: false } });
  });

  it('coerces numeric 0/1 checkbox values (YAML round-trip from some editors)', () => {
    expect(wrapForNotionPush('checkbox', 1)).toEqual({ ok: true, payload: { checkbox: true } });
    expect(wrapForNotionPush('checkbox', 0)).toEqual({ ok: true, payload: { checkbox: false } });
    expect(wrapForNotionPush('checkbox', 2).ok).toBe(false);
  });

  it('wraps select/status; empty/null clears', () => {
    expect(wrapForNotionPush('select', 'A')).toEqual({ ok: true, payload: { select: { name: 'A' } } });
    expect(wrapForNotionPush('select', '')).toEqual({ ok: true, payload: { select: null } });
    expect(wrapForNotionPush('select', null)).toEqual({ ok: true, payload: { select: null } });
    expect(wrapForNotionPush('status', 'Done')).toEqual({ ok: true, payload: { status: { name: 'Done' } } });
  });

  it('wraps multi_select from array or comma-joined string', () => {
    expect(wrapForNotionPush('multi_select', ['a', 'b'])).toEqual({ ok: true, payload: { multi_select: [{ name: 'a' }, { name: 'b' }] } });
    expect(wrapForNotionPush('multi_select', 'a,b')).toEqual({ ok: true, payload: { multi_select: [{ name: 'a' }, { name: 'b' }] } });
    expect(wrapForNotionPush('multi_select', '')).toEqual({ ok: true, payload: { multi_select: [] } });
    expect(wrapForNotionPush('multi_select', [])).toEqual({ ok: true, payload: { multi_select: [] } });
  });

  it('wraps date, splitting on the first slash into start/end', () => {
    expect(wrapForNotionPush('date', '')).toEqual({ ok: true, payload: { date: null } });
    expect(wrapForNotionPush('date', null)).toEqual({ ok: true, payload: { date: null } });
    expect(wrapForNotionPush('date', '2026-01-01')).toEqual({ ok: true, payload: { date: { start: '2026-01-01' } } });
    expect(wrapForNotionPush('date', '2026-01-01/2026-01-05')).toEqual({ ok: true, payload: { date: { start: '2026-01-01', end: '2026-01-05' } } });
  });

  it('wraps url/email/phone_number; empty clears to null', () => {
    expect(wrapForNotionPush('url', 'https://x.com')).toEqual({ ok: true, payload: { url: 'https://x.com' } });
    expect(wrapForNotionPush('url', '')).toEqual({ ok: true, payload: { url: null } });
    expect(wrapForNotionPush('email', 'a@b.com')).toEqual({ ok: true, payload: { email: 'a@b.com' } });
    expect(wrapForNotionPush('phone_number', '')).toEqual({ ok: true, payload: { phone_number: null } });
  });

  it('rejects unsupported types', () => {
    const result = wrapForNotionPush('relation', ['r1']);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBeTruthy();
  });

  it('round-trips flatten → wrap for reconstructible types', () => {
    const flat = flattenNotionProperties({
      Name: { type: 'title', title: [{ plain_text: 'Round Trip' }] },
    });
    const wrapped = wrapForNotionPush('title', flat.Name);
    expect(wrapped).toEqual({ ok: true, payload: { title: [{ text: { content: 'Round Trip' } }] } });

    const flatDate = flattenNotionProperties({ D: { type: 'date', date: { start: '2026-01-01', end: '2026-01-05' } } });
    const wrappedDate = wrapForNotionPush('date', flatDate.D);
    expect(wrappedDate).toEqual({ ok: true, payload: { date: { start: '2026-01-01', end: '2026-01-05' } } });
  });
});
