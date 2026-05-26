/**
 * Settings tab UI for the Auto Note Importer plugin.
 * UI-only - delegates API calls to FieldCache.
 *
 * Multi-config UI with credential management, tab-based config switching,
 * and per-config settings rendering.
 *
 * @handbook 5.1-ui-components
 * @handbook 4.4-provider-abstraction
 * @tested e2e:tests/e2e/run-settings-e2e.mjs
 * @tested e2e:tests/e2e/run-seatable-settings-e2e.mjs
 * @tested e2e:tests/e2e/run-supabase-settings-e2e.mjs
 */

import { App, PluginSettingTab, Setting, Notice, setIcon } from "obsidian";
import type { ExtraButtonComponent, Plugin } from "obsidian";
import {
  FieldCache,
  SeaTableMetadataCache,
  SupabaseMetadataCache,
  SupabaseSchemaRpcMissingError,
  getFieldTypeMapper,
  hasFieldTypeMapper,
  getCredentialFormRenderer,
  hasCredentialFormRenderer,
} from '../services';
import type { SeaTableTable } from '../services';
import type { CredentialFormState, CredentialFormRenderer, SetupRequirement } from '../types';
import type { AutoNoteImporterSettings, ConfigEntry, Credential, AirtableCredential, SeaTableCredential, SupabaseCredential, SupabaseOpenApiSpec, CredentialType, ConflictResolutionMode, BasesFileLocation } from '../types';
import { DEFAULT_CONFIG_ENTRY, CREDENTIAL_TYPES, CREDENTIAL_TYPE_LABELS } from '../types';
import { SUPABASE_DEFAULT_SCHEMA, SUPABASE_RPC_SCHEMA_SQL } from '../constants';
import { FolderSuggest, FileSuggest } from './suggest';
import { generateId } from '../utils/object-utils';
import { validateFolderPath } from '../utils/validation';
import { debounce } from '../utils/debounce';

/**
 * Interface for the plugin that the settings tab needs.
 */
export interface SettingsPlugin extends Plugin {
  settings: AutoNoteImporterSettings;
  saveSettings(): Promise<void>;
}

/**
 * Transient UI state for the credential add/edit form. Tracks whether
 * the active form has a pending setup requirement (e.g. Supabase RPC
 * not installed), references to the banner host element and Save button,
 * in-flight guards to prevent concurrent click races, and a cleanups
 * array for any event listeners that must be detached when the form is
 * disposed or re-rendered (prevents listener accumulation across
 * type-switches and re-displays). Owned by the settings tab; reset via
 * resetCredentialFormUi() when a credential form opens, and torn down
 * (cleanups invoked) by display().
 */
interface CredentialFormUiState {
  setupRequirement: SetupRequirement | null;
  bannerHost: HTMLElement | null;
  saveButton: HTMLButtonElement | null;
  testButton: HTMLButtonElement | null;
  isTesting: boolean;
  isSaving: boolean;
  cleanups: Array<() => void>;
}

/**
 * Settings tab for the Auto Note Importer plugin.
 */
export class AutoNoteImporterSettingTab extends PluginSettingTab {
  plugin: SettingsPlugin;
  private fieldCache: FieldCache;
  private seatableMetadataCache: SeaTableMetadataCache;
  private supabaseMetadataCache: SupabaseMetadataCache;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * Bumped on each `display()` so async render callbacks (e.g. SeaTable
   * metadata fetch) can detect that the DOM they captured has been
   * superseded — without this they'd populate a detached element and
   * leave the visible card body blank.
   */
  private renderGeneration = 0;
  private editingCredentialId: string | null = null;
  private addingCredential = false;
  private addingCredentialType: CredentialType = 'airtable';
  // Both connection-card ids are seeded so whichever provider's card
  // renders for the active credential starts expanded; the inactive one
  // is harmless (no card = no element to apply the class to).
  private expandedSections: Set<string> = new Set(['airtable-connection', 'seatable-connection', 'supabase-connection']);
  private pendingDeleteConfigId: string | null = null;
  private pendingDeleteCredentialId: string | null = null;
  private credentialFormUi: CredentialFormUiState | null = null;

  constructor(
    app: App,
    plugin: SettingsPlugin,
    fieldCache: FieldCache,
    seatableMetadataCache: SeaTableMetadataCache,
    supabaseMetadataCache: SupabaseMetadataCache,
  ) {
    super(app, plugin);
    this.plugin = plugin;
    this.fieldCache = fieldCache;
    this.seatableMetadataCache = seatableMetadataCache;
    this.supabaseMetadataCache = supabaseMetadataCache;
  }

  /**
   * Returns the active config entry, or undefined if none exists.
   */
  private get activeConfig(): ConfigEntry | undefined {
    const { activeConfigId, configs } = this.plugin.settings;
    return configs.find(c => c.id === activeConfigId) ?? configs[0];
  }

  /**
   * Returns the credential for the active config, or undefined.
   */
  private get activeCredential(): Credential | undefined {
    const config = this.activeConfig;
    if (!config) return undefined;
    return this.plugin.settings.credentials.find(c => c.id === config.credentialId);
  }

  private debounceDisplay(delay = 100): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(() => {
      this.display();
    }, delay);
  }

  /**
   * Returns a debouncer that saves plugin settings after `delay` ms of input
   * inactivity. Use for text-input handlers where saving on every keystroke
   * triggers heavy work (provider reconfigure, command re-register).
   */
  private makeFieldDebouncer(delay = 400): () => void {
    return debounce(() => { void this.plugin.saveSettings(); }, delay);
  }

  private configureRefreshButton(button: ExtraButtonComponent, tooltip: string, clearCache: () => void): ExtraButtonComponent {
    return button
      .setIcon("refresh-cw")
      .setTooltip(tooltip)
      .onClick(() => {
        clearCache();
        this.debounceDisplay();
      });
  }

  hide(): void {
    super.hide();
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
  }

  display(): void {
    this.renderGeneration++;
    this.tearDownCredentialFormUi();
    const { containerEl } = this;
    containerEl.empty();

    // Credentials section
    this.renderCredentialsSection(containerEl);

    // Debug settings (global, above per-config tabs)
    this.renderDebugSettings(containerEl);

    // Tab bar for config switching
    this.renderTabBar(containerEl);

    const config = this.activeConfig;
    const credential = this.activeCredential;

    if (!config || !credential) {
      if (this.plugin.settings.configs.length === 0) {
        new Setting(containerEl)
          .setName('No configuration')
          .setDesc('Add a configuration using the + tab above.');
      }
      return;
    }

    // Config header: name, enabled toggle, credential selector
    this.renderConfigHeader(containerEl, config);

    // Summary card stack
    const cardStack = containerEl.createDiv({ cls: 'ani-card-stack' });

    // The card renders by credential type alone — missing secrets just
    // flip the badge to 'Setup required'. Previously the && apiKey / &&
    // apiToken guard dropped the whole card when the new credential's
    // secret was empty, which manifested as a one-way render asymmetry
    // when the user switched credentials via the dropdown (the next
    // display() call would only fire from an unrelated re-render — see
    // issue #76).
    if (credential.type === 'airtable') {
      const airtableCred = credential;
      const connected = !!(airtableCred.apiKey && config.baseId && config.tableId);
      this.renderSummaryCard(cardStack, {
        sectionId: 'airtable-connection', icon: '\u{1F4E1}', title: 'Airtable Connection',
        summary: this.getConnectionSummary(config),
        badge: connected ? { status: 'ok', text: 'Connected' } : { status: 'off', text: 'Setup required' },
        renderContent: (c) => this.renderBaseSelector(c, config, airtableCred),
      });
    } else if (credential.type === 'seatable') {
      // SeaTable's API token is base-specific, so the dtable_uuid is derived
      // from the credential at sync time — only tableId/viewId are user-supplied.
      const seatableCred = credential;
      const connected = !!(seatableCred.apiToken && config.tableId);
      this.renderSummaryCard(cardStack, {
        sectionId: 'seatable-connection', icon: '\u{1F4E1}', title: 'SeaTable Connection',
        summary: this.getConnectionSummary(config),
        badge: connected ? { status: 'ok', text: 'Connected' } : { status: 'off', text: 'Setup required' },
        renderContent: (c) => this.renderSeaTableConnection(c, config, seatableCred),
      });
    } else if (credential.type === 'supabase') {
      const supabaseCred = credential;
      const connected = !!(supabaseCred.apiKey && supabaseCred.projectUrl && config.tableId);
      this.renderSummaryCard(cardStack, {
        sectionId: 'supabase-connection', icon: '\u{1F4E1}', title: 'Supabase Connection',
        summary: this.getConnectionSummary(config),
        badge: connected ? { status: 'ok', text: 'Connected' } : { status: 'off', text: 'Setup required' },
        renderContent: (c) => { void this.renderSupabaseConnection(c, config, supabaseCred); },
      });
    }

    this.renderSummaryCard(cardStack, {
      sectionId: 'file-settings', icon: '\u{1F4C1}', title: 'File Settings',
      summary: this.getFileSummary(config),
      badge: config.folderPath ? { status: 'ok', text: 'Configured' } : { status: 'off', text: 'Setup required' },
      renderContent: (c) => this.renderFileSettings(c, config),
    });

    this.renderSummaryCard(cardStack, {
      sectionId: 'bases-database', icon: '\u{1F4BE}', title: 'Bases Database',
      summary: config.generateBasesFile ? 'Auto-generate enabled' : '',
      badge: config.generateBasesFile ? { status: 'ok', text: 'On' } : { status: 'off', text: 'Off' },
      renderContent: (c) => this.renderBasesSettings(c, config),
    });

    this.renderSummaryCard(cardStack, {
      sectionId: 'bidirectional-sync', icon: '\u{1F504}', title: 'Bidirectional Sync',
      summary: this.getSyncSummary(config),
      badge: config.bidirectionalSync ? { status: 'ok', text: 'On' } : { status: 'off', text: 'Off' },
      renderContent: (c) => this.renderBidirectionalSyncSettings(c, config),
    });

    // Delete config button
    this.renderDeleteConfigButton(containerEl, config);
  }

  // ─── Credentials Section ───────────────────────────────────────────

  private renderCredentialsSection(containerEl: HTMLElement): void {
    const section = containerEl.createDiv({ cls: 'ani-credentials-section' });
    section.createEl('h3', { text: 'Credentials' });
    section.createEl('p', { cls: 'ani-credentials-desc', text: 'Configure credentials for your database providers.' });

    const { credentials } = this.plugin.settings;

    if (credentials.length > 0) {
      const table = section.createEl('table', { cls: 'ani-credentials-table' });
      const thead = table.createEl('thead');
      const headerRow = thead.createEl('tr');
      headerRow.createEl('th', { text: 'Name' });
      headerRow.createEl('th', { text: 'Type' });
      headerRow.createEl('th', { text: 'Auth' });
      headerRow.createEl('th', { text: 'Actions' });

      const tbody = table.createEl('tbody');
      for (const cred of credentials) {
        this.renderCredentialTableRow(tbody, cred);
      }
    }

    // Edit form (inline below table)
    if (this.editingCredentialId) {
      const cred = credentials.find(c => c.id === this.editingCredentialId);
      if (cred) this.renderCredentialEditRow(section, cred);
    }

    // Add form or button
    if (this.addingCredential) {
      this.renderCredentialAddRow(section);
    } else {
      const addContainer = section.createDiv({ cls: 'ani-credentials-add' });
      const addBtn = addContainer.createEl('button', { text: '+ Add credential' });
      addBtn.addEventListener('click', () => {
        this.addingCredential = true;
        this.display();
      });
    }
  }

  private maskApiKey(apiKey: string): string {
    if (apiKey.length <= 4) return apiKey ? '****' : '';
    return '\u2022\u2022\u2022\u2022' + apiKey.slice(-4);
  }

  private renderCredentialTableRow(tbody: HTMLElement, cred: Credential): void {
    const row = tbody.createEl('tr');
    row.createEl('td', { cls: 'ani-cred-name', text: cred.name });
    row.createEl('td', { cls: 'ani-cred-type', text: CREDENTIAL_TYPE_LABELS[cred.type] });

    const keyCell = row.createEl('td');
    const authValue = cred.type === 'airtable' ? cred.apiKey
      : cred.type === 'seatable' ? cred.apiToken
      : cred.type === 'supabase' ? cred.apiKey
      : null;
    if (authValue) {
      keyCell.createSpan({ cls: 'ani-cred-key', text: this.maskApiKey(authValue) });
    } else if (authValue === '') {
      const setLink = keyCell.createSpan({ cls: 'ani-cred-key-set', text: 'Set credential' });
      setLink.addEventListener('click', () => {
        this.editingCredentialId = cred.id;
        this.display();
      });
    } else {
      keyCell.createSpan({ cls: 'ani-cred-key-na', text: '\u2014' });
    }

    const actionsCell = row.createEl('td', { cls: 'ani-cred-actions' });

    const editBtn = actionsCell.createEl('button', { cls: 'ani-cred-action-btn' });
    setIcon(editBtn, 'settings');
    editBtn.title = 'Edit credential';
    editBtn.addEventListener('click', () => {
      this.editingCredentialId = cred.id;
      this.display();
    });

    const isPendingDelete = this.pendingDeleteCredentialId === cred.id;
    const deleteBtn = actionsCell.createEl('button', {
      cls: `ani-cred-action-btn${isPendingDelete ? ' ani-cred-action-confirm' : ''}`,
    });
    setIcon(deleteBtn, isPendingDelete ? 'check' : 'trash-2');
    deleteBtn.title = isPendingDelete ? 'Confirm delete' : 'Delete credential';
    deleteBtn.addEventListener('click', async () => {
      if (!isPendingDelete) {
        const inUse = this.plugin.settings.configs.some(c => c.credentialId === cred.id);
        if (inUse) {
          new Notice('Auto Note Importer: Cannot delete a credential that is in use by a configuration.');
          return;
        }
        this.pendingDeleteCredentialId = cred.id;
        this.display();
        return;
      }
      this.pendingDeleteCredentialId = null;
      this.plugin.settings.credentials = this.plugin.settings.credentials.filter(c => c.id !== cred.id);
      await this.plugin.saveSettings();
      this.display();
    });
  }

  private renderCredentialEditRow(containerEl: HTMLElement, cred: Credential): void {
    if (!hasCredentialFormRenderer(cred.type)) {
      new Setting(containerEl)
        .setName('Edit not supported')
        .setDesc(`Editing ${cred.type} credentials is not yet supported.`);
      return;
    }
    const renderer = getCredentialFormRenderer(cred.type);
    this.resetCredentialFormUi();
    const state: CredentialFormState = {};
    let nameValue = cred.name;

    const nameSetting = new Setting(containerEl)
      .setName('Name')
      .addText(text => text
        .setValue(cred.name)
        .setPlaceholder('Credential name')
        .onChange(value => { nameValue = value; }));
    nameSetting.settingEl.addClass('ani-credential-edit');

    renderer.renderFields(containerEl, state, cred);

    // Any field edit invalidates a prior setup verification. Auto-clear
    // the banner + re-enable Save so a stale RPC-missing diagnosis can't
    // outlive the inputs it was diagnosed against.
    //
    // Register the handler reference in credentialFormUi.cleanups so the
    // next form render / display() detaches it — otherwise add-mode
    // type-switches (which re-call renderCredentialAddDetails on the
    // same containerEl) would accumulate listeners.
    const inputResetHandler = (): void => {
      if (this.credentialFormUi?.setupRequirement) {
        this.clearFormSetupRequirement();
      }
    };
    containerEl.addEventListener('input', inputResetHandler);
    this.credentialFormUi?.cleanups.push(() =>
      containerEl.removeEventListener('input', inputResetHandler),
    );

    new Setting(containerEl)
      .addButton(button => {
        button.setButtonText('Save').setCta();
        if (this.credentialFormUi) {
          this.credentialFormUi.saveButton = button.buttonEl;
        }
        button.onClick(async () => {
          const result = renderer.build(nameValue, state, cred.id);
          if (!result.ok) {
            new Notice(`Auto Note Importer: ${result.error}`);
            return;
          }
          const gate = await this.verifyCredentialBeforeSave(renderer, result.credential, containerEl);
          if (gate !== 'proceed') return;
          // Replace the existing credential in-place
          const idx = this.plugin.settings.credentials.findIndex(c => c.id === cred.id);
          if (idx >= 0) {
            this.plugin.settings.credentials[idx] = result.credential;
          }
          await this.plugin.saveSettings();
          this.editingCredentialId = null;
          this.display();
        });
      })
      .addButton(button => {
        button.setButtonText('Test').setDisabled(!renderer.testConnection);
        if (this.credentialFormUi) {
          this.credentialFormUi.testButton = button.buttonEl;
        }
        button.onClick(() => {
          const result = renderer.build(nameValue, state, cred.id);
          if (!result.ok) {
            new Notice(`Auto Note Importer: ${result.error}`);
            return;
          }
          void this.runConnectionTest(renderer, result.credential, containerEl);
        });
      })
      .addButton(button => button
        .setButtonText('Cancel')
        .onClick(() => {
          this.editingCredentialId = null;
          this.display();
        }));
  }

  private renderCredentialAddRow(containerEl: HTMLElement): void {
    // Name persists across detail re-renders. The provider-specific state
    // bag survives dropdown switches within the same closure so a user who
    // types a key, switches types, and switches back doesn't lose input.
    const context = {
      name: '',
      state: {} as CredentialFormState,
    };

    const nameSetting = new Setting(containerEl)
      .setName('Name')
      .addText(text => text
        .setPlaceholder('e.g. Personal Airtable')
        .onChange(value => { context.name = value; }));
    nameSetting.settingEl.addClass('ani-credential-edit');

    const typeSetting = new Setting(containerEl).setName('Type');
    typeSetting.settingEl.addClass('ani-credential-edit');

    const detailEl = containerEl.createDiv({ cls: 'ani-credential-add-details' });
    const renderDetails = () => {
      detailEl.empty();
      this.renderCredentialAddDetails(detailEl, context);
    };

    typeSetting.addDropdown(dropdown => {
      for (const t of CREDENTIAL_TYPES) {
        dropdown.addOption(t, CREDENTIAL_TYPE_LABELS[t]);
      }
      dropdown.setValue(this.addingCredentialType);
      dropdown.onChange(value => {
        this.addingCredentialType = value as CredentialType;
        renderDetails();
      });
    });

    renderDetails();
  }

  private renderCredentialAddDetails(
    containerEl: HTMLElement,
    context: { name: string; state: CredentialFormState },
  ): void {
    const type = this.addingCredentialType;

    if (!hasCredentialFormRenderer(type)) {
      const noticeSetting = new Setting(containerEl)
        .setName('Not yet supported')
        .setDesc(`${CREDENTIAL_TYPE_LABELS[type]} provider will be available in a future release.`);
      noticeSetting.settingEl.addClass('ani-credential-edit');

      new Setting(containerEl)
        .addButton(button => button.setButtonText('Save').setCta().setDisabled(true))
        .addButton(button => button
          .setButtonText('Cancel')
          .onClick(() => {
            this.addingCredential = false;
            this.addingCredentialType = 'airtable';
            this.display();
          }));
      return;
    }

    const renderer = getCredentialFormRenderer(type);
    this.resetCredentialFormUi();
    if (renderer.description) {
      containerEl.createEl('p', { cls: 'ani-credential-desc', text: renderer.description });
    }
    renderer.renderFields(containerEl, context.state);

    // Any field edit invalidates a prior setup verification. Auto-clear
    // the banner + re-enable Save so a stale RPC-missing diagnosis can't
    // outlive the inputs it was diagnosed against.
    //
    // Register the handler reference in credentialFormUi.cleanups so the
    // next form render / display() detaches it — otherwise add-mode
    // type-switches (which re-call renderCredentialAddDetails on the
    // same containerEl) would accumulate listeners.
    const inputResetHandler = (): void => {
      if (this.credentialFormUi?.setupRequirement) {
        this.clearFormSetupRequirement();
      }
    };
    containerEl.addEventListener('input', inputResetHandler);
    this.credentialFormUi?.cleanups.push(() =>
      containerEl.removeEventListener('input', inputResetHandler),
    );

    new Setting(containerEl)
      .addButton(button => {
        button.setButtonText('Save').setCta();
        if (this.credentialFormUi) {
          this.credentialFormUi.saveButton = button.buttonEl;
        }
        button.onClick(async () => {
          const result = renderer.build(context.name, context.state, generateId());
          if (!result.ok) {
            new Notice(`Auto Note Importer: ${result.error}`);
            return;
          }
          const gate = await this.verifyCredentialBeforeSave(renderer, result.credential, containerEl);
          if (gate !== 'proceed') return;
          this.plugin.settings.credentials.push(result.credential);
          await this.plugin.saveSettings();
          this.addingCredential = false;
          this.addingCredentialType = 'airtable';
          this.display();
        });
      })
      .addButton(button => {
        button.setButtonText('Test').setDisabled(!renderer.testConnection);
        if (this.credentialFormUi) {
          this.credentialFormUi.testButton = button.buttonEl;
        }
        button.onClick(() => {
          const result = renderer.build(context.name, context.state, 'test-only');
          if (!result.ok) {
            new Notice(`Auto Note Importer: ${result.error}`);
            return;
          }
          void this.runConnectionTest(renderer, result.credential, containerEl);
        });
      })
      .addButton(button => button
        .setButtonText('Cancel')
        .onClick(() => {
          this.addingCredential = false;
          this.addingCredentialType = 'airtable';
          this.display();
        }));
  }

  private async runConnectionTest(
    renderer: CredentialFormRenderer,
    credential: Credential,
    formHostEl: HTMLElement,
  ): Promise<void> {
    if (!renderer.testConnection) return;
    if (this.credentialFormUi?.isTesting) return;   // re-entry guard
    if (this.credentialFormUi) this.credentialFormUi.isTesting = true;

    // Visual loading state on the Test button itself \u2014 re-entry guard
    // silently drops rapid double-clicks, but without UI feedback the
    // user has no idea the second click was ignored.
    const testBtn = this.credentialFormUi?.testButton ?? null;
    const originalTestText = testBtn?.textContent ?? null;
    if (testBtn) {
      testBtn.disabled = true;
      testBtn.textContent = 'Testing\u2026';
    }

    new Notice('Auto Note Importer: Testing connection\u2026');
    try {
      const result = await renderer.testConnection(credential);
      if (!result.success) {
        new Notice(`Auto Note Importer: Connection failed \u2014 ${result.error}`);
        return;
      }
      if (result.needsSetup) {
        // Suppress the "Connection OK" Notice \u2014 the inline banner is the
        // contextual surface. Render banner inside form host, disable
        // Save until verify succeeds.
        this.renderSetupBannerForRequirement(result.needsSetup, credential, formHostEl);
        return;
      }
      // Success without needsSetup \u2014 if a prior probe set the banner
      // (e.g. user installed the RPC externally between Test clicks),
      // clear it now so Save isn't stuck disabled (Codex P2, PR #92).
      if (this.credentialFormUi?.setupRequirement) {
        this.clearFormSetupRequirement();
      }
      const detail = result.detail ? ` ${result.detail}` : '';
      new Notice(`Auto Note Importer: Connection OK.${detail}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      new Notice(`Auto Note Importer: Connection test errored \u2014 ${message}`);
    } finally {
      if (this.credentialFormUi) this.credentialFormUi.isTesting = false;
      if (testBtn) {
        testBtn.disabled = false;
        testBtn.textContent = originalTestText ?? 'Test';
      }
    }
  }

  // ─── Tab Bar ───────────────────────────────────────────────────────

  private renderTabBar(containerEl: HTMLElement): void {
    const tabBar = containerEl.createDiv({ cls: 'ani-config-tab-bar' });
    const { configs } = this.plugin.settings;
    const activeId = this.activeConfig?.id;

    for (const config of configs) {
      const tab = tabBar.createDiv({
        cls: `ani-config-tab${config.id === activeId ? ' active' : ''}`,
        text: config.name || 'Untitled',
        attr: { 'data-config-id': config.id },
      });
      tab.addEventListener('click', async () => {
        this.plugin.settings.activeConfigId = config.id;
        await this.plugin.saveSettings();
        this.display();
      });
    }

    // Add tab
    const addTab = tabBar.createDiv({
      cls: 'ani-config-tab ani-add-tab',
      text: '+',
    });
    addTab.addEventListener('click', async () => {
      if (this.plugin.settings.credentials.length === 0) {
        new Notice('Auto Note Importer: Add a credential first before creating a configuration.');
        this.addingCredential = true;
        this.display();
        return;
      }
      const existingNames = new Set(configs.map(c => c.name));
      let nameIdx = configs.length + 1;
      while (existingNames.has(`Config ${nameIdx}`)) nameIdx++;

      const newConfig: ConfigEntry = {
        ...DEFAULT_CONFIG_ENTRY,
        id: generateId(),
        name: `Config ${nameIdx}`,
        credentialId: this.plugin.settings.credentials[0].id,
      };
      this.plugin.settings.configs.push(newConfig);
      this.plugin.settings.activeConfigId = newConfig.id;
      await this.plugin.saveSettings();
      this.display();
    });
  }

  // ─── Config Header ─────────────────────────────────────────────────

  private renderConfigHeader(containerEl: HTMLElement, config: ConfigEntry): void {
    new Setting(containerEl).setName('Configuration').setHeading();

    // Config name
    const nameSetting = new Setting(containerEl)
      .setName('Configuration name')
      .setDesc('A display name for this sync configuration.')
      .addText(text => text
        .setPlaceholder('My Config')
        .setValue(config.name)
        .onChange(async (value) => {
          const duplicate = this.plugin.settings.configs.some(
            c => c.id !== config.id && c.name.trim() === value.trim(),
          );
          if (duplicate) {
            this.showFieldError(nameSetting, 'This name is already used by another configuration.');
            return;
          }
          this.showFieldError(nameSetting, null, 'A display name for this sync configuration.');
          config.name = value;
          await this.plugin.saveSettings();
          // Update tab text without full re-render
          const tab = this.containerEl.querySelector(`.ani-config-tab[data-config-id="${config.id}"]`);
          if (tab) tab.textContent = value || 'Untitled';
        }));

    // Enabled toggle
    new Setting(containerEl)
      .setName('Enabled')
      .setDesc('When disabled, this configuration will not sync.')
      .addToggle(toggle => toggle
        .setValue(config.enabled)
        .onChange(async (value) => {
          config.enabled = value;
          await this.plugin.saveSettings();
        }));

    // Credential selector
    new Setting(containerEl)
      .setName('Credential')
      .setDesc('Select the database credential to use for this configuration.')
      .addDropdown(dropdown => {
        const { credentials } = this.plugin.settings;
        if (credentials.length === 0) {
          dropdown.addOption('', '-- No credentials --');
        } else {
          for (const cred of credentials) {
            dropdown.addOption(cred.id, cred.name);
          }
        }
        dropdown.setValue(config.credentialId);
        dropdown.onChange(async (value) => {
          config.credentialId = value;
          await this.plugin.saveSettings();
          this.debounceDisplay();
        });
      });
  }

  // ─── Delete Config ─────────────────────────────────────────────────

  private renderDeleteConfigButton(containerEl: HTMLElement, config: ConfigEntry): void {
    new Setting(containerEl).setName('Danger zone').setHeading();

    const isPending = this.pendingDeleteConfigId === config.id;
    const setting = new Setting(containerEl)
      .setName('Delete this configuration')
      .setDesc(isPending
        ? 'Click again to confirm deletion.'
        : 'Permanently remove this sync configuration. This cannot be undone.')
      .addButton(button => {
        button
          .setButtonText(isPending ? 'Confirm delete' : 'Delete')
          .setWarning()
          .onClick(async () => {
            if (!isPending) {
              this.pendingDeleteConfigId = config.id;
              this.display();
              return;
            }
            const { configs } = this.plugin.settings;
            if (configs.length <= 1) {
              new Notice('Auto Note Importer: Cannot delete the last configuration.');
              return;
            }
            this.pendingDeleteConfigId = null;
            this.plugin.settings.configs = configs.filter(c => c.id !== config.id);
            this.plugin.settings.activeConfigId = this.plugin.settings.configs[0]?.id ?? '';
            await this.plugin.saveSettings();
            this.display();
          });
        if (isPending) {
          button.buttonEl.addClass('mod-destructive');
        }
      });
    if (isPending) {
      setting.addButton(button => button
        .setButtonText('Cancel')
        .onClick(() => {
          this.pendingDeleteConfigId = null;
          this.display();
        }));
    }
    setting.settingEl.addClass('ani-delete-config');
  }

  // ─── Summary Cards ─────────────────────────────────────────────────

  private renderSummaryCard(
    containerEl: HTMLElement,
    opts: {
      sectionId: string;
      icon: string;
      title: string;
      summary: string;
      badge: { status: 'ok' | 'off'; text: string };
      renderContent: (container: HTMLElement) => void;
    },
  ): void {
    const { sectionId, icon, title, summary, badge, renderContent } = opts;
    const isExpanded = this.expandedSections.has(sectionId);
    const card = containerEl.createDiv({ cls: `ani-summary-card${isExpanded ? ' is-expanded' : ''}` });

    const header = card.createDiv({ cls: 'ani-card-header' });
    header.createSpan({ cls: 'ani-card-icon', text: icon });
    header.createSpan({ cls: 'ani-card-title', text: title });
    if (summary) {
      header.createSpan({ cls: 'ani-card-summary', text: summary });
    }
    header.createSpan({ cls: `ani-card-badge ani-card-badge-${badge.status}`, text: badge.text });
    header.createSpan({ cls: 'ani-card-chevron', text: '\u25B6' });

    header.addEventListener('click', () => {
      if (this.expandedSections.has(sectionId)) {
        this.expandedSections.delete(sectionId);
      } else {
        this.expandedSections.add(sectionId);
      }
      this.display();
    });

    if (isExpanded) {
      const body = card.createDiv({ cls: 'ani-card-body' });
      renderContent(body);
    }
  }

  private showFieldError(setting: Setting, error: string | null, defaultDesc?: string): void {
    if (error) {
      setting.descEl.textContent = error;
      setting.descEl.addClass('ani-field-error');
    } else {
      setting.descEl.textContent = defaultDesc ?? '';
      setting.descEl.removeClass('ani-field-error');
    }
  }

  private getConnectionSummary(config: ConfigEntry): string {
    // tableId is the universal "is this configured" signal. Airtable also
    // requires baseId, but if tableId is set without baseId the Airtable
    // path won't render anyway, so this single check is safe across providers.
    if (!config.tableId) return '';
    const parts: string[] = [];
    if (config.filenameFieldName) parts.push(config.filenameFieldName);
    if (config.viewId) parts.push('View filtered');
    return parts.join(' \u00B7 ');
  }

  private getFileSummary(config: ConfigEntry): string {
    const parts: string[] = [];
    if (config.folderPath) parts.push(config.folderPath + '/');
    if (config.templatePath) {
      parts.push(config.templatePath.split('/').pop() ?? config.templatePath);
    }
    if (config.syncInterval > 0) parts.push(config.syncInterval + 'min');
    return parts.join(' \u00B7 ');
  }

  private getSyncSummary(config: ConfigEntry): string {
    if (!config.bidirectionalSync) return '';
    const parts: string[] = [];
    parts.push(config.conflictResolution);
    if (config.watchForChanges) parts.push('watching');
    return parts.join(' \u00B7 ');
  }

  // ─── File Settings ──────────────────────────────────────────────────

  private renderFileSettings(containerEl: HTMLElement, config: ConfigEntry): void {
    // Folder path setting (with inline overlap validation)
    const folderDesc = 'Example: folder1/folder2';
    const folderSetting = new Setting(containerEl)
      .setName("New file location")
      .setDesc(folderDesc)
      .addText(text => {
        const input = text
          .setPlaceholder("Crawling")
          .setValue(config.folderPath)
          .onChange(async (value) => {
            const error = validateFolderPath(config.id, value, this.plugin.settings.configs);
            if (error) {
              this.showFieldError(folderSetting, error);
              return;
            }
            this.showFieldError(folderSetting, null, folderDesc);
            config.folderPath = value;
            await this.plugin.saveSettings();
          });
        new FolderSuggest(this.app, input.inputEl as HTMLInputElement);
      });

    // Template path setting
    new Setting(containerEl)
      .setName("Template file")
      .setDesc("Example: templates/template-file.md")
      .addText(text => {
        const input = text
          .setPlaceholder("Templates/note-template.md")
          .setValue(config.templatePath)
          .onChange(async (value) => {
            config.templatePath = value;
            await this.plugin.saveSettings();
          });
        new FileSuggest(this.app, input.inputEl as HTMLInputElement);
      });

    this.renderNumberSetting(containerEl, "Sync interval (minutes)", "How often to sync notes (in minutes).", "0",
      config.syncInterval, "Sync interval",
      (num) => { config.syncInterval = num; });

    // Allow overwrite setting
    new Setting(containerEl)
      .setName("Allow overwrite existing notes")
      .setDesc("If enabled, existing notes will be overwritten when syncing.")
      .addToggle(toggle => toggle
        .setValue(config.allowOverwrite)
        .onChange(async (value) => {
          config.allowOverwrite = value;
          await this.plugin.saveSettings();
        }));
  }

  // ─── Existing Render Methods ───────────────────────────────────────

  private renderSeaTableConnection(
    containerEl: HTMLElement,
    config: ConfigEntry,
    credential: SeaTableCredential,
  ): void {
    if (!hasFieldTypeMapper(credential.type)) {
      new Setting(containerEl)
        .setName('Field type mapper missing')
        .setDesc(`No field type mapper registered for ${credential.type}.`);
      return;
    }

    // Try to load metadata so dropdowns can replace ID-text inputs.
    // If the API token isn't set yet (or fetch fails), fall back to
    // text inputs so the user can still configure manually — same
    // graceful-degrade contract as Airtable's renderBaseSelector.
    if (!credential.apiToken) {
      this.renderSeaTableTextFallback(containerEl, config);
      return;
    }

    // Cold-cache loading hint — replaced by either renderSeaTableDropdowns
    // (success) or renderSeaTableTextFallback (failure) once the fetch
    // settles. Without this the card body sits blank for a beat.
    const loadingHint = containerEl.createEl('p', {
      cls: 'ani-credential-desc',
      text: 'Loading SeaTable metadata…',
    });

    // Capture the current render generation so a subsequent display()
    // (tab switch / cred edit) can mark our callback as stale and skip
    // populating a detached DOM node. Without this guard the new render
    // coexists with our zombie callback and the visible card body
    // appears blank until another re-render kicks in.
    const gen = this.renderGeneration;
    void this.seatableMetadataCache.fetchTables(credential).then(
      tables => {
        if (this.renderGeneration !== gen) return;
        loadingHint.remove();
        this.renderSeaTableDropdowns(containerEl, config, credential, tables);
      },
      err => {
        if (this.renderGeneration !== gen) return;
        loadingHint.remove();
        new Notice(`Auto Note Importer: Failed to load SeaTable metadata. ${err.message || err}`);
        this.renderSeaTableTextFallback(containerEl, config);
      },
    );
  }

  private renderSeaTableDropdowns(
    containerEl: HTMLElement,
    config: ConfigEntry,
    credential: SeaTableCredential,
    tables: SeaTableTable[],
  ): void {
    const mapper = getFieldTypeMapper(credential.type);
    containerEl.empty();
    containerEl.createEl('p', {
      cls: 'ani-credential-desc',
      text: 'Pick the table, view, and columns to sync. The dropdowns are populated from your SeaTable base metadata.',
    });

    const selectedTable = tables.find(t => t.id === config.tableId);

    new Setting(containerEl)
      .setName('Table')
      .setDesc('Required. The SeaTable table to sync.')
      .addDropdown(dropdown => {
        dropdown.addOption('', '-- Select table --');
        for (const t of tables) dropdown.addOption(t.id, t.name);
        dropdown.setValue(config.tableId);
        dropdown.onChange(async (value) => {
          config.tableId = value;
          // Table change invalidates view + field selections, since they're
          // table-scoped on the SeaTable side.
          config.viewId = '';
          config.filenameFieldName = '';
          config.subfolderFieldName = '';
          await this.plugin.saveSettings();
          this.debounceDisplay();
        });
      })
      .addExtraButton(button => this.configureRefreshButton(button, 'Refresh metadata', () => {
        this.seatableMetadataCache.clearForCred(credential.id);
      }));

    new Setting(containerEl)
      .setName('View (optional)')
      .setDesc('Filter synced rows by a SeaTable view. Leave empty to sync the entire table.')
      .addDropdown(dropdown => {
        dropdown.addOption('', '-- All rows (no view filter) --');
        for (const v of selectedTable?.views ?? []) dropdown.addOption(v.id, v.name);
        dropdown.setValue(config.viewId);
        dropdown.setDisabled(!selectedTable);
        dropdown.onChange(async (value) => {
          config.viewId = value;
          await this.plugin.saveSettings();
        });
      });

    const safeTypes = new Set(mapper.getFilenameSafeTypes());
    const filenameCandidates = (selectedTable?.columns ?? []).filter(c => safeTypes.has(c.type));
    const safeTypesList = mapper.getFilenameSafeTypes().join(', ') || 'text';
    // Stale-value surface: symmetric with the subfolder dropdown — exposes a
    // stored filenameFieldName that no longer matches any candidate so the
    // user sees what they have rather than a silent empty selection. Skip
    // when columns haven't loaded yet (cold-load flicker guard).
    const staleFilenameValue =
      selectedTable && config.filenameFieldName &&
      !filenameCandidates.some(c => c.name === config.filenameFieldName)
        ? config.filenameFieldName
        : null;
    new Setting(containerEl)
      .setName('Filename field')
      .setDesc(`Column whose value becomes the note filename. Filtered to: ${safeTypesList}.`)
      .addDropdown(dropdown => {
        dropdown.addOption('', '-- Select filename column --');
        for (const c of filenameCandidates) dropdown.addOption(c.name, c.name);
        if (staleFilenameValue) {
          dropdown.addOption(staleFilenameValue, `${staleFilenameValue} (unsupported / hidden)`);
        }
        dropdown.setValue(config.filenameFieldName);
        dropdown.setDisabled(!selectedTable);
        dropdown.onChange(async (value) => {
          config.filenameFieldName = value;
          await this.plugin.saveSettings();
        });
      });

    // Subfolder accepts the broader `isSubfolderSafe` set (date / formula /
    // multi-select / etc.) since sanitizeSubfolderValue normalizes path-unsafe
    // characters. Excludes attachment/link/unknown types whose stringified
    // shape is garbage. Filename remains stricter (OS filename rules). #98.
    const subfolderSafeTypes = new Set(mapper.getSubfolderSafeTypes());
    const subfolderCandidates = (selectedTable?.columns ?? []).filter(c => subfolderSafeTypes.has(c.type));
    // Skip stale-value surface when columns haven't loaded (cold-load flicker
    // guard) — wait until selectedTable resolves before judging "stale".
    const staleSubfolderValue =
      selectedTable && config.subfolderFieldName &&
      !subfolderCandidates.some(c => c.name === config.subfolderFieldName)
        ? config.subfolderFieldName
        : null;
    new Setting(containerEl)
      .setName('Subfolder field (optional)')
      .setDesc('Column used for subfolder organization. Leave empty for a flat layout.')
      .addDropdown(dropdown => {
        dropdown.addOption('', '-- No subfolder column --');
        for (const c of subfolderCandidates) dropdown.addOption(c.name, c.name);
        // Stale value surface: stored selection no longer matches any column —
        // expose explicitly so the user sees what they have.
        if (staleSubfolderValue) {
          dropdown.addOption(staleSubfolderValue, `${staleSubfolderValue} (unsupported / hidden)`);
        }
        dropdown.setValue(config.subfolderFieldName);
        dropdown.setDisabled(!selectedTable);
        dropdown.onChange(async (value) => {
          config.subfolderFieldName = value;
          await this.plugin.saveSettings();
        });
      });

    this.renderSubfolderSlashToggle(containerEl, config);
  }

  /**
   * Manual ID/name text inputs — used while the SeaTable API token is
   * unset, or as a fallback when metadata fetch fails (network down,
   * token revoked, server unreachable). The user can still wire up
   * the config by typing IDs from the SeaTable web UI directly.
   */
  private renderSeaTableTextFallback(containerEl: HTMLElement, config: ConfigEntry): void {
    containerEl.createEl('p', {
      cls: 'ani-credential-desc',
      text: 'Enter SeaTable IDs manually. Once an API token is saved and reachable, this card will switch to dropdowns automatically.',
    });

    new Setting(containerEl)
      .setName('Table ID')
      .setDesc('Required. The SeaTable table identifier (e.g. 0000).')
      .addText(text => text
        .setPlaceholder('0000')
        .setValue(config.tableId)
        .onChange(async (value) => {
          config.tableId = value.trim();
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('View ID (optional)')
      .setDesc('Filter synced rows by a SeaTable view. Leave empty to sync the entire table.')
      .addText(text => text
        .setPlaceholder('0000')
        .setValue(config.viewId)
        .onChange(async (value) => {
          config.viewId = value.trim();
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('Filename field')
      .setDesc('Column name whose value becomes the note filename.')
      .addText(text => text
        .setPlaceholder('column name (e.g. Name)')
        .setValue(config.filenameFieldName)
        .onChange(async (value) => {
          config.filenameFieldName = value.trim();
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('Subfolder field (optional)')
      .setDesc('Column name used for subfolder organization.')
      .addText(text => text
        .setPlaceholder('column name')
        .setValue(config.subfolderFieldName)
        .onChange(async (value) => {
          config.subfolderFieldName = value.trim();
          await this.plugin.saveSettings();
        }));

    this.renderSubfolderSlashToggle(containerEl, config);
  }

  // ─── Supabase Connection ───────────────────────────────────────────

  private async renderSupabaseConnection(
    containerEl: HTMLElement,
    config: ConfigEntry,
    credential: SupabaseCredential,
  ): Promise<void> {
    // Symmetric with SeaTable's renderSeaTableConnection — bail early if the
    // mapper isn't registered so the dropdown render path can use
    // getFieldTypeMapper safely below.
    if (!hasFieldTypeMapper(credential.type)) {
      new Setting(containerEl)
        .setName('Field type mapper missing')
        .setDesc(`No field type mapper registered for ${credential.type}.`);
      return;
    }

    // Read defaults at render time; do NOT persist 'public' as a side effect of
    // rendering. The schema input's onChange handler is the only place that
    // writes baseId — opening the settings tab is read-only.
    const schema = (config.baseId?.trim() || SUPABASE_DEFAULT_SCHEMA);

    if (!credential.apiKey?.trim() || !credential.projectUrl?.trim()) {
      this.renderSupabaseTextFallback(containerEl, config);
      return;
    }

    containerEl.empty();
    containerEl.createEl('p', {
      cls: 'ani-credential-desc',
      text: 'Loading Supabase schema…',
    });

    // Capture the current render generation so a subsequent display() (tab
    // switch, cred edit) can mark our callback as stale and skip populating
    // a now-detached containerEl. Same guard SeaTable uses (line ~843).
    const gen = this.renderGeneration;
    try {
      const spec = await this.supabaseMetadataCache.getSpec(credential, schema);
      if (this.renderGeneration !== gen) return;
      this.renderSupabaseDropdowns(containerEl, config, credential, spec);
    } catch (error) {
      if (this.renderGeneration !== gen) return;
      // The RPC-missing case has its own banner with one-time setup SQL; every
      // other failure (network, project URL typo, etc.) falls through to the
      // generic text-input fallback with a Notice.
      if (error instanceof SupabaseSchemaRpcMissingError) {
        this.renderSupabaseRpcSetupBanner(containerEl, config, credential);
        return;
      }
      const message = error instanceof Error ? error.message : 'Check API key or network.';
      new Notice(`Auto Note Importer: Failed to load Supabase schema. ${message}`);
      this.renderSupabaseTextFallback(containerEl, config);
    }
  }

  /**
   * Renders the shared parts of the RPC setup banner — SQL code block,
   * Copy SQL button, and "I've run it — Verify" button — into the given
   * host. Callers wrap this with banner-specific header/desc/manual-
   * fallback content. The two callbacks decide what happens after the
   * Verify RPC call returns; both connection-card and credential-form
   * contexts share the SQL block + buttons but diverge in post-verify
   * action.
   *
   * The verify path always bypasses the cache (clearForCred) before
   * calling verifySetup — the user just ran the SQL, so the previous
   * 404 is stale by definition.
   */
  private renderRpcSetupBannerCore(
    host: HTMLElement,
    credential: SupabaseCredential,
    onVerifySuccess: () => void,
    onVerifyFailure: (error: string) => void,
  ): void {
    const codeBlock = host.createEl('pre', { cls: 'ani-rpc-setup-sql' });
    codeBlock.createEl('code', { text: SUPABASE_RPC_SCHEMA_SQL });

    const buttonRow = host.createDiv({ cls: 'ani-rpc-setup-actions' });

    const copyBtn = buttonRow.createEl('button', { text: 'Copy SQL', cls: 'mod-cta' });
    copyBtn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(SUPABASE_RPC_SCHEMA_SQL);
        new Notice('Auto Note Importer: SQL copied to clipboard.');
      } catch {
        new Notice('Auto Note Importer: Could not access clipboard — select + copy the SQL block manually.');
      }
    });

    const verifyBtn = buttonRow.createEl('button', { text: 'I’ve run it — Verify' });
    verifyBtn.addEventListener('click', async () => {
      verifyBtn.disabled = true;
      const originalText = verifyBtn.textContent;
      verifyBtn.textContent = 'Verifying…';
      try {
        this.supabaseMetadataCache.clearForCred(credential.id);
        const renderer = getCredentialFormRenderer('supabase');
        if (!renderer.verifySetup) {
          onVerifyFailure('Supabase provider does not implement verifySetup — please report this as a bug.');
          return;
        }
        const result = await renderer.verifySetup(credential);
        if (result.success && !result.needsSetup) {
          onVerifySuccess();
        } else if (result.success && result.needsSetup) {
          onVerifyFailure('RPC still not installed. Common issues: SQL ran in the wrong schema (try \'public\'); missing GRANT EXECUTE — re-run the SQL fully; different project — verify the Project URL matches.');
        } else if (!result.success) {
          onVerifyFailure(result.error);
        }
      } finally {
        verifyBtn.disabled = false;
        // `textContent` is `string | null`; restore the literal default
        // if the original was somehow null (e.g. detached node) so the
        // button never goes blank (claude #1, PR #92).
        verifyBtn.textContent = originalText ?? 'I’ve run it — Verify';
      }
    });
  }

  /**
   * Credential-form variant of the RPC setup banner. Unlike the
   * connection-card variant, this one does NOT include the manual-entry
   * text fallback (the credential is still being authored — no config
   * exists yet). On verify success the caller's onSuccess fires
   * (which calls clearFormSetupRequirement → removes the host); on
   * verify failure the error is surfaced inline inside the banner.
   *
   * Returns void — the caller already holds the host from
   * `ensureFormBannerHost`. Removing that host wipes the inner banner +
   * buttons + error in one DOM op (claude bot round 2 PR #92 review:
   * the prior `return host` was redundant API surface noise).
   */
  private renderRpcSetupBannerInForm(
    host: HTMLElement,
    credential: SupabaseCredential,
    onSuccess: () => void,
  ): void {
    host.empty();
    const banner = host.createDiv({ cls: 'ani-rpc-setup-banner' });
    banner.createEl('h4', { text: 'One-time setup required for publishable keys' });
    banner.createEl('p').setText(
      'Supabase’s new key system blocks publishable keys from reading the ' +
      'OpenAPI schema. Run this SQL once in your Supabase SQL Editor — it ' +
      'creates a SECURITY DEFINER function the plugin uses for schema introspection.',
    );

    const errorHost = banner.createDiv({ cls: 'ani-rpc-setup-error' });

    this.renderRpcSetupBannerCore(
      banner,
      credential,
      () => {
        new Notice('Auto Note Importer: Setup confirmed — you can save now.');
        onSuccess();   // clearFormSetupRequirement removes the host (covers banner)
      },
      (error) => {
        errorHost.empty();
        errorHost.createEl('p', { cls: 'ani-rpc-setup-error-msg', text: `⚠ ${error}` });
      },
    );
  }

  /**
   * Returns (creating if needed) the dedicated banner host inside the
   * credential form. Reusing one host means consecutive Test/Save
   * cycles replace the previous banner instead of stacking.
   */
  private ensureFormBannerHost(formHostEl: HTMLElement): HTMLElement {
    let host = formHostEl.querySelector<HTMLElement>(':scope > .ani-rpc-setup-host');
    if (!host) {
      host = formHostEl.createDiv({ cls: 'ani-rpc-setup-host' });
    }
    return host;
  }

  /**
   * Runs all pending cleanups (e.g. removeEventListener handles) and
   * drops the credential form UI state. Called from display() and
   * before initializing a fresh form via resetCredentialFormUi() so
   * type-switches in the add-mode form do not leak listeners.
   */
  private tearDownCredentialFormUi(): void {
    if (!this.credentialFormUi) return;
    for (const cleanup of this.credentialFormUi.cleanups) {
      try { cleanup(); } catch { /* listener removal must not throw */ }
    }
    this.credentialFormUi = null;
  }

  /**
   * Tears down any prior form state then initializes a fresh
   * CredentialFormUiState. Both renderCredentialEditRow and
   * renderCredentialAddDetails call this at their entry point.
   */
  private resetCredentialFormUi(): void {
    this.tearDownCredentialFormUi();
    this.credentialFormUi = {
      setupRequirement: null,
      bannerHost: null,
      saveButton: null,
      testButton: null,
      isTesting: false,
      isSaving: false,
      cleanups: [],
    };
  }

  /**
   * Renders the inline RPC setup banner for the given requirement and
   * wires it to the form-scoped UI state (setupRequirement + bannerHost
   * + saveButton.disabled). Uses an exhaustive switch on
   * SetupRequirement.kind so future widening of the union fails at
   * compile time until a handler is added.
   *
   * Callers must already have decided to suppress the usual success
   * Notice / return blocked from the gate — see runConnectionTest and
   * verifyCredentialBeforeSave for the surrounding flow.
   */
  private renderSetupBannerForRequirement(
    needsSetup: SetupRequirement,
    credential: Credential,
    formHostEl: HTMLElement,
  ): void {
    switch (needsSetup.kind) {
      case 'supabase-rpc': {
        if (credential.type !== 'supabase') {
          // Shouldn't happen — registry only maps supabase-rpc to
          // Supabase. Surface as an internal error rather than silently
          // skipping the banner.
          new Notice(`Auto Note Importer: Internal error — supabase-rpc setup requested for ${credential.type} credential.`);
          return;
        }
        const host = this.ensureFormBannerHost(formHostEl);
        this.renderRpcSetupBannerInForm(
          host,
          credential,
          () => this.clearFormSetupRequirement(),
        );
        if (this.credentialFormUi) {
          this.credentialFormUi.setupRequirement = needsSetup;
          this.credentialFormUi.bannerHost = host;
          if (this.credentialFormUi.saveButton) {
            this.credentialFormUi.saveButton.disabled = true;
          }
        }
        return;
      }
      default: {
        const _exhaustive: never = needsSetup.kind;
        throw new Error(`Unhandled setup requirement kind: ${String(_exhaustive)}`);
      }
    }
  }

  /**
   * Pre-save gate. Calls verifySetup on the credential and returns
   * - 'proceed' if the credential is ready to persist
   * - 'blocked' if needsSetup or verify failure — the banner / Notice
   *   has been surfaced and the caller MUST NOT persist.
   *
   * Fails closed: any network failure during verify blocks the save
   * with a Notice. Silently saving a credential that cannot sync is
   * worse than a one-extra-click retry.
   */
  private async verifyCredentialBeforeSave(
    renderer: CredentialFormRenderer,
    credential: Credential,
    formHostEl: HTMLElement,
  ): Promise<'proceed' | 'blocked'> {
    if (!renderer.verifySetup) return 'proceed';
    if (this.credentialFormUi?.isSaving) return 'blocked';   // re-entry guard
    if (this.credentialFormUi) this.credentialFormUi.isSaving = true;

    // Visual loading state on the Save button — symmetric with the
    // Test button pattern in runConnectionTest (claude bot round 2
    // PR #92 review). verifySetup is a 2-step network probe and can
    // take 1-3s; silent re-entry drops with no UI feedback would
    // confuse users.
    const saveBtn = this.credentialFormUi?.saveButton ?? null;
    const originalSaveText = saveBtn?.textContent ?? null;
    if (saveBtn) {
      saveBtn.disabled = true;
      saveBtn.textContent = 'Saving…';
    }

    try {
      const result = await renderer.verifySetup(credential);
      if (!result.success) {
        new Notice(`Auto Note Importer: Could not verify setup before save — ${result.error}`);
        return 'blocked';
      }
      if (result.needsSetup) {
        this.renderSetupBannerForRequirement(result.needsSetup, credential, formHostEl);
        return 'blocked';
      }
      // Save-time verify can also clear a stale banner — e.g. user
      // installed the RPC externally then clicked Save without Verify
      // first (Codex P2, PR #92).
      if (this.credentialFormUi?.setupRequirement) {
        this.clearFormSetupRequirement();
      }
      return 'proceed';
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      new Notice(`Auto Note Importer: Could not verify setup before save — ${message}`);
      return 'blocked';
    } finally {
      if (this.credentialFormUi) this.credentialFormUi.isSaving = false;
      if (saveBtn) {
        // Only restore disabled=false if the banner didn't take over the
        // disable state. renderSetupBannerForRequirement sets
        // saveButton.disabled=true when needsSetup is rendered — we must
        // not clobber that here.
        if (!this.credentialFormUi?.setupRequirement) {
          saveBtn.disabled = false;
        }
        saveBtn.textContent = originalSaveText ?? 'Save';
      }
    }
  }

  /**
   * Clears the form-scoped setup requirement: removes the banner from
   * the DOM and re-enables Save. Called when the user verifies setup
   * successfully or edits a credential field (Task 9 auto-reset).
   */
  private clearFormSetupRequirement(): void {
    if (!this.credentialFormUi) return;
    this.credentialFormUi.setupRequirement = null;
    this.credentialFormUi.bannerHost?.remove();
    this.credentialFormUi.bannerHost = null;
    if (this.credentialFormUi.saveButton) {
      this.credentialFormUi.saveButton.disabled = false;
    }
  }

  /**
   * Rendered when the publishable key can read /rest/v1/<table> for data but
   * cannot read /rest/v1/ for schema introspection (Supabase new key policy)
   * AND the user has not yet installed the SECURITY DEFINER RPC fallback.
   *
   * Shows the one-time setup SQL with a Copy button + a Verify action via
   * the shared renderRpcSetupBannerCore. On verify success the cache is
   * cleared and the settings tab re-renders so the card flips to
   * renderSupabaseDropdowns automatically. Includes a manual-entry text
   * fallback for users who want to keep the publishable key without
   * installing the RPC.
   */
  private renderSupabaseRpcSetupBanner(
    containerEl: HTMLElement,
    config: ConfigEntry,
    credential: SupabaseCredential,
  ): void {
    containerEl.empty();
    const banner = containerEl.createDiv({ cls: 'ani-rpc-setup-banner' });
    banner.createEl('h4', { text: 'One-time setup required for publishable keys' });
    banner.createEl('p').setText(
      'Supabase’s new key system blocks publishable keys from reading the ' +
      'OpenAPI schema. Run this SQL once in your Supabase SQL Editor — it ' +
      'creates a SECURITY DEFINER function the plugin uses for schema introspection.',
    );

    this.renderRpcSetupBannerCore(
      banner,
      credential,
      () => {
        // Connection-card success: re-render so the card flips back to
        // dropdowns (verifySetup already cleared the cache).
        this.debounceDisplay(0);
      },
      (error) => {
        new Notice(`Auto Note Importer: ${error}`);
      },
    );

    // Manual-entry escape hatch — render into a fresh sub-container so the
    // fallback's containerEl.empty() can't wipe the banner above it.
    banner.createEl('p', { cls: 'ani-credential-desc' })
      .setText('Or enter table/column names manually below:');
    const fallbackHost = banner.createDiv({ cls: 'ani-rpc-setup-fallback' });
    this.renderSupabaseTextFallback(fallbackHost, config);
  }

  // STUBS - filled in by T22 and T23
  private renderSupabaseDropdowns(
    containerEl: HTMLElement,
    config: ConfigEntry,
    credential: SupabaseCredential,
    spec: SupabaseOpenApiSpec,
  ): void {
    const mapper = getFieldTypeMapper(credential.type);
    containerEl.empty();
    containerEl.createEl('p', {
      cls: 'ani-credential-desc',
      text: 'Pick the schema, table, view, and columns to sync. Dropdowns are populated from your Supabase OpenAPI spec.',
    });

    const tables = this.supabaseMetadataCache.getTables(spec);
    const views = this.supabaseMetadataCache.getViews(spec);

    // Schema (text input + Refresh)
    new Setting(containerEl)
      .setName('Schema')
      .setDesc('PostgreSQL schema name. Default is "public".')
      .addText(text => text
        .setValue(config.baseId || SUPABASE_DEFAULT_SCHEMA)
        .setPlaceholder(SUPABASE_DEFAULT_SCHEMA)
        .onChange(async value => {
          const trimmed = value.trim() || SUPABASE_DEFAULT_SCHEMA;
          if (trimmed === config.baseId) return;
          config.baseId = trimmed;
          config.tableId = '';
          config.viewId = '';
          config.primaryKeyColumn = '';
          config.filenameFieldName = '';
          config.subfolderFieldName = '';
          await this.plugin.saveSettings();
          this.supabaseMetadataCache.clearForCred(credential.id);
          this.debounceDisplay();
        }))
      .addExtraButton(button => this.configureRefreshButton(button, 'Refresh schema', () => {
        this.supabaseMetadataCache.clearForCred(credential.id);
      }));

    // Table dropdown
    const selectedTable = tables.find(t => t.name === config.tableId);
    new Setting(containerEl)
      .setName('Table')
      .setDesc('Required. PostgreSQL table to sync.')
      .addDropdown(dropdown => {
        dropdown.addOption('', '-- Select table --');
        for (const t of tables) dropdown.addOption(t.name, t.name);
        dropdown.setValue(config.tableId);
        dropdown.onChange(async value => {
          config.tableId = value;
          config.viewId = '';
          config.filenameFieldName = '';
          config.subfolderFieldName = '';
          config.primaryKeyColumn = this.supabaseMetadataCache.detectPrimaryKey(spec, value) ?? '';
          await this.plugin.saveSettings();
          this.debounceDisplay();
        });
      });

    // View dropdown (optional)
    new Setting(containerEl)
      .setName('View (optional)')
      .setDesc('Filter synced rows by a PostgreSQL view. Leave empty to sync the entire table.')
      .addDropdown(dropdown => {
        dropdown.addOption('', '-- All rows (no view filter) --');
        for (const v of views) dropdown.addOption(v.name, v.name);
        dropdown.setValue(config.viewId);
        dropdown.setDisabled(!selectedTable);
        dropdown.onChange(async value => {
          config.viewId = value;
          await this.plugin.saveSettings();
        });
      });

    // Primary key (text input, auto-filled + editable)
    new Setting(containerEl)
      .setName('Primary key column')
      .setDesc('Auto-detected from OpenAPI. Override for views or non-standard names. Single column only — composite primary keys are not supported for sync (pick one unique column).')
      .addText(text => text
        .setValue(config.primaryKeyColumn || '')
        .setPlaceholder('id')
        .onChange(async value => {
          config.primaryKeyColumn = value.trim();
          await this.plugin.saveSettings();
        }));

    // Filename / Subfolder field dropdowns
    const activeEndpoint = config.viewId || config.tableId;
    const columns = activeEndpoint ? this.supabaseMetadataCache.getColumns(spec, activeEndpoint) : [];
    const safeTypes = new Set(mapper.getFilenameSafeTypes());
    const filenameCandidates = columns.filter(c => safeTypes.has(c.providerType));
    const safeTypesList = mapper.getFilenameSafeTypes().join(', ');
    // Stale-value surface — only when columns have actually loaded.
    const staleFilenameValue =
      columns.length > 0 && config.filenameFieldName &&
      !filenameCandidates.some(c => c.name === config.filenameFieldName)
        ? config.filenameFieldName
        : null;

    new Setting(containerEl)
      .setName('Filename field')
      .setDesc(`Column whose value becomes the note filename. Filtered to: ${safeTypesList}.`)
      .addDropdown(dropdown => {
        dropdown.addOption('', '-- Select filename column --');
        for (const c of filenameCandidates) dropdown.addOption(c.name, c.name);
        if (staleFilenameValue) {
          dropdown.addOption(staleFilenameValue, `${staleFilenameValue} (unsupported / hidden)`);
        }
        dropdown.setValue(config.filenameFieldName);
        dropdown.setDisabled(columns.length === 0);
        dropdown.onChange(async value => {
          config.filenameFieldName = value;
          await this.plugin.saveSettings();
        });
      });

    // Subfolder filter: broader than filename (issue #98). Excludes
    // unknown-to-mapper types fail-closed (e.g. bytea / unrecognized
    // PostgREST formats).
    const subfolderSafeTypes = new Set(mapper.getSubfolderSafeTypes());
    const subfolderCandidates = columns.filter(c => subfolderSafeTypes.has(c.providerType));
    const staleSubfolderValue =
      columns.length > 0 && config.subfolderFieldName &&
      !subfolderCandidates.some(c => c.name === config.subfolderFieldName)
        ? config.subfolderFieldName
        : null;
    new Setting(containerEl)
      .setName('Subfolder field (optional)')
      .setDesc('Column used for subfolder organization. Leave empty for flat layout.')
      .addDropdown(dropdown => {
        dropdown.addOption('', '-- No subfolder column --');
        for (const c of subfolderCandidates) dropdown.addOption(c.name, c.name);
        if (staleSubfolderValue) {
          dropdown.addOption(staleSubfolderValue, `${staleSubfolderValue} (unsupported / hidden)`);
        }
        dropdown.setValue(config.subfolderFieldName);
        dropdown.setDisabled(columns.length === 0);
        dropdown.onChange(async value => {
          config.subfolderFieldName = value;
          await this.plugin.saveSettings();
        });
      });

    this.renderSubfolderSlashToggle(containerEl, config);
  }

  private renderSupabaseTextFallback(containerEl: HTMLElement, config: ConfigEntry): void {
    containerEl.empty();
    containerEl.createEl('p', {
      cls: 'ani-credential-desc',
      text: 'Enter Supabase config manually. Once an API key + project URL are saved and reachable, this card switches to dropdowns automatically.',
    });

    // Debounced save to avoid disk write + provider reconfigure on every
    // keystroke (fallback path is a raw text input — no dropdown coalescing).
    const debouncedSave = this.makeFieldDebouncer();

    new Setting(containerEl)
      .setName('Schema')
      .setDesc('PostgreSQL schema name. Default "public".')
      .addText(text => text
        .setValue(config.baseId || SUPABASE_DEFAULT_SCHEMA)
        .setPlaceholder(SUPABASE_DEFAULT_SCHEMA)
        .onChange(value => {
          const trimmed = value.trim() || SUPABASE_DEFAULT_SCHEMA;
          if (trimmed === config.baseId) return;
          // Schema change invalidates every dependent selection — same
          // cascade reset as the dropdown path so a half-switched config
          // can't target the wrong table under the new schema.
          config.baseId = trimmed;
          config.tableId = '';
          config.viewId = '';
          config.primaryKeyColumn = '';
          config.filenameFieldName = '';
          config.subfolderFieldName = '';
          debouncedSave();
        }));

    new Setting(containerEl)
      .setName('Table')
      .setDesc('Required. PostgreSQL table name.')
      .addText(text => text
        .setValue(config.tableId)
        .setPlaceholder('notes')
        .onChange(value => {
          config.tableId = value.trim();
          debouncedSave();
        }));

    new Setting(containerEl)
      .setName('View (optional)')
      .setDesc('PostgreSQL view to sync. Leave empty for the full table.')
      .addText(text => text
        .setValue(config.viewId)
        .setPlaceholder('active_notes')
        .onChange(value => {
          config.viewId = value.trim();
          debouncedSave();
        }));

    new Setting(containerEl)
      .setName('Primary key column')
      .setDesc('Required for updates. e.g. "id" or "uuid". Single column only — composite PKs not supported.')
      .addText(text => text
        .setValue(config.primaryKeyColumn || '')
        .setPlaceholder('id')
        .onChange(value => {
          config.primaryKeyColumn = value.trim();
          debouncedSave();
        }));

    new Setting(containerEl)
      .setName('Filename field')
      .setDesc('Column whose value becomes the note filename.')
      .addText(text => text
        .setValue(config.filenameFieldName)
        .setPlaceholder('title')
        .onChange(value => {
          config.filenameFieldName = value.trim();
          debouncedSave();
        }));

    new Setting(containerEl)
      .setName('Subfolder field (optional)')
      .setDesc('Column used for subfolder organization. Leave empty for flat layout.')
      .addText(text => text
        .setValue(config.subfolderFieldName)
        .setPlaceholder('category')
        .onChange(value => {
          config.subfolderFieldName = value.trim();
          debouncedSave();
        }));

    this.renderSubfolderSlashToggle(containerEl, config);
  }

  private renderBaseSelector(containerEl: HTMLElement, config: ConfigEntry, credential: AirtableCredential): void {
    new Setting(containerEl)
      .setName("Select base")
      .setDesc("Choose the Airtable base you want to import notes from.")
      .addDropdown(async dropdown => {
        try {
          dropdown.addOption("", "-- Select base. --");
          const bases = await this.fieldCache.fetchBases(credential.apiKey);
          for (const base of bases) {
            dropdown.addOption(base.id, base.name);
          }
          dropdown.setValue(config.baseId);
          dropdown.onChange(async (value) => {
            config.baseId = value;
            config.tableId = "";
            config.viewId = "";
            await this.plugin.saveSettings();
            this.debounceDisplay();
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Check PAT or network.';
          new Notice(`Auto Note Importer: Failed to fetch Airtable bases. ${message}`);
        }
      })
      .addExtraButton(button => this.configureRefreshButton(button, "Refresh base list", () => {
        this.fieldCache.clearBases();
      }));

    if (config.baseId) {
      this.renderTableSelector(containerEl, config, credential);
    }
  }

  private renderTableSelector(containerEl: HTMLElement, config: ConfigEntry, credential: AirtableCredential): void {
    new Setting(containerEl)
      .setName("Select table")
      .setDesc("Choose the specific table within the selected base.")
      .addDropdown(async dropdown => {
        try {
          dropdown.addOption("", "-- Select table --");
          const tables = await this.fieldCache.fetchTables(
            credential.apiKey,
            config.baseId
          );
          for (const table of tables) {
            dropdown.addOption(table.id, table.name);
          }
          dropdown.setValue(config.tableId);
          dropdown.onChange(async (value) => {
            config.tableId = value;
            config.viewId = "";
            await this.plugin.saveSettings();
            this.debounceDisplay();
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Check base ID or network.';
          new Notice(`Auto Note Importer: Failed to fetch Airtable tables. ${message}`);
        }
      })
      .addExtraButton(button => this.configureRefreshButton(button, "Refresh table list", () => {
        this.fieldCache.clearTables(config.baseId);
      }));

    if (config.tableId) {
      this.renderViewSelector(containerEl, config, credential);
      this.renderFieldSelectors(containerEl, config, credential);
    }
  }

  private renderViewSelector(containerEl: HTMLElement, config: ConfigEntry, credential: AirtableCredential): void {
    new Setting(containerEl)
      .setName("Select view (optional)")
      .setDesc("Filter synced records by an Airtable view. Leave empty to sync all records.")
      .addDropdown(async dropdown => {
        try {
          dropdown.addOption("", "-- All records (no view filter) --");
          const views = await this.fieldCache.fetchViews(
            credential.apiKey,
            config.baseId,
            config.tableId
          );
          for (const view of views) {
            dropdown.addOption(view.id, `${view.name} (${view.type})`);
          }
          dropdown.setValue(config.viewId);
          dropdown.onChange(async (value) => {
            config.viewId = value;
            await this.plugin.saveSettings();
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Check table ID or network.';
          new Notice(`Auto Note Importer: Failed to fetch views. ${message}`);
        }
      })
      .addExtraButton(button => this.configureRefreshButton(button, "Refresh view list", () => {
        this.fieldCache.clearViews(config.baseId, config.tableId);
      }));
  }

  private renderFieldSelectors(containerEl: HTMLElement, config: ConfigEntry, credential: AirtableCredential): void {
    this.renderFieldDropdown(containerEl, "Filename field", "Select the field to use for the note's filename.", "-- Select field --",
      config.filenameFieldName, (value) => { config.filenameFieldName = value; }, config, credential, 'filename');

    this.renderFieldDropdown(containerEl, "Subfolder field", "Select the field to use for subfolder organization.", "-- No subfolder --",
      config.subfolderFieldName, (value) => { config.subfolderFieldName = value; }, config, credential, 'subfolder');

    this.renderSubfolderSlashToggle(containerEl, config);
  }

  private renderFieldDropdown(
    containerEl: HTMLElement,
    name: string,
    desc: string,
    placeholder: string,
    currentValue: string,
    onSelect: (value: string) => void,
    config: ConfigEntry,
    credential: AirtableCredential,
    // Filter policy: 'filename' uses isFilenameSafe (strict — OS filename
    // rules); 'subfolder' uses isSubfolderSafe (broader — sanitize handles
    // path-unsafe chars). Both fail-closed on unknown types. Issue #98.
    filterMode: 'filename' | 'subfolder'
  ): void {
    if (!hasFieldTypeMapper(credential.type)) {
      new Setting(containerEl)
        .setName(name)
        .setDesc(`No field type mapper registered for ${credential.type}.`);
      return;
    }
    const mapper = getFieldTypeMapper(credential.type);

    // Capture renderGeneration so a subsequent display() invocation can
    // invalidate this still-resolving async callback. Same guard SeaTable
    // and Supabase use for their async metadata fetches.
    const gen = this.renderGeneration;
    new Setting(containerEl)
      .setName(name)
      .setDesc(desc)
      .addDropdown(async dropdown => {
        try {
          dropdown.addOption("", placeholder);
          const fields = await this.fieldCache.fetchFields(
            credential.apiKey,
            config.baseId,
            config.tableId
          );
          if (this.renderGeneration !== gen) return;

          let supportedFields: typeof fields;
          switch (filterMode) {
            case 'filename':
              supportedFields = fields.filter(field => mapper.isFilenameSafe(field.type));
              break;
            case 'subfolder':
              supportedFields = fields.filter(field => mapper.isSubfolderSafe(field.type));
              break;
            default: {
              // Fail-closed exhaustiveness guard. The `never` assertion is a
              // compile-time signal; the runtime fallback empties the option
              // set so a future filterMode union extension can't silently
              // surface attachment/link types.
              const _exhaustive: never = filterMode;
              void _exhaustive;
              supportedFields = [];
            }
          }
          // Stale-value detection: the stored field isn't visible in the
          // filtered set (renamed, type became unrecognized, etc.). We
          // surface it as a synthetic '(unsupported / hidden)' entry AND
          // exclude it from the "N hidden" count below — otherwise the
          // single stale field would be both visible inline AND counted
          // in the trailing banner ("1 hidden") which is contradictory.
          const isStale = currentValue && !supportedFields.some(f => f.name === currentValue);
          const fieldInCurrentBatch = currentValue && fields.some(f => f.name === currentValue);
          const unsupportedCount =
            fields.length - supportedFields.length - (isStale && fieldInCurrentBatch ? 1 : 0);

          for (const field of supportedFields) {
            dropdown.addOption(field.name, `${field.name} (${field.type})`);
          }

          if (isStale) {
            dropdown.addOption(currentValue, `${currentValue} (unsupported / hidden)`);
          }

          if (unsupportedCount > 0) {
            // 'excluded' covers both reasons: filename rules are stricter
            // than what stringifies, subfolder rules drop attachment/link
            // and object-shaped types. 'unrecognized' was misleading
            // because attachment columns ARE recognized — just excluded.
            dropdown.addOption("", `--- ${unsupportedCount} excluded field${unsupportedCount > 1 ? 's' : ''} hidden ---`);
          }

          dropdown.setValue(currentValue);
          dropdown.onChange(async (value) => {
            onSelect(value);
            await this.plugin.saveSettings();
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Check table ID or network.';
          new Notice(`Auto Note Importer: Failed to fetch table fields. ${message}`);
        }
      })
      .addExtraButton(button => this.configureRefreshButton(button, "Refresh field list", () => {
        this.fieldCache.clearFields(config.baseId, config.tableId);
      }));
  }

  private renderBasesSettings(containerEl: HTMLElement, config: ConfigEntry): void {
    new Setting(containerEl)
      .setName('Auto-generate Bases database file')
      .setDesc('Create a .base file after sync for table/card view in Obsidian Bases.')
      .addToggle(toggle => toggle
        .setValue(config.generateBasesFile)
        .onChange(async (value) => {
          config.generateBasesFile = value;
          await this.plugin.saveSettings();
          this.debounceDisplay();
        }));

    if (config.generateBasesFile) {
      new Setting(containerEl)
        .setName('Database file location')
        .setDesc('Where to create the .base file.')
        .addDropdown(dropdown => dropdown
          .addOption('vault-root', 'Vault root')
          .addOption('synced-folder', 'Inside synced folder')
          .addOption('custom', 'Custom path')
          .setValue(config.basesFileLocation)
          .onChange(async (value) => {
            config.basesFileLocation = value as BasesFileLocation;
            await this.plugin.saveSettings();
            this.debounceDisplay();
          }));

      if (config.basesFileLocation === 'custom') {
        new Setting(containerEl)
          .setName('Custom path')
          .setDesc('Folder path for the .base file. Leave empty to use vault root.')
          .addText(text => {
            const input = text
              .setPlaceholder('Bases')
              .setValue(config.basesCustomPath)
              .onChange(async (value) => {
                config.basesCustomPath = value;
                await this.plugin.saveSettings();
              });
            new FolderSuggest(this.app, input.inputEl as HTMLInputElement);
          });
      }

      new Setting(containerEl)
        .setName('Regenerate on each sync')
        .setDesc('Recreate .base file on every sync. Disable to preserve manual edits.')
        .addToggle(toggle => toggle
          .setValue(config.basesRegenerateOnSync)
          .onChange(async (value) => {
            config.basesRegenerateOnSync = value;
            await this.plugin.saveSettings();
          }));
    }
  }

  private renderBidirectionalSyncSettings(containerEl: HTMLElement, config: ConfigEntry): void {
    const cred = this.plugin.settings.credentials.find(c => c.id === config.credentialId);
    const providerLabel = cred ? CREDENTIAL_TYPE_LABELS[cred.type] : 'the remote database';
    new Setting(containerEl)
      .setName("Enable bidirectional sync")
      .setDesc(`When enabled, changes made in Obsidian will be synced back to ${providerLabel}.`)
      .addToggle(toggle => toggle
        .setValue(config.bidirectionalSync)
        .onChange(async (value) => {
          config.bidirectionalSync = value;
          await this.plugin.saveSettings();
          this.debounceDisplay();
        }));

    if (config.bidirectionalSync) {
      new Setting(containerEl)
        .setName("Conflict resolution")
        .setDesc("How to handle conflicts when the same field is modified in both places.")
        .addDropdown(dropdown => dropdown
          .addOption('manual', 'Manual resolution (show conflicts)')
          .addOption('obsidian-wins', 'Obsidian wins (overwrite remote)')
          .addOption('remote-wins', 'Remote wins (overwrite Obsidian)')
          .setValue(config.conflictResolution)
          .onChange(async (value) => {
            config.conflictResolution = value as ConflictResolutionMode;
            await this.plugin.saveSettings();
          }));

      new Setting(containerEl)
        .setName("Watch for file changes")
        .setDesc("Automatically detect and sync changes made to notes in Obsidian.")
        .addToggle(toggle => toggle
          .setValue(config.watchForChanges)
          .onChange(async (value) => {
            config.watchForChanges = value;
            await this.plugin.saveSettings();
            this.debounceDisplay();
          }));

      if (config.watchForChanges) {
        this.renderNumberSetting(containerEl, "File watch debounce (milliseconds)",
          "How long to wait after a file change before triggering sync.", "2000",
          config.fileWatchDebounce, "Debounce time",
          (num) => { config.fileWatchDebounce = num; }, undefined, "500");
      }

      new Setting(containerEl)
        .setName("Auto-sync server-computed fields")
        .setDesc("Automatically fetch fields the remote computes server-side (formulas, lookups, rollups, generated columns) after each sync.")
        .addToggle(toggle => toggle
          .setValue(config.autoSyncComputedFields)
          .onChange(async (value) => {
            config.autoSyncComputedFields = value;
            await this.plugin.saveSettings();
            this.debounceDisplay();
          }));

      if (config.autoSyncComputedFields) {
        this.renderNumberSetting(containerEl, "Computed-field sync delay (milliseconds)",
          "How long to wait for the remote to compute fields before fetching.", "1500",
          config.formulaSyncDelay, "Computed-field sync delay",
          (num) => { config.formulaSyncDelay = num; }, undefined, "100");
      }
    }
  }

  /**
   * Provider-agnostic toggle that controls how `/` in a subfolder field value
   * is interpreted: as a nested-folder separator (default) or as a literal
   * character collapsed to `-`. Shown beneath every "Subfolder field" picker
   * across Airtable / SeaTable / Supabase cards and their text fallbacks.
   * See issue #96.
   */
  private renderSubfolderSlashToggle(containerEl: HTMLElement, config: ConfigEntry): void {
    new Setting(containerEl)
      .setName('Treat / as literal in subfolder values')
      .setDesc("When on, '/' is replaced with '-' instead of nesting subfolders.")
      .addToggle(toggle => toggle
        // Defensive `?? false`: legacy v3 configs persisted before this field
        // existed arrive as `undefined` until hydrateConfigDefaults runs at
        // load time. Belt-and-suspenders for any synthetic call path that
        // bypasses load (tests, plugin reloads after partial writes).
        .setValue(config.subfolderTreatSlashAsLiteral ?? false)
        .onChange(async value => {
          config.subfolderTreatSlashAsLiteral = value;
          await this.plugin.saveSettings();
        }));
  }

  private renderNumberSetting(
    containerEl: HTMLElement,
    name: string,
    desc: string,
    placeholder: string,
    currentValue: number,
    label: string,
    onSet: (num: number) => void,
    postSave?: () => void,
    step?: string
  ): void {
    new Setting(containerEl)
      .setName(name)
      .setDesc(desc)
      .addText(text => {
        const input = text
          .setPlaceholder(placeholder)
          .setValue(currentValue.toString())
          .onChange(async (value) => {
            const num = Number(value);
            if (Number.isNaN(num) || num < 0) {
              new Notice(`Auto Note Importer: ${label} must be a positive number.`);
              return;
            }
            onSet(num);
            await this.plugin.saveSettings();
            postSave?.();
          });
        const el = input.inputEl as HTMLInputElement;
        el.type = "number";
        el.min = "0";
        if (step) el.step = step;
      });
  }

  private renderDebugSettings(containerEl: HTMLElement): void {
    const section = containerEl.createDiv({ cls: 'ani-debug-section' });

    new Setting(section).setName('Debug').setHeading();

    new Setting(section)
      .setName("Debug mode (slow sync)")
      .setDesc("Slows down all sync operations by 5x for easier testing and observation.")
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.debugMode)
        .onChange(async (value) => {
          this.plugin.settings.debugMode = value;
          await this.plugin.saveSettings();
        }));
  }
}
