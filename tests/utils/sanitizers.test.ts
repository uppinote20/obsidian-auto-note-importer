/**
 * Tests for sanitizers utility functions.
 */

import { describe, it, expect } from 'vitest';
import {
  sanitizeFileName,
  sanitizeFolderPath,
  validateAndSanitizeFilename
} from '../../src/utils/sanitizers';

describe('sanitizeFileName', () => {
  it('should return empty string for empty input', () => {
    expect(sanitizeFileName('')).toBe('');
  });

  it('should return empty string for null/undefined', () => {
    expect(sanitizeFileName(null as unknown as string)).toBe('');
    expect(sanitizeFileName(undefined as unknown as string)).toBe('');
  });

  it('should replace forward slashes with dashes', () => {
    expect(sanitizeFileName('path/to/file')).toBe('path-to-file');
  });

  it('should replace backslashes with dashes', () => {
    expect(sanitizeFileName('path\\to\\file')).toBe('path-to-file');
  });

  it('should replace colons with dashes', () => {
    expect(sanitizeFileName('file:name')).toBe('file-name');
  });

  it('should replace asterisks with dashes', () => {
    expect(sanitizeFileName('file*name')).toBe('file-name');
  });

  it('should replace question marks with dashes', () => {
    expect(sanitizeFileName('file?name')).toBe('file-name');
  });

  it('should replace double quotes with dashes', () => {
    expect(sanitizeFileName('file"name')).toBe('file-name');
  });

  it('should replace angle brackets with dashes', () => {
    expect(sanitizeFileName('file<name>')).toBe('file-name-');
  });

  it('should replace pipes with dashes', () => {
    expect(sanitizeFileName('file|name')).toBe('file-name');
  });

  it('should replace single quotes with dashes', () => {
    expect(sanitizeFileName("file'name")).toBe('file-name');
  });

  it('should normalize multiple spaces to single space', () => {
    expect(sanitizeFileName('file   name')).toBe('file name');
  });

  it('should trim whitespace', () => {
    expect(sanitizeFileName('  filename  ')).toBe('filename');
  });

  it('should truncate to 255 characters', () => {
    const longName = 'a'.repeat(300);
    expect(sanitizeFileName(longName).length).toBe(255);
  });

  it('should handle multiple invalid characters', () => {
    expect(sanitizeFileName('file/name:test*file')).toBe('file-name-test-file');
  });
});

describe('sanitizeFolderPath', () => {
  it('should return empty string for empty input', () => {
    expect(sanitizeFolderPath('')).toBe('');
  });

  it('should return empty string for null/undefined', () => {
    expect(sanitizeFolderPath(null as unknown as string)).toBe('');
    expect(sanitizeFolderPath(undefined as unknown as string)).toBe('');
  });

  it('should preserve forward slashes for folder paths', () => {
    expect(sanitizeFolderPath('path/to/folder')).toBe('path/to/folder');
  });

  it('should replace backslashes with dashes', () => {
    expect(sanitizeFolderPath('path\\to\\folder')).toBe('path-to-folder');
  });

  it('should replace colons with dashes', () => {
    expect(sanitizeFolderPath('folder:name')).toBe('folder-name');
  });

  it('should trim each path segment', () => {
    expect(sanitizeFolderPath(' path / to / folder ')).toBe('path/to/folder');
  });

  it('should filter out empty segments', () => {
    expect(sanitizeFolderPath('path//to///folder')).toBe('path/to/folder');
  });

  it('should truncate each segment to 255 characters', () => {
    const longSegment = 'a'.repeat(300);
    const path = `short/${longSegment}/other`;
    const result = sanitizeFolderPath(path);
    const segments = result.split('/');
    expect(segments[1].length).toBe(255);
  });

  it('should normalize multiple spaces in segments', () => {
    expect(sanitizeFolderPath('folder   name/other')).toBe('folder name/other');
  });
});

describe('validateAndSanitizeFilename', () => {
  it('should return null for null input', () => {
    expect(validateAndSanitizeFilename(null)).toBeNull();
  });

  it('should return null for undefined input', () => {
    expect(validateAndSanitizeFilename(undefined)).toBeNull();
  });

  it('should return null for empty string', () => {
    expect(validateAndSanitizeFilename('')).toBeNull();
  });

  it('should return null for whitespace-only string', () => {
    expect(validateAndSanitizeFilename('   ')).toBeNull();
  });

  it('should return null for string exceeding 255 characters', () => {
    const longName = 'a'.repeat(256);
    expect(validateAndSanitizeFilename(longName)).toBeNull();
  });

  it('should return null for string that becomes only dashes', () => {
    expect(validateAndSanitizeFilename('***')).toBeNull();
  });

  it('should return null for Windows reserved name CON', () => {
    expect(validateAndSanitizeFilename('CON')).toBeNull();
    expect(validateAndSanitizeFilename('con')).toBeNull();
  });

  it('should return null for Windows reserved name PRN', () => {
    expect(validateAndSanitizeFilename('PRN')).toBeNull();
  });

  it('should return null for Windows reserved name AUX', () => {
    expect(validateAndSanitizeFilename('AUX')).toBeNull();
  });

  it('should return null for Windows reserved name NUL', () => {
    expect(validateAndSanitizeFilename('NUL')).toBeNull();
  });

  it('should return null for Windows reserved names with extensions', () => {
    expect(validateAndSanitizeFilename('CON.txt')).toBeNull();
    expect(validateAndSanitizeFilename('PRN.doc')).toBeNull();
  });

  it('should return null for COM1-COM9', () => {
    expect(validateAndSanitizeFilename('COM1')).toBeNull();
    expect(validateAndSanitizeFilename('COM9')).toBeNull();
  });

  it('should return null for LPT1-LPT9', () => {
    expect(validateAndSanitizeFilename('LPT1')).toBeNull();
    expect(validateAndSanitizeFilename('LPT9')).toBeNull();
  });

  it('should convert numbers to strings', () => {
    expect(validateAndSanitizeFilename(123)).toBe('123');
  });

  it('should return sanitized valid filename', () => {
    expect(validateAndSanitizeFilename('valid-filename')).toBe('valid-filename');
  });

  it('should sanitize and return valid filename', () => {
    expect(validateAndSanitizeFilename('file:name')).toBe('file-name');
  });

  it('should accept filenames containing reserved names as substrings', () => {
    expect(validateAndSanitizeFilename('CONNECT')).toBe('CONNECT');
    expect(validateAndSanitizeFilename('PRINTERS')).toBe('PRINTERS');
  });
});
