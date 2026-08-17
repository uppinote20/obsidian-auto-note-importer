/**
 * Tests for the Notion block → Markdown converter.
 * @covers src/services/notion-block-converter.ts
 */

import { describe, it, expect } from 'vitest';
import { richTextToMarkdown, blocksToMarkdown } from '../../src/services/notion-block-converter';
import type { NotionBlock, NotionRichTextItem } from '../../src/types';

function rt(plain_text: string, extra: Partial<NotionRichTextItem> = {}): NotionRichTextItem {
  return { type: 'text', plain_text, ...extra };
}

function childrenMap(map: Record<string, NotionBlock[] | null>) {
  return async (blockId: string): Promise<NotionBlock[] | null> => {
    if (!(blockId in map)) return [];
    return map[blockId];
  };
}

describe('richTextToMarkdown', () => {
  it('returns empty string for empty/missing input', () => {
    expect(richTextToMarkdown([])).toBe('');
  });

  it('renders plain text with no annotations', () => {
    expect(richTextToMarkdown([rt('hello')])).toBe('hello');
  });

  it('applies code then bold innermost-first', () => {
    const item = rt('x', { annotations: { bold: true, code: true } });
    expect(richTextToMarkdown([item])).toBe('**`x`**');
  });

  it('applies italic and strikethrough on top of bold/code', () => {
    const item = rt('x', { annotations: { bold: true, italic: true, strikethrough: true, code: true } });
    expect(richTextToMarkdown([item])).toBe('~~***`x`***~~');
  });

  it('wraps underline in <u> tags', () => {
    const item = rt('x', { annotations: { underline: true } });
    expect(richTextToMarkdown([item])).toBe('<u>x</u>');
  });

  it('wraps background colors in == highlight ==', () => {
    const item = rt('x', { annotations: { color: 'yellow_background' } });
    expect(richTextToMarkdown([item])).toBe('==x==');
  });

  it('drops foreground colors', () => {
    const item = rt('x', { annotations: { color: 'red' } });
    expect(richTextToMarkdown([item])).toBe('x');
  });

  it('wraps href outermost, after annotations', () => {
    const item = rt('x', { annotations: { bold: true }, href: 'https://example.com' });
    expect(richTextToMarkdown([item])).toBe('[**x**](https://example.com)');
  });

  it('renders inline equations as $expr$', () => {
    const item: NotionRichTextItem = { type: 'equation', equation: { expression: 'a+b' } };
    expect(richTextToMarkdown([item])).toBe('$a+b$');
  });

  it('treats missing plain_text as empty', () => {
    expect(richTextToMarkdown([{ type: 'text' }])).toBe('');
  });

  it('joins multiple items with no separator', () => {
    expect(richTextToMarkdown([rt('foo '), rt('bar', { annotations: { bold: true } })])).toBe('foo **bar**');
  });
});

describe('blocksToMarkdown', () => {
  it('returns empty string for an empty blocks array', async () => {
    expect(await blocksToMarkdown([], childrenMap({}))).toBe('');
  });

  it('renders a paragraph', async () => {
    const block: NotionBlock = { id: 'b1', type: 'paragraph', paragraph: { rich_text: [rt('hello world')] } };
    expect(await blocksToMarkdown([block], childrenMap({}))).toBe('hello world');
  });

  it('renders headings 1/2/3', async () => {
    const blocks: NotionBlock[] = [
      { id: 'h1', type: 'heading_1', heading_1: { rich_text: [rt('One')] } },
      { id: 'h2', type: 'heading_2', heading_2: { rich_text: [rt('Two')] } },
      { id: 'h3', type: 'heading_3', heading_3: { rich_text: [rt('Three')] } },
    ];
    const md = await blocksToMarkdown(blocks, childrenMap({}));
    expect(md).toBe('# One\n\n## Two\n\n### Three');
  });

  it('renders a toggleable heading with children as an admonition, prefixing children with >', async () => {
    const heading: NotionBlock = {
      id: 'h1',
      type: 'heading_1',
      has_children: true,
      heading_1: { rich_text: [rt('Title')], is_toggleable: true },
    };
    const child: NotionBlock = { id: 'c1', type: 'paragraph', paragraph: { rich_text: [rt('body')] } };
    const md = await blocksToMarkdown([heading], childrenMap({ h1: [child] }));
    expect(md).toBe('> [!note]+ # Title\n> body');
  });

  it('renders bulleted and to_do list items with markers', async () => {
    const blocks: NotionBlock[] = [
      { id: 'b1', type: 'bulleted_list_item', bulleted_list_item: { rich_text: [rt('item')] } },
      { id: 't1', type: 'to_do', to_do: { rich_text: [rt('unchecked')], checked: false } },
      { id: 't2', type: 'to_do', to_do: { rich_text: [rt('checked')], checked: true } },
    ];
    const md = await blocksToMarkdown(blocks, childrenMap({}));
    expect(md).toBe('- item\n- [ ] unchecked\n- [x] checked');
  });

  it('numbers numbered_list_item sequentially within a contiguous run', async () => {
    const blocks: NotionBlock[] = [
      { id: 'n1', type: 'numbered_list_item', numbered_list_item: { rich_text: [rt('first')] } },
      { id: 'n2', type: 'numbered_list_item', numbered_list_item: { rich_text: [rt('second')] } },
      { id: 'p1', type: 'paragraph', paragraph: { rich_text: [rt('break')] } },
      { id: 'n3', type: 'numbered_list_item', numbered_list_item: { rich_text: [rt('restarts')] } },
    ];
    const md = await blocksToMarkdown(blocks, childrenMap({}));
    expect(md).toBe('1. first\n2. second\n\nbreak\n\n1. restarts');
  });

  it('indents nested list children 4 spaces per depth', async () => {
    const parent: NotionBlock = {
      id: 'b1',
      type: 'bulleted_list_item',
      has_children: true,
      bulleted_list_item: { rich_text: [rt('parent')] },
    };
    const child: NotionBlock = {
      id: 'b2',
      type: 'bulleted_list_item',
      has_children: true,
      bulleted_list_item: { rich_text: [rt('child')] },
    };
    const grandchild: NotionBlock = {
      id: 'b3',
      type: 'bulleted_list_item',
      bulleted_list_item: { rich_text: [rt('grandchild')] },
    };
    const md = await blocksToMarkdown([parent], childrenMap({ b1: [child], b2: [grandchild] }));
    expect(md).toBe('- parent\n    - child\n        - grandchild');
  });

  it('renders a toggle block with children prefixed by >', async () => {
    const toggle: NotionBlock = { id: 't1', type: 'toggle', has_children: true, toggle: { rich_text: [rt('Toggle')] } };
    const child: NotionBlock = { id: 'c1', type: 'paragraph', paragraph: { rich_text: [rt('line1')] } };
    const md = await blocksToMarkdown([toggle], childrenMap({ t1: [child] }));
    expect(md).toBe('> [!note]+ Toggle\n> line1');
  });

  it('renders a quote block, re-prefixing multi-line children with >', async () => {
    const quote: NotionBlock = { id: 'q1', type: 'quote', has_children: true, quote: { rich_text: [rt('Quoted')] } };
    const child1: NotionBlock = { id: 'c1', type: 'paragraph', paragraph: { rich_text: [rt('line1')] } };
    const child2: NotionBlock = { id: 'c2', type: 'paragraph', paragraph: { rich_text: [rt('line2')] } };
    const md = await blocksToMarkdown([quote], childrenMap({ q1: [child1, child2] }));
    expect(md).toBe('> Quoted\n> line1\n> \n> line2');
  });

  it('maps callout icon emoji to admonition type', async () => {
    const blocks: NotionBlock[] = [
      { id: 'c1', type: 'callout', callout: { rich_text: [rt('tip text')], icon: { emoji: '💡' } } },
      { id: 'c2', type: 'callout', callout: { rich_text: [rt('warn text')], icon: { emoji: '⚠️' } } },
      { id: 'c3', type: 'callout', callout: { rich_text: [rt('danger text')], icon: { emoji: '❌' } } },
      { id: 'c4', type: 'callout', callout: { rich_text: [rt('success text')], icon: { emoji: '✅' } } },
      { id: 'c5', type: 'callout', callout: { rich_text: [rt('info text')], icon: { emoji: 'ℹ️' } } },
      { id: 'c6', type: 'callout', callout: { rich_text: [rt('question text')], icon: { emoji: '❓' } } },
      { id: 'c7', type: 'callout', callout: { rich_text: [rt('note text')] } },
    ];
    const md = await blocksToMarkdown(blocks, childrenMap({}));
    expect(md).toBe(
      [
        '> [!tip] 💡 tip text',
        '> [!warning] ⚠️ warn text',
        '> [!danger] ❌ danger text',
        '> [!success] ✅ success text',
        '> [!info] ℹ️ info text',
        '> [!question] ❓ question text',
        '> [!note] note text',
      ].join('\n\n'),
    );
  });

  it('renders code blocks verbatim without annotation processing, dropping "plain text" language', () => {
    return blocksToMarkdown(
      [
        {
          id: 'code1',
          type: 'code',
          code: { rich_text: [rt('const *x* = 1;')], language: 'plain text' },
        },
      ],
      childrenMap({}),
    ).then(md => {
      expect(md).toBe('```\nconst *x* = 1;\n```');
    });
  });

  it('renders a code block with a language fence', async () => {
    const block: NotionBlock = {
      id: 'code1',
      type: 'code',
      code: { rich_text: [rt('const x = 1;')], language: 'javascript' },
    };
    const md = await blocksToMarkdown([block], childrenMap({}));
    expect(md).toBe('```javascript\nconst x = 1;\n```');
  });

  it('renders inline and block equations', async () => {
    const inline: NotionBlock = {
      id: 'p1',
      type: 'paragraph',
      paragraph: { rich_text: [{ type: 'equation', equation: { expression: 'x^2' } }] },
    };
    const block: NotionBlock = { id: 'e1', type: 'equation', equation: { expression: 'y = mx + b' } };
    const md = await blocksToMarkdown([inline, block], childrenMap({}));
    expect(md).toBe('$x^2$\n\n$$\ny = mx + b\n$$');
  });

  it('renders a divider', async () => {
    const blocks: NotionBlock[] = [
      { id: 'p1', type: 'paragraph', paragraph: { rich_text: [rt('above')] } },
      { id: 'd1', type: 'divider', divider: {} },
      { id: 'p2', type: 'paragraph', paragraph: { rich_text: [rt('below')] } },
    ];
    const md = await blocksToMarkdown(blocks, childrenMap({}));
    expect(md).toBe('above\n\n---\n\nbelow');
  });

  it('renders a table with a header separator always after the first row', async () => {
    const table: NotionBlock = { id: 'tbl1', type: 'table', table: { table_width: 2 } };
    const row1: NotionBlock = { id: 'r1', type: 'table_row', table_row: { cells: [[rt('A')], [rt('B')]] } };
    const row2: NotionBlock = { id: 'r2', type: 'table_row', table_row: { cells: [[rt('1')], [rt('2\nmulti')]] } };
    const md = await blocksToMarkdown([table], childrenMap({ tbl1: [row1, row2] }));
    expect(md).toBe('| A | B |\n| --- | --- |\n| 1 | 2<br>multi |');
  });

  it('renders an empty table as an empty string', async () => {
    const table: NotionBlock = { id: 'tbl1', type: 'table', table: { table_width: 0 } };
    const md = await blocksToMarkdown([table], childrenMap({ tbl1: [] }));
    expect(md).toBe('');
  });

  it('flattens column_list into left-to-right columns with markers', async () => {
    const columnList: NotionBlock = { id: 'cl1', type: 'column_list', column_list: {} };
    const col1: NotionBlock = { id: 'col1', type: 'column', column: {} };
    const col2: NotionBlock = { id: 'col2', type: 'column', column: {} };
    const col1child: NotionBlock = { id: 'p1', type: 'paragraph', paragraph: { rich_text: [rt('left')] } };
    const col2child: NotionBlock = { id: 'p2', type: 'paragraph', paragraph: { rich_text: [rt('right')] } };
    const md = await blocksToMarkdown(
      [columnList],
      childrenMap({ cl1: [col1, col2], col1: [col1child], col2: [col2child] }),
    );
    expect(md).toBe('<!-- Column 1 -->\nleft\n\n<!-- Column 2 -->\nright');
  });

  it('renders an image with external url and caption', async () => {
    const block: NotionBlock = {
      id: 'img1',
      type: 'image',
      image: { type: 'external', caption: [rt('a caption')], external: { url: 'https://example.com/a.png' } },
    };
    const md = await blocksToMarkdown([block], childrenMap({}));
    expect(md).toBe('![a caption](https://example.com/a.png)');
  });

  it('renders video/audio/file/pdf blocks as attachment links', async () => {
    const blocks: NotionBlock[] = [
      { id: 'v1', type: 'video', video: { type: 'external', external: { url: 'https://example.com/v.mp4' } } },
      { id: 'f1', type: 'file', file: { type: 'file', caption: [rt('doc')], file: { url: 'https://example.com/f.pdf' } } },
    ];
    const md = await blocksToMarkdown(blocks, childrenMap({}));
    expect(md).toBe('[attachment](https://example.com/v.mp4)\n\n[doc](https://example.com/f.pdf)');
  });

  it('renders bookmark/embed/link_preview using caption or url', async () => {
    const blocks: NotionBlock[] = [
      { id: 'bm1', type: 'bookmark', bookmark: { url: 'https://example.com', caption: [rt('My Site')] } },
      { id: 'em1', type: 'embed', embed: { url: 'https://embed.example.com' } },
    ];
    const md = await blocksToMarkdown(blocks, childrenMap({}));
    expect(md).toBe('[My Site](https://example.com)\n\n[https://embed.example.com](https://embed.example.com)');
  });

  it('renders original synced_block content by rendering its children', async () => {
    const synced: NotionBlock = {
      id: 's1',
      type: 'synced_block',
      has_children: true,
      synced_block: { synced_from: null },
    };
    const child: NotionBlock = { id: 'c1', type: 'paragraph', paragraph: { rich_text: [rt('original')] } };
    const md = await blocksToMarkdown([synced], childrenMap({ s1: [child] }));
    expect(md).toBe('original');
  });

  it('resolves a synced_block copy by fetching its synced_from target', async () => {
    const synced: NotionBlock = {
      id: 's1',
      type: 'synced_block',
      synced_block: { synced_from: { block_id: 'orig1' } },
    };
    const child: NotionBlock = { id: 'c1', type: 'paragraph', paragraph: { rich_text: [rt('copied content')] } };
    const md = await blocksToMarkdown([synced], childrenMap({ orig1: [child] }));
    expect(md).toBe('copied content');
  });

  it('emits an unresolved marker for a synced_block cycle', async () => {
    const syncedA: NotionBlock = {
      id: 'a1',
      type: 'synced_block',
      synced_block: { synced_from: { block_id: 'b1' } },
    };
    const syncedB: NotionBlock = {
      id: 'b1',
      type: 'synced_block',
      synced_block: { synced_from: { block_id: 'a1' } },
    };
    const md = await blocksToMarkdown([syncedA], childrenMap({ b1: [syncedB], a1: [syncedA] }));
    expect(md).toBe('<!-- Unresolved synced block -->');
  });

  it('renders child_page and child_database as bold titles', async () => {
    const blocks: NotionBlock[] = [
      { id: 'cp1', type: 'child_page', child_page: { title: 'Sub Page' } },
      { id: 'cd1', type: 'child_database', child_database: { title: 'Sub DB' } },
    ];
    const md = await blocksToMarkdown(blocks, childrenMap({}));
    expect(md).toBe('**Sub Page**\n\n**Sub DB**');
  });

  it('emits an unsupported marker for unknown block types', async () => {
    const block: NotionBlock = { id: 'x1', type: 'unknown_type' };
    const md = await blocksToMarkdown([block], childrenMap({}));
    expect(md).toBe('<!-- Unsupported block: unknown_type -->');
  });

  it('emits a truncation marker and stops descending when the budget is exhausted', async () => {
    const parent: NotionBlock = {
      id: 'p1',
      type: 'paragraph',
      has_children: true,
      paragraph: { rich_text: [rt('parent')] },
    };
    const md = await blocksToMarkdown([parent], childrenMap({ p1: null }));
    expect(md).toBe('parent\n\n<!-- Body truncated: request budget exhausted -->');
  });

  it('emits a truncation marker at the configured max depth', async () => {
    const l1: NotionBlock = {
      id: 'l1',
      type: 'bulleted_list_item',
      has_children: true,
      bulleted_list_item: { rich_text: [rt('level1')] },
    };
    const l2: NotionBlock = {
      id: 'l2',
      type: 'bulleted_list_item',
      has_children: true,
      bulleted_list_item: { rich_text: [rt('level2')] },
    };
    const md = await blocksToMarkdown([l1], childrenMap({ l1: [l2] }), { maxDepth: 1 });
    expect(md).toBe('- level1\n    - level2\n        <!-- Body truncated: max depth -->');
  });
});
