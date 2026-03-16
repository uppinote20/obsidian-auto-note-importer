/**
 * Credential type definitions for external service authentication.
 */

export type CredentialType = 'airtable';

export interface Credential {
  id: string;
  name: string;
  type: CredentialType;
  apiKey: string;
}
