/**
 * Tests for frontmatter-parser ensurePrimaryField pure logic.
 * Note: Only testing the ensurePrimaryField method which is pure logic.
 * Other methods require Obsidian App which is harder to mock.
 */

import { describe, it, expect, vi } from 'vitest';

// Mock obsidian before importing
vi.mock('obsidian', () => ({
  App: vi.fn(),
  TFile: vi.fn(),
  TFolder: vi.fn()
}));

import { FrontmatterParser } from '../../src/file-operations/frontmatter-parser';

describe('FrontmatterParser.ensurePrimaryField', () => {
  // Create a minimal parser with mocked app
  const createParser = () => {
    const mockApp = {
      metadataCache: { getFileCache: vi.fn() },
      vault: { getAbstractFileByPath: vi.fn() }
    };
    return new FrontmatterParser(mockApp as any);
  };

  describe('content without frontmatter (FP-1.1)', () => {
    it('should inject frontmatter with primaryField for content without frontmatter', () => {
      const parser = createParser();
      const content = 'Some content without frontmatter';
      const primaryField = 'rec123';

      const result = parser.ensurePrimaryField(content, primaryField);

      expect(result).toContain('---');
      expect(result).toContain('primaryField: "rec123"');
      expect(result).toContain('Some content without frontmatter');
    });

    it('should handle empty content', () => {
      const parser = createParser();
      const content = '';
      const primaryField = 'rec123';

      const result = parser.ensurePrimaryField(content, primaryField);

      expect(result).toContain('---');
      expect(result).toContain('primaryField: "rec123"');
    });
  });

  describe('content with frontmatter but no primaryField (FP-1.2)', () => {
    it('should add primaryField to existing frontmatter', () => {
      const parser = createParser();
      const content = `---
title: Test
status: active
---

Content here`;
      const primaryField = 'rec123';

      const result = parser.ensurePrimaryField(content, primaryField);

      expect(result).toContain('primaryField: "rec123"');
      expect(result).toContain('title: Test');
      expect(result).toContain('status: active');
      expect(result).toContain('Content here');
      // Should still have exactly one frontmatter block
      const dashes = result.match(/---/g);
      expect(dashes?.length).toBe(2);
    });
  });

  describe('content with existing primaryField (FP-1.3)', () => {
    it('should not modify content if primaryField already exists', () => {
      const parser = createParser();
      const content = `---
primaryField: "rec456"
title: Test
---

Content here`;
      const primaryField = 'rec123';

      const result = parser.ensurePrimaryField(content, primaryField);

      // Should keep original primaryField
      expect(result).toContain('primaryField: "rec456"');
      expect(result).not.toContain('primaryField: "rec123"');
    });

    it('should handle primaryField with spaces in key', () => {
      const parser = createParser();
      const content = `---
  primaryField: "rec456"
title: Test
---

Content here`;
      const primaryField = 'rec123';

      const result = parser.ensurePrimaryField(content, primaryField);

      // Should detect existing primaryField
      expect(result.match(/primaryField/g)?.length).toBe(1);
    });
  });

  describe('special characters in primaryField (FP-1.4)', () => {
    it('should properly escape primaryField with quotes', () => {
      const parser = createParser();
      const content = 'Some content';
      const primaryField = 'rec"123"test';

      const result = parser.ensurePrimaryField(content, primaryField);

      expect(result).toContain('primaryField: "rec\\"123\\"test"');
    });

    it('should properly escape primaryField with backslashes', () => {
      const parser = createParser();
      const content = 'Some content';
      const primaryField = 'rec\\123\\test';

      const result = parser.ensurePrimaryField(content, primaryField);

      expect(result).toContain('primaryField: "rec\\\\123\\\\test"');
    });

    it('should handle primaryField with special characters', () => {
      const parser = createParser();
      const content = 'Some content';
      const primaryField = 'rec:123/test';

      const result = parser.ensurePrimaryField(content, primaryField);

      expect(result).toContain('primaryField: "rec:123/test"');
    });
  });

  describe('extractSyncableFields', () => {
    it('should exclude fields not present in Airtable when cachedFields is provided', () => {
      const mockApp = {
        metadataCache: {
          getFileCache: vi.fn().mockReturnValue({
            frontmatter: {
              primaryField: 'rec123',
              Name: 'Test',
              Count: 100,
              Status: 'Todo',
              created: '2026-02-25',
              status: 'imported',
              position: { start: { line: 0 }, end: { line: 5 } }
            }
          })
        },
        vault: { getAbstractFileByPath: vi.fn() }
      };
      const parser = new FrontmatterParser(mockApp as any);
      const mockFile = { path: 'test.md' } as any;

      const cachedFields = [
        { id: 'fld1', name: 'Name', type: 'singleLineText' },
        { id: 'fld2', name: 'Count', type: 'number' },
        { id: 'fld3', name: 'Status', type: 'singleSelect' },
        { id: 'fld4', name: 'Cal', type: 'formula' }
      ];

      const result = parser.extractSyncableFields(mockFile, cachedFields);

      expect(result).toEqual({ Name: 'Test', Count: 100, Status: 'Todo' });
      expect(result).not.toHaveProperty('created');
      expect(result).not.toHaveProperty('status');
      expect(result).not.toHaveProperty('Cal');
      expect(result).not.toHaveProperty('primaryField');
    });

    it('should include all non-system fields when no cachedFields provided', () => {
      const mockApp = {
        metadataCache: {
          getFileCache: vi.fn().mockReturnValue({
            frontmatter: {
              primaryField: 'rec123',
              Name: 'Test',
              Count: 100,
              created: '2026-02-25',
              status: 'imported',
              position: { start: { line: 0 }, end: { line: 5 } }
            }
          })
        },
        vault: { getAbstractFileByPath: vi.fn() }
      };
      const parser = new FrontmatterParser(mockApp as any);
      const mockFile = { path: 'test.md' } as any;

      const result = parser.extractSyncableFields(mockFile, undefined);

      expect(result).toHaveProperty('Name');
      expect(result).toHaveProperty('Count');
      expect(result).toHaveProperty('created');
      expect(result).toHaveProperty('status');
      expect(result).not.toHaveProperty('primaryField');
    });

    it('should return null when no primaryField exists', () => {
      const mockApp = {
        metadataCache: {
          getFileCache: vi.fn().mockReturnValue({
            frontmatter: { Name: 'Test', Count: 100 }
          })
        },
        vault: { getAbstractFileByPath: vi.fn() }
      };
      const parser = new FrontmatterParser(mockApp as any);
      const mockFile = { path: 'test.md' } as any;

      const result = parser.extractSyncableFields(mockFile, []);
      expect(result).toBeNull();
    });

    it('should return null when all fields are filtered out', () => {
      const mockApp = {
        metadataCache: {
          getFileCache: vi.fn().mockReturnValue({
            frontmatter: {
              primaryField: 'rec123',
              Cal: 200,
              position: { start: { line: 0 }, end: { line: 3 } }
            }
          })
        },
        vault: { getAbstractFileByPath: vi.fn() }
      };
      const parser = new FrontmatterParser(mockApp as any);
      const mockFile = { path: 'test.md' } as any;

      const cachedFields = [
        { id: 'fld1', name: 'Cal', type: 'formula' }
      ];

      const result = parser.extractSyncableFields(mockFile, cachedFields);
      expect(result).toBeNull();
    });

    it('should skip null and undefined values', () => {
      const mockApp = {
        metadataCache: {
          getFileCache: vi.fn().mockReturnValue({
            frontmatter: {
              primaryField: 'rec123',
              Name: 'Test',
              Empty: null,
              Missing: undefined,
              position: { start: { line: 0 }, end: { line: 4 } }
            }
          })
        },
        vault: { getAbstractFileByPath: vi.fn() }
      };
      const parser = new FrontmatterParser(mockApp as any);
      const mockFile = { path: 'test.md' } as any;

      const cachedFields = [
        { id: 'fld1', name: 'Name', type: 'singleLineText' },
        { id: 'fld2', name: 'Empty', type: 'singleLineText' },
        { id: 'fld3', name: 'Missing', type: 'singleLineText' }
      ];

      const result = parser.extractSyncableFields(mockFile, cachedFields);
      expect(result).toEqual({ Name: 'Test' });
    });
  });

  describe('edge cases', () => {
    it('should handle frontmatter with only dashes', () => {
      const parser = createParser();
      const content = `---
---

Content`;
      const primaryField = 'rec123';

      const result = parser.ensurePrimaryField(content, primaryField);

      expect(result).toContain('primaryField: "rec123"');
    });

    it('should handle frontmatter ending without newline', () => {
      const parser = createParser();
      const content = `---
title: Test
---`;
      const primaryField = 'rec123';

      const result = parser.ensurePrimaryField(content, primaryField);

      expect(result).toContain('primaryField: "rec123"');
    });

    it('should handle content with multiple --- in body', () => {
      const parser = createParser();
      const content = `---
title: Test
---

Some content
---
More dashes
---`;
      const primaryField = 'rec123';

      const result = parser.ensurePrimaryField(content, primaryField);

      expect(result).toContain('primaryField: "rec123"');
      // Body content should be preserved
      expect(result).toContain('Some content');
      expect(result).toContain('More dashes');
    });
  });
});
