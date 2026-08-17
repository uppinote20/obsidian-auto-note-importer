/**
 * Notion property value converters.
 *
 * Pure functions with no `obsidian` imports — flattens Notion's wire-format
 * property values into frontmatter-safe scalars/arrays, and wraps
 * frontmatter values back into Notion's PATCH-body property shape.
 *
 * @handbook 4.4-provider-abstraction
 * @handbook 7.3-read-only-field-protection
 * @tested tests/services/notion-value-converter.test.ts
 * @tested e2e:tests/e2e/run-notion-e2e.mjs
 */

import { NOTION_RICH_TEXT_MAX_LEN } from '../constants';
import type { NotionPropertyValue } from '../types';

type RichTextItem = { plain_text?: string };

function joinRichText(items: unknown): string | null {
  if (!Array.isArray(items) || items.length === 0) return null;
  return (items as RichTextItem[]).map(i => i.plain_text ?? '').join('');
}

function nameOrId(entity: unknown): string | null {
  if (!entity || typeof entity !== 'object') return null;
  const e = entity as { name?: string; id?: string };
  return e.name ?? e.id ?? null;
}

/**
 * Flattens a single already-typed property value (the shape Notion returns
 * for `formula`/`rollup` inner values too) into a frontmatter-safe scalar.
 */
function flattenScalarByType(type: string, value: Record<string, unknown>): unknown {
  switch (type) {
    case 'number':
      return value.number ?? null;
    case 'string':
      return value.string ?? null;
    case 'boolean':
      return value.boolean ?? null;
    case 'date': {
      const d = value.date as { start?: string; end?: string | null } | null;
      if (!d) return null;
      return d.end ? `${d.start}/${d.end}` : d.start ?? null;
    }
    case 'title':
      return joinRichText(value.title);
    default:
      return null;
  }
}

function flattenOneProperty(value: NotionPropertyValue): unknown {
  switch (value.type) {
    case 'title':
      return joinRichText(value.title);
    case 'rich_text':
      return joinRichText(value.rich_text);
    case 'number':
      return value.number ?? null;
    case 'checkbox':
      return Boolean(value.checkbox);
    case 'select':
    case 'status': {
      const v = value[value.type] as { name?: string } | null;
      return v?.name ?? null;
    }
    case 'multi_select': {
      const arr = value.multi_select as { name: string }[] | undefined;
      if (!arr || arr.length === 0) return null;
      return arr.map(i => i.name);
    }
    case 'date': {
      const d = value.date as { start: string; end?: string | null } | null;
      if (!d) return null;
      return d.end ? `${d.start}/${d.end}` : d.start;
    }
    case 'url':
      return value.url ?? null;
    case 'email':
      return value.email ?? null;
    case 'phone_number':
      return value.phone_number ?? null;
    case 'people': {
      const arr = value.people as unknown[] | undefined;
      if (!arr || arr.length === 0) return null;
      return arr.map(nameOrId);
    }
    case 'files': {
      const arr = value.files as {
        name?: string | null;
        file?: { url?: string };
        external?: { url?: string };
        url?: string;
      }[] | undefined;
      if (!arr || arr.length === 0) return null;
      return arr.map(f => f.name ?? f.file?.url ?? f.external?.url ?? f.url ?? null);
    }
    case 'relation': {
      const arr = value.relation as { id: string }[] | undefined;
      if (!arr || arr.length === 0) return null;
      return arr.map(r => r.id);
    }
    case 'formula': {
      const inner = value.formula as Record<string, unknown> & { type: string };
      if (!inner) return null;
      return flattenScalarByType(inner.type, inner);
    }
    case 'rollup': {
      const inner = value.rollup as Record<string, unknown> & { type: string };
      if (!inner) return null;
      if (inner.type === 'array') {
        const arr = inner.array as NotionPropertyValue[] | undefined;
        if (!arr || arr.length === 0) return null;
        return arr.map(item => {
          const scalar = flattenOneProperty(item);
          return scalar === null ? null : String(scalar);
        });
      }
      return flattenScalarByType(inner.type, inner);
    }
    case 'created_time':
      return value.created_time ?? null;
    case 'last_edited_time':
      return value.last_edited_time ?? null;
    case 'created_by':
      return nameOrId(value.created_by);
    case 'last_edited_by':
      return nameOrId(value.last_edited_by);
    case 'unique_id': {
      const u = value.unique_id as { prefix?: string | null; number: number } | null;
      if (!u) return null;
      return u.prefix ? `${u.prefix}-${u.number}` : u.number;
    }
    default:
      return null;
  }
}

/**
 * Flattens a Notion page's properties map into frontmatter-safe values.
 * Every input key is preserved in the output (null for empties) so Bases
 * columns don't silently disappear when a value is unset.
 */
export function flattenNotionProperties(
  properties: Record<string, NotionPropertyValue>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(properties)) {
    out[name] = flattenOneProperty(value);
  }
  return out;
}

export type WrapResult =
  | { ok: true; payload: Record<string, unknown> }
  | { ok: false; reason: string };

function chunkRichText(text: string): { text: { content: string } }[] {
  if (text === '') return [];
  const chunks: { text: { content: string } }[] = [];
  for (let i = 0; i < text.length; i += NOTION_RICH_TEXT_MAX_LEN) {
    chunks.push({ text: { content: text.slice(i, i + NOTION_RICH_TEXT_MAX_LEN) } });
  }
  return chunks;
}

/**
 * Wraps a frontmatter value into the Notion PATCH property payload shape
 * for the given Notion property type. Returns `{ ok: false }` for types the
 * sync pipeline doesn't (or can't) push — callers should skip the field.
 */
export function wrapForNotionPush(notionType: string, value: unknown): WrapResult {
  switch (notionType) {
    case 'title': {
      const s = String(value ?? '');
      if (s === '') {
        return { ok: false, reason: 'empty title would clear the Notion page name' };
      }
      return { ok: true, payload: { title: chunkRichText(s) } };
    }
    case 'rich_text':
      return { ok: true, payload: { rich_text: chunkRichText(String(value ?? '')) } };
    case 'number': {
      if (value === null || value === undefined || value === '') {
        return { ok: true, payload: { number: null } };
      }
      const n = typeof value === 'number' ? value : Number(value);
      if (Number.isNaN(n)) return { ok: false, reason: `Value is not a number: ${String(value)}` };
      return { ok: true, payload: { number: n } };
    }
    case 'checkbox': {
      if (typeof value === 'boolean') return { ok: true, payload: { checkbox: value } };
      if (value === 'true') return { ok: true, payload: { checkbox: true } };
      if (value === 'false') return { ok: true, payload: { checkbox: false } };
      // Some editors round-trip YAML booleans as 0/1 — coerce those two
      // exact values; anything else is still rejected.
      if (value === 0 || value === 1) return { ok: true, payload: { checkbox: value === 1 } };
      return { ok: false, reason: `Value is not a boolean: ${String(value)}` };
    }
    case 'select':
    case 'status': {
      if (value === null || value === undefined || value === '') {
        return { ok: true, payload: { [notionType]: null } };
      }
      return { ok: true, payload: { [notionType]: { name: String(value) } } };
    }
    case 'multi_select': {
      let names: string[];
      if (Array.isArray(value)) {
        names = value.map(v => String(v)).filter(v => v !== '');
      } else if (value === null || value === undefined || value === '') {
        names = [];
      } else {
        names = String(value).split(',').map(s => s.trim()).filter(s => s !== '');
      }
      return { ok: true, payload: { multi_select: names.map(name => ({ name })) } };
    }
    case 'date': {
      if (value === null || value === undefined || value === '') {
        return { ok: true, payload: { date: null } };
      }
      const raw = String(value);
      const idx = raw.indexOf('/');
      if (idx === -1) return { ok: true, payload: { date: { start: raw } } };
      return { ok: true, payload: { date: { start: raw.slice(0, idx), end: raw.slice(idx + 1) } } };
    }
    case 'url':
    case 'email':
    case 'phone_number': {
      if (value === null || value === undefined || value === '') {
        return { ok: true, payload: { [notionType]: null } };
      }
      return { ok: true, payload: { [notionType]: String(value) } };
    }
    default:
      return { ok: false, reason: `Unsupported Notion property type for push: ${notionType}` };
  }
}
