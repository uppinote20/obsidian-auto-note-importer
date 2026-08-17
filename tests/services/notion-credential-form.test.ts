/**
 * Tests for notionCredentialFormRenderer.
 *
 * @covers src/services/notion-credential-form.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockRequestUrl = vi.fn();
vi.mock('obsidian', async () => {
  const actual = await vi.importActual<typeof import('obsidian')>('obsidian');
  return { ...actual, requestUrl: (...args: unknown[]) => mockRequestUrl(...args) };
});

import type { Credential, CredentialFormState } from '../../src/types';
import { notionCredentialFormRenderer } from '../../src/services/notion-credential-form';

describe('notionCredentialFormRenderer.build', () => {
  const state = (overrides: Partial<CredentialFormState> = {}): CredentialFormState => ({
    integrationToken: 'ntn_abc123',
    ...overrides,
  });

  it('builds a NotionCredential when the token is present', () => {
    const r = notionCredentialFormRenderer.build('My Notion', state(), 'c1');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.credential).toMatchObject({
      id: 'c1', name: 'My Notion', type: 'notion', integrationToken: 'ntn_abc123',
    });
  });

  it('trims the name and token', () => {
    const r = notionCredentialFormRenderer.build('  My Notion  ', state({ integrationToken: '  ntn_abc123  ' }), 'c1');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    if (r.credential.type !== 'notion') throw new Error('wrong type');
    expect(r.credential.name).toBe('My Notion');
    expect(r.credential.integrationToken).toBe('ntn_abc123');
  });

  it('rejects empty name', () => {
    expect(notionCredentialFormRenderer.build('   ', state(), 'c1').ok).toBe(false);
  });

  it('rejects empty integrationToken', () => {
    expect(notionCredentialFormRenderer.build('X', state({ integrationToken: '' }), 'c1').ok).toBe(false);
  });
});

describe('notionCredentialFormRenderer.testConnection', () => {
  beforeEach(() => mockRequestUrl.mockReset());

  const cred: Credential = { id: 'c1', name: 'X', type: 'notion', integrationToken: 'ntn_abc123' };

  it('refuses non-notion credential', async () => {
    const wrong: Credential = { id: 'c1', name: 'X', type: 'airtable', apiKey: 'k' };
    const r = await notionCredentialFormRenderer.testConnection!(wrong);
    expect(r.success).toBe(false);
  });

  it('reports the number of shared data sources on success', async () => {
    mockRequestUrl.mockResolvedValueOnce({
      status: 200,
      json: {
        results: [
          { id: 'ds-1', parent: { database_id: 'db-1' }, title: [{ plain_text: 'Tasks' }] },
          { id: 'ds-2', parent: { database_id: 'db-2' }, title: [{ plain_text: 'Notes' }] },
        ],
        has_more: false,
        next_cursor: null,
      },
    });
    const r = await notionCredentialFormRenderer.testConnection!(cred);
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.detail).toContain('2');
  });

  it('reports connected-but-nothing-shared when zero data sources are visible', async () => {
    mockRequestUrl.mockResolvedValueOnce({
      status: 200,
      json: { results: [], has_more: false, next_cursor: null },
    });
    const r = await notionCredentialFormRenderer.testConnection!(cred);
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.detail).toMatch(/Connections/i);
  });

  it('returns failure on non-2xx response', async () => {
    mockRequestUrl.mockResolvedValueOnce({ status: 401, json: { message: 'Unauthorized' } });
    const r = await notionCredentialFormRenderer.testConnection!(cred);
    expect(r.success).toBe(false);
    if (r.success) return;
    expect(r.error).toContain('401');
  });

  it('returns failure on network error', async () => {
    mockRequestUrl.mockRejectedValueOnce(new Error('network unreachable'));
    const r = await notionCredentialFormRenderer.testConnection!(cred);
    expect(r.success).toBe(false);
    if (r.success) return;
    expect(r.error).toContain('network');
  });
});
