# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build & Development Commands

```bash
npm run build    # TypeScript check + production build
npm run dev      # Development mode with watch
npm run lint     # ESLint for src/*.ts files
```

## Architecture Overview

This is an Obsidian plugin that syncs notes bidirectionally between Airtable and Obsidian.

### Module Structure (`src/`)

```
src/
├── main.ts              # Plugin entry point, service orchestration
├── types/               # Type definitions
│   ├── settings.types.ts    # Settings interface, DEFAULT_SETTINGS
│   ├── airtable.types.ts    # RemoteNote, SyncResult, BatchUpdate
│   └── sync.types.ts        # SyncMode, SyncScope, SyncRequest
├── constants/           # Constants
│   ├── api.ts               # AIRTABLE_BATCH_SIZE, RATE_LIMIT_INTERVAL_MS
│   └── field-types.ts       # SUPPORTED_FIELD_TYPES, READ_ONLY_FIELD_TYPES
├── services/            # External service integration
│   ├── airtable-client.ts   # API client (fetchNotes, batchUpdate)
│   ├── rate-limiter.ts      # Request throttling (200ms interval)
│   └── field-cache.ts       # Airtable field metadata cache
├── core/                # Business logic
│   ├── sync-queue.ts        # Queue-based sync management
│   └── conflict-resolver.ts # Conflict resolution logic
├── builders/            # Content generation
│   └── note-builder.ts      # Template parsing, markdown generation
├── file-operations/     # File system operations
│   ├── file-watcher.ts      # Change detection (2s debounce)
│   └── frontmatter-parser.ts # YAML frontmatter parsing
├── ui/                  # UI components
│   ├── settings-tab.ts      # Settings panel
│   └── suggest/             # Autocomplete components
└── utils/               # Utilities
    ├── sanitizers.ts        # File/folder name sanitization
    ├── yaml-formatter.ts    # YAML value formatting
    └── object-utils.ts      # Object utilities
```

### Key Classes

- **`DatabaseProvider`** - Provider-agnostic interface for remote databases (see handbook §4.4)
- **`AirtableClient`** - First concrete `DatabaseProvider` impl; Airtable REST API with rate limiting
- **`ProviderRegistry`** - Credential-type → provider factory lookup (`createProvider()`)
- **`SyncQueue`** - Prevents concurrent syncs, merges duplicate requests
- **`FileWatcher`** - Detects file changes, triggers sync with debounce
- **`FrontmatterParser`** - Extracts/filters fields from YAML frontmatter
- **`ConflictResolver`** - Handles sync conflicts based on resolution mode

### Sync Flow

1. **From remote**: `DatabaseProvider.fetchNotes()` → `createNoteFromRemote()` → writes `.md` with `primaryField`
2. **To remote**: `FileWatcher` detects changes → `SyncQueue.enqueue()` → `DatabaseProvider.batchUpdate()`
3. **Bidirectional**: Push to remote → wait for server-side computation → pull back computed values

### Key Design Decisions

- `primaryField` in frontmatter is always the Airtable record ID (immutable identifier)
- Read-only fields (formulas, rollups, lookups) are filtered out via `isReadOnlyFieldType()`
- Conflict resolution modes: `obsidian-wins`, `airtable-wins`, `manual`
- Services receive settings updates via `updateSettings()` method
- FileWatcher is reconfigured on settings change (no reload needed for `watchForChanges`)
- Commands use `checkCallback` pattern to hide when `bidirectionalSync` is disabled

### Available Commands

| Command | Always Available |
|:---|:---|
| Sync current note from Airtable | ✅ |
| Sync all notes from Airtable | ✅ |
| Sync current/modified/all to Airtable | ❌ (requires bidirectionalSync) |
| Bidirectional sync current/modified/all | ❌ (requires bidirectionalSync) |

## Documentation

- `docs/ENGINEERING_HANDBOOK.md` - 코딩 컨벤션, 스타일 가이드, 아키텍처, 디자인 시스템, 코드 스탠다드, 거버넌스, 프로젝트 고유 패턴

## Coding Conventions

### Bidirectional Links

Code ↔ Docs 양방향 링크 시스템:
- **Code → Docs**: `@handbook {section}` (소스 파일 JSDoc에 마커)
- **Docs → Code**: `<!-- @code {file} -->` (핸드북에 마커)
- **검색**: `grep -r "@handbook" src/` / `grep -r "@code" docs/`

### Quick Reference

| Topic | Handbook Section |
|:---|:---|
| Naming conventions | 2.1 |
| Import order | 2.2 |
| Module structure | 4.1 |
| Sync architecture | 4.2 |
| Provider abstraction | 4.4 |
| StatusBar abstraction | 5.3 |
| Error handling | 6.1 |
| State management | 6.2 |
| Input validation | 7.1 |
| Read-only field protection | 7.3 |
| Git/PR rules | 8 |
| Sync flow | 9.1 |
| Service init order | 9.2 |
| Settings update pattern | 9.3 |
| Conflict resolution | 9.5 |
| API patterns | 9.6 |
| Multi-config architecture | 9.8 |
| Settings migration | 9.9 |
| Folder overlap validation | 9.10 |
| Bases file generation | 9.11 |

## Commit Guidelines

See `.claude/commit-guidelines.md` - uses conventional commits **without** Claude metadata.
