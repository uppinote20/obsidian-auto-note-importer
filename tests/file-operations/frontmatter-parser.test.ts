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
