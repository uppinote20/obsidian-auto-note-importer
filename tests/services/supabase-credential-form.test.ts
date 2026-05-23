/**
 * Tests for detectKeyType helper.
 *
 * @covers src/services/supabase-credential-form.ts
 */

import { describe, it, expect } from 'vitest';
import { detectKeyType } from '../../src/services/supabase-credential-form';

function jwt(role: string): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ role, iss: 'supabase' })).toString('base64url');
  return `${header}.${payload}.signature-placeholder`;
}

describe('detectKeyType', () => {
  it('classifies sb_publishable_ prefix as publishable-new', () => {
    const r = detectKeyType('sb_publishable_abc123');
    expect(r.kind).toBe('publishable-new');
    expect(r.tone).toBe('ok');
  });

  it('classifies sb_secret_ prefix as secret-new with warn tone', () => {
    const r = detectKeyType('sb_secret_abc123');
    expect(r.kind).toBe('secret-new');
    expect(r.tone).toBe('warn');
  });

  it('classifies JWT with role anon as anon-legacy', () => {
    const r = detectKeyType(jwt('anon'));
    expect(r.kind).toBe('anon-legacy');
    expect(r.tone).toBe('ok');
  });

  it('classifies JWT with role service_role as service-legacy with warn tone', () => {
    const r = detectKeyType(jwt('service_role'));
    expect(r.kind).toBe('service-legacy');
    expect(r.tone).toBe('warn');
  });

  it('classifies JWT with unknown role as unknown-jwt', () => {
    const r = detectKeyType(jwt('authenticated'));
    expect(r.kind).toBe('unknown-jwt');
    expect(r.tone).toBe('neutral');
  });

  it('classifies non-prefix non-JWT input as unknown', () => {
    expect(detectKeyType('abc').kind).toBe('unknown');
    expect(detectKeyType('').kind).toBe('unknown');
  });

  it('returns unknown-jwt for malformed JWT (does not throw)', () => {
    expect(detectKeyType('eyJnot-valid-base64.x.y').kind).toBe('unknown-jwt');
  });

  it('every kind has a non-empty label', () => {
    for (const input of ['sb_publishable_x', 'sb_secret_x', jwt('anon'), jwt('service_role'), jwt('authenticated'), 'x']) {
      expect(detectKeyType(input).label.length).toBeGreaterThan(0);
    }
  });
});

import type { Credential, CredentialFormState } from '../../src/types';
import { supabaseCredentialFormRenderer } from '../../src/services/supabase-credential-form';

describe('supabaseCredentialFormRenderer.build', () => {
  const state = (overrides: Partial<CredentialFormState> = {}): CredentialFormState => ({
    projectUrl: 'https://abc.supabase.co',
    apiKey: 'sb_publishable_xxx',
    ...overrides,
  });

  it('builds a SupabaseCredential when all fields are valid', () => {
    const r = supabaseCredentialFormRenderer.build('My Project', state(), 'c1');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.credential).toMatchObject({
      id: 'c1', name: 'My Project', type: 'supabase',
      projectUrl: 'https://abc.supabase.co',
      apiKey: 'sb_publishable_xxx',
    });
  });

  it('rejects empty name', () => {
    expect(supabaseCredentialFormRenderer.build('   ', state(), 'c1').ok).toBe(false);
  });

  it('rejects empty projectUrl', () => {
    expect(supabaseCredentialFormRenderer.build('X', state({ projectUrl: '' }), 'c1').ok).toBe(false);
  });

  it('rejects projectUrl without scheme', () => {
    expect(supabaseCredentialFormRenderer.build('X', state({ projectUrl: 'abc.supabase.co' }), 'c1').ok).toBe(false);
  });

  it('strips trailing slash from projectUrl', () => {
    const r = supabaseCredentialFormRenderer.build('X', state({ projectUrl: 'https://abc.supabase.co/' }), 'c1');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    if (r.credential.type !== 'supabase') throw new Error('wrong type');
    expect(r.credential.projectUrl).toBe('https://abc.supabase.co');
  });

  it('rejects empty apiKey', () => {
    expect(supabaseCredentialFormRenderer.build('X', state({ apiKey: '' }), 'c1').ok).toBe(false);
  });
});

import { vi, beforeEach } from 'vitest';

const mockRequestUrl = vi.fn();
vi.mock('obsidian', async () => {
  const actual = await vi.importActual<typeof import('obsidian')>('obsidian');
  return { ...actual, requestUrl: (...args: unknown[]) => mockRequestUrl(...args) };
});

describe('supabaseCredentialFormRenderer.testConnection', () => {
  beforeEach(() => mockRequestUrl.mockReset());

  const cred: Credential = {
    id: 'c1', name: 'X', type: 'supabase',
    projectUrl: 'https://abc.supabase.co', apiKey: 'sb_publishable_xxx',
  };

  it('returns success with endpoint count when spec is reachable', async () => {
    mockRequestUrl.mockResolvedValueOnce({
      status: 200,
      json: { definitions: { notes: {}, active_notes: {}, tags: {} } },
    });
    const r = await supabaseCredentialFormRenderer.testConnection!(cred);
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.detail).toContain('3');
  });

  it('treats OpenAPI 401 + RPC 200 as success (publishable-key path)', async () => {
    mockRequestUrl
      .mockResolvedValueOnce({ status: 401, json: { code: 'PGRST301', message: 'JWT expired' } })
      .mockResolvedValueOnce({ status: 200, json: { notes: {}, active_notes: {} } });
    const r = await supabaseCredentialFormRenderer.testConnection!(cred);
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.detail).toContain('RPC');
  });

  it('returns needsSetup on OpenAPI 401 + RPC PGRST202 (publishable + missing RPC)', async () => {
    mockRequestUrl
      .mockResolvedValueOnce({ status: 401, json: {} })
      .mockResolvedValueOnce({ status: 404, json: { code: 'PGRST202', message: 'function ani_supabase_schema does not exist' } });
    const r = await supabaseCredentialFormRenderer.testConnection!(cred);
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.needsSetup).toEqual({ kind: 'supabase-rpc' });
    // Detail no longer references "(settings card)" — the UI renders the
    // inline banner in-place, so the location hint is redundant.
    expect(r.detail).not.toMatch(/settings card/i);
  });

  it('omits needsSetup when OpenAPI returns 200 (legacy anon JWT / secret key)', async () => {
    mockRequestUrl.mockResolvedValueOnce({
      status: 200,
      json: { definitions: { notes: {} } },
    });
    const r = await supabaseCredentialFormRenderer.testConnection!(cred);
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.needsSetup).toBeUndefined();
  });

  it('omits needsSetup when OpenAPI 401 + RPC 200 (publishable + installed RPC)', async () => {
    mockRequestUrl
      .mockResolvedValueOnce({ status: 401, json: {} })
      .mockResolvedValueOnce({ status: 200, json: { notes: {} } });
    const r = await supabaseCredentialFormRenderer.testConnection!(cred);
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.needsSetup).toBeUndefined();
  });

  it('does NOT miscategorize non-JSON body on RPC fallback as rpc-missing', async () => {
    // OpenAPI 401 → falls through to RPC. RPC returns HTML 502 (proxy).
    // Without isRpcMissingResponse's type guard, the .code check would
    // silently fall through. Verify the helper catches it.
    mockRequestUrl
      .mockResolvedValueOnce({ status: 401, json: {} })
      .mockResolvedValueOnce({
        status: 502,
        json: undefined,
        text: () => '<html>502</html>',
      });
    const r = await supabaseCredentialFormRenderer.testConnection!(cred);
    expect(r.success).toBe(false);
    if (r.success) return;
    expect(r.error).toContain('502');
  });

  it('returns failure on non-401 OpenAPI status (e.g., 500)', async () => {
    mockRequestUrl.mockResolvedValueOnce({
      status: 500,
      json: { message: 'server error' },
    });
    const r = await supabaseCredentialFormRenderer.testConnection!(cred);
    expect(r.success).toBe(false);
    if (r.success) return;
    expect(r.error).toContain('500');
  });

  it('returns failure on network error', async () => {
    mockRequestUrl.mockRejectedValueOnce(new Error('network unreachable'));
    const r = await supabaseCredentialFormRenderer.testConnection!(cred);
    expect(r.success).toBe(false);
    if (r.success) return;
    expect(r.error).toContain('network');
  });

  it('refuses non-supabase credential', async () => {
    const wrong: Credential = { id: 'c1', name: 'X', type: 'airtable', apiKey: 'k' };
    const r = await supabaseCredentialFormRenderer.testConnection!(wrong);
    expect(r.success).toBe(false);
  });
});

describe('supabaseCredentialFormRenderer.verifySetup', () => {
  beforeEach(() => mockRequestUrl.mockReset());

  const cred: Credential = {
    id: 'c1', name: 'X', type: 'supabase',
    projectUrl: 'https://abc.supabase.co', apiKey: 'sb_publishable_xxx',
  };

  it('returns needsSetup when RPC returns 404/PGRST202', async () => {
    mockRequestUrl.mockResolvedValueOnce({
      status: 404,
      json: { code: 'PGRST202', message: 'function ani_supabase_schema does not exist' },
    });
    const r = await supabaseCredentialFormRenderer.verifySetup!(cred);
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.needsSetup).toEqual({ kind: 'supabase-rpc' });
  });

  it('returns plain success with detail when RPC returns 200', async () => {
    mockRequestUrl.mockResolvedValueOnce({ status: 200, json: { notes: {} } });
    const r = await supabaseCredentialFormRenderer.verifySetup!(cred);
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.needsSetup).toBeUndefined();
    expect(r.detail).toBe('RPC reachable.');
  });

  it('does NOT miscategorize non-JSON body (HTML 502) as rpc-missing', async () => {
    // Self-hosted PostgREST behind a misconfigured proxy may return
    // HTML 502 with no JSON body — without isRpcMissingResponse's type
    // guard, the .code check would silently fall through to "not
    // missing" and we'd return a generic HTTP error (still correct here)
    // — but with `rpc.json === undefined` we MUST NOT throw or
    // miscategorize as success.
    mockRequestUrl.mockResolvedValueOnce({
      status: 502,
      json: undefined,
      text: () => '<html>502 Bad Gateway</html>',
    });
    const r = await supabaseCredentialFormRenderer.verifySetup!(cred);
    expect(r.success).toBe(false);
    if (r.success) return;
    expect(r.error).toContain('502');
  });

  it('does NOT miscategorize null rpc.json as rpc-missing', async () => {
    mockRequestUrl.mockResolvedValueOnce({ status: 500, json: null });
    const r = await supabaseCredentialFormRenderer.verifySetup!(cred);
    expect(r.success).toBe(false);
  });

  it('does NOT miscategorize array rpc.json as rpc-missing', async () => {
    mockRequestUrl.mockResolvedValueOnce({
      status: 404,
      json: ['unexpected', 'shape'],
    });
    const r = await supabaseCredentialFormRenderer.verifySetup!(cred);
    expect(r.success).toBe(false);
    if (r.success) return;
    // Critical: must surface as failure, NOT as `success: true, needsSetup`.
    expect(r.error).toContain('404');
  });

  it('returns failure on 401', async () => {
    mockRequestUrl.mockResolvedValueOnce({
      status: 401,
      json: { message: 'Invalid API key' },
    });
    const r = await supabaseCredentialFormRenderer.verifySetup!(cred);
    expect(r.success).toBe(false);
    if (r.success) return;
    expect(r.error).toContain('401');
  });

  it('returns failure on 5xx', async () => {
    mockRequestUrl.mockResolvedValueOnce({
      status: 503,
      json: { message: 'service unavailable' },
    });
    const r = await supabaseCredentialFormRenderer.verifySetup!(cred);
    expect(r.success).toBe(false);
    if (r.success) return;
    expect(r.error).toContain('503');
  });

  it('returns failure on network error', async () => {
    mockRequestUrl.mockRejectedValueOnce(new Error('network unreachable'));
    const r = await supabaseCredentialFormRenderer.verifySetup!(cred);
    expect(r.success).toBe(false);
    if (r.success) return;
    expect(r.error).toContain('network');
  });

  it('refuses non-supabase credential', async () => {
    const wrong: Credential = { id: 'c1', name: 'X', type: 'airtable', apiKey: 'k' };
    const r = await supabaseCredentialFormRenderer.verifySetup!(wrong);
    expect(r.success).toBe(false);
  });
});
