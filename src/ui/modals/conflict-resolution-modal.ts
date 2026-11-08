/**
 * Modal listing queued sync conflicts (grouped by config → note) and
 * applying the chosen resolution per field (spec §4).
 *
 * Remote values are untrusted: they are only ever rendered as text
 * (`createEl` / `setText`), never as HTML.
 */

import { Modal, Notice } from 'obsidian';
import type { App } from 'obsidian';
import type { PendingConflict } from '../../types';
import type { ApplyResult, ConflictChoice } from '../../core/conflict-applier';
import { formatObjectLabel } from '../../utils';

/** Pending conflicts of one config, as the modal shows them. */
export interface ConflictGroup {
  configId: string;
  configName: string;
  providerLabel: string;
  bidirectional: boolean;
  conflicts: PendingConflict[];
}

/** What the modal needs from the plugin. */
export interface ConflictModalHost {
  /** Current pending conflicts of active configs (read fresh on every render). */
  getGroups(): ConflictGroup[];
  apply(configId: string, choices: Array<{ conflict: PendingConflict; choice: ConflictChoice }>): Promise<ApplyResult>;
}

type ConflictKey = string;

function keyOf(configId: string, c: PendingConflict): ConflictKey {
  return JSON.stringify([configId, c.recordId, c.field]);
}

/** A conflict as the modal rendered it (the values the user is choosing between). */
export interface RenderedConflict {
  configId: string;
  conflict: PendingConflict;
}

/**
 * Apply list per config from the rendered rows and their choices. Uses the
 * rendered conflict objects, so the applier's stale check compares against the
 * values the user saw — not ones a later sync re-queued while the modal was open.
 * Rows no longer in `pendingKeys` were settled meanwhile and are skipped (the
 * stale path would otherwise re-queue them).
 */
export function buildApplyList(
  rendered: Map<string, RenderedConflict>,
  choices: Map<string, ConflictChoice>,
  pendingKeys: Set<string>,
): Map<string, Array<{ conflict: PendingConflict; choice: ConflictChoice }>> {
  const byConfig = new Map<string, Array<{ conflict: PendingConflict; choice: ConflictChoice }>>();
  for (const [key, { configId, conflict }] of rendered) {
    if (!pendingKeys.has(key)) continue;
    const choice = choices.get(key) ?? 'later';
    if (choice === 'later') continue;
    const list = byConfig.get(configId) ?? [];
    list.push({ conflict, choice });
    byConfig.set(configId, list);
  }
  return byConfig;
}

/**
 * Choices a row offers: "Use Obsidian" needs a writable field and bidirectional
 * sync. Without it, "Keep local" (pin the value so pulls stop overwriting it)
 * is the only way to keep a local edit.
 */
export function offeredChoices(c: PendingConflict, bidirectional: boolean): ConflictChoice[] {
  if (c.writable && bidirectional) return ['later', 'obsidian', 'remote'];
  return ['later', 'remote', 'keep-local'];
}

/**
 * "Set all to": sets `choice` on every row that offers it; rows that don't
 * (e.g. Obsidian on a non-writable field) keep their own choice.
 */
export function applySetAll(
  rows: Array<{ key: string; offered: ConflictChoice[] }>,
  choice: ConflictChoice,
  choices: Map<string, ConflictChoice>,
): void {
  for (const { key, offered } of rows) {
    if (offered.includes(choice)) choices.set(key, choice);
  }
}

/** Plain-text rendering of a field value. */
function formatValue(value: unknown): string {
  if (value === undefined || value === null || value === '') return '(empty)';
  if (Array.isArray(value)) {
    return value
      .map(item => (typeof item === 'object' && item !== null ? formatObjectLabel(item) : String(item)))
      .join(', ');
  }
  if (typeof value === 'object') return formatObjectLabel(value);
  return String(value);
}

export class ConflictResolutionModal extends Modal {
  /** Entries this modal shows; `null` = every pending conflict. */
  private keys: Set<ConflictKey> | null;
  private choices = new Map<ConflictKey, ConflictChoice>();
  /** Rows of the current render; Apply sends these, never fresh store entries. */
  private rendered = new Map<ConflictKey, RenderedConflict>();
  /** Choice dropdown per rendered row (for "Set all to"). */
  private selects = new Map<ConflictKey, HTMLSelectElement>();
  private errors = new Map<ConflictKey, string>();
  private applying = false;

  constructor(
    app: App,
    private host: ConflictModalHost,
    only?: Array<{ configId: string; conflict: PendingConflict }>,
    private onClosed?: () => void,
  ) {
    super(app);
    this.keys = only ? new Set(only.map(e => keyOf(e.configId, e.conflict))) : null;
  }

  /** Widens an open modal to more entries (or to all pending), keeping choices made so far. */
  show(only?: Array<{ configId: string; conflict: PendingConflict }>): void {
    if (!only) this.keys = null;
    else if (this.keys) for (const e of only) this.keys.add(keyOf(e.configId, e.conflict));
    if (!this.applying) this.render();
  }

  onOpen(): void {
    this.titleEl.setText('Resolve sync conflicts');
    this.render();
  }

  onClose(): void {
    this.contentEl.empty();
    this.onClosed?.();
  }

  /** Visible groups: fresh store values, restricted to this modal's entries. */
  private visibleGroups(): ConflictGroup[] {
    return this.host.getGroups()
      .map(g => ({
        ...g,
        conflicts: g.conflicts.filter(c => this.keys === null || this.keys.has(keyOf(g.configId, c))),
      }))
      .filter(g => g.conflicts.length > 0);
  }

  private render(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('ani-conflict-modal');
    this.rendered.clear();
    this.selects.clear();

    const groups = this.visibleGroups();
    if (groups.length === 0) {
      contentEl.createEl('p', { cls: 'ani-conflict-empty', text: 'No sync conflicts to resolve.' });
      this.renderButtons(false);
      return;
    }

    contentEl.createEl('p', {
      cls: 'ani-conflict-desc',
      text: 'These fields changed in both places since the last sync. Choose which value to keep; "Later" leaves a field queued.',
    });

    for (const group of groups) {
      const groupEl = contentEl.createDiv({ cls: 'ani-conflict-group' });
      groupEl.createEl('h3', { cls: 'ani-conflict-config', text: `${group.configName} (${group.providerLabel})` });
      this.renderSetAll(groupEl, group);

      const byNote = new Map<string, PendingConflict[]>();
      for (const c of group.conflicts) {
        const list = byNote.get(c.filePath) ?? [];
        list.push(c);
        byNote.set(c.filePath, list);
      }

      for (const [filePath, conflicts] of byNote) {
        const noteEl = groupEl.createDiv({ cls: 'ani-conflict-note' });
        noteEl.createDiv({ cls: 'ani-conflict-note-path', text: filePath });
        for (const c of conflicts) this.renderField(noteEl, group, c);
      }
    }

    this.renderButtons(true);
  }

  private renderField(parent: HTMLElement, group: ConflictGroup, c: PendingConflict): void {
    const key = keyOf(group.configId, c);
    this.rendered.set(key, { configId: group.configId, conflict: c });
    const row = parent.createDiv({ cls: 'ani-conflict-field' });

    const header = row.createDiv({ cls: 'ani-conflict-field-header' });
    header.createSpan({ cls: 'ani-conflict-field-name', text: c.field });
    if (!c.writable) header.createSpan({ cls: 'ani-conflict-badge', text: 'Not synced to remote' });
    if (c.stale) header.createSpan({ cls: 'ani-conflict-badge ani-conflict-badge-warn', text: 'Changed since detected' });

    const values = row.createDiv({ cls: 'ani-conflict-values' });
    const addValue = (label: string, value: unknown): void => {
      const cell = values.createDiv({ cls: 'ani-conflict-value' });
      cell.createDiv({ cls: 'ani-conflict-value-label', text: label });
      cell.createDiv({ cls: 'ani-conflict-value-text', text: formatValue(value) });
    };
    addValue('Obsidian', c.local);
    addValue(group.providerLabel, c.remote);
    addValue('Previous sync', c.snapshot ? c.snapshot.local : undefined);

    const select = row.createEl('select', { cls: 'dropdown ani-conflict-choice' });
    const offered = offeredChoices(c, group.bidirectional);
    const optionText: Record<ConflictChoice, string> = {
      later: 'Later',
      obsidian: 'Use Obsidian',
      remote: c.writable ? `Use ${group.providerLabel}` : `Restore ${group.providerLabel} value`,
      'keep-local': 'Keep local (not synced)',
    };
    for (const value of offered) select.createEl('option', { value, text: optionText[value] });
    this.selects.set(key, select);
    // Keep a choice made before a re-render if this row still offers it.
    const previous = this.choices.get(key);
    const initial: ConflictChoice = previous && offered.includes(previous) ? previous : 'later';
    select.value = initial;
    this.choices.set(key, initial);
    select.addEventListener('change', () => {
      this.choices.set(key, select.value as ConflictChoice);
    });

    const error = this.errors.get(key);
    if (error) row.createDiv({ cls: 'ani-conflict-error', text: error });
  }

  /** "Set all to: Obsidian / {provider} / Later" for one config group. */
  private renderSetAll(parent: HTMLElement, group: ConflictGroup): void {
    const rows = group.conflicts.map(c => ({ key: keyOf(group.configId, c), offered: offeredChoices(c, group.bidirectional) }));
    const bar = parent.createDiv({ cls: 'ani-conflict-set-all' });
    bar.createSpan({ cls: 'ani-conflict-set-all-label', text: 'Set all to:' });
    const addButton = (choice: ConflictChoice, text: string): void => {
      const button = bar.createEl('button', { text });
      button.addEventListener('click', () => {
        applySetAll(rows, choice, this.choices);
        for (const { key } of rows) {
          const select = this.selects.get(key);
          const value = this.choices.get(key);
          if (select && value) select.value = value;
        }
      });
    };
    if (rows.some(r => r.offered.includes('obsidian'))) addButton('obsidian', 'Obsidian');
    addButton('remote', group.providerLabel);
    addButton('later', 'Later');
  }

  private renderButtons(canApply: boolean): void {
    const bar = this.contentEl.createDiv({ cls: 'ani-conflict-buttons' });
    if (canApply) {
      const apply = bar.createEl('button', { cls: 'mod-cta', text: 'Apply' });
      apply.addEventListener('click', () => {
        void this.applyChoices(apply);
      });
    }
    const close = bar.createEl('button', { text: 'Close' });
    close.addEventListener('click', () => this.close());
  }

  private async applyChoices(button: HTMLButtonElement): Promise<void> {
    if (this.applying) return;

    const pendingKeys = new Set(this.host.getGroups().flatMap(g => g.conflicts.map(c => keyOf(g.configId, c))));
    const byConfig = buildApplyList(this.rendered, this.choices, pendingKeys);
    if (byConfig.size === 0) {
      const chosen = [...this.rendered.keys()].some(k => (this.choices.get(k) ?? 'later') !== 'later');
      if (chosen) {
        new Notice('Auto Note Importer: The chosen conflicts were already settled by a sync.');
        if (this.visibleGroups().length === 0) this.close();
        else this.render();
      } else {
        new Notice('Auto Note Importer: No resolution chosen. Pick a value for a field, or close to resolve later.');
      }
      return;
    }

    this.applying = true;
    button.disabled = true;
    let applied = 0;
    let stale = 0;
    let failed = 0;
    this.errors.clear();
    // Applied entries leave the queue; stale / failed ones are reviewed afresh.
    this.choices.clear();
    try {
      for (const [configId, choices] of byConfig) {
        let result: ApplyResult;
        try {
          result = await this.host.apply(configId, choices);
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Unknown error';
          result = { applied: 0, stale: [], removed: [], failed: choices.map(({ conflict }) => ({ conflict, error: message })) };
        }
        applied += result.applied;
        stale += result.stale.length;
        failed += result.failed.length;
        for (const f of result.failed) this.errors.set(keyOf(configId, f.conflict), f.error);
      }
    } finally {
      this.applying = false;
    }

    const parts = [`${applied} applied`];
    if (stale > 0) parts.push(`${stale} changed since detected (review again)`);
    if (failed > 0) parts.push(`${failed} failed`);
    new Notice(`Auto Note Importer: Sync conflicts: ${parts.join(', ')}`);

    // Stay open while anything this modal shows is still pending.
    if (this.visibleGroups().length === 0) this.close();
    else this.render();
  }
}
