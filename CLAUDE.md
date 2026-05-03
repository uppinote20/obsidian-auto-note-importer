# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build & Development Commands

```bash
npm run build    # TypeScript check + production build
npm run dev      # Development mode with watch
npm run lint     # ESLint for src/*.ts files
npm test         # Vitest unit tests (watch)
npm run test:run # Vitest unit tests (one-shot)

# E2E (require Obsidian running with --remote-debugging-port=9222)
npm run test:e2e            # Airtable sync e2e
npm run test:e2e:settings   # Airtable settings UI e2e
npm run test:e2e:full       # Build + deploy + run Airtable sync e2e
npm run test:e2e:seatable          # SeaTable sync e2e (.env required)
npm run test:e2e:seatable:settings # SeaTable settings UI e2e
npm run test:e2e:seatable:full     # Build + deploy + run SeaTable e2e
```

## Architecture Overview

This is an Obsidian plugin that syncs notes bidirectionally between **remote databases (Airtable, SeaTable; Supabase / Notion / Custom API tracked in epic #11)** and your Obsidian vault. Higher layers operate on the provider-agnostic `DatabaseProvider` interface — adding a new provider is documented in handbook §4.4.

### Module Structure (`src/`)

```
src/
├── main.ts                          # Plugin entry point, service orchestration
├── types/                           # Type definitions
│   ├── settings.types.ts                # AutoNoteImporterSettings, LegacySettings, DEFAULT_SETTINGS
│   ├── config.types.ts                  # ConfigEntry (per-config sync settings), SharedServices
│   ├── credential.types.ts              # CredentialType union + AirtableCredential / SeaTableCredential / etc.
│   ├── database.types.ts                # DatabaseProvider interface, RemoteNote, SyncResult, ProviderCapabilities
│   ├── field-types.types.ts             # StandardFieldType + FieldTypeMapper
│   ├── provider-settings.types.ts       # CredentialFormRenderer (settings-tab plugin point)
│   ├── airtable.types.ts                # Airtable-specific (AirtableField, AirtableBase, AirtableTable, AirtableView)
│   └── sync.types.ts                    # SyncMode, SyncScope, SyncRequest
├── constants/                       # Constants
│   ├── api.ts                           # AIRTABLE_* / SEATABLE_* / RATE_LIMIT_INTERVAL_MS / retry knobs
│   └── system-fields.ts                 # SYSTEM_FIELDS, isSystemField (frontmatter-reserved)
├── services/                        # External service integration
│   ├── airtable-client.ts               # Airtable DatabaseProvider impl (REST API)
│   ├── airtable-field-mapper.ts         # Airtable type → StandardFieldType
│   ├── airtable-credential-form.ts      # Airtable settings form + connection test
│   ├── seatable-client.ts               # SeaTable DatabaseProvider impl (API Gateway v2 + Base-Token caching)
│   ├── seatable-field-mapper.ts         # SeaTable type → StandardFieldType
│   ├── seatable-credential-form.ts      # SeaTable settings form + connection test
│   ├── provider-registry.ts             # Factory + mapper + form-renderer registry by CredentialType
│   ├── rate-limiter.ts                  # Per-credential request throttling + 429 retry + transient retry
│   └── field-cache.ts                   # Airtable field metadata cache (Meta API)
├── core/                            # Business logic
│   ├── sync-orchestrator.ts             # processSyncRequest (pull / push / bidirectional)
│   ├── conflict-resolver.ts             # detectConflicts + resolve by mode
│   ├── sync-queue.ts                    # Queue-based sync (dedup + merge)
│   ├── config-instance.ts               # Per-config service stack
│   └── config-manager.ts                # ConfigInstance lifecycle
├── builders/                        # Content generation
│   ├── note-builder.ts                  # Template parsing, markdown generation
│   └── bases-file-generator.ts          # Obsidian Bases (.base) generator
├── file-operations/                 # File system operations
│   ├── file-watcher.ts                  # Change detection (debounced)
│   └── frontmatter-parser.ts            # YAML frontmatter (read/inject + read-only filter)
├── ui/                              # UI components
│   ├── settings-tab.ts                  # Settings panel (multi-config, provider-aware cards)
│   └── suggest/                         # Folder/file autocomplete
└── utils/                           # Utilities
    ├── sanitizers.ts                    # File/folder name sanitization
    ├── yaml-formatter.ts                # YAML value formatting (Bases-aware)
    ├── object-utils.ts                  # Deep equality, generateId
    ├── settings-bridge.ts               # ConfigEntry + Credential → LegacySettings
    ├── migration.ts                     # Settings v1 → v3 migration
    ├── validation.ts                    # Folder overlap validation
    └── api-errors.ts                    # Cross-provider API error extraction + URL normalization
```

### Key Classes

- **`DatabaseProvider`** — Provider-agnostic interface for remote databases (handbook §4.4)
- **`AirtableClient` / `SeaTableClient`** — Concrete `DatabaseProvider` impls
- **`ProviderRegistry`** — `CredentialType → factory` lookup (`createProvider()` + `getFieldTypeMapper()` + `getCredentialFormRenderer()`)
- **`ConfigManager` / `ConfigInstance`** — Multi-config orchestration; per-config service stack (handbook §9.8)
- **`SyncOrchestrator`** — `processSyncRequest(mode, scope)` — central pull/push/bidirectional coordinator
- **`SyncQueue`** — Dedup + merge sequential sync requests; `enqueueSyncRequest` returns the queue's promise so e2e can await completion
- **`FileWatcher`** — Detects file changes with debounce
- **`FrontmatterParser`** — Read-only field filter via the active provider's `FieldTypeMapper`
- **`ConflictResolver`** — Detect/resolve based on `obsidian-wins` / `remote-wins` / `manual`

### Sync Flow

1. **From remote**: `DatabaseProvider.fetchNotes()` → builder writes `.md` with `primaryField` (the remote record id)
2. **To remote**: `FileWatcher` detects change → `SyncQueue.enqueue()` → `SyncOrchestrator.pushFiles()` → `DatabaseProvider.batchUpdate()`
3. **Bidirectional**: push to remote → wait `formulaSyncDelay` (server-side computation) → pull back computed values

### Key Design Decisions

- `primaryField` in frontmatter is always the **remote record id** (provider-agnostic immutable identifier)
- Read-only fields (formula / rollup / lookup / `_ctime` / etc.) are filtered out via `FieldTypeMapper.isReadOnly()` — fail-closed for unknown types
- Conflict resolution modes: `obsidian-wins`, `remote-wins`, `manual` (renamed from `airtable-wins` in #64)
- Services receive settings updates via `updateSettings()` — `ConfigInstance.updateSettings()` propagates to all owned services
- `FileWatcher` is reconfigured on settings change (no reload needed for `watchForChanges`)
- Commands use `checkCallback` pattern to hide push/bidirectional commands when `bidirectionalSync` is disabled
- User-facing labels (status bar, command names, settings) derive from `CREDENTIAL_TYPE_LABELS[credential.type]` — never hardcode `"Airtable"` in shared render methods

### Available Commands

Command titles include the provider label (e.g. `Sync current note from Airtable` / `Sync current note from SeaTable`) — derived dynamically per active config.

| Command | Always Available |
|:---|:---|
| Sync current note from {provider} | ✅ |
| Sync all notes from {provider} | ✅ |
| Sync current/modified/all to {provider} | ❌ (requires `bidirectionalSync`) |
| Bidirectional sync current/modified/all | ❌ (requires `bidirectionalSync`) |

## Documentation

- `docs/ENGINEERING_HANDBOOK.md` — 코딩 컨벤션, 스타일 가이드, 아키텍처, 디자인 시스템, 코드 스탠다드, 거버넌스, 프로젝트 고유 패턴 (`.private/docs` symlink로 별도 repo에서 관리)

## Coding Conventions

### Bidirectional Links

Code ↔ Docs 양방향 링크 시스템:
- **Code → Docs**: `@handbook {section}` (소스 파일 JSDoc에 마커)
- **Docs → Code**: `<!-- @code {file} -->` (핸드북에 마커)
- **검색**: `grep -r "@handbook" src/` / `grep -r "@code" docs/`

### Code ↔ Tests Bidirectional Links

- **Code → Tests**: `@tested {path}` (e2e harness는 `e2e:` prefix)
- **Tests → Code**: `@covers {path}`
- **Sync**: `/update-test-map` (test-sync 태그 기반)

### Quick Reference

| Topic | Handbook Section |
|:---|:---|
| Naming conventions | 2.1 |
| Import order | 2.2 |
| Module structure | 4.1 |
| Sync architecture | 4.2 |
| Provider abstraction (multi-DB) | 4.4 |
| StatusBar abstraction | 5.3 |
| Error handling (api-errors util) | 6.1 |
| State management (SyncQueue) | 6.2 |
| Input validation | 7.1 |
| Read-only field protection | 7.3 |
| Git/PR rules | 8 |
| Sync flow | 9.1 |
| Service init order | 9.2 |
| Settings update pattern | 9.3 |
| Conflict resolution | 9.5 |
| API patterns | 9.6 |
| Multi-config architecture | 9.8 |
| Settings migration (v1 → v3) | 9.9 |
| Folder overlap validation | 9.10 |
| Bases file generation | 9.11 |

## Commit Guidelines

See `.claude/commit-guidelines.md` — uses conventional commits **without** Claude metadata.
