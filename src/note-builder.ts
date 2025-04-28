import { Vault } from "obsidian";
import { RemoteNote } from "./fetcher";

export function sanitizeFileName(name: string): string {
  return name
    .trim()
    .replace(/[/\\:*?"<>|]/g, "-")
    .replace(/\s+/g, " ")
    .slice(0, 255);
}

export function parseTemplate(template: string, note: RemoteNote): string {
  const record = note.fields;
  return template.replace(/\{\{(.*?)\}\}/g, (_, key) => {
    const value = record[key.trim()];
    return value !== undefined ? String(value) : "";
  });
}

export function buildMarkdownContent(note: RemoteNote): string {
  const fields = note.fields;

  const metadata = [
    "---",
    `primaryField: ${note.primaryField}`,
    `videoId: ${fields.videoId ?? ""}`,
    `title: ${fields.title ?? ""}`,
    `uploadDate: ${fields.uploadDate ?? ""}`,
    `channelName: ${fields.channelName ?? ""}`,
    `canonicalUrl: ${fields.canonicalUrl ?? ""}`,
    `tags: ${fields.tags ?? ""}`,
    `categories: ${fields.categories ?? ""}`,
    `분류: ${fields.분류 ?? ""}`,
    `description: "${fields.description?.replace(/"/g, '\\"') ?? ""}"`,
    `summary: ${fields.summary ?? ""}`,
    "check-read: false",
    "---"
  ].join("\n");

  const youtubeImage = fields.thumbnail ? `![](${fields.thumbnail})` : "";

  const summarySection = fields.topics ? `# 📝 요약\n${fields.topics}` : "";
  const scriptSection = fields.script ? `# 📜 전체 스크립트\n${fields.script}` : "";

  return `${metadata}\n\n${youtubeImage}\n\n${summarySection}\n\n${scriptSection}`;
}

export async function saveNoteToVault(
  vault: Vault,
  folderPath: string,
  note: RemoteNote,
  templatePath?: string,
  allowOverwrite?: boolean
) {
  let content: string;

  if (templatePath) {
    const template = await vault.adapter.read(templatePath);
    content = parseTemplate(template, note);
  } else {
    content = buildMarkdownContent(note);
  }


  const safeTitle = sanitizeFileName(note.fields.title ?? note.primaryField);
  const filePath = `${folderPath}/${safeTitle}.md`;

  // Check if the folder exists, if not create it
  if (!(await vault.adapter.exists(folderPath))) {
    await vault.createFolder(folderPath);
  }
  const exists = await vault.adapter.exists(filePath);
  // Check if the file already exists
  if (exists && !allowOverwrite) {
    return;
  }
  await vault.adapter.write(filePath, content);
}

