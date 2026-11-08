/**
 * Sync Orchestrator - Coordinates sync operations between a DatabaseProvider and Obsidian.
 *
 * Extracted from main.ts to separate sync orchestration from plugin lifecycle management.
 * User-facing labels (status bar, Notice) derive the provider name from
 * `provider.providerType` so the same orchestrator works for any provider.
 *
 * @handbook 4.2-sync-architecture
 * @handbook 4.4-provider-abstraction
 * @handbook 5.3-statusbar-abstraction
 * @handbook 9.1-sync-flow
 * @tested tests/core/sync-orchestrator.test.ts
 * @tested e2e:tests/e2e/run-e2e.mjs
 * @tested e2e:tests/e2e/run-seatable-e2e.mjs
 * @tested e2e:tests/e2e/run-supabase-e2e.mjs
 * @tested e2e:tests/e2e/run-notion-e2e.mjs
 */

import { App, TFile, TFolder, normalizePath, Notice, MarkdownView } from "obsidian";
import type { LegacySettings, RemoteNote, BatchUpdate, SyncMode, SyncScope, NoteCreationResult, DatabaseProvider, RemoteFieldInfo, SyncRunResult, SyncTrigger, PendingConflict, FieldSnapshot } from '../types';
import { CREDENTIAL_TYPE_LABELS } from '../types';
import { DEBUG_DELAY_MULTIPLIER, isSystemField } from '../constants';
import { FieldCache } from '../services';
import { planPush } from './conflict-resolver';
import type { PushPlan } from './conflict-resolver';
import { threeWayMerge } from './three-way-merge';
import type { FieldVerdict } from './three-way-merge';
import type { ConfigSyncStateHandle } from './sync-state-store';
import { FrontmatterParser, FileWatcher } from '../file-operations';
import { parseTemplate, buildMarkdownContent, generateBasesContent, resolveBasesFilePath, collectFieldNames } from '../builders';
import { sanitizeFileName, sanitizeSubfolderValue, validateAndSanitizeFilename, assertNever, areValuesEqual } from '../utils';

export interface StatusBarHandle {
  setText(text: string): void;
  remove(): void;
}

export interface StatusBarController {
  createItem(): StatusBarHandle;
}

/** One note judged for push: everything needed to record the outcome. */
interface JudgedPush {
  recordId: string;
  filePath: string;
  local: Record<string, unknown>;
  remote: Record<string, unknown>;
  snapshot: Record<string, FieldSnapshot> | undefined;
  verdicts: Record<string, FieldVerdict>;
  plan: PushPlan;
}

export class SyncOrchestrator {
  private app: App;
  private settings: LegacySettings;
  private provider: DatabaseProvider;
  private fieldCache: FieldCache;
  private frontmatterParser: FrontmatterParser;
  private fileWatcher: FileWatcher;
  private syncState: ConfigSyncStateHandle;
  private statusBar: StatusBarController;

  constructor(
    app: App,
    settings: LegacySettings,
    provider: DatabaseProvider,
    fieldCache: FieldCache,
    frontmatterParser: FrontmatterParser,
    fileWatcher: FileWatcher,
    syncState: ConfigSyncStateHandle,
    statusBar: StatusBarController
  ) {
    this.app = app;
    this.settings = settings;
    this.provider = provider;
    this.fieldCache = fieldCache;
    this.frontmatterParser = frontmatterParser;
    this.fileWatcher = fileWatcher;
    this.syncState = syncState;
    this.statusBar = statusBar;
  }

  updateSettings(settings: LegacySettings): void {
    this.settings = settings;
  }

  /** Display name of the linked provider (Airtable / SeaTable / …) for user-facing strings. */
  private get providerLabel(): string {
    return CREDENTIAL_TYPE_LABELS[this.provider.providerType];
  }

  /**
   * Runs one sync. `trigger` is accepted for the conflict-modal flow and not
   * acted on yet. Pull phases report no conflicts until pull judgement lands.
   */
  async processSyncRequest(
    mode: SyncMode,
    scope: SyncScope,
    filePaths?: string[],
    trigger?: SyncTrigger,
  ): Promise<SyncRunResult> {
    const statusBarItem = this.statusBar.createItem();
    const label = this.providerLabel;
    let newConflicts: PendingConflict[] = [];

    try {
      switch (mode) {
        case 'pull':
          if (scope === 'current') {
            statusBarItem.setText(`Syncing current note from ${label}...`);
            await this.pullCurrent();
          } else {
            statusBarItem.setText(`Syncing from ${label}...`);
            await this.pullAll();
          }
          break;

        case 'push':
        case 'bidirectional': {
          const files = filePaths
            ? filePaths.map(p => this.app.vault.getAbstractFileByPath(p)).filter((f): f is TFile => f instanceof TFile)
            : await this.getFilesToSync(scope);

          if (files.length === 0) {
            new Notice(`Auto Note Importer: No files to sync for scope: ${scope}`);
            return { newConflicts };
          }

          if (mode === 'push') {
            statusBarItem.setText(`Syncing ${files.length} file(s) to ${label}...`);
            newConflicts = await this.pushFiles(files);
            new Notice(`Auto Note Importer: Synced ${files.length} file(s) to ${label}`);
          } else {
            statusBarItem.setText(`Phase 1/2 - Syncing ${files.length} file(s) to ${label}...`);
            newConflicts = await this.pushFiles(files);

            if (this.settings.autoSyncComputedFields) {
              const delay = this.settings.debugMode
                ? this.settings.formulaSyncDelay * DEBUG_DELAY_MULTIPLIER
                : this.settings.formulaSyncDelay;
              statusBarItem.setText(`Waiting ${delay}ms for formulas...`);
              await this.sleep(delay);

              statusBarItem.setText("Phase 2/2 - Fetching computed results...");
              await this.pullAll();
              new Notice("Auto Note Importer: Bidirectional sync complete!");
            } else {
              // Bases file is not generated here because pullAll() is skipped,
              // so no remoteNotes are available to derive column definitions from.
              new Notice(`Auto Note Importer: Synced ${files.length} file(s) to ${label}`);
            }
          }
          break;
        }

        default:
          assertNever(mode, 'Unknown sync mode');
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      new Notice(`Auto Note Importer: Sync failed: ${message}`);
    } finally {
      statusBarItem.remove();
    }
    return { newConflicts };
  }

  private async getFilesToSync(scope: SyncScope): Promise<TFile[]> {
    const folderPath = normalizePath(this.settings.folderPath);

    switch (scope) {
      case 'current': {
        const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (!activeView?.file) {
          throw new Error("No active markdown file");
        }
        if (!activeView.file.path.startsWith(folderPath + '/')) {
          throw new Error("Current file is not in the sync folder");
        }
        return [activeView.file];
      }

      case 'modified': {
        return this.fileWatcher.getPendingFiles();
      }

      case 'all': {
        const folder = this.app.vault.getAbstractFileByPath(folderPath);
        if (!(folder instanceof TFolder)) {
          throw new Error("Sync folder not found");
        }
        return this.collectMarkdownFiles(folder);
      }

      default:
        return assertNever(scope, 'Unknown sync scope');
    }
  }

  private collectMarkdownFiles(folder: TFolder): TFile[] {
    const files: TFile[] = [];
    for (const child of folder.children) {
      if (child instanceof TFile && child.extension === 'md') {
        files.push(child);
      } else if (child instanceof TFolder) {
        files.push(...this.collectMarkdownFiles(child));
      }
    }
    return files;
  }

  private async pullCurrent(): Promise<void> {
    const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!activeView?.file) {
      new Notice("Auto Note Importer: No active markdown file");
      return;
    }

    const file = activeView.file;
    const folderPath = normalizePath(this.settings.folderPath);
    if (!file.path.startsWith(folderPath + '/')) {
      new Notice("Auto Note Importer: Current file is not in the sync folder");
      return;
    }

    const recordId = this.frontmatterParser.getRecordId(file);
    if (!recordId) {
      new Notice("Auto Note Importer: No primaryField found in current file");
      return;
    }

    const label = this.providerLabel;
    this.fileWatcher.setSyncing(true);
    try {
      const remoteNote = await this.provider.fetchRecord(recordId);
      if (!remoteNote) {
        new Notice(`Auto Note Importer: Record not found in ${label}`);
        return;
      }

      const result = await this.createNoteFromRemote(remoteNote);
      if (result === "updated") {
        new Notice(`Auto Note Importer: Current note updated from ${label}`);
      } else if (result === "skipped") {
        new Notice("Auto Note Importer: No changes detected");
      }
    } finally {
      this.fileWatcher.clearPending();
      this.fileWatcher.setSyncing(false);
    }
  }

  private async pullAll(): Promise<void> {
    const folderPath = normalizePath(this.settings.folderPath);
    if (!await this.app.vault.adapter.exists(folderPath)) {
      await this.app.vault.createFolder(folderPath);
    }

    this.fileWatcher.setSyncing(true);
    try {
      const remoteNotes = await this.provider.fetchNotes();

      let existingPrimaryFields: Set<string> | null = null;
      if (!this.settings.allowOverwrite) {
        existingPrimaryFields = await this.frontmatterParser.loadExistingPrimaryFields(folderPath);
      }

      let createdCount = 0;
      let updatedCount = 0;
      let skippedCount = 0;
      let errorCount = 0;

      for (const note of remoteNotes) {
        const shouldProcess = this.settings.allowOverwrite ||
          !existingPrimaryFields?.has(note.primaryField);

        if (shouldProcess) {
          const result = await this.createNoteFromRemote(note);
          if (result === "created") createdCount++;
          else if (result === "updated") updatedCount++;
          else if (result === "error") errorCount++;
        } else {
          skippedCount++;
        }
      }

      let summary = `Auto Note Importer: Sync complete: ${createdCount} created, ${updatedCount} updated.`;
      if (skippedCount > 0) summary += ` (${skippedCount} skipped)`;
      if (errorCount > 0) summary += ` (${errorCount} errors)`;
      new Notice(summary);

      await this.generateBasesFileIfNeeded(remoteNotes);
    } finally {
      this.fileWatcher.clearPending();
      this.fileWatcher.setSyncing(false);
    }
  }

  private async createNoteFromRemote(note: RemoteNote): Promise<NoteCreationResult> {
    const safeTitle = this.determineFilename(note);
    const finalFolderPath = this.determineFolderPath(note);
    const folderPath = normalizePath(finalFolderPath);

    if (!await this.app.vault.adapter.exists(folderPath)) {
      await this.app.vault.createFolder(folderPath);
    }

    const filePath = normalizePath(`${folderPath}/${safeTitle}.md`);
    const existingFile = this.app.vault.getAbstractFileByPath(filePath);

    if (existingFile instanceof TFile && !this.settings.allowOverwrite) {
      return "skipped";
    }

    if (this.settings.syncPageBody && this.provider.capabilities.bodySync && this.provider.fetchBody) {
      try {
        const body = await this.provider.fetchBody(note.id);
        if (body !== null) note.body = body;
      } catch (error) {
        if (this.settings.debugMode) {
          const message = error instanceof Error ? error.message : 'Unknown error';
          new Notice(`Auto Note Importer: Body fetch failed for ${safeTitle}: ${message}`);
        }
      }
    }

    let content = await this.buildNoteContent(note);
    content = this.frontmatterParser.ensurePrimaryField(content, note.primaryField);

    try {
      if (existingFile instanceof TFile) {
        const currentContent = await this.app.vault.read(existingFile);
        if (currentContent !== content) {
          await this.app.vault.modify(existingFile, content);
          return "updated";
        }
        return "skipped";
      } else {
        await this.app.vault.create(filePath, content);
        return "created";
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      new Notice(`Auto Note Importer: Failed to save note: ${safeTitle}${this.settings.debugMode ? ` (${message})` : ''}`);
      return "error";
    }
  }

  private determineFilename(note: RemoteNote): string {
    if (!this.settings.filenameFieldName ||
        !Object.prototype.hasOwnProperty.call(note.fields, this.settings.filenameFieldName)) {
      return note.primaryField;
    }

    const rawValue = note.fields[this.settings.filenameFieldName];

    // Remote APIs either omit an empty field or send it as null — treat both
    // the same. Without this, String(null) === 'null' slips past the
    // primaryField fallback below and every empty-name record overwrites a
    // single null.md (#134). Plain objects and arrays of objects get the same
    // treatment as the subfolder path (#98): String() yields '[object Object]',
    // which collides just the same. Empty strings and empty arrays don't need
    // this guard — String() gives '' for both, so the sanitizeFileName(...)
    // || primaryField fallback at the end already catches them.
    if (rawValue == null || String(rawValue).startsWith('[object ')) {
      return note.primaryField;
    }

    try {
      const cacheKey = this.fieldCache.getCacheKey(this.settings.baseId, this.settings.tableId);
      const fieldInfo = this.fieldCache.getField(cacheKey, this.settings.filenameFieldName);

      if (fieldInfo?.type === 'formula') {
        const validated = validateAndSanitizeFilename(rawValue);
        if (validated) return validated;
        new Notice(`Auto Note Importer: Invalid filename from Formula field. Using record ID.`);
        return note.primaryField;
      }
    } catch (error) {
      if (this.settings.debugMode) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        new Notice(`Auto Note Importer: Filename field error: ${message}`);
      }
    }

    return sanitizeFileName(String(rawValue)) || note.primaryField;
  }

  private determineFolderPath(note: RemoteNote): string {
    if (!this.settings.subfolderFieldName) {
      return this.settings.folderPath;
    }

    const subfolderValue = note.fields[this.settings.subfolderFieldName];
    if (subfolderValue == null) {
      return this.settings.folderPath;
    }

    // Defense-in-depth: if the column's API value is a plain object or array
    // of objects (e.g. Airtable collaborator, SeaTable geolocation, Supabase
    // jsonb), String(...) yields '[object Object]' garbage. The settings UI
    // filters these types out, but a legacy config from before #98 may still
    // reference one — fall back to flat layout instead of bucketing every
    // record under a literal '[object Object]' folder.
    const rawString = String(subfolderValue).trim();
    if (rawString.startsWith('[object ')) {
      if (this.settings.debugMode) {
        new Notice(`Auto Note Importer: Subfolder field '${this.settings.subfolderFieldName}' returned a non-string value; using flat layout.`);
      }
      return this.settings.folderPath;
    }

    const sanitized = sanitizeSubfolderValue(
      rawString,
      this.settings.subfolderTreatSlashAsLiteral,
    );
    if (!sanitized) {
      return this.settings.folderPath;
    }

    return `${this.settings.folderPath}/${sanitized}`;
  }

  private async buildNoteContent(note: RemoteNote): Promise<string> {
    if (this.settings.templatePath) {
      const templateFile = this.app.vault.getAbstractFileByPath(
        normalizePath(this.settings.templatePath)
      );
      if (templateFile instanceof TFile) {
        try {
          const templateContent = await this.app.vault.read(templateFile);
          return parseTemplate(templateContent, note);
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Unknown error';
          new Notice(`Auto Note Importer: Template error: ${message}. Using default format.`);
        }
      }
    }
    return buildMarkdownContent(note);
  }

  /**
   * Pushes local edits, judging every field three-way against the sync
   * snapshot (snapshot vs local frontmatter vs freshly fetched remote) and
   * letting `planPush` decide per conflict mode what is sent. Only records
   * whose push succeeds get their snapshot advanced. Returns the conflicts
   * queued for manual resolution in this run.
   */
  private async pushFiles(files: TFile[]): Promise<PendingConflict[]> {
    // Provider-agnostic: each provider serves its own cached metadata and
    // fails open with null (#124). The defensive catch is belt-and-suspenders —
    // the contract already forbids rejection.
    let remoteFields: RemoteFieldInfo[] | null = null;
    try {
      remoteFields = await this.provider.fetchFieldMetadata();
    } catch {
      remoteFields = null;
    }
    const metadata = remoteFields ? new Map(remoteFields.map(f => [f.name, f])) : null;
    // Without metadata every judged field is writable (fail-open, handbook §4.4).
    const writable = (field: string): boolean => {
      if (!metadata) return true;
      const info = metadata.get(field);
      return info !== undefined && this.provider.fieldTypeMapper.isPushable(info.type);
    };

    const label = this.providerLabel;
    const mode = this.settings.conflictResolution;
    const newConflicts: PendingConflict[] = [];
    const overwrote: string[] = [];
    let syncedCount = 0;
    let errorCount = 0;

    try {
      const toSend: JudgedPush[] = [];

      for (const file of files) {
        const recordId = this.frontmatterParser.getRecordId(file);
        if (!recordId) {
          if (this.settings.debugMode) {
            new Notice(`Auto Note Importer: Skipping ${file.name} (no primaryField)`);
          }
          continue;
        }

        const local = this.frontmatterParser.readComparableFields(file);
        if (!local) continue;

        let remote: RemoteNote | null;
        try {
          remote = await this.provider.fetchRecord(recordId);
        } catch (error) {
          errorCount++;
          if (this.settings.debugMode) {
            const message = error instanceof Error ? error.message : 'Unknown error';
            new Notice(`Auto Note Importer: Remote fetch failed for ${file.name}: ${message}`);
          }
          continue;
        }
        if (!remote) {
          errorCount++;
          if (this.settings.debugMode) {
            new Notice(`Auto Note Importer: Skipping ${file.name} (record not found in ${label})`);
          }
          continue;
        }

        const fieldNames = this.judgedFieldNames(local, remote.fields, metadata);
        const snapshot = this.syncState.getRecord(recordId)?.fields;
        const verdicts = threeWayMerge(snapshot, local, remote.fields, fieldNames);
        const plan = planPush(mode, verdicts, local, writable);
        const judged: JudgedPush = {
          recordId, filePath: file.path, local, remote: remote.fields, snapshot, verdicts, plan,
        };

        if (Object.keys(plan.send).length > 0) {
          toSend.push(judged);
        } else {
          // Nothing to write: the judgement itself is the successful outcome.
          this.recordPushOutcome(judged, writable, newConflicts, overwrote);
        }
      }

      // Guard against a misimplemented provider reporting 0 — would otherwise infinite-loop below.
      const batchSize = Math.max(1, this.provider.capabilities.batchUpdateMaxSize);

      for (let i = 0; i < toSend.length; i += batchSize) {
        const batch = toSend.slice(i, i + batchSize);
        const updates: BatchUpdate[] = batch.map(j => ({ recordId: j.recordId, fields: j.plan.send }));

        try {
          const results = await this.provider.batchUpdate(updates);
          const unmatched = [...batch];
          const failures: string[] = [];
          for (const result of results) {
            const idx = unmatched.findIndex(j => j.recordId === result.recordId);
            const judged = idx >= 0 ? unmatched.splice(idx, 1)[0] : undefined;
            if (result.success) {
              syncedCount++;
              if (judged) this.recordPushOutcome(judged, writable, newConflicts, overwrote, result.updatedFields);
            } else {
              errorCount++;
              failures.push(result.error);
            }
          }
          if (failures.length > 0) {
            new Notice(`Auto Note Importer: Batch errors: ${failures.join('; ')}`);
          }
        } catch (error) {
          errorCount += batch.length;
          const message = error instanceof Error ? error.message : 'Unknown error';
          new Notice(`Auto Note Importer: Batch update failed: ${message}`);
        }
      }

      if (errorCount > 0) {
        new Notice(`Auto Note Importer: ${syncedCount} synced, ${errorCount} errors`);
      }
      if (overwrote.length > 0) {
        const names = [...new Set(overwrote)].join(', ');
        new Notice(`Auto Note Importer: Overwrote remote changes: ${names} (${label})`);
      }
      if (newConflicts.length > 0) {
        new Notice(`Auto Note Importer: ${newConflicts.length} sync conflict(s) need resolving (${label})`);
      }

      this.fileWatcher.clearPending();
    } finally {
      await this.syncState.flush();
    }

    return newConflicts;
  }

  /**
   * Fields judged for one record: every remote key, plus local keys the
   * provider's field metadata knows. Without metadata only remote keys —
   * local-only keys (e.g. `created`) are never pushed blind. System fields
   * are never judged.
   */
  private judgedFieldNames(
    local: Record<string, unknown>,
    remote: Record<string, unknown>,
    metadata: Map<string, RemoteFieldInfo> | null,
  ): string[] {
    const names = new Set(Object.keys(remote));
    if (metadata) {
      for (const key of Object.keys(local)) {
        if (metadata.has(key)) names.add(key);
      }
    }
    return [...names].filter(name => !isSystemField(name));
  }

  /**
   * Records a successful push for one record: advances the snapshot for sent
   * and in-sync (`unchanged` / `both-same`) fields, queues `manual` conflicts,
   * (reporting only new or changed ones), and drops queue entries the run settled. Fields left for pull
   * (`remote-only`, unsent `local-only` / `conflict`) keep their baseline.
   */
  private recordPushOutcome(
    judged: JudgedPush,
    writable: (field: string) => boolean,
    newConflicts: PendingConflict[],
    overwrote: string[],
    echoed?: Record<string, unknown>,
  ): void {
    const { recordId, filePath, local, remote, snapshot, verdicts, plan } = judged;
    const fields: Record<string, FieldSnapshot> = {};

    // Remote baseline = the provider's echo when it returns one (it may
    // normalise, e.g. timestamptz), else the value sent.
    for (const [field, sent] of Object.entries(plan.send)) {
      const echo = echoed && field in echoed && echoed[field] !== undefined ? echoed[field] : sent;
      fields[field] = { local: local[field], remote: echo };
    }
    for (const [field, verdict] of Object.entries(verdicts)) {
      if (field in fields) continue;
      if (verdict === 'unchanged' || verdict === 'both-same') {
        fields[field] = { local: local[field], remote: remote[field] };
      }
    }
    if (Object.keys(fields).length > 0) {
      this.syncState.setFields(recordId, fields);
    }

    const enqueue = new Set(plan.enqueue);
    const detectedAt = new Date().toISOString();
    const pending = enqueue.size > 0
      ? this.syncState.pendingConflicts().filter(p => p.recordId === recordId)
      : [];
    for (const [field, verdict] of Object.entries(verdicts)) {
      if (enqueue.has(field)) {
        const conflict: PendingConflict = {
          recordId,
          filePath,
          field,
          local: local[field],
          remote: remote[field],
          snapshot: snapshot?.[field] ?? null,
          writable: writable(field),
          detectedAt,
        };
        const previous = pending.find(p => p.field === field);
        // Always refresh the queue entry; report it only when it is new or
        // its values moved, so re-detection on every save does not re-notify.
        const isNew = !previous
          || !areValuesEqual(previous.local, conflict.local)
          || !areValuesEqual(previous.remote, conflict.remote);
        this.syncState.upsertConflict(conflict);
        if (isNew) newConflicts.push(conflict);
      } else if (verdict !== 'conflict' || field in plan.send) {
        this.syncState.removeConflict(recordId, field);
      }
    }

    overwrote.push(...plan.overwroteRemote);
  }

  private async resolveTableName(): Promise<string> {
    let tables = this.fieldCache.getTablesForBase(this.settings.baseId);
    if (!tables && this.settings.apiKey && this.settings.baseId) {
      try {
        tables = await this.fieldCache.fetchTables(this.settings.apiKey, this.settings.baseId);
      } catch (error) {
        if (this.settings.debugMode) {
          const message = error instanceof Error ? error.message : 'Unknown error';
          new Notice(`Auto Note Importer: Table name fetch failed, using folder name: ${message}`);
        }
      }
    }
    const table = tables?.find(t => t.id === this.settings.tableId);
    const name = table?.name ?? (this.settings.folderPath || 'Database');
    const sanitized = sanitizeFileName(name) || 'Database';
    return sanitized.replace(/\.base$/i, '');
  }

  private async generateBasesFileIfNeeded(remoteNotes: RemoteNote[]): Promise<void> {
    if (!this.settings.generateBasesFile || remoteNotes.length === 0) return;

    const tableName = await this.resolveTableName();
    const filePath = resolveBasesFilePath(this.settings, tableName);

    const existingFile = this.app.vault.getAbstractFileByPath(filePath);
    if (!this.settings.basesRegenerateOnSync && existingFile) return;

    try {
      const fieldNames = collectFieldNames(remoteNotes);
      const content = generateBasesContent(this.settings.folderPath, fieldNames);

      if (existingFile instanceof TFile) {
        const currentContent = await this.app.vault.read(existingFile);
        if (currentContent === content) return;
        await this.app.vault.modify(existingFile, content);
        new Notice('Auto Note Importer: Bases database file updated.');
      } else {
        const dir = filePath.substring(0, filePath.lastIndexOf('/'));
        if (dir) {
          try { await this.app.vault.createFolder(dir); } catch { /* already exists */ }
        }
        await this.app.vault.create(filePath, content);
        new Notice('Auto Note Importer: Bases database file created.');
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      new Notice(`Auto Note Importer: Failed to create Bases file: ${message}`);
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => window.setTimeout(resolve, ms));
  }
}
