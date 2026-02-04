/**
 * Tests for note-builder functions.
 */

import { describe, it, expect } from 'vitest';
import {
  parseTemplate,
  buildMarkdownContent
} from '../../src/builders/note-builder';
import type { RemoteNote } from '../../src/types';

describe('parseTemplate', () => {
  const createNote = (fields: Record<string, unknown>): RemoteNote => ({
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

  it('should handle whitespace in placeholder keys', () => {
    const note = createNote({ title: 'Test' });
    const result = parseTemplate('{{  title  }}', note);
    expect(result).toBe('Test');
  });
});

describe('buildMarkdownContent', () => {
  const createNote = (fields: Record<string, unknown>): RemoteNote => ({
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
});
