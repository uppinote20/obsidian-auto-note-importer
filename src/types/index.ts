/**
 * Central type exports for the Auto Note Importer plugin.
 */

// Settings types
export type {
  ConflictResolutionMode,
  SyncScope,
  AutoNoteImporterSettings,
} from './settings.types';
export { DEFAULT_SETTINGS } from './settings.types';

// Airtable types
export type {
  AirtableField,
  AirtableBase,
  AirtableTable,
  RemoteNote,
  SyncResult,
  ConflictInfo,
  BatchUpdate,
} from './airtable.types';

// Sync types
export type {
  SyncMode,
  SyncRequest,
  QueueStatus,
  SyncSummary,
  NoteCreationResult,
} from './sync.types';
