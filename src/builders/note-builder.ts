/**
 * Markdown note content builders.
 */

import { getNestedValue, formatYamlValue, formatFieldForBases } from '../utils';
import type { RemoteNote } from '../types';

/**
 * Replaces placeholders in a template string with values from a RemoteNote object.
 * Supports nested field access using dot notation (e.g., {{Attachment.0.url}}).
 */
export function parseTemplate(template: string, note: RemoteNote): string {
  const record = note.fields;
  let processedTemplate = template;

  // Pre-process frontmatter for multi-line values in quoted placeholders
  const fmMatchForPreProcess = processedTemplate.match(/^---\s*[\s\S]*?---/);
  if (fmMatchForPreProcess) {
    let frontmatter = fmMatchForPreProcess[0];
    const body = processedTemplate.slice(frontmatter.length);

    const placeholderInQuotesRegex = /^(\s*[^\n:]+:\s*)"\{\{\s*([^}]+?)\s*\}\}"\s*$/gm;

    frontmatter = frontmatter.replace(placeholderInQuotesRegex, (match, keyPrefix, placeholderKey) => {
      const key = placeholderKey.trim();
      const value = getNestedValue(record, key);

      if (value && String(value).includes('\n')) {
        const indentMatch = keyPrefix.match(/^\s*/);
        const baseIndent = indentMatch ? indentMatch[0] : "";
        return `${keyPrefix.trimEnd()} |\n${baseIndent}  {{${key}}}`;
      }

      return match;
    });

    processedTemplate = frontmatter + body;
  }

  // Find frontmatter boundaries
  const fmMatch = processedTemplate.match(/^---\s*[\s\S]*?---/);
  const fmEnd = fmMatch ? fmMatch[0].length : -1;

  // Replace all placeholders
  return processedTemplate.replace(/\{\{(.*?)\}\}/g, (match, rawKey, offset, originalString) => {
    const key = String(rawKey).trim();
    const value = getNestedValue(record, key);

    if (value == null) return "";

    if (Array.isArray(value)) {
      const items = value.map(item =>
        typeof item === "object" && item !== null ? "[Object]" : String(item)
      );
      return `[${items.join(", ")}]`;
    }

    if (typeof value === "boolean") return String(value);
    if (typeof value === "number" && isFinite(value)) return String(value);
    if (typeof value === "object") return "[Object]";

    const stringValue = String(value);
    const inFrontmatter = fmEnd !== -1 && offset < fmEnd;

    if (inFrontmatter) {
      if (stringValue.includes("\n")) {
        const lineStart = originalString.lastIndexOf("\n", offset) + 1;
        const before = originalString.slice(lineStart, offset);
        if (/^\s*$/.test(before)) {
          const indent = before;
          return stringValue.replace(/\n/g, "\n" + indent);
        }
      }

      return formatYamlValue(stringValue);
    }

    return stringValue;
  });
}

/**
 * Builds a default Markdown string content for a note.
 */
export function buildMarkdownContent(note: RemoteNote): string {
  const fields = note.fields;

  const metadata = buildBasesMetadata(note);
  const contentSections = buildContentSections(fields);

  return `${metadata}\n\n${contentSections}`;
}

/**
 * Builds Bases-optimized YAML frontmatter.
 */
function buildBasesMetadata(note: RemoteNote): string {
  const fields = note.fields;
  const metadata = ["---"];

  metadata.push(`primaryField: ${formatYamlValue(note.primaryField)}`);

  for (const [key, value] of Object.entries(fields)) {
    const formattedValue = formatFieldForBases(key, value);
    if (formattedValue !== null) {
      metadata.push(`${key}: ${formattedValue}`);
    }
  }

  if (!Object.prototype.hasOwnProperty.call(fields, 'created')) {
    metadata.push(`created: ${new Date().toISOString().split('T')[0]}`);
  }
  if (!Object.prototype.hasOwnProperty.call(fields, 'status')) {
    metadata.push(`status: imported`);
  }

  metadata.push("---");
  return metadata.join("\n");
}

/**
 * Builds content sections based on available fields.
 */
function buildContentSections(fields: Record<string, unknown>): string {
  const sections: string[] = [];

  const imageFields = ['thumbnail', 'image', 'cover', 'photo'];
  const imageField = imageFields.find(field => fields[field]);
  if (imageField && fields[imageField]) {
    sections.push(`![](${fields[imageField]})`);
  }

  const contentFields = ['description', 'content', 'summary', 'notes'];
  const contentField = contentFields.find(field => fields[field]);
  if (contentField && fields[contentField]) {
    sections.push(`## Description\n${fields[contentField]}`);
  }

  if (fields.topics) {
    sections.push(`## Topics\n${fields.topics}`);
  }

  if (fields.script) {
    sections.push(`## Content\n${fields.script}`);
  }

  return sections.join('\n\n') || '<!-- Content imported from Airtable -->';
}
