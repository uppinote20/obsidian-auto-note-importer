/**
 * ConfigManager orchestrates multiple ConfigInstances.
 *
 * Handles lifecycle of per-config service stacks: creation, update,
 * enable/disable transitions, and teardown.
 */

import type { App } from "obsidian";
import type { ConfigEntry, Credential, SharedServices } from '../types';
import { ConfigInstance } from './config-instance';

/**
 * Manages multiple ConfigInstance objects keyed by config ID.
 */
export class ConfigManager {
  private app: App;
  private shared: SharedServices;
  private instances = new Map<string, ConfigInstance>();

  constructor(app: App, shared: SharedServices) {
    this.app = app;
    this.shared = shared;
  }

  /**
   * Creates ConfigInstance for each enabled config.
   * Skips disabled configs.
   */
  initialize(configs: ConfigEntry[], credentials: Credential[]): void {
    const credentialMap = new Map(credentials.map(c => [c.id, c]));

    for (const config of configs) {
      if (!config.enabled) continue;

      const credential = credentialMap.get(config.credentialId);
      if (!credential) continue;

      this.addConfig(config, credential);
    }
  }

  /**
   * Creates a new ConfigInstance and adds it to the map.
   */
  addConfig(config: ConfigEntry, credential: Credential): ConfigInstance {
    const instance = new ConfigInstance(this.app, config, credential, this.shared);
    this.instances.set(config.id, instance);
    return instance;
  }

  /**
   * Destroys and removes a ConfigInstance.
   */
  removeConfig(configId: string): void {
    const instance = this.instances.get(configId);
    if (instance) {
      instance.destroy();
      this.instances.delete(configId);
      this.pruneOrphanedRateLimiters();
    }
  }

  private pruneOrphanedRateLimiters(): void {
    const usedCredentialIds = new Set(
      Array.from(this.instances.values()).map(i => i.credentialId),
    );
    for (const credId of this.shared.rateLimiters.keys()) {
      if (!usedCredentialIds.has(credId)) {
        this.shared.rateLimiters.delete(credId);
      }
    }
  }

  /**
   * Returns a ConfigInstance by ID, or undefined if not found.
   */
  getInstance(configId: string): ConfigInstance | undefined {
    return this.instances.get(configId);
  }

  /**
   * Returns all active (instantiated) ConfigInstances.
   */
  getAllEnabled(): ConfigInstance[] {
    return Array.from(this.instances.values());
  }

  /**
   * Updates a config entry, handling enable/disable transitions.
   *
   * - If instance exists and config still enabled: update settings
   * - If instance exists but config now disabled: remove instance
   * - If no instance but config now enabled: add instance
   */
  updateConfig(configId: string, config: ConfigEntry, credential: Credential): void {
    const instance = this.instances.get(configId);

    if (instance && config.enabled) {
      instance.updateSettings(config, credential);
    } else if (instance && !config.enabled) {
      this.removeConfig(configId);
    } else if (!instance && config.enabled) {
      this.addConfig(config, credential);
    }
  }

  /**
   * Destroys all instances and clears the map.
   */
  destroy(): void {
    for (const instance of this.instances.values()) {
      instance.destroy();
    }
    this.instances.clear();
  }
}
