/**
 * Tests for note-builder functions.
 * @covers src/builders/note-builder.ts
 */

import { describe, it, expect } from 'vitest';
import {
  parseTemplate,
  buildMarkdownContent
} from '../../src/builders/note-builder';
import type { RemoteNote } from '../../src/types';

describe('parseTemplate', () => {
  const createNote = (fields: Record<string, unknown>): RemoteNote => ({
    id: 'rec123',
    primaryField: 'rec123',
    fields
  });

  it('should replace simple placeholder', () => {
    const note = createNote({ title: 'Test Title' });
    const result = parseTemplate('# {{title}}', note);
    expect(result).toBe('# Test Title');
  });

  it('should replace multiple placeholders', () => {
    const note = createNote({ title: 'Test', author: 'John' });
    const result = parseTemplate('{{title}} by {{author}}', note);
    expect(result).toBe('Test by John');
  });

  it('should return empty string for missing field', () => {
    const note = createNote({});
    const result = parseTemplate('{{missing}}', note);
    expect(result).toBe('');
  });

  it('should return empty string for null field', () => {
    const note = createNote({ value: null });
    const result = parseTemplate('{{value}}', note);
    expect(result).toBe('');
  });

  it('should handle nested field access', () => {
    const note = createNote({ user: { name: 'John' } });
    const result = parseTemplate('{{user.name}}', note);
    expect(result).toBe('John');
  });

  it('should handle array index access', () => {
    const note = createNote({ items: ['first', 'second', 'third'] });
    const result = parseTemplate('{{items.0}}', note);
    expect(result).toBe('first');
  });

  it('should format arrays as comma-separated list', () => {
    const note = createNote({ tags: ['a', 'b', 'c'] });
    const result = parseTemplate('{{tags}}', note);
    expect(result).toBe('[a, b, c]');
  });

  it('should handle boolean values', () => {
    const note = createNote({ active: true, disabled: false });
    expect(parseTemplate('{{active}}', note)).toBe('true');
    expect(parseTemplate('{{disabled}}', note)).toBe('false');
  });

  it('should handle numeric values', () => {
    const note = createNote({ count: 42, price: 3.14 });
    expect(parseTemplate('{{count}}', note)).toBe('42');
    expect(parseTemplate('{{price}}', note)).toBe('3.14');
  });

  it('should replace objects with [Object]', () => {
    const note = createNote({ data: { complex: 'value' } });
    const result = parseTemplate('{{data}}', note);
    expect(result).toBe('[Object]');
  });

  it('should resolve {{body}} to note.body when no body field exists', () => {
    const note: RemoteNote = { id: 'rec123', primaryField: 'rec123', fields: {}, body: 'Body text' };
    const result = parseTemplate('# {{title}}\n{{body}}', note);
    expect(result).toBe('# \nBody text');
  });

  it('should let an actual body field win over note.body', () => {
    const note: RemoteNote = {
      id: 'rec123', primaryField: 'rec123',
      fields: { body: 'Field body' }, body: 'Note body'
    };
    const result = parseTemplate('{{body}}', note);
    expect(result).toBe('Field body');
  });

  it('should insert multiline body raw (not YAML-escaped) in the body region', () => {
    const note: RemoteNote = { id: 'rec123', primaryField: 'rec123', fields: {}, body: 'Line one\nLine two' };
    const result = parseTemplate('# Note\n\n{{body}}', note);
    expect(result).toBe('# Note\n\nLine one\nLine two');
  });

  it('should resolve {{body}} to empty string when note.body is undefined', () => {
    const note: RemoteNote = { id: 'rec123', primaryField: 'rec123', fields: {} };
    const result = parseTemplate('{{body}}', note);
    expect(result).toBe('');
  });

  it('should handle whitespace in placeholder keys', () => {
    const note = createNote({ title: 'Test' });
    const result = parseTemplate('{{  title  }}', note);
    expect(result).toBe('Test');
  });
});

describe('buildMarkdownContent', () => {
  const createNote = (fields: Record<string, unknown>): RemoteNote => ({
    id: 'rec123',
    primaryField: 'rec123',
    fields
  });

  it('should include frontmatter with primaryField', () => {
    const note = createNote({});
    const result = buildMarkdownContent(note);
    expect(result).toContain('---');
    expect(result).toContain('primaryField: "rec123"');
  });

  it('should add default created date if not in fields', () => {
    const note = createNote({});
    const result = buildMarkdownContent(note);
    expect(result).toMatch(/created: \d{4}-\d{2}-\d{2}/);
  });

  it('should add default status if not in fields', () => {
    const note = createNote({});
    const result = buildMarkdownContent(note);
    expect(result).toContain('status: imported');
  });

  it('should not add default created if already in fields', () => {
    const note = createNote({ created: '2024-01-01' });
    const result = buildMarkdownContent(note);
    const createdMatches = result.match(/created:/g);
    expect(createdMatches?.length).toBe(1);
  });

  it('should not add default status if already in fields', () => {
    const note = createNote({ status: 'published' });
    const result = buildMarkdownContent(note);
    const statusMatches = result.match(/status:/g);
    expect(statusMatches?.length).toBe(1);
    expect(result).toContain('status: "published"');
  });

  it('should include description section if description field exists', () => {
    const note = createNote({ description: 'Test description' });
    const result = buildMarkdownContent(note);
    expect(result).toContain('## Description');
    expect(result).toContain('Test description');
  });

  it('should include image if thumbnail field exists', () => {
    const note = createNote({ thumbnail: 'https://example.com/image.jpg' });
    const result = buildMarkdownContent(note);
    expect(result).toContain('![](https://example.com/image.jpg)');
  });

  it('should include content comment when no content fields exist', () => {
    const note = createNote({});
    const result = buildMarkdownContent(note);
    expect(result).toContain('<!-- Content imported from Airtable -->');
  });

  it('should replace default content sections with note.body when present', () => {
    const note: RemoteNote = {
      id: 'rec123', primaryField: 'rec123',
      fields: { description: 'Test description' },
      body: 'Page body content',
    };
    const result = buildMarkdownContent(note);
    expect(result).toContain('Page body content');
    expect(result).not.toContain('## Description');
  });

  it('should fall back to default content sections when note.body is empty/whitespace', () => {
    const note: RemoteNote = {
      id: 'rec123', primaryField: 'rec123',
      fields: { description: 'Test description' },
      body: '   ',
    };
    const result = buildMarkdownContent(note);
    expect(result).toContain('## Description');
    expect(result).toContain('Test description');
  });

  it('should stay byte-identical without note.body (no template)', () => {
    const note = createNote({ description: 'Test description' });
    const withoutBody = buildMarkdownContent(note);
    const withUndefinedBody: RemoteNote = { ...note, body: undefined };
    expect(buildMarkdownContent(withUndefinedBody)).toBe(withoutBody);
  });
});
