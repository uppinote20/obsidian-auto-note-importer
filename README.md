# Obsidian Auto Note Importer

Easily import and sync notes from an external database like Airtable into your Vault.  
Customize destination folders, apply templates, and manage syncing with flexible settings.

<br>

## ✨ Features

- Pulls notes from Airtable (more database support planned)
- Creates Markdown files with structured YAML metadata
- Supports manual and scheduled syncing (configurable interval)
- Customizable:
  - Destination folder
  - Note template
  - Overwrite option
- Handles missing folders by auto-creating them
- Minimal setup, zero coding required!

<br>

## 📦 Installation

1. Open Obsidian.
2. Go to **Settings > Community plugins > Browse**.
3. Search for "**Auto Note Importer**" and install it.
4. Enable the plugin.
5. Configure your Airtable PAT and Base/Table settings.

<br>

## 🚀 Usage

- **Manual Sync**:  
  - Use the Command Palette (`Ctrl+P`) → search for **"Sync Notes Now"** to trigger manual sync.
- **Auto Sync**:
  - Set a sync interval (minutes) in settings.  
  - If set to `0`, auto sync will be disabled (manual only).

<br>

## ⚙️ Settings

![Plugin Settings Screenshot](assets/settings.png)

| Setting | Description |
|:---|:---|
| Airtable Personal Access Token | Personal Access Token for Airtable API |
| Select Base | Select the Airtable Base to fetch records from |
| Select Table | Select the Airtable Table inside the Base |
| New file location | Where imported notes are saved in your Vault |
| Template file | (Optional) Path to a template Markdown file |
| Sync Interval (minutes) | Interval (in minutes) for auto-sync (0 = no auto sync) |
| Allow Overwrite Existing Notes | Whether to overwrite existing notes |


<br>

## 🔄 Example Workflow

1. Use **n8n** to collect and summarize YouTube video information.
2. Store the processed summaries into **Airtable**.
3. Launch **Obsidian**, and use this plugin to fetch and create beautiful Markdown notes!

<br>



## 📝 Default Note Template Example

If no custom template is provided, notes will be created with the following default structure:

```markdown
---
primaryField: First Column of Airtable
videoId: Video Id
title: Video Title
uploadDate: 2025-04-28
summary: This is a summary of the video content.
tags: [tag#1, tag#2]
categories: [category#1, category#2]
check-read: false
---

![](https://example.com/thumbnail.jpg)

# 📝 요약
Summary content or key topics extracted from the script.

# 📜 전체 스크립트
Full original script text goes here.
```

<br>

## 🛠️ Planned Features

- [ ] Support multi-database (Airtable, Supabase, Notion DB, Custom API)
- [ ] Flexible field mapping (choose which field to treat as unique key)
- [ ] Improved error handling with retry mechanism
- [ ] Progress indicator during sync
- [ ] Internationalization (i18n) support for multiple languages
- [ ] Advanced overwrite/merge strategies
- [ ] Pagination support for large Airtable datasets
- [ ] UI/UX improvements in settings panel

<br>

## ☕ Support

If you find this plugin useful, you can support the development:

<div style="display: flex; gap: 20px; align-items: center;">
  <a href="https://ko-fi.com/uppinote" target="_blank">
    <img src="https://storage.ko-fi.com/cdn/kofi5.png" alt="Buy Me a Coffee at ko-fi.com" style="height:60px; width:217px;">
  </a>
  <a href="https://www.buymeacoffee.com/uppinote" target="_blank">
    <img src="https://cdn.buymeacoffee.com/buttons/v2/default-yellow.png" alt="Buy Me A Coffee" style="height:60px; width:217px;">
  </a>
</div>

<br>

## 📄 License

MIT License