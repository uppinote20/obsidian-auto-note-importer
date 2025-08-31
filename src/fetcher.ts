import { requestUrl } from "obsidian";
import { AutoNoteImporterSettings } from "./settings";

export interface RemoteNote {
  id: string;
  primaryField: string;
  fields: Record<string, any>;
}

/**
 * Fetches notes from a specified Airtable base and table using the provided API key.
 * Handles pagination automatically to retrieve all records.
 * @param settings The plugin settings containing Airtable credentials (apiKey, baseId, tableId) and the primary field name.
 * @returns A Promise that resolves to an array of RemoteNote objects fetched from Airtable.
 * @throws An error if API Key, Base ID, or Table ID are missing in settings.
 * @throws An error if the fetch request fails (e.g., network error, invalid credentials, Airtable API error).
 */
export async function fetchNotes(settings: AutoNoteImporterSettings): Promise<RemoteNote[]> {
  const { apiKey, baseId, tableId } = settings;

  if (!apiKey || !baseId || !tableId) {
    throw new Error("Airtable API key, base ID, and table ID must be set.");
  }

  let allNotes: RemoteNote[] = [];
  let offset: string | undefined;
  const baseUrl = `https://api.airtable.com/v0/${baseId}/${tableId}`

  // Loop to handle Airtable's pagination (max 100 records per request)
  do {
    const url = offset ? `${baseUrl}?offset=${offset}` : baseUrl;
    const response = await requestUrl({
      url: url,
      method: "GET",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
    });
    
    if (response.status !== 200) {
      let errorDetails = `HTTP ${response.status}`;
      try {
        const errorJson = response.json;
        errorDetails += `: ${errorJson?.error?.message || JSON.stringify(errorJson)}`;
      } catch (e) {
        // Ignore if response body isn't valid JSON
      }
      throw new Error(`Failed to fetch remote notes: ${errorDetails}`);
    }

    const json = response.json;

    const notesFromPage: RemoteNote[] = json.records.map((record: any) => {
      return {
        id: record.id,
        // Use Airtable record ID as primaryField for guaranteed uniqueness
        primaryField: record.id,
        fields: record.fields
      };
    });
    allNotes = allNotes.concat(notesFromPage);

    offset = json.offset;
  // Continue fetching if Airtable provides an offset for the next page
  } while (offset);

  return allNotes;
}