import { RemoteNote } from "./fetcher";
// import { getNestedValue } from "./utils";
import { getNestedValue, formatYamlValue } from "./utils";


/**
 * Replaces placeholders in a template string with values from a RemoteNote object.
 * Supports nested field access using dot notation (e.g., {{Attachment.0.url}}).
 * @param template The template string containing {{fieldName}} placeholders.
 * @param note The RemoteNote object containing the data.
 * @returns The template string with placeholders replaced by corresponding values.
 */
export function parseTemplate(template: string, note: RemoteNote): string {
  const record = note.fields;

  // Use a regular expression to find all placeholders like {{fieldName}} or {{object.nested.field}}
  return template.replace(/\{\{(.*?)\}\}/g, (_, key) => {
    // Retrieve the value using the helper function for nested access
    const value = getNestedValue(record, key.trim());
  
    // --- Value Handling ---

    // 1. Handle null or undefined values
    if (value === null || value === undefined) {
      // Replace with an empty string
      return "";
    }
  
    // 2. Handle Array values
    if (Array.isArray(value)) {
      // Format as a string representation of a list: "[item1, item2]"
      const stringifiedItems = value.map(item => {
        // Represent nested objects simply within the string list
        if (typeof item === "object" && item !== null) {
          return "[Object]";
        }
        // Basic string conversion for other types
        return String(item);
      });
      return `[${stringifiedItems.join(", ")}]`;
    }

    // 3. Handle Boolean values
    if (typeof value === "boolean") {
      return value ? "true" : "false";
    }

    // 4. Handle generic Object values (that are not arrays or null)
    if (typeof value === "object") {
      return "[Object]";
    }
    
    // 5. Handle all other types (String, Number)
    // Ensure multi-line strings maintain indentation suitable for YAML blocks
    const stringValue = String(value);
    if (stringValue.includes('\n')) {
      // Replace internal newlines with newline + standard indentation (e.g., 2 spaces)
      return stringValue.replace(/\n/g, '\n  '); // Assuming 2 spaces indent
    } else {
      return stringValue;
    }
  });
}

/**
 * Builds a default Markdown string content for a note if no template is provided.
 * Includes YAML frontmatter with specific fields and basic content structure.
 * @param note The RemoteNote object.
 * @returns A Markdown string representing the note content.
 */
export function buildMarkdownContent(note: RemoteNote): string {
  const fields = note.fields;

  const metadata = [
    "---",
    `primaryField: ${note.primaryField}`,
    `videoId: ${fields.videoId ?? ""}`,
    `title: ${formatYamlValue(fields.title)}`,
    `uploadDate: ${fields.uploadDate ?? ""}`,
    `channelName: ${fields.channelName ?? ""}`,
    `canonicalUrl: ${fields.canonicalUrl ?? ""}`,
    `tags: ${Array.isArray(fields.tags) ? fields.tags.join(', ') : (fields.tags ?? "")}`,
    `categories: ${Array.isArray(fields.categories) ? fields.categories.join(', ') : (fields.categories ?? "")}`,
    `분류: ${fields.분류 ?? ""}`,
    `description: |`,
    `  ${(fields.description ?? "").replace(/\n/g, '\n ')}`,
    `summary: ${fields.summary ?? ""}`,
    "check-read: false",
    "---"
  ].join("\n");

  const youtubeImage = fields.thumbnail ? `![](${fields.thumbnail})` : "";

  const summarySection = fields.topics ? `# 📝 요약\n${fields.topics}` : "";
  const scriptSection = fields.script ? `# 📜 전체 스크립트\n${fields.script}` : "";

  return `${metadata}\n\n${youtubeImage}\n\n${summarySection}\n\n${scriptSection}`;
}