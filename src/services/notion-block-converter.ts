/**
 * Notion block → Markdown converter.
 *
 * Pure functions with no `obsidian` imports — walks a Notion block tree
 * (fetched page-by-page by the caller via `fetchChildren`) and renders it
 * into a single Markdown string for the note body.
 *
 * Simplification notes (documented per spec, v1 scope):
 * - "List-like nesting context" is simplified to: list items
 *   (bulleted/numbered/to_do) indent their children 4 spaces per depth;
 *   quote/toggle/callout/toggleable-heading prefix their children with
 *   `> `; every other block type (paragraph, etc.) appends its children as
 *   plain sibling blocks with no indent/prefix.
 * - `fetchChildren` is budget-owned by the caller (C2): returning `null`
 *   means the request budget is exhausted, which the converter treats as
 *   "stop descending this subtree" and renders a truncation marker.
 *
 * @handbook 4.4-provider-abstraction
 * @tested tests/services/notion-block-converter.test.ts
 */

import { NOTION_BODY_MAX_DEPTH } from '../constants';
import type { NotionBlock, NotionRichTextItem } from '../types';

const BUDGET_EXHAUSTED_MARKER = '<!-- Body truncated: request budget exhausted -->';
const MAX_DEPTH_MARKER = '<!-- Body truncated: max depth -->';
const UNRESOLVED_SYNCED_BLOCK_MARKER = '<!-- Unresolved synced block -->';

type FetchChildren = (blockId: string) => Promise<NotionBlock[] | null>;

/**
 * Remote Notion content is untrusted (a shared workspace means other
 * people author it) — values landing in structural Markdown positions
 * must not be able to break out of them.
 *
 * Link/image targets: only http(s)/mailto schemes survive (kills
 * `javascript:` payloads); characters that terminate or corrupt a
 * `](…)` target are percent-encoded. Returns null for rejected URLs so
 * callers degrade to plain text.
 */
function sanitizeUrl(url: string | undefined): string | null {
  const u = (url ?? '').trim();
  if (!/^(https?:\/\/|mailto:)/i.test(u)) return null;
  return u.replace(/[\s<>()]/g, ch => `%${ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`);
}

/** Keeps HTML-comment markers unescapable: `-->` can never form. */
function sanitizeForComment(value: string): string {
  return value.replace(/[^a-z0-9_]/gi, '_');
}

/**
 * Renders a Notion `rich_text` array into inline Markdown. Annotations are
 * applied innermost-first: code, then bold, italic, strikethrough, then
 * underline (`<u>`) and background-color highlight (`==`); a link href
 * wraps everything outermost.
 */
export function richTextToMarkdown(items: NotionRichTextItem[]): string {
  if (!items || items.length === 0) return '';
  return items.map(renderRichTextItem).join('');
}

function renderRichTextItem(item: NotionRichTextItem): string {
  let text = item.type === 'equation'
    ? `$${item.equation?.expression ?? ''}$`
    : item.plain_text ?? '';

  const a = item.annotations;
  if (a?.code) text = `\`${text}\``;
  if (a?.bold) text = `**${text}**`;
  if (a?.italic) text = `*${text}*`;
  if (a?.strikethrough) text = `~~${text}~~`;
  if (a?.underline) text = `<u>${text}</u>`;
  if (a?.color && a.color.endsWith('_background')) text = `==${text}==`;
  const safeHref = sanitizeUrl(item.href ?? undefined);
  if (safeHref) text = `[${text}](${safeHref})`;
  return text;
}

function getRichText(block: NotionBlock, key: string): NotionRichTextItem[] {
  const data = block[key] as { rich_text?: NotionRichTextItem[] } | undefined;
  return data?.rich_text ?? [];
}

function indentLines(text: string, spaces: number): string {
  if (text === '') return '';
  const pad = ' '.repeat(spaces);
  return text.split('\n').map(line => `${pad}${line}`).join('\n');
}

function quoteLines(text: string): string {
  if (text === '') return '';
  return text.split('\n').map(line => `> ${line}`).join('\n');
}

const LIST_LIKE_TYPES = new Set(['bulleted_list_item', 'numbered_list_item', 'to_do']);

function isListLike(type: string): boolean {
  return LIST_LIKE_TYPES.has(type);
}

function joinBlocks(rendered: { type: string; text: string }[]): string {
  let out = '';
  for (let i = 0; i < rendered.length; i++) {
    out += rendered[i].text;
    if (i < rendered.length - 1) {
      const sep = isListLike(rendered[i].type) && isListLike(rendered[i + 1].type) ? '\n' : '\n\n';
      out += sep;
    }
  }
  return out;
}

async function renderChildren(
  blockId: string,
  depth: number,
  visited: Set<string>,
  maxDepth: number,
  fetchChildren: FetchChildren,
): Promise<string> {
  if (depth + 1 > maxDepth) {
    return MAX_DEPTH_MARKER;
  }
  const children = await fetchChildren(blockId);
  if (children === null) {
    return BUDGET_EXHAUSTED_MARKER;
  }
  if (children.length === 0) return '';
  return renderBlockList(children, depth + 1, visited, maxDepth, fetchChildren);
}

async function renderBlockList(
  blocks: NotionBlock[],
  depth: number,
  visited: Set<string>,
  maxDepth: number,
  fetchChildren: FetchChildren,
): Promise<string> {
  const rendered: { type: string; text: string }[] = [];
  let numberedRunIndex = 0;
  for (const block of blocks) {
    numberedRunIndex = block.type === 'numbered_list_item' ? numberedRunIndex + 1 : 0;
    const text = await renderBlock(block, depth, visited, maxDepth, fetchChildren, numberedRunIndex);
    rendered.push({ type: block.type, text });
  }
  return joinBlocks(rendered);
}

async function renderParagraph(
  block: NotionBlock,
  depth: number,
  visited: Set<string>,
  maxDepth: number,
  fetchChildren: FetchChildren,
): Promise<string> {
  let out = richTextToMarkdown(getRichText(block, 'paragraph'));
  if (block.has_children) {
    const childrenMd = await renderChildren(block.id, depth, visited, maxDepth, fetchChildren);
    if (childrenMd) out = out === '' ? childrenMd : `${out}\n\n${childrenMd}`;
  }
  return out;
}

async function renderHeading(
  block: NotionBlock,
  depth: number,
  visited: Set<string>,
  maxDepth: number,
  fetchChildren: FetchChildren,
  level: 1 | 2 | 3,
): Promise<string> {
  const key = `heading_${level}`;
  const data = block[key] as { rich_text?: NotionRichTextItem[]; is_toggleable?: boolean } | undefined;
  const text = richTextToMarkdown(data?.rich_text ?? []);
  const hashes = '#'.repeat(level);

  if (data?.is_toggleable) {
    const header = `> [!note]+ ${hashes} ${text}`;
    if (!block.has_children) return header;
    const childrenMd = await renderChildren(block.id, depth, visited, maxDepth, fetchChildren);
    return childrenMd ? `${header}\n${quoteLines(childrenMd)}` : header;
  }

  let out = `${hashes} ${text}`;
  if (block.has_children) {
    const childrenMd = await renderChildren(block.id, depth, visited, maxDepth, fetchChildren);
    if (childrenMd) out = `${out}\n\n${childrenMd}`;
  }
  return out;
}

async function renderListItem(
  block: NotionBlock,
  depth: number,
  visited: Set<string>,
  maxDepth: number,
  fetchChildren: FetchChildren,
  marker: string,
): Promise<string> {
  const text = richTextToMarkdown(getRichText(block, block.type));
  let out = `${marker}${text}`;
  if (block.has_children) {
    const childrenMd = await renderChildren(block.id, depth, visited, maxDepth, fetchChildren);
    if (childrenMd) out = `${out}\n${indentLines(childrenMd, 4)}`;
  }
  return out;
}

async function renderToggle(
  block: NotionBlock,
  depth: number,
  visited: Set<string>,
  maxDepth: number,
  fetchChildren: FetchChildren,
): Promise<string> {
  const text = richTextToMarkdown(getRichText(block, 'toggle'));
  const header = `> [!note]+ ${text}`;
  if (!block.has_children) return header;
  const childrenMd = await renderChildren(block.id, depth, visited, maxDepth, fetchChildren);
  return childrenMd ? `${header}\n${quoteLines(childrenMd)}` : header;
}

async function renderQuote(
  block: NotionBlock,
  depth: number,
  visited: Set<string>,
  maxDepth: number,
  fetchChildren: FetchChildren,
): Promise<string> {
  const text = richTextToMarkdown(getRichText(block, 'quote'));
  let out = quoteLines(text) || '> ';
  if (block.has_children) {
    const childrenMd = await renderChildren(block.id, depth, visited, maxDepth, fetchChildren);
    if (childrenMd) out = `${out}\n${quoteLines(childrenMd)}`;
  }
  return out;
}

function calloutTypeFromEmoji(emoji?: string): string {
  if (!emoji) return 'note';
  if (['💡', '⚡'].includes(emoji)) return 'tip';
  if (['⚠️', '❗'].includes(emoji)) return 'warning';
  if (['❌', '🚫'].includes(emoji)) return 'danger';
  if (['✅', '✔️'].includes(emoji)) return 'success';
  if (emoji === 'ℹ️') return 'info';
  if (['❓', '🤔'].includes(emoji)) return 'question';
  return 'note';
}

async function renderCallout(
  block: NotionBlock,
  depth: number,
  visited: Set<string>,
  maxDepth: number,
  fetchChildren: FetchChildren,
): Promise<string> {
  const data = block.callout as { rich_text?: NotionRichTextItem[]; icon?: { emoji?: string } } | undefined;
  const emoji = data?.icon?.emoji;
  const type = calloutTypeFromEmoji(emoji);
  const text = richTextToMarkdown(data?.rich_text ?? []);
  const header = [`> [!${type}]`, emoji, text].filter(part => part !== undefined && part !== '').join(' ');
  if (!block.has_children) return header;
  const childrenMd = await renderChildren(block.id, depth, visited, maxDepth, fetchChildren);
  return childrenMd ? `${header}\n${quoteLines(childrenMd)}` : header;
}

function renderCode(block: NotionBlock): string {
  const data = block.code as { rich_text?: NotionRichTextItem[]; language?: string } | undefined;
  // Language lands on the fence line — strip backticks/whitespace so a
  // crafted value can't break or extend the fence.
  const lang = (data?.language === 'plain text' ? '' : data?.language ?? '').replace(/[`\s]/g, '');
  const content = (data?.rich_text ?? []).map(i => i.plain_text ?? '').join('');
  // A backtick run in the content must never close the fence — grow it.
  const longestRun = (content.match(/`+/g) ?? []).reduce((m, r) => Math.max(m, r.length), 0);
  const fence = '`'.repeat(Math.max(3, longestRun + 1));
  return `${fence}${lang}\n${content}\n${fence}`;
}

function renderEquationBlock(block: NotionBlock): string {
  const expr = (block.equation as { expression?: string } | undefined)?.expression ?? '';
  return `$$\n${expr}\n$$`;
}

async function renderTable(block: NotionBlock, fetchChildren: FetchChildren): Promise<string> {
  const rows = await fetchChildren(block.id);
  if (rows === null) return BUDGET_EXHAUSTED_MARKER;
  if (rows.length === 0) return '';

  const rowCells = rows.map(row => {
    const cells = (row.table_row as { cells?: NotionRichTextItem[][] } | undefined)?.cells ?? [];
    return cells.map(cell => {
      const rendered = richTextToMarkdown(cell ?? []).replace(/\|/g, '\\|').replace(/\n/g, '<br>');
      return rendered === '' ? ' ' : rendered;
    });
  });

  const colCount = rowCells[0]?.length ?? 0;
  const lines = [`| ${rowCells[0].join(' | ')} |`, `| ${new Array(colCount).fill('---').join(' | ')} |`];
  for (let i = 1; i < rowCells.length; i++) {
    lines.push(`| ${rowCells[i].join(' | ')} |`);
  }
  return lines.join('\n');
}

async function renderColumnList(
  block: NotionBlock,
  depth: number,
  visited: Set<string>,
  maxDepth: number,
  fetchChildren: FetchChildren,
): Promise<string> {
  const columns = await fetchChildren(block.id);
  if (columns === null) return BUDGET_EXHAUSTED_MARKER;

  const parts: string[] = [];
  for (let i = 0; i < columns.length; i++) {
    const col = columns[i];
    const colChildren = await fetchChildren(col.id);
    let colMd: string;
    if (colChildren === null) {
      colMd = BUDGET_EXHAUSTED_MARKER;
    } else if (colChildren.length === 0) {
      colMd = '';
    } else {
      colMd = await renderBlockList(colChildren, depth + 1, visited, maxDepth, fetchChildren);
    }
    parts.push(`<!-- Column ${i + 1} -->\n${colMd}`);
  }
  return parts.join('\n\n');
}

function renderImage(block: NotionBlock): string {
  const data = block.image as {
    caption?: NotionRichTextItem[];
    external?: { url?: string };
    file?: { url?: string };
  } | undefined;
  const caption = richTextToMarkdown(data?.caption ?? []);
  const url = sanitizeUrl(data?.external?.url ?? data?.file?.url);
  return url ? `![${caption}](${url})` : caption;
}

function renderFileLikeBlock(block: NotionBlock): string {
  const data = block[block.type] as {
    caption?: NotionRichTextItem[];
    name?: string;
    external?: { url?: string };
    file?: { url?: string };
  } | undefined;
  const caption = richTextToMarkdown(data?.caption ?? []);
  const url = sanitizeUrl(data?.external?.url ?? data?.file?.url);
  const label = data?.name || caption || 'attachment';
  return url ? `[${label}](${url})` : label;
}

function renderLinkBlock(block: NotionBlock): string {
  const data = block[block.type] as { url?: string; caption?: NotionRichTextItem[] } | undefined;
  const url = sanitizeUrl(data?.url);
  const caption = richTextToMarkdown(data?.caption ?? []);
  const label = caption || url || '';
  return url ? `[${label}](${url})` : label;
}

async function renderSyncedBlock(
  block: NotionBlock,
  depth: number,
  visited: Set<string>,
  maxDepth: number,
  fetchChildren: FetchChildren,
): Promise<string> {
  const data = block.synced_block as { synced_from?: { block_id?: string } | null } | undefined;

  if (!data?.synced_from) {
    if (!block.has_children) return '';
    return renderChildren(block.id, depth, visited, maxDepth, fetchChildren);
  }

  const targetId = data.synced_from.block_id;
  if (!targetId || visited.has(targetId)) {
    return UNRESOLVED_SYNCED_BLOCK_MARKER;
  }
  visited.add(targetId);

  const children = await fetchChildren(targetId);
  if (children === null) return UNRESOLVED_SYNCED_BLOCK_MARKER;
  if (children.length === 0) return '';
  return renderBlockList(children, depth + 1, visited, maxDepth, fetchChildren);
}

function renderChildPage(block: NotionBlock): string {
  const title = (block.child_page as { title?: string } | undefined)?.title ?? '';
  return `**${title}**`;
}

function renderChildDatabase(block: NotionBlock): string {
  const title = (block.child_database as { title?: string } | undefined)?.title ?? '';
  return `**${title}**`;
}

async function renderColumn(
  block: NotionBlock,
  depth: number,
  visited: Set<string>,
  maxDepth: number,
  fetchChildren: FetchChildren,
): Promise<string> {
  if (!block.has_children) return '';
  return renderChildren(block.id, depth, visited, maxDepth, fetchChildren);
}

async function renderBlock(
  block: NotionBlock,
  depth: number,
  visited: Set<string>,
  maxDepth: number,
  fetchChildren: FetchChildren,
  numberedRunIndex: number,
): Promise<string> {
  switch (block.type) {
    case 'paragraph':
      return renderParagraph(block, depth, visited, maxDepth, fetchChildren);
    case 'heading_1':
      return renderHeading(block, depth, visited, maxDepth, fetchChildren, 1);
    case 'heading_2':
      return renderHeading(block, depth, visited, maxDepth, fetchChildren, 2);
    case 'heading_3':
      return renderHeading(block, depth, visited, maxDepth, fetchChildren, 3);
    case 'bulleted_list_item':
      return renderListItem(block, depth, visited, maxDepth, fetchChildren, '- ');
    case 'numbered_list_item':
      return renderListItem(block, depth, visited, maxDepth, fetchChildren, `${numberedRunIndex}. `);
    case 'to_do': {
      const checked = (block.to_do as { checked?: boolean } | undefined)?.checked;
      return renderListItem(block, depth, visited, maxDepth, fetchChildren, checked ? '- [x] ' : '- [ ] ');
    }
    case 'toggle':
      return renderToggle(block, depth, visited, maxDepth, fetchChildren);
    case 'quote':
      return renderQuote(block, depth, visited, maxDepth, fetchChildren);
    case 'callout':
      return renderCallout(block, depth, visited, maxDepth, fetchChildren);
    case 'code':
      return renderCode(block);
    case 'equation':
      return renderEquationBlock(block);
    case 'divider':
      return '---';
    case 'table':
      return renderTable(block, fetchChildren);
    case 'column_list':
      return renderColumnList(block, depth, visited, maxDepth, fetchChildren);
    case 'column':
      return renderColumn(block, depth, visited, maxDepth, fetchChildren);
    case 'image':
      return renderImage(block);
    case 'video':
    case 'audio':
    case 'file':
    case 'pdf':
      return renderFileLikeBlock(block);
    case 'bookmark':
    case 'embed':
    case 'link_preview':
      return renderLinkBlock(block);
    case 'synced_block':
      return renderSyncedBlock(block, depth, visited, maxDepth, fetchChildren);
    case 'child_page':
      return renderChildPage(block);
    case 'child_database':
      return renderChildDatabase(block);
    default:
      return `<!-- Unsupported block: ${sanitizeForComment(block.type)} -->`;
  }
}

/**
 * Renders a Notion block tree into a single Markdown string. `fetchChildren`
 * is called for every block with `has_children: true` (and for table/
 * column_list containers regardless); it returns `null` when the caller's
 * request budget is exhausted, which stops descent into that subtree and
 * emits a truncation marker instead of failing the whole note.
 */
export async function blocksToMarkdown(
  blocks: NotionBlock[],
  fetchChildren: FetchChildren,
  opts?: { maxDepth?: number },
): Promise<string> {
  if (!blocks || blocks.length === 0) return '';
  const maxDepth = opts?.maxDepth ?? NOTION_BODY_MAX_DEPTH;
  const visited = new Set<string>();
  return renderBlockList(blocks, 0, visited, maxDepth, fetchChildren);
}
