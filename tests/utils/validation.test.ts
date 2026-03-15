/**
 * Tests for folder overlap validation utility.
 */

import { describe, it, expect } from 'vitest';
import { validateFolderPath } from '../../src/utils/validation';
import type { ConfigEntry } from '../../src/types/config.types';

function makeConfig(overrides: Partial<ConfigEntry> & { id: string; name: string; folderPath: string }): ConfigEntry {
  return {
    enabled: true,
    credentialId: 'cred-1',
    baseId: '',
    tableId: '',
    viewId: '',
    templatePath: '',
    filenameFieldName: '',
    subfolderFieldName: '',
    syncInterval: 0,
    allowOverwrite: true,
    bidirectionalSync: false,
    conflictResolution: 'manual',
    watchForChanges: false,
    fileWatchDebounce: 2000,
    autoSyncFormulas: false,
    formulaSyncDelay: 3000,
    generateBasesFile: false,
    basesFileLocation: 'vault-root',
    basesCustomPath: '',
    basesRegenerateOnSync: false,
    ...overrides,
  };
}

describe('validateFolderPath', () => {
  it('should return null for non-overlapping folders', () => {
    const configs = [
      makeConfig({ id: 'cfg-1', name: 'Config A', folderPath: 'Notes' }),
      makeConfig({ id: 'cfg-2', name: 'Config B', folderPath: 'Docs' }),
    ];
    expect(validateFolderPath('cfg-new', 'Tasks', configs)).toBeNull();
  });

  it('should return null for sibling folders (a/b and a/c)', () => {
    const configs = [
      makeConfig({ id: 'cfg-1', name: 'Config A', folderPath: 'Root/Alpha' }),
    ];
    expect(validateFolderPath('cfg-new', 'Root/Beta', configs)).toBeNull();
  });

  it('should return an error for identical folders', () => {
    const configs = [
      makeConfig({ id: 'cfg-1', name: 'Existing Config', folderPath: 'Notes' }),
    ];
    const result = validateFolderPath('cfg-new', 'Notes', configs);
    expect(result).not.toBeNull();
    expect(result).toContain('Existing Config');
  });

  it('should return an error for parent-child overlap (new is child of existing)', () => {
    const configs = [
      makeConfig({ id: 'cfg-1', name: 'Parent Config', folderPath: 'Notes' }),
    ];
    const result = validateFolderPath('cfg-new', 'Notes/Sub', configs);
    expect(result).not.toBeNull();
    expect(result).toContain('Parent Config');
  });

  it('should return an error for child-parent overlap (new is parent of existing)', () => {
    const configs = [
      makeConfig({ id: 'cfg-1', name: 'Child Config', folderPath: 'Notes/Sub' }),
    ];
    const result = validateFolderPath('cfg-new', 'Notes', configs);
    expect(result).not.toBeNull();
    expect(result).toContain('Child Config');
  });

  it('should skip the config with the same configId (self-skip)', () => {
    const configs = [
      makeConfig({ id: 'cfg-self', name: 'Self Config', folderPath: 'Notes' }),
    ];
    expect(validateFolderPath('cfg-self', 'Notes', configs)).toBeNull();
  });

  it('should check disabled configs too', () => {
    const configs = [
      makeConfig({ id: 'cfg-1', name: 'Disabled Config', folderPath: 'Notes', enabled: false }),
    ];
    const result = validateFolderPath('cfg-new', 'Notes', configs);
    expect(result).not.toBeNull();
    expect(result).toContain('Disabled Config');
  });

  it('should skip configs with empty folderPath', () => {
    const configs = [
      makeConfig({ id: 'cfg-1', name: 'No Folder Config', folderPath: '' }),
    ];
    expect(validateFolderPath('cfg-new', 'Notes', configs)).toBeNull();
  });

  it('should return null with no configs', () => {
    expect(validateFolderPath('cfg-new', 'Notes', [])).toBeNull();
  });

  it('should detect conflict for deeply nested parent-child', () => {
    const configs = [
      makeConfig({ id: 'cfg-1', name: 'Deep Config', folderPath: 'A/B/C' }),
    ];
    const result = validateFolderPath('cfg-new', 'A/B/C/D/E', configs);
    expect(result).not.toBeNull();
    expect(result).toContain('Deep Config');
  });

  it('should not match partial folder name prefix (a/bc vs a/b)', () => {
    const configs = [
      makeConfig({ id: 'cfg-1', name: 'Config B', folderPath: 'Notes/Sub' }),
    ];
    // "Notes/Subtext" should NOT conflict with "Notes/Sub"
    expect(validateFolderPath('cfg-new', 'Notes/Subtext', configs)).toBeNull();
  });
});
