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
