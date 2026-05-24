/**
 * Settings UI renderer contract for provider credentials.
 *
 * Each provider registers a CredentialFormRenderer that knows how to draw
 * its own auth fields, validate user input, and optionally test the
 * credential against the remote service. The settings tab delegates
 * rendering to the registered renderer so the UI stays decoupled from
 * any specific provider.
 *
 * @handbook 4.4-provider-abstraction
 * @handbook 5.1-ui-components
 */

import type { Credential, CredentialType } from './credential.types';

/**
 * Mutable key-value state for a credential form in flight.
 * Each field's `onChange` handler mutates the corresponding key; the
 * renderer's `build()` reads from the same state when the user saves.
 */
export type CredentialFormState = Record<string, string>;

/**
 * Result of building a Credential from form state.
 */
export type CredentialBuildResult =
  | { ok: true; credential: Credential }
  | { ok: false; error: string };

/**
 * Describes a one-time setup action the user must perform before the
 * credential can be used. Surfaced from testConnection / verifySetup so
 * the settings UI can render contextual setup instructions instead of a
 * blind error toast.
 */
export interface SetupRequirement {
  /** Discriminator for the setup kind. Widened as more providers need it. */
  kind: 'supabase-rpc';
}

/**
 * Result of testing a credential against the remote service. A
 * `success: true` result MAY also carry `needsSetup` to signal that the
 * credential authenticates but cannot complete its job until the user
 * performs a one-time setup action.
 */
export type ConnectionTestResult =
  | { success: true; detail?: string; needsSetup?: SetupRequirement }
  | { success: false; error: string };

/**
 * Per-provider credential form renderer. Stateless singleton registered
 * via provider-registry alongside the provider factory and field type mapper.
 */
export interface CredentialFormRenderer {
  /** Credential type this renderer handles. */
  readonly type: CredentialType;

  /** Human-readable label shown in the type dropdown (e.g. "Airtable"). */
  readonly label: string;

  /** Optional one-line description rendered above the auth fields. */
  readonly description?: string;

  /**
   * Renders provider-specific auth fields into the container. Each field's
   * onChange handler mutates the shared `state` object so `build()` can
   * construct a Credential from the latest values.
   *
   * `initial` pre-populates state in edit mode — the renderer must respect
   * existing values when present.
   */
  renderFields(
    containerEl: HTMLElement,
    state: CredentialFormState,
    initial?: Credential,
  ): void;

  /**
   * Builds a Credential from the current form state. Returns an error
   * message when required fields are missing or invalid.
   *
   * `id` is provided so edit mode can preserve the existing credential's
   * ID instead of generating a new one.
   */
  build(
    name: string,
    state: CredentialFormState,
    id: string,
  ): CredentialBuildResult;

  /**
   * Tests a credential against the remote service. Optional — providers
   * without a cheap auth probe can omit this.
   */
  testConnection?(credential: Credential): Promise<ConnectionTestResult>;

  /**
   * Verifies a credential is ready to be saved. Distinct from
   * testConnection in intent: testConnection answers "does this key
   * work?", verifySetup answers "can the user save right now, or do they
   * need a setup step first?". Providers that gate save behind a
   * one-time setup (e.g. Supabase publishable key + ani_supabase_schema
   * RPC) implement this; others omit it and the settings tab skips the
   * pre-save check.
   */
  verifySetup?(credential: Credential): Promise<ConnectionTestResult>;
}
