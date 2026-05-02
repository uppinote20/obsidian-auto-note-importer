/**
 * SeaTable field type mapper.
 *
 * Maps SeaTable's native column type strings (kebab-case, e.g. `single-select`,
 * `link-formula`) to the provider-agnostic StandardFieldType taxonomy and
 * answers writability / filename-safety questions the sync pipeline needs.
 *
 * @handbook 4.4-provider-abstraction
 * @handbook 7.3-read-only-field-protection
 * @tested tests/services/seatable-field-mapper.test.ts
 */

import type { FieldTypeMapper, StandardFieldType } from '../types';

const FILENAME_SAFE_TYPES = [
  'text',
  'single-select',
  'number',
  'auto-number',
  'formula',
] as const;

const READ_ONLY_TYPES = [
  'formula',
  'link-formula',
  'ctime',
  'mtime',
  'creator',
  'last-modifier',
  'auto-number',
  'button',
] as const;

const TYPE_TO_STANDARD: Record<string, StandardFieldType> = {
  // text
  'text': 'text',
  'long-text': 'text',
  'email': 'text',
  'url': 'text',
  'geolocation': 'text',
  // number
  'number': 'number',
  'duration': 'number',
  'rate': 'number',
  // date
  'date': 'date',
  // boolean
  'checkbox': 'boolean',
  // select
  'single-select': 'single-select',
  'multiple-select': 'multi-select',
  'department-single-select': 'single-select',
  'collaborator': 'multi-select',
  // attachment
  'image': 'attachment',
  'file': 'attachment',
  'digital-sign': 'attachment',
  // link
  'link': 'link',
  // computed (server-side, read-only)
  'formula': 'computed',
  'link-formula': 'computed',
  'button': 'computed',
  // system (server-assigned, read-only)
  'ctime': 'system',
  'mtime': 'system',
  'creator': 'system',
  'last-modifier': 'system',
  'auto-number': 'system',
};

class SeaTableFieldMapperImpl implements FieldTypeMapper {
  mapToStandardType(providerType: string): StandardFieldType {
    return TYPE_TO_STANDARD[providerType] ?? 'unknown';
  }

  isReadOnly(providerType: string): boolean {
    if (!(providerType in TYPE_TO_STANDARD)) return true;
    return (READ_ONLY_TYPES as readonly string[]).includes(providerType);
  }

  isFilenameSafe(providerType: string): boolean {
    return (FILENAME_SAFE_TYPES as readonly string[]).includes(providerType);
  }

  getFilenameSafeTypes(): readonly string[] {
    return FILENAME_SAFE_TYPES;
  }

  getReadOnlyTypes(): readonly string[] {
    return READ_ONLY_TYPES;
  }
}

export const seatableFieldMapper: FieldTypeMapper = new SeaTableFieldMapperImpl();
