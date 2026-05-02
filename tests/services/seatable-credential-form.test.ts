/**
 * Tests for SeaTableCredentialFormRenderer.
 *
 * Focuses on `build()` validation + `testConnection()` API interaction.
 *
 * @covers src/services/seatable-credential-form.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { requestUrl } from 'obsidian';
import { seatableCredentialFormRenderer } from '../../src/services/seatable-credential-form';
import type { Credential, CredentialFormState } from '../../src/types';

const mockRequestUrl = vi.mocked(requestUrl);

function createSeaTableCredential(overrides: Partial<{ apiToken: string; serverUrl: string }> = {}): Credential {
  return {
    id: 'cred-1',
    name: 'SeaTable',
    type: 'seatable',
    apiToken: 'st-token',
    serverUrl: 'https://cloud.seatable.io',
    ...overrides,
  };
}

describe('seatableCredentialFormRenderer', () => {
  describe('metadata', () => {
    it('should identify as seatable type', () => {
      expect(seatableCredentialFormRenderer.type).toBe('seatable');
    });

    it('should expose human-readable label', () => {
      expect(seatableCredentialFormRenderer.label).toBe('SeaTable');
    });

    it('should expose a description pointing users at API tokens', () => {
      expect(seatableCredentialFormRenderer.description).toMatch(/api token/i);
    });

    it('should provide testConnection', () => {
      expect(seatableCredentialFormRenderer.testConnection).toBeDefined();
    });
  });

  describe('build', () => {
    it('should return a valid SeaTableCredential when all fields are present', () => {
      const state: CredentialFormState = {
        apiToken: 'st-valid',
        serverUrl: 'https://cloud.seatable.io',
      };
      const result = seatableCredentialFormRenderer.build('My SeaTable', state, 'cred-new');

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.credential).toEqual({
        id: 'cred-new',
        name: 'My SeaTable',
        type: 'seatable',
        apiToken: 'st-valid',
        serverUrl: 'https://cloud.seatable.io',
      });
    });

    it('should default serverUrl to cloud.seatable.io when empty', () => {
      const state: CredentialFormState = { apiToken: 'st-valid', serverUrl: '' };
      const result = seatableCredentialFormRenderer.build('My SeaTable', state, 'cred-new');

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.credential.type === 'seatable' && result.credential.serverUrl)
        .toBe('https://cloud.seatable.io');
    });

    it('should trim whitespace from name, apiToken, and serverUrl', () => {
      const state: CredentialFormState = {
        apiToken: '  st-valid  ',
        serverUrl: '  https://seatable.example.com  ',
      };
      const result = seatableCredentialFormRenderer.build('  Spaced  ', state, 'cred-new');

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.credential.name).toBe('Spaced');
      expect(result.credential.type === 'seatable' && result.credential.apiToken).toBe('st-valid');
      expect(result.credential.type === 'seatable' && result.credential.serverUrl)
        .toBe('https://seatable.example.com');
    });

    it('should reject empty name', () => {
      const state: CredentialFormState = { apiToken: 'st-valid' };
      const result = seatableCredentialFormRenderer.build('', state, 'cred-new');

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toMatch(/name cannot be empty/i);
    });

    it('should reject missing apiToken', () => {
      const result = seatableCredentialFormRenderer.build('My SeaTable', {}, 'cred-new');

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toMatch(/api token cannot be empty/i);
    });

    it('should reject malformed serverUrl (no protocol)', () => {
      const state: CredentialFormState = {
        apiToken: 'st-valid',
        serverUrl: 'cloud.seatable.io',
      };
      const result = seatableCredentialFormRenderer.build('My SeaTable', state, 'cred-new');

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toMatch(/http/i);
    });

    it('should preserve the provided id (for edit mode)', () => {
      const state: CredentialFormState = { apiToken: 'st-valid' };
      const result = seatableCredentialFormRenderer.build('Existing', state, 'cred-existing-42');

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.credential.id).toBe('cred-existing-42');
    });
  });

  describe('testConnection', () => {
    beforeEach(() => {
      vi.clearAllMocks();
    });

    it('should return success when the Base-Token endpoint responds with 200', async () => {
      mockRequestUrl.mockResolvedValueOnce({
        status: 200,
        json: {
          access_token: 'bt-xxx',
          dtable_uuid: 'd1d2d3d4-aaaa-bbbb-cccc-eeeeeeeeeeee',
          dtable_server: 'https://cloud.seatable.io/dtable-server/',
        },
        headers: {},
        text: '',
        arrayBuffer: new ArrayBuffer(0),
      });

      const result = await seatableCredentialFormRenderer.testConnection!(createSeaTableCredential());

      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.detail).toMatch(/d1d2d3d4/);
    });

    it('should include the Token header and Accept header', async () => {
      mockRequestUrl.mockResolvedValueOnce({
        status: 200,
        json: {
          access_token: 'bt-xxx',
          dtable_uuid: 'uuid-1',
        },
        headers: {},
        text: '',
        arrayBuffer: new ArrayBuffer(0),
      });

      await seatableCredentialFormRenderer.testConnection!(
        createSeaTableCredential({ apiToken: 'st-test-token' }),
      );

      const call = mockRequestUrl.mock.calls[0][0];
      expect(call.headers?.Authorization).toBe('Token st-test-token');
      expect(call.headers?.Accept).toBe('application/json');
      expect(call.url).toContain('/api/v2.1/dtable/app-access-token/');
      expect(call.method).toBe('GET');
    });

    it('should hit the custom self-hosted server URL', async () => {
      mockRequestUrl.mockResolvedValueOnce({
        status: 200,
        json: { access_token: 'bt', dtable_uuid: 'u1' },
        headers: {},
        text: '',
        arrayBuffer: new ArrayBuffer(0),
      });

      await seatableCredentialFormRenderer.testConnection!(
        createSeaTableCredential({ serverUrl: 'https://seatable.example.com/' }),
      );

      const call = mockRequestUrl.mock.calls[0][0];
      expect(call.url).toBe('https://seatable.example.com/api/v2.1/dtable/app-access-token/');
    });

    it('should return failure on 403 forbidden', async () => {
      mockRequestUrl.mockResolvedValueOnce({
        status: 403,
        json: { error_msg: 'Permission denied' },
        headers: {},
        text: '',
        arrayBuffer: new ArrayBuffer(0),
      });

      const result = await seatableCredentialFormRenderer.testConnection!(
        createSeaTableCredential({ apiToken: 'bad' }),
      );

      expect(result.success).toBe(false);
      if (result.success) return;
      expect(result.error).toContain('403');
      expect(result.error).toContain('Permission denied');
    });

    it('should return failure on missing access_token in response', async () => {
      mockRequestUrl.mockResolvedValueOnce({
        status: 200,
        json: { dtable_uuid: 'partial' },
        headers: {},
        text: '',
        arrayBuffer: new ArrayBuffer(0),
      });

      const result = await seatableCredentialFormRenderer.testConnection!(createSeaTableCredential());
      expect(result.success).toBe(false);
    });

    it('should return failure on network errors', async () => {
      mockRequestUrl.mockRejectedValueOnce(new Error('Network unreachable'));

      const result = await seatableCredentialFormRenderer.testConnection!(createSeaTableCredential());

      expect(result.success).toBe(false);
      if (result.success) return;
      expect(result.error).toBe('Network unreachable');
    });

    it('should reject non-seatable credentials at the type boundary', async () => {
      const airtableCred: Credential = {
        id: 'cred-2',
        name: 'AT',
        type: 'airtable',
        apiKey: 'pat-x',
      };

      const result = await seatableCredentialFormRenderer.testConnection!(airtableCred);

      expect(result.success).toBe(false);
      if (result.success) return;
      expect(result.error).toContain('airtable');
    });
  });
});
