import { requestUrl } from "obsidian";
import { AutoNoteImporterSettings } from "./settings";

export interface RemoteNote {
  id: string;
  primaryField: string;
  fields: Record<string, any>;
}

export async function fetchNotes(settings: AutoNoteImporterSettings): Promise<RemoteNote[]> {
  const { apiKey, baseId, tableId } = settings;

  if (!apiKey || !baseId || !tableId) {
    throw new Error("Airtable API Key, Base ID, and Table ID must be set.");
  }

  const response = await requestUrl({
    url: `https://api.airtable.com/v0/${baseId}/${tableId}`,
    method: "GET",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
  });

  if (response.status !== 200) {
    throw new Error(`Failed to fetch remote notes: HTTP ${response.status}`);
  }

  const json = response.json;

  const notes: RemoteNote[] = json.records.map((record: any) => {
    const primaryField = Object.keys(record.fields)[0];
    return {
    id: record.id,
    primaryField: record.fields[primaryField],
    fields:record.fields
    };
  });

  return notes;
}