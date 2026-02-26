# Auto Note Importer

![GitHub Actions Workflow Status](https://img.shields.io/github/actions/workflow/status/uppinote20/obsidian-auto-note-importer/release.yml?logo=github)
![GitHub release (latest SemVer)](https://img.shields.io/github/v/release/uppinote20/obsidian-auto-note-importer?sort=semver)
![GitHub Downloads (all assets, all releases)](https://img.shields.io/github/downloads/uppinote20/obsidian-auto-note-importer/total)

Import and sync notes bidirectionally between Airtable and your Obsidian vault with smart field mapping and organization features.

## ✨ Key Features

- **Bidirectional Sync**: Sync notes from Airtable to Obsidian and back
- **Formula & Relation Support**: Auto-fetch computed values after syncing to Airtable
- **Conflict Resolution**: Choose how to handle concurrent edits (Obsidian wins, Airtable wins, or manual)
- **Smart Field Selection**: Dropdown-based field selection with type validation
- **Subfolder Organization**: Automatically organize notes into subfolders based on field values
- **Safe File Naming**: Compatible field types (Text, Select, Number, Formula) for filenames
- **Template Support**: Customize note format with powerful template system
- **Obsidian Bases Compatible**: Optimized YAML properties for table/card views
- **Automated Syncing**: Manual sync, scheduled intervals, or automatic on file change
- **Zero Coding Required**: Point-and-click setup with intuitive UI

## 📦 Installation

1. Open Obsidian
2. Go to **Settings > Community plugins > Browse**
3. Search for "**Auto Note Importer**" and install it
4. Enable the plugin
5. Configure your Airtable settings

## 🚀 Quick Start

### 1. Get Airtable Personal Access Token

1. Go to [Airtable Tokens page](https://airtable.com/create/tokens)
2. Click **Create new token**
3. Select scopes:
   - `data.records:read` - Required for importing notes
   - `data.records:write` - Required for bidirectional sync
   - `schema.bases:read` - Required for field selection
4. Select your bases and click **Create token**
5. Copy the token and paste it in plugin settings

### 2. Configure Plugin

1. **Airtable PAT**: Enter your Personal Access Token
2. **Select Base**: Choose from your available bases
3. **Select Table**: Pick the table to sync
4. **Filename Field**: Choose field for note names (Text/Select/Number only)
5. **Subfolder Field**: Optional - organize notes by field value
6. **Destination**: Set folder location for imported notes
7. **Template**: Optional - customize note format

### 3. Sync Notes

Use Command Palette (Ctrl/Cmd + P) to access sync commands:

| Command | Description |
|:---|:---|
| **Sync current note from Airtable** | Refresh current note from Airtable |
| **Sync all notes from Airtable** | Import/update all notes from Airtable |
| **Sync current note to Airtable** | Push current note changes to Airtable* |
| **Sync modified notes to Airtable** | Push all pending changes to Airtable* |
| **Sync all notes to Airtable** | Push all notes to Airtable* |
| **Bidirectional sync current note** | Sync to Airtable, then fetch formula results* |
| **Bidirectional sync modified notes** | Sync modified notes with formula refresh* |
| **Bidirectional sync all notes** | Full bidirectional sync with formulas* |

*Commands marked with * require **Enable bidirectional sync** to be turned on. They are hidden from Command Palette when disabled.

- **Auto**: Set sync interval in minutes (0 = manual only)
- **Watch**: Enable file change detection for automatic sync

## ⚙️ Settings Guide

### Basic Settings

| Setting | Description |
|:---|:---|
| **Airtable Personal Access Token** | Your Airtable PAT for API access |
| **Select Base** | Choose Airtable base (auto-populated from PAT) |
| **Select Table** | Choose table within base |
| **Filename Field** | Field to use for note filenames (safe types only) |
| **Subfolder Field** | Field to organize notes into subfolders (optional) |
| **New File Location** | Destination folder in your vault |
| **Template File** | Custom template for note format (optional) |
| **Sync Interval** | Auto-sync frequency in minutes (0 = disabled) |
| **Allow Overwrite** | Update existing notes vs skip duplicates |

### Bidirectional Sync Settings

| Setting | Description |
|:---|:---|
| **Enable bidirectional sync** | Allow syncing changes from Obsidian back to Airtable |
| **Conflict resolution** | How to handle conflicts: Manual, Obsidian wins, or Airtable wins |
| **Watch for file changes** | Automatically detect and queue changes for sync |
| **Auto-sync formulas** | Fetch computed formula/relation results after syncing |
| **Formula sync delay** | Wait time (ms) for Airtable to compute formulas (default: 1500) |

### Supported Field Types

**✅ Safe for Filenames & Subfolders:**
- Single line text
- Single select
- Number
- Formula (validated for filename compatibility)

**❌ Not Supported for Filenames:**
- Email, URL, Phone (special characters)
- Date, Time (formatting issues)
- Multiple select (unpredictable results)
- Attachment, User (complex data types)

**🔒 Read-only Fields (synced from Airtable only):**
- Formula, Rollup, Count, Lookup
- Created time, Last modified time
- Created by, Last modified by
- Auto number

*Unsupported fields are automatically hidden in dropdowns to prevent errors.*

**📋 [Complete Field Type Reference →](examples/airtable-field-types.md)**

## 🔄 How It Works

### Unique Identification
Each note gets a unique `primaryField` (Airtable record ID) in frontmatter to prevent duplicates and enable proper sync tracking.

### File Naming Logic
1. Use selected **Filename Field** if available and non-empty
2. Fallback to **Airtable record ID** for guaranteed unique, safe filename
3. All filenames are sanitized for cross-platform compatibility

### Subfolder Organization
- **With Subfolder Field**: `destination/field-value/note.md`
- **Without Subfolder Field**: `destination/note.md`
- Supports nested folders (e.g., "Category/Subcategory")
- Recursive duplicate detection across all subfolders

### Bidirectional Sync Flow

```
┌─────────────┐     Push      ┌─────────────┐
│   Obsidian  │ ───────────▶  │   Airtable  │
│   (Notes)   │               │  (Database) │
│             │  ◀───────────  │             │
└─────────────┘     Pull      └─────────────┘
```

1. **Obsidian → Airtable**: Edit frontmatter fields in Obsidian, sync pushes changes
2. **Formula Computation**: Airtable computes formulas, rollups, and relations
3. **Airtable → Obsidian**: Pull back computed values to update notes

### Conflict Resolution

When the same field is modified in both Obsidian and Airtable:

| Mode | Behavior |
|:---|:---|
| **Manual** | Show notification, skip conflicted fields |
| **Obsidian wins** | Overwrite Airtable with Obsidian values |
| **Airtable wins** | Keep Airtable values, ignore Obsidian changes |

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
- **Multi-line Support**: Automatic YAML block scalar formatting
- **Bases Optimization**: Proper YAML types for table/card views

**📝 [Template Examples & Best Practices →](examples/template-examples.md)**

## 🔗 Obsidian Bases Integration

This plugin creates Bases-compatible YAML frontmatter with proper data types for seamless table/card view editing. Import your notes, enable the Bases plugin, and create a database from your imported folder for powerful data management workflows.

## 📊 Example Workflows

### One-way Import
1. **Collect Data**: Use automation tools (n8n, Zapier) to gather content
2. **Store in Airtable**: Organize and process your data
3. **Import to Obsidian**: Use this plugin to create structured notes
4. **Organize Automatically**: Subfolder structure based on your data
5. **Manage in Bases**: View and edit in table/card format

### Bidirectional Workflow
1. **Import from Airtable**: Pull records as Obsidian notes
2. **Edit in Obsidian**: Modify frontmatter fields (status, tags, notes)
3. **Sync to Airtable**: Push changes back to update the database
4. **Formula Updates**: Airtable computes formulas and relations
5. **Pull Results**: Fetch computed values back to Obsidian

## 🛠️ Troubleshooting

**Common Issues:**
- **No fields showing**: Check PAT permissions and base/table selection
- **Sync fails**: Verify network connection and Airtable credentials
- **File naming errors**: Ensure selected field type is supported
- **Missing subfolders**: Check subfolder field value isn't empty
- **Bidirectional sync not working**: Ensure PAT has `data.records:write` permission
- **Formulas not updating**: Increase formula sync delay in settings
- **Conflicts detected**: Check conflict resolution mode in settings

**Field Selection Tips:**
- Use descriptive text fields for filenames
- Choose categorical fields for subfolder organization
- Formula fields work for filenames but are validated for compatibility

**Bidirectional Sync Tips:**
- Read-only fields (formulas, rollups) are automatically excluded from push
- Use "Obsidian wins" mode for faster sync (skips conflict detection)
- Increase formula sync delay for complex Airtable formulas

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