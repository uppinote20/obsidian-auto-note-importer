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
 * Result of testing a credential against the remote service.
 */
export type ConnectionTestResult =
  | { success: true; detail?: string }
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
}
