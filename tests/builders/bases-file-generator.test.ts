/**
 * Tests for bases-file-generator functions.
 * @covers src/builders/bases-file-generator.ts
 */

import { describe, it, expect } from 'vitest';
import {
  generateBasesContent,
  resolveBasesFilePath,
  collectFieldNames,
} from '../../src/builders/bases-file-generator';
import type { RemoteNote } from '../../src/types';

// ---------------------------------------------------------------------------
// generateBasesContent
// ---------------------------------------------------------------------------

describe('generateBasesContent', () => {
  it('should generate valid YAML with file.inFolder filter', () => {
    const result = generateBasesContent('Crawling', ['title', 'status']);
    expect(result).toContain('filters:');
    expect(result).toContain('  file.inFolder("Crawling")');
  });

  it('should include table view structure', () => {
    const result = generateBasesContent('Notes', ['title']);
    expect(result).toContain('views:');
    expect(result).toContain('  - type: table');
    expect(result).toContain('    name: Table');
    expect(result).toContain('    order:');
  });

  it('should always include file.name as first column', () => {
    const result = generateBasesContent('Notes', ['a', 'b']);
    const lines = result.split('\n');
    const orderStart = lines.findIndex(l => l.includes('order:'));
    expect(lines[orderStart + 1]).toBe('      - file.name');
  });

  it('should prefix field names with note.', () => {
    const result = generateBasesContent('Folder', ['title', 'status', 'count']);
    expect(result).toContain('      - note.title');
    expect(result).toContain('      - note.status');
    expect(result).toContain('      - note.count');
  });

  it('should handle empty field names array', () => {
    const result = generateBasesContent('Folder', []);
    expect(result).toContain('      - file.name');
    // Only file.name, no note.* entries
    expect(result).not.toContain('note.');
  });

  it('should quote field names with special characters', () => {
    const result = generateBasesContent('Folder', ['my:field', 'has spaces']);
    expect(result).toContain('note."my:field"');
    // Spaces alone don't need quoting
    expect(result).toContain('note.has spaces');
  });

  it('should escape double quotes in field names', () => {
    const result = generateBasesContent('Folder', ['field"name']);
    expect(result).toContain('note."field\\"name"');
  });

  it('should escape backslashes in field names', () => {
    const result = generateBasesContent('Folder', ['field\\name']);
    expect(result).toContain('note."field\\\\name"');
  });

  it('should escape folderPath containing double quotes', () => {
    const result = generateBasesContent('My "Folder"', ['title']);
    expect(result).toContain('file.inFolder("My \\"Folder\\"")');
  });

  it('should escape folderPath containing backslashes', () => {
    const result = generateBasesContent('My\\Folder', ['title']);
    expect(result).toContain('file.inFolder("My\\\\Folder")');
  });

  it('should end with a newline', () => {
    const result = generateBasesContent('Folder', ['title']);
    expect(result.endsWith('\n')).toBe(true);
  });

  it('should preserve field order', () => {
    const fields = ['z-last', 'a-first', 'm-middle'];
    const result = generateBasesContent('Folder', fields);
    const noteLines = result.split('\n').filter(l => l.includes('note.'));
    expect(noteLines[0]).toContain('z-last');
    expect(noteLines[1]).toContain('a-first');
    expect(noteLines[2]).toContain('m-middle');
  });
});

// ---------------------------------------------------------------------------
// resolveBasesFilePath
// ---------------------------------------------------------------------------

describe('resolveBasesFilePath', () => {
  const baseOptions = {
    basesFileLocation: 'vault-root' as const,
    folderPath: 'Crawling',
    basesCustomPath: '',
  };

  it('should return filename at vault root by default', () => {
    const result = resolveBasesFilePath(baseOptions, 'MyTable');
    expect(result).toBe('MyTable.base');
  });

  it('should place file inside synced folder', () => {
    const result = resolveBasesFilePath(
      { ...baseOptions, basesFileLocation: 'synced-folder' },
      'MyTable'
    );
    expect(result).toBe('Crawling/MyTable.base');
  });

  it('should place file at custom path', () => {
    const result = resolveBasesFilePath(
      { ...baseOptions, basesFileLocation: 'custom', basesCustomPath: 'Databases' },
      'MyTable'
    );
    expect(result).toBe('Databases/MyTable.base');
  });

  it('should fall back to vault root when custom path is empty', () => {
    const result = resolveBasesFilePath(
      { ...baseOptions, basesFileLocation: 'custom', basesCustomPath: '' },
      'MyTable'
    );
    expect(result).toBe('MyTable.base');
  });

  it('should normalize paths with synced-folder', () => {
    const result = resolveBasesFilePath(
      { ...baseOptions, basesFileLocation: 'synced-folder', folderPath: 'My//Folder' },
      'Table'
    );
    // normalizePath collapses double slashes
    expect(result).not.toContain('//');
  });

  it('should append .base even if table name already ends with .base (caller strips it)', () => {
    const result = resolveBasesFilePath(baseOptions, 'Already.base');
    expect(result).toBe('Already.base.base');
  });
});

// ---------------------------------------------------------------------------
// collectFieldNames
// ---------------------------------------------------------------------------

describe('collectFieldNames', () => {
  const createNote = (fields: Record<string, unknown>): RemoteNote => ({
    id: 'rec123',
    primaryField: 'rec123',
    fields,
  });

  it('should collect unique field names sorted alphabetically', () => {
    const notes = [
      createNote({ title: 'A', status: 'done' }),
      createNote({ title: 'B', category: 'tech' }),
    ];
    const result = collectFieldNames(notes);
    expect(result).toEqual(['category', 'status', 'title']);
  });

  it('should deduplicate field names', () => {
    const notes = [
      createNote({ title: 'A', count: 1 }),
      createNote({ title: 'B', count: 2 }),
      createNote({ title: 'C', count: 3 }),
    ];
    const result = collectFieldNames(notes);
    expect(result.filter(n => n === 'title')).toHaveLength(1);
    expect(result.filter(n => n === 'count')).toHaveLength(1);
  });

  it('should return empty array for empty notes', () => {
    const result = collectFieldNames([]);
    expect(result).toEqual([]);
  });

  it('should handle notes with no fields', () => {
    const notes = [createNote({})];
    const result = collectFieldNames(notes);
    expect(result).toEqual([]);
  });

  it('should handle notes with different field sets in sorted order', () => {
    const notes = [
      createNote({ c: 3 }),
      createNote({ a: 1 }),
      createNote({ b: 2 }),
    ];
    const result = collectFieldNames(notes);
    expect(result).toEqual(['a', 'b', 'c']);
  });

  it('should include all field types (null, objects, arrays)', () => {
    const notes = [
      createNote({
        nullField: null,
        objField: { nested: true },
        arrField: [1, 2, 3],
        strField: 'text',
      }),
    ];
    const result = collectFieldNames(notes);
    expect(result).toHaveLength(4);
    expect(result).toContain('nullField');
    expect(result).toContain('objField');
    expect(result).toContain('arrField');
    expect(result).toContain('strField');
  });
});
