/**
 * Settings tab UI for the Auto Note Importer plugin.
 * UI-only - delegates API calls to FieldCache.
 *
 * Multi-config UI with credential management, tab-based config switching,
 * and per-config settings rendering.
 *
 * @handbook 5.1-ui-components
 * @tested e2e:tests/e2e/run-settings-e2e.mjs
 */

import { App, PluginSettingTab, Setting, Notice, setIcon } from "obsidian";
import type { ExtraButtonComponent, Plugin } from "obsidian";
import { FieldCache } from '../services';
import { isFieldTypeSupported } from '../constants';
import type { AutoNoteImporterSettings, ConfigEntry, Credential, AirtableCredential, CredentialType, ConflictResolutionMode, BasesFileLocation } from '../types';
import { DEFAULT_CONFIG_ENTRY, CREDENTIAL_TYPES, CREDENTIAL_TYPE_LABELS } from '../types';
import { FolderSuggest, FileSuggest } from './suggest';
import { generateId } from '../utils/object-utils';
import { validateFolderPath } from '../utils/validation';

/**
 * Interface for the plugin that the settings tab needs.
 */
export interface SettingsPlugin extends Plugin {
  settings: AutoNoteImporterSettings;
  saveSettings(): Promise<void>;
}

/**
 * Settings tab for the Auto Note Importer plugin.
 */
export class AutoNoteImporterSettingTab extends PluginSettingTab {
  plugin: SettingsPlugin;
  private fieldCache: FieldCache;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private editingCredentialId: string | null = null;
  private addingCredential = false;
  private addingCredentialType: CredentialType = 'airtable';
  private expandedSections: Set<string> = new Set(['airtable-connection']);
  private pendingDeleteConfigId: string | null = null;
  private pendingDeleteCredentialId: string | null = null;

  constructor(app: App, plugin: SettingsPlugin, fieldCache: FieldCache) {
    super(app, plugin);
    this.plugin = plugin;
    this.fieldCache = fieldCache;
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

    const connected = !!(config.baseId && config.tableId);
    if (credential.type === 'airtable' && credential.apiKey) {
      const airtableCred = credential;
      this.renderSummaryCard(cardStack, {
        sectionId: 'airtable-connection', icon: '\u{1F4E1}', title: 'Airtable Connection',
        summary: this.getConnectionSummary(config),
        badge: connected ? { status: 'ok', text: 'Connected' } : { status: 'off', text: 'Setup required' },
        renderContent: (c) => this.renderBaseSelector(c, config, airtableCred),
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
    if (cred.type === 'airtable') {
      if (cred.apiKey) {
        keyCell.createSpan({ cls: 'ani-cred-key', text: this.maskApiKey(cred.apiKey) });
      } else {
        const setLink = keyCell.createSpan({ cls: 'ani-cred-key-set', text: 'Set API key' });
        setLink.addEventListener('click', () => {
          this.editingCredentialId = cred.id;
          this.display();
        });
      }
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
    if (cred.type !== 'airtable') {
      new Setting(containerEl)
        .setName('Edit not supported')
        .setDesc(`Editing ${cred.type} credentials is not yet supported.`);
      return;
    }
    let nameValue = cred.name;
    let keyValue = cred.apiKey;

    const nameSetting = new Setting(containerEl)
      .setName('Name')
      .addText(text => text
        .setValue(cred.name)
        .setPlaceholder('Credential name')
        .onChange(value => { nameValue = value; }));
    nameSetting.settingEl.addClass('ani-credential-edit');

    const keySetting = new Setting(containerEl)
      .setName('API Key')
      .addText(text => {
        text
          .setValue(cred.apiKey)
          .setPlaceholder('pat-xxx...')
          .onChange(value => { keyValue = value; });
        text.inputEl.type = 'password';
      });
    keySetting.settingEl.addClass('ani-credential-edit');

    new Setting(containerEl)
      .addButton(button => button
        .setButtonText('Save')
        .setCta()
        .onClick(async () => {
          if (!nameValue.trim()) {
            new Notice('Auto Note Importer: Credential name cannot be empty.');
            return;
          }
          cred.name = nameValue.trim();
          cred.apiKey = keyValue;
          await this.plugin.saveSettings();
          this.editingCredentialId = null;
          this.display();
        }))
      .addButton(button => button
        .setButtonText('Cancel')
        .onClick(() => {
          this.editingCredentialId = null;
          this.display();
        }));
  }

  private renderCredentialAddRow(containerEl: HTMLElement): void {
    // Name + Type persist across detail re-renders; key is type-specific
    // and held in the same closure so it survives dropdown switches.
    const state = { name: '', key: '' };

    const nameSetting = new Setting(containerEl)
      .setName('Name')
      .addText(text => text
        .setPlaceholder('e.g. Personal Airtable')
        .onChange(value => { state.name = value; }));
    nameSetting.settingEl.addClass('ani-credential-edit');

    const typeSetting = new Setting(containerEl).setName('Type');
    typeSetting.settingEl.addClass('ani-credential-edit');

    const detailEl = containerEl.createDiv({ cls: 'ani-credential-add-details' });
    const renderDetails = () => {
      detailEl.empty();
      this.renderCredentialAddDetails(detailEl, state);
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
    state: { name: string; key: string },
  ): void {
    const type = this.addingCredentialType;
    const isAirtable = type === 'airtable';

    if (isAirtable) {
      const keySetting = new Setting(containerEl)
        .setName('API Key')
        .addText(text => {
          text
            .setValue(state.key)
            .setPlaceholder('pat-xxx...')
            .onChange(value => { state.key = value; });
          text.inputEl.type = 'password';
        });
      keySetting.settingEl.addClass('ani-credential-edit');
    } else {
      const noticeSetting = new Setting(containerEl)
        .setName('Not yet supported')
        .setDesc(`${CREDENTIAL_TYPE_LABELS[type]} provider will be available in a future release.`);
      noticeSetting.settingEl.addClass('ani-credential-edit');
    }

    new Setting(containerEl)
      .addButton(button => {
        button
          .setButtonText('Save')
          .setCta()
          .setDisabled(!isAirtable)
          .onClick(async () => {
            if (!isAirtable) return;
            if (!state.name.trim()) {
              new Notice('Auto Note Importer: Credential name cannot be empty.');
              return;
            }
            if (!state.key.trim()) {
              new Notice('Auto Note Importer: API key cannot be empty.');
              return;
            }
            this.plugin.settings.credentials.push({
              id: generateId(),
              name: state.name.trim(),
              type: 'airtable',
              apiKey: state.key.trim(),
            });
            await this.plugin.saveSettings();
            this.addingCredential = false;
            this.addingCredentialType = 'airtable';
            this.display();
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
      .setDesc('Select the Airtable credential to use for this configuration.')
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
    if (!config.baseId || !config.tableId) return '';
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
      config.filenameFieldName, (value) => { config.filenameFieldName = value; }, config, credential);

    this.renderFieldDropdown(containerEl, "Subfolder field", "Select the field to use for subfolder organization.", "-- No subfolder --",
      config.subfolderFieldName, (value) => { config.subfolderFieldName = value; }, config, credential);
  }

  private renderFieldDropdown(
    containerEl: HTMLElement,
    name: string,
    desc: string,
    placeholder: string,
    currentValue: string,
    onSelect: (value: string) => void,
    config: ConfigEntry,
    credential: AirtableCredential
  ): void {
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

          const supportedFields = fields.filter(field => isFieldTypeSupported(field.type));
          const unsupportedCount = fields.length - supportedFields.length;

          for (const field of supportedFields) {
            dropdown.addOption(field.name, `${field.name} (${field.type})`);
          }

          if (unsupportedCount > 0) {
            dropdown.addOption("", `--- ${unsupportedCount} unsupported field${unsupportedCount > 1 ? 's' : ''} hidden ---`);
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
    new Setting(containerEl)
      .setName("Enable bidirectional sync")
      .setDesc("When enabled, changes made in Obsidian will be synced back to Airtable.")
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
          .addOption('obsidian-wins', 'Obsidian wins (overwrite Airtable)')
          .addOption('airtable-wins', 'Airtable wins (overwrite Obsidian)')
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
        .setName("Auto-sync formulas and relations")
        .setDesc("Automatically fetch computed formula and relation results after syncing.")
        .addToggle(toggle => toggle
          .setValue(config.autoSyncFormulas)
          .onChange(async (value) => {
            config.autoSyncFormulas = value;
            await this.plugin.saveSettings();
            this.debounceDisplay();
          }));

      if (config.autoSyncFormulas) {
        this.renderNumberSetting(containerEl, "Formula sync delay (milliseconds)",
          "How long to wait for Airtable to compute formulas before fetching.", "1500",
          config.formulaSyncDelay, "Formula sync delay",
          (num) => { config.formulaSyncDelay = num; }, undefined, "100");
      }
    }
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
