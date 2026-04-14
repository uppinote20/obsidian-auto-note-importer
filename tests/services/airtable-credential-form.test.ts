/**
 * Tests for AirtableCredentialFormRenderer.
 *
 * Focuses on `build()` validation + `testConnection()` API interaction.
 * Field rendering is covered by settings E2E.
 *
 * @covers src/services/airtable-credential-form.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { requestUrl } from 'obsidian';
import { airtableCredentialFormRenderer } from '../../src/services/airtable-credential-form';
import type { Credential, CredentialFormState } from '../../src/types';

const mockRequestUrl = vi.mocked(requestUrl);

function createAirtableCredential(apiKey = 'pat-test'): Credential {
  return { id: 'cred-1', name: 'Airtable', type: 'airtable', apiKey };
}

describe('airtableCredentialFormRenderer', () => {
  describe('metadata', () => {
    it('should identify as airtable type', () => {
      expect(airtableCredentialFormRenderer.type).toBe('airtable');
    });

    it('should expose human-readable label', () => {
      expect(airtableCredentialFormRenderer.label).toBe('Airtable');
    });

    it('should expose a description pointing users at the PAT creation URL', () => {
      expect(airtableCredentialFormRenderer.description).toContain('airtable.com');
    });

    it('should provide testConnection', () => {
      expect(airtableCredentialFormRenderer.testConnection).toBeDefined();
    });
  });

  describe('build', () => {
    it('should return a valid AirtableCredential when name and apiKey are present', () => {
      const state: CredentialFormState = { apiKey: 'pat-valid' };
      const result = airtableCredentialFormRenderer.build('My Airtable', state, 'cred-new');

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.credential).toEqual({
        id: 'cred-new',
        name: 'My Airtable',
        type: 'airtable',
        apiKey: 'pat-valid',
      });
    });

    it('should trim whitespace from name and apiKey', () => {
      const state: CredentialFormState = { apiKey: '  pat-valid  ' };
      const result = airtableCredentialFormRenderer.build('  Spaced  ', state, 'cred-new');

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.credential.name).toBe('Spaced');
      expect(result.credential.type === 'airtable' && result.credential.apiKey).toBe('pat-valid');
    });

    it('should reject empty name', () => {
      const state: CredentialFormState = { apiKey: 'pat-valid' };
      const result = airtableCredentialFormRenderer.build('', state, 'cred-new');

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toMatch(/name cannot be empty/i);
    });

    it('should reject whitespace-only name', () => {
      const state: CredentialFormState = { apiKey: 'pat-valid' };
      const result = airtableCredentialFormRenderer.build('   ', state, 'cred-new');

      expect(result.ok).toBe(false);
    });

    it('should reject missing apiKey', () => {
      const result = airtableCredentialFormRenderer.build('My Airtable', {}, 'cred-new');

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toMatch(/api key cannot be empty/i);
    });

    it('should reject empty apiKey', () => {
      const state: CredentialFormState = { apiKey: '' };
      const result = airtableCredentialFormRenderer.build('My Airtable', state, 'cred-new');

      expect(result.ok).toBe(false);
    });

    it('should preserve the provided id (for edit mode)', () => {
      const state: CredentialFormState = { apiKey: 'pat-valid' };
      const result = airtableCredentialFormRenderer.build('Existing', state, 'cred-existing-42');

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.credential.id).toBe('cred-existing-42');
    });
  });

  describe('testConnection', () => {
    beforeEach(() => {
      vi.clearAllMocks();
    });

    it('should return success when the meta API responds with 200', async () => {
      mockRequestUrl.mockResolvedValueOnce({
        status: 200,
        json: { bases: [{ id: 'app1' }, { id: 'app2' }, { id: 'app3' }] },
        headers: {},
        text: '',
        arrayBuffer: new ArrayBuffer(0),
      });

      const result = await airtableCredentialFormRenderer.testConnection!(createAirtableCredential());

      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.detail).toMatch(/3 base/);
    });

    it('should include the bearer token and Accept header', async () => {
      mockRequestUrl.mockResolvedValueOnce({
        status: 200,
        json: { bases: [] },
        headers: {},
        text: '',
        arrayBuffer: new ArrayBuffer(0),
      });

      await airtableCredentialFormRenderer.testConnection!(createAirtableCredential('pat-test-key'));

      const call = mockRequestUrl.mock.calls[0][0];
      expect(call.headers?.Authorization).toBe('Bearer pat-test-key');
      expect(call.headers?.Accept).toBe('application/json');
      expect(call.headers?.['Content-Type']).toBeUndefined();
      expect(call.url).toContain('/meta/bases');
      expect(call.method).toBe('GET');
    });

    it('should report success with no-bases detail when auth is OK but empty', async () => {
      mockRequestUrl.mockResolvedValueOnce({
        status: 200,
        json: { bases: [] },
        headers: {},
        text: '',
        arrayBuffer: new ArrayBuffer(0),
      });

      const result = await airtableCredentialFormRenderer.testConnection!(createAirtableCredential());

      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.detail).toMatch(/no bases/i);
    });

    it('should return failure on 401 unauthorized', async () => {
      mockRequestUrl.mockResolvedValueOnce({
        status: 401,
        json: { error: { message: 'Invalid authentication token' } },
        headers: {},
        text: '',
        arrayBuffer: new ArrayBuffer(0),
      });

      const result = await airtableCredentialFormRenderer.testConnection!(createAirtableCredential('pat-bad'));

      expect(result.success).toBe(false);
      if (result.success) return;
      expect(result.error).toContain('401');
      expect(result.error).toContain('Invalid authentication token');
    });

    it('should return failure on network errors', async () => {
      mockRequestUrl.mockRejectedValueOnce(new Error('Network unreachable'));

      const result = await airtableCredentialFormRenderer.testConnection!(createAirtableCredential());

      expect(result.success).toBe(false);
      if (result.success) return;
      expect(result.error).toBe('Network unreachable');
    });

    it('should reject non-airtable credentials at the type boundary', async () => {
      const seatableCred: Credential = {
        id: 'cred-2',
        name: 'SeaTable',
        type: 'seatable',
        apiToken: 'st-token',
        serverUrl: 'https://cloud.seatable.io',
      };

      const result = await airtableCredentialFormRenderer.testConnection!(seatableCred);

      expect(result.success).toBe(false);
      if (result.success) return;
      expect(result.error).toContain('seatable');
    });

    it('should handle error response with string error field', async () => {
      mockRequestUrl.mockResolvedValueOnce({
        status: 500,
        json: { error: 'Internal server error' },
        headers: {},
        text: '',
        arrayBuffer: new ArrayBuffer(0),
      });

      const result = await airtableCredentialFormRenderer.testConnection!(createAirtableCredential());

      expect(result.success).toBe(false);
      if (result.success) return;
      expect(result.error).toContain('Internal server error');
    });
  });
});
