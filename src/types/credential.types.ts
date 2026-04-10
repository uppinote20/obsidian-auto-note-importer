/**
 * Credential type definitions for external database authentication.
 *
 * Credentials are discriminated by `type`, which also determines which
 * DatabaseProvider is instantiated for any ConfigEntry referencing the credential.
 */

export type CredentialType =
  | 'airtable'
  | 'seatable'
  | 'supabase'
  | 'notion'
  | 'custom-api';

interface BaseCredential {
  id: string;
  name: string;
}

export interface AirtableCredential extends BaseCredential {
  type: 'airtable';
  apiKey: string;
}

export interface SeaTableCredential extends BaseCredential {
  type: 'seatable';
  apiToken: string;
  serverUrl: string;
}

export interface SupabaseCredential extends BaseCredential {
  type: 'supabase';
  projectUrl: string;
  apiKey: string;
}

export interface NotionCredential extends BaseCredential {
  type: 'notion';
  integrationToken: string;
}

export interface CustomApiCredential extends BaseCredential {
  type: 'custom-api';
  baseUrl: string;
  authHeader: string;
  authValue: string;
}

export type Credential =
  | AirtableCredential
  | SeaTableCredential
  | SupabaseCredential
  | NotionCredential
  | CustomApiCredential;
