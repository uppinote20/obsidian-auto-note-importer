/**
 * Supabase credential form renderer + key-type auto-detection helper.
 *
 * The detected key kind is derived from the input value each render and is
 * not persisted on SupabaseCredential. The UI just surfaces a security hint
 * (RLS protected vs RLS bypassed) based on the prefix or decoded JWT role.
 *
 * @handbook 4.4-provider-abstraction
 * @handbook 5.1-ui-components
 * @tested tests/services/supabase-credential-form.test.ts
 */

export type KeyKind =
  | 'publishable-new'
  | 'secret-new'
  | 'anon-legacy'
  | 'service-legacy'
  | 'unknown-jwt'
  | 'unknown';

export type KeyTone = 'ok' | 'warn' | 'neutral';

export interface KeyTypeInfo {
  kind: KeyKind;
  label: string;
  tone: KeyTone;
}

function decodeJwtPayload(token: string): { role?: string } | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const padded = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const decoded =
      typeof atob === 'function'
        ? atob(padded)
        : Buffer.from(padded, 'base64').toString('binary');
    return JSON.parse(decoded);
  } catch {
    return null;
  }
}

export function detectKeyType(key: string): KeyTypeInfo {
  if (key.startsWith('sb_publishable_')) {
    return { kind: 'publishable-new', label: 'Publishable key - RLS protected', tone: 'ok' };
  }
  if (key.startsWith('sb_secret_')) {
    return { kind: 'secret-new', label: 'Secret key - RLS bypassed, full DB access', tone: 'warn' };
  }
  if (key.startsWith('eyJ')) {
    const payload = decodeJwtPayload(key);
    if (payload?.role === 'anon') {
      return { kind: 'anon-legacy', label: 'Legacy anon key - RLS protected', tone: 'ok' };
    }
    if (payload?.role === 'service_role') {
      return { kind: 'service-legacy', label: 'Legacy service_role key - RLS bypassed', tone: 'warn' };
    }
    return { kind: 'unknown-jwt', label: 'Unrecognized JWT key', tone: 'neutral' };
  }
  return { kind: 'unknown', label: 'Unrecognized key format', tone: 'neutral' };
}
