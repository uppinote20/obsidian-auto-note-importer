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
 * @tested e2e:tests/e2e/run-seatable-e2e.mjs
 */

import type { FieldTypeMapper, StandardFieldType } from '../types';

// Filename-safe types only need to produce a stable, human-readable
// string — writability isn't required. That's why `auto-number` and
// `formula` appear here AND in READ_ONLY_TYPES below: they're great
// stable identifiers but the sync pipeline must not push to them.
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

// Types whose SeaTable API value is an object, NOT a scalar string.
// collaborator → array of { name, email, … }; geolocation → { lng, lat,
// country_region }; button → link-formula-like object. Their standard-type
// classification doesn't capture this — explicit exclusion.
const OBJECT_SHAPED_TYPES: ReadonlySet<string> = new Set([
  'collaborator',
  'geolocation',
  'button',
]);

// Excludes attachment (image / file / digital-sign) and link types — they
// stringify to JSON / record-id garbage when used as folder names — and
// explicit object-shaped types (see OBJECT_SHAPED_TYPES). Sorted for
// deterministic enumeration across providers.
const SUBFOLDER_SAFE_TYPES = Object.entries(TYPE_TO_STANDARD)
  .filter(([t, std]) =>
    std !== 'attachment' &&
    std !== 'link' &&
    std !== 'unknown' &&
    !OBJECT_SHAPED_TYPES.has(t)
  )
  .map(([t]) => t)
  .sort() as readonly string[];

class SeaTableFieldMapperImpl implements FieldTypeMapper {
  mapToStandardType(providerType: string): StandardFieldType {
    return TYPE_TO_STANDARD[providerType] ?? 'unknown';
  }

  isReadOnly(providerType: string): boolean {
    // Use Object.prototype.hasOwnProperty.call to avoid `in`-operator
    // prototype-chain leak (toString/constructor/etc.). See issue #98 fix.
    if (!Object.prototype.hasOwnProperty.call(TYPE_TO_STANDARD, providerType)) return true;
    return (READ_ONLY_TYPES as readonly string[]).includes(providerType);
  }

  isPushable(providerType: string): boolean {
    if (!Object.prototype.hasOwnProperty.call(TYPE_TO_STANDARD, providerType)) return false;
    if (TYPE_TO_STANDARD[providerType] === 'unknown') return false;
    return !this.isReadOnly(providerType) && !OBJECT_SHAPED_TYPES.has(providerType);
  }

  isFilenameSafe(providerType: string): boolean {
    return (FILENAME_SAFE_TYPES as readonly string[]).includes(providerType);
  }

  /**
   * Permissive but excludes attachment / link types. Uses Array.includes to
   * avoid `in TYPE_TO_STANDARD` prototype-chain leak. Issue #98.
   */
  isSubfolderSafe(providerType: string): boolean {
    return (SUBFOLDER_SAFE_TYPES as readonly string[]).includes(providerType);
  }

  getFilenameSafeTypes(): readonly string[] {
    return FILENAME_SAFE_TYPES;
  }

  getSubfolderSafeTypes(): readonly string[] {
    return SUBFOLDER_SAFE_TYPES;
  }

  getReadOnlyTypes(): readonly string[] {
    return READ_ONLY_TYPES;
  }
}

export const seatableFieldMapper: FieldTypeMapper = new SeaTableFieldMapperImpl();
