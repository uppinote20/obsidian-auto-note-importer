# Auto Note Importer

![GitHub Actions Workflow Status](https://img.shields.io/github/actions/workflow/status/uppinote20/obsidian-auto-note-importer/release.yml?logo=github)
![GitHub release (latest SemVer)](https://img.shields.io/github/v/release/uppinote20/obsidian-auto-note-importer?sort=semver)
![GitHub Downloads (all assets, all releases)](https://img.shields.io/github/downloads/uppinote20/obsidian-auto-note-importer/total)

Import and sync notes bidirectionally between **Airtable**, **SeaTable**, and your Obsidian vault with smart field mapping and organization features. Built on a provider-agnostic core; more databases (Supabase, Notion, Custom API) tracked in [#11](https://github.com/uppinote20/obsidian-auto-note-importer/issues/11).

## ✨ Key Features

- **Multiple Databases**: Airtable and SeaTable supported today; pluggable provider architecture for more
- **Bidirectional Sync**: Sync notes from your remote database to Obsidian and back
- **Multi-Config**: Run several sync configurations (different bases / tables / folders) side-by-side
- **Computed-Field Support**: Auto-fetch formula / rollup / lookup / link-formula values after pushing
- **Conflict Resolution**: `Manual`, `Obsidian wins`, `Remote wins` modes
- **Smart Field Selection**: Type-aware dropdowns; provider-specific safe-for-filename whitelist
- **Subfolder Organization**: Auto-organize notes into subfolders based on a field value
- **Safe File Naming**: Per-provider validation (text / select / number / formula / auto-number)
- **Template Support**: `{{fieldName}}` placeholders with nested-property access
- **Obsidian Bases Compatible**: YAML output tuned for table/card views
- **Automated Syncing**: Manual sync, scheduled intervals, or auto on file change
- **Zero Coding Required**: Point-and-click setup with intuitive UI

## 📦 Installation

1. Open Obsidian
2. Go to **Settings → Community plugins → Browse**
3. Search for "**Auto Note Importer**" and install it
4. Enable the plugin
5. Add a credential for your provider (Airtable PAT or SeaTable API Token), then configure a sync configuration

## 🚀 Quick Start

### 1. Get Your Provider Credentials

#### Airtable

1. Visit the [Airtable Tokens page](https://airtable.com/create/tokens)
2. Click **Create new token**
3. Select scopes:
   - `data.records:read` — required for importing
   - `data.records:write` — required for bidirectional sync
   - `schema.bases:read` — required for field selection
4. Choose your bases and click **Create token**
5. Copy the Personal Access Token

#### SeaTable

1. Open your SeaTable Base → **More options (⋯) → Advanced settings → API Tokens → Add API Token**
2. Pick **Read and write** permission
3. Copy the API Token (it is base-specific)
4. Note your server URL (default: `https://cloud.seatable.io`; self-hosted users use their own host)

### 2. Configure the Plugin

1. Open **Settings → Auto Note Importer**
2. **Add credential** — pick the provider type (Airtable / SeaTable) and paste your token
3. The connection card adapts to your selected credential. Fill in:
   - **Airtable**: Base → Table → View (optional) → Filename / Subfolder fields
   - **SeaTable**: Table ID → View ID (optional) → Filename / Subfolder column names
4. **Destination folder** in your vault
5. **Template** — optional `{{fieldName}}` template
6. **Bidirectional sync** — toggle if you want changes flowing both ways

You can have multiple configurations (e.g. one for Airtable, one for SeaTable, or two SeaTable bases) — switch between them with the tab bar at the top of the settings panel.

### 3. Sync Notes

Use Command Palette (Ctrl/Cmd + P). Each command is labeled with the active config's provider:

| Command | Description |
|:---|:---|
| **Sync current note from {provider}** | Refresh current note from the remote database |
| **Sync all notes from {provider}** | Import / update all notes |
| **Sync current note to {provider}** \* | Push current note changes |
| **Sync modified notes to {provider}** \* | Push pending changes |
| **Sync all notes to {provider}** \* | Push every note |
| **Bidirectional sync current note** \* | Push, wait for formulas, then pull |
| **Bidirectional sync modified notes** \* | Same for modified notes |
| **Bidirectional sync all notes** \* | Same for all notes |

\* Commands marked with \* require **Enable bidirectional sync** to be turned on. They are hidden from Command Palette when disabled.

You can also schedule syncs:

- **Sync interval**: minutes (0 = manual only)
- **Watch for changes**: detect file edits and queue automatic sync

## ⚙️ Settings Guide

### Per-Configuration Basics

| Setting | Description |
|:---|:---|
| **Credential** | Pick a registered credential (Airtable / SeaTable) |
| **Base / Table / View** (Airtable) | Selectable from your base via the Meta API |
| **Table / View ID** (SeaTable) | Identifiers from your SeaTable base — auto-derived dropdowns are tracked in [#73](https://github.com/uppinote20/obsidian-auto-note-importer/issues/73) |
| **Filename Field** | Field used for note filenames (safe types only) |
| **Subfolder Field** | Optional — organize notes into subfolders |
| **New File Location** | Destination folder in your vault |
| **Template File** | Custom template (optional) |
| **Sync Interval** | Auto-sync frequency in minutes (0 = disabled) |
| **Allow Overwrite** | Update existing notes vs skip duplicates |

### Bidirectional Sync

| Setting | Description |
|:---|:---|
| **Enable bidirectional sync** | Allow Obsidian → remote pushes |
| **Conflict resolution** | `Manual`, `Obsidian wins`, `Remote wins` |
| **Watch for file changes** | Auto-detect Obsidian edits and queue sync |
| **Auto-sync computed fields** | After push, fetch formulas / rollups / lookups |
| **Computed-field sync delay** | ms to wait for the remote to recompute (default: 1500) |

### Supported Field Types

The plugin maps each provider's native types to a normalized taxonomy (`text` / `number` / `date` / `boolean` / `single-select` / `multi-select` / `attachment` / `link` / `computed` / `system`). Each provider's `FieldTypeMapper` decides which types are filename-safe and which are read-only (excluded from push) — fail-closed for unknown types.

#### Airtable

**✅ Safe for Filenames & Subfolders:** `singleLineText`, `singleSelect`, `number`, `formula`

**🔒 Read-only (synced from Airtable only):** `formula`, `rollup`, `count`, `lookup`, `externalSyncSource`, `aiText`, `button`, `createdTime`, `lastModifiedTime`, `createdBy`, `lastModifiedBy`, `autoNumber`

**📋 [Complete Airtable Field Type Reference →](examples/airtable-field-types.md)**

#### SeaTable

**✅ Safe for Filenames & Subfolders:** `text`, `single-select`, `number`, `auto-number`, `formula`

**🔒 Read-only (synced from SeaTable only):** `formula`, `link-formula`, `button`, `ctime`, `mtime`, `creator`, `last-modifier`, `auto-number`

Unsupported / read-only fields are automatically hidden in dropdowns to prevent push errors.

## 🔄 How It Works

### Unique Identification
Each note carries the remote record id in the `primaryField` frontmatter key — the immutable handle the sync pipeline uses to match notes back to their remote row.

### File Naming Logic
1. Use the selected **Filename Field** if present and non-empty
2. Fallback to the **remote record id**
3. All filenames are sanitized for cross-platform compatibility

### Subfolder Organization
- **With Subfolder Field**: `destination/field-value/note.md`
- **Without Subfolder Field**: `destination/note.md`
- Supports nested folders (e.g. "Category/Subcategory")
- Recursive duplicate detection across all subfolders

### Bidirectional Sync Flow

```
┌─────────────┐     Push      ┌──────────────┐
│   Obsidian  │ ───────────▶  │   Remote DB  │
│   (Notes)   │               │  (Airtable / │
│             │  ◀───────────  │   SeaTable)  │
└─────────────┘     Pull      └──────────────┘
```

1. **Obsidian → Remote**: edit frontmatter, sync pushes writable fields
2. **Server-side computation**: the remote computes formulas / rollups / link-formulas
3. **Remote → Obsidian**: pull back computed values to update notes

### Conflict Resolution

When the same field is modified in both Obsidian and the remote:

| Mode | Behavior |
|:---|:---|
| **Manual** | Show notification, skip conflicting fields |
| **Obsidian wins** | Overwrite the remote with Obsidian values |
| **Remote wins** | Keep remote values, ignore Obsidian changes |

## 📝 Template Usage

Create custom note templates using `{{fieldName}}` placeholders:

```markdown
---
title: "{{Title}}"
status: "{{Status}}"
author: "{{Author.name}}"
created: "{{Created time}}"
---

# {{Title}}

## Summary
{{Summary}}

## Content
{{Description}}

## Attachments
{{Attachment.0.url}}
```

**Advanced Features:**
- **Nested Access**: `{{Attachment.0.url}}`, `{{User.name}}`
- **Multi-line Support**: Automatic YAML block-scalar formatting
- **Bases Optimization**: Proper YAML types for table/card views

**📝 [Template Examples & Best Practices →](examples/template-examples.md)**

## 🔗 Obsidian Bases Integration

This plugin emits Bases-compatible YAML frontmatter with proper data types for seamless table/card view editing. Import your notes, enable the Bases plugin, and create a database from the imported folder for powerful data management workflows.

## 📊 Example Workflows

### One-way Import
1. **Collect data** with automation tools (n8n, Zapier, Apps Script)
2. **Store** in Airtable or SeaTable
3. **Import** to Obsidian via this plugin
4. **Organize** automatically using Subfolder Field
5. **Manage** in Obsidian Bases (table/card view)

### Bidirectional Workflow
1. **Import** records as Obsidian notes
2. **Edit** frontmatter fields in Obsidian (status, tags, notes)
3. **Push** changes back to the remote
4. **Compute** formulas / rollups / link-formulas server-side
5. **Pull** computed values back into Obsidian

## 🛠️ Troubleshooting

**Common Issues:**
- **No fields showing**: re-check token permissions and base/table selection
- **Sync fails**: verify network connection and credentials
- **File naming errors**: confirm the selected field type is supported (per-provider whitelist)
- **Missing subfolders**: check the subfolder field value isn't empty
- **Bidirectional sync not working**: ensure write permissions (Airtable PAT `data.records:write`; SeaTable token "Read and write")
- **Formulas not updating**: increase the computed-field sync delay
- **Conflicts detected**: check conflict resolution mode

**Provider-specific Tips:**
- **Airtable**: read-only fields (formulas, rollups) are auto-excluded from push. Use **Obsidian wins** for faster sync (skips conflict detection).
- **SeaTable**: API tokens are base-specific. Each token grants access to exactly one base — get a separate token per base. Self-hosted users override `Server URL` per credential.

## ☕ Support

If you find this plugin useful, support development:

<div style="display: flex; gap: 20px; align-items: center;">
  <a href="https://ko-fi.com/uppinote" target="_blank">
    <img src="https://storage.ko-fi.com/cdn/kofi5.png" alt="Buy Me a Coffee at ko-fi.com" style="height:60px; width:217px;">
  </a>
  <a href="https://www.buymeacoffee.com/uppinote" target="_blank">
    <img src="https://cdn.buymeacoffee.com/buttons/v2/default-yellow.png" alt="Buy Me A Coffee" style="height:60px; width:217px;">
  </a>
</div>

## 📄 License

MIT License
