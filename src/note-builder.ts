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
	let processedTemplate = template;

	// --- Pre-process frontmatter for multi-line values in quoted placeholders ---
	const fmMatchForPreProcess = processedTemplate.match(/^---\s*[\s\S]*?---/);
	if (fmMatchForPreProcess) {
		let frontmatter = fmMatchForPreProcess[0];
		const body = processedTemplate.slice(frontmatter.length);

		// Regex to find `key: "{{placeholder}}"`
		const placeholderInQuotesRegex = /^(\s*[^\n:]+:\s*)"\{\{\s*([^}]+?)\s*\}\}"\s*$/gm;

		frontmatter = frontmatter.replace(placeholderInQuotesRegex, (match, keyPrefix, placeholderKey) => {
			const key = placeholderKey.trim();
			const value = getNestedValue(record, key);

			if (value && String(value).includes('\n')) {
				// It's a multi-line value, so transform the template line to use a block scalar
				const indentMatch = keyPrefix.match(/^\s*/);
				const baseIndent = indentMatch ? indentMatch[0] : "";
				// from: `key: "{{field}}"`
				// to:   `key: |
				//         {{field}}`
				return `${keyPrefix.trimEnd()} |\n${baseIndent}  {{${key}}}`;
			}

			// It's a single-line value, leave it as is.
			return match;
		});

		processedTemplate = frontmatter + body;
	}
	// --- End of pre-processing ---

	// Find frontmatter boundaries once.
	const fmMatch = processedTemplate.match(/^---\s*[\s\S]*?---/);
	const fmEnd = fmMatch ? fmMatch[0].length : -1;

	// Use a regular expression to find all placeholders like {{fieldName}} or {{object.nested.field}}
	// The 'originalTemplate' parameter in the callback is crucial as it's the unmodified string.
	return processedTemplate.replace(/\{\{(.*?)\}\}/g, (match, rawKey, offset, originalString) => {
		const key = String(rawKey).trim();
		const value = getNestedValue(record, key);

		// 1. Handle null or undefined values
		if (value === null || value === undefined) return "";

		// 2. Handle Array values
		if (Array.isArray(value)) {
			const items = value.map(item =>
				typeof item === "object" && item !== null ? "[Object]" : String(item)
			);
			return `[${items.join(", ")}]`;
		}

		// 3. Handle Boolean values
		if (typeof value === "boolean") return String(value);

		// 4. Handle Number values (avoid double quoting)
		if (typeof value === "number" && isFinite(value)) return String(value);

		// 5. Handle generic Object values (that are not arrays or null)
		if (typeof value === "object") return "[Object]";

		// 6. Handle all other types (String) with Bases optimization
		const stringValue = String(value);
		const inFrontmatter = fmEnd !== -1 && offset < fmEnd;

		// In frontmatter, optimize for Bases compatibility
		if (inFrontmatter) {
			// For multiline strings in frontmatter, use block scalar format
			if (stringValue.includes("\n")) {
				const lineStart = originalString.lastIndexOf("\n", offset) + 1;
				const before = originalString.slice(lineStart, offset);
				// Check Placeholder is indented
				if (/^\s*$/.test(before)) {
					const indent = before;
					return stringValue.replace(/\n/g, "\n" + indent);
				}
			}
			
			// For single-line strings in frontmatter, ensure proper quoting
			return formatYamlValue(stringValue);
		}

		// For body content, return as-is
		return stringValue;
	});
}

/**
 * Builds a default Markdown string content for a note if no template is provided.
 * Creates Bases-optimized YAML frontmatter with proper property types for table/card views.
 * @param note The RemoteNote object.
 * @returns A Markdown string representing the note content.
 */
export function buildMarkdownContent(note: RemoteNote): string {
  const fields = note.fields;
  
  // Build Bases-compatible metadata with proper property types
  const metadata = buildBasesMetadata(note);

  // Generate content sections based on available fields
  const contentSections = buildContentSections(fields);

  return `${metadata}\n\n${contentSections}`;
}

/**
 * Builds Bases-optimized YAML frontmatter with proper property types.
 * Ensures all fields are editable in Bases table view.
 */
function buildBasesMetadata(note: RemoteNote): string {
  const fields = note.fields;
  const metadata = ["---"];

  // Always include primary field for duplicate detection
  metadata.push(`primaryField: ${formatYamlValue(note.primaryField)}`);

  // Process all fields with proper Bases-compatible types
  Object.entries(fields).forEach(([key, value]) => {
    const formattedValue = formatFieldForBases(key, value);
    if (formattedValue !== null) {
      metadata.push(`${key}: ${formattedValue}`);
    }
  });

  // Add Bases-specific metadata for better table/card view experience
  if (!fields.hasOwnProperty('created')) {
    metadata.push(`created: ${new Date().toISOString().split('T')[0]}`);
  }
  if (!fields.hasOwnProperty('status')) {
    metadata.push(`status: imported`);
  }

  metadata.push("---");
  return metadata.join("\n");
}

/**
 * Formats field values for optimal Bases compatibility.
 * Handles different data types to ensure proper editing in Bases.
 */
function formatFieldForBases(key: string, value: any): string | null {
  if (value === null || value === undefined) {
    return '""'; // Empty string for null values, editable in Bases
  }

  // Handle arrays - convert to Bases-friendly list format
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    
    // For simple arrays, create a comma-separated list
    const simpleItems = value.filter(item => 
      typeof item === 'string' || typeof item === 'number'
    );
    if (simpleItems.length === value.length) {
      return `[${simpleItems.map(item => `"${String(item)}"`).join(', ')}]`;
    }
    
    // For complex arrays, stringify
    return `"${value.map(item => 
      typeof item === 'object' ? '[Object]' : String(item)
    ).join(', ')}"`;
  }

  // Handle booleans - Bases can edit these directly
  if (typeof value === 'boolean') {
    return String(value);
  }

  // Handle numbers - Bases can edit these directly
  if (typeof value === 'number' && isFinite(value)) {
    return String(value);
  }

  // Handle dates - try to format as YYYY-MM-DD for Bases date property
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value)) {
    return formatYamlValue(value.split('T')[0]); // Keep date part only
  }

  // Handle objects - convert to readable string
  if (typeof value === 'object') {
    return `"[Object: ${Object.keys(value).slice(0, 3).join(', ')}]"`;
  }

  // Handle multiline strings - use block scalar for better editing
  const stringValue = String(value);
  if (stringValue.includes('\n')) {
    return `|\n  ${stringValue.replace(/\n/g, '\n  ')}`;
  }

  // Default: quote the string value
  return formatYamlValue(stringValue);
}

/**
 * Builds content sections based on available fields.
 * Creates a more generic structure suitable for various data types.
 */
function buildContentSections(fields: Record<string, any>): string {
  const sections = [];

  // Add cover image if available (for Bases card view)
  const imageFields = ['thumbnail', 'image', 'cover', 'photo'];
  const imageField = imageFields.find(field => fields[field]);
  if (imageField && fields[imageField]) {
    sections.push(`![](${fields[imageField]})`);
  }

  // Add main content sections based on field types
  const contentFields = ['description', 'content', 'summary', 'notes'];
  const contentField = contentFields.find(field => fields[field]);
  if (contentField && fields[contentField]) {
    sections.push(`## Description\n${fields[contentField]}`);
  }

  // Add topics/summary section for YouTube or similar content
  if (fields.topics) {
    sections.push(`## Topics\n${fields.topics}`);
  }

  // Add script section for transcripts
  if (fields.script) {
    sections.push(`## Content\n${fields.script}`);
  }

  return sections.join('\n\n') || '<!-- Content imported from Airtable -->';
}