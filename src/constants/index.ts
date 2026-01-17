/**
 * Central constants exports.
 */

// Field type constants
export {
  SUPPORTED_FIELD_TYPES,
  SYNCABLE_FIELD_TYPES,
  READ_ONLY_FIELD_TYPES,
  isFieldTypeSupported,
  isReadOnlyFieldType,
} from './field-types';
export type {
  SupportedFieldType,
  SyncableFieldType,
  ReadOnlyFieldType,
} from './field-types';

// System field constants
export {
  SYSTEM_FIELDS,
  isSystemField,
} from './system-fields';
export type { SystemField } from './system-fields';

// API constants
export {
  AIRTABLE_BATCH_SIZE,
  RATE_LIMIT_INTERVAL_MS,
  FILE_CHANGE_DEBOUNCE_MS,
  DEFAULT_FORMULA_SYNC_DELAY_MS,
  DEBUG_DELAY_MULTIPLIER,
  MAX_FOLDER_DEPTH,
  AIRTABLE_API_BASE_URL,
  AIRTABLE_META_API_URL,
} from './api';
