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

		// 4. Handle generic Object values (that are not arrays or null)
		if (typeof value === "object") return "[Object]";

		// 5. Handle all other types (String, Number)
		const stringValue = String(value);
		const inFrontmatter = fmEnd !== -1 && offset < fmEnd;

		if (inFrontmatter && stringValue.includes("\n")) {
			const lineStart = originalString.lastIndexOf("\n", offset) + 1;
			const before = originalString.slice(lineStart, offset);
			// Placeholder가 들여쓰기 외에 다른 문자 없이 라인 시작 부분에 있을 때만 처리
			if (/^\s*$/.test(before)) {
				const indent = before;
				return stringValue.replace(/\n/g, "\n" + indent);
			}
		}

		// Frontmatter가 아니거나, 한 줄 짜리 문자열이거나, inline placeholder인 경우 그대로 반환
		return stringValue;
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
    `  ${(fields.description ?? "").replace(/\n/g, '\n  ')}`,
    `summary: ${fields.summary ?? ""}`,
    "check-read: false",
    "---"
  ].join("\n");

  const youtubeImage = fields.thumbnail ? `![](${fields.thumbnail})` : "";

  const summarySection = fields.topics ? `# 📝 요약\n${fields.topics}` : "";
  const scriptSection = fields.script ? `# 📜 전체 스크립트\n${fields.script}` : "";

  return `${metadata}\n\n${youtubeImage}\n\n${summarySection}\n\n${scriptSection}`;
}