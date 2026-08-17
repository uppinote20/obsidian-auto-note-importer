# E2E Test Suites — Contributor Setup

All suites drive a real Obsidian instance over the Chrome DevTools Protocol. Prerequisites for every suite:

1. Obsidian running with `--remote-debugging-port=9222` — the `*:full` scripts launch it for you, **macOS only** (`start-e2e.sh` hardcodes `/Applications/Obsidian.app`; on Linux/Windows start Obsidian with the flag yourself and use the non-`full` commands)
2. The plugin **installed in the vault at least once** (folder `.obsidian/plugins/auto-note-importer` must exist) — `*:full` copies a fresh build into an existing install but does not create it on a brand-new vault
3. Provider credentials in a **repo-root `.env`** (not inside `tests/e2e/`) — annotated template: [`tests/e2e/.env.example`](./.env.example)

| Suite | Command | Needs |
|:---|:---|:---|
| Airtable sync / settings | `npm run test:e2e` · `test:e2e:settings` | An Airtable credential configured in the vault **plus `AIRTABLE_E2E_BASE_ID` + `AIRTABLE_E2E_TABLE_ID` in `.env`** (`run-e2e.mjs` exits without them) |
| SeaTable | `test:e2e:seatable{,:settings,:full}` | `SEATABLE_*` in `.env` |
| Supabase | `test:e2e:supabase{,:settings,:full}` | `SUPABASE_URL` + `SUPABASE_KEY` in `.env` + demo schema below |
| Notion | `test:e2e:notion{,:settings,:full}` | `NOTION_*` in `.env` + a data source shared with the integration |

Run e2e with only the target vault open in Obsidian — the harness attaches to the first Obsidian window it finds.

## Supabase demo project

Create a free project at [supabase.com](https://supabase.com), open the SQL Editor, and run:

```sql
CREATE TYPE note_status AS ENUM ('draft', 'published', 'archived');

CREATE TABLE notes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL,
  content text,
  status note_status DEFAULT 'draft',
  tags text[],
  meta jsonb,
  archived boolean DEFAULT false,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  full_text text GENERATED ALWAYS AS (title || ' ' || coalesce(content, '')) STORED
);

CREATE VIEW active_notes AS
  SELECT * FROM notes WHERE archived = false;

ALTER TABLE notes ENABLE ROW LEVEL SECURITY;
CREATE POLICY "anon_all" ON notes FOR ALL USING (true);
```

**Publishable keys** (`sb_publishable_…`) additionally need the schema-introspection RPC — Supabase blocks the OpenAPI endpoint for them. Easiest: load the plugin once, open **Settings → Supabase Connection**, click **Copy SQL** in the setup banner, run it in the SQL Editor. Headless alternative:

```bash
npx tsx -e "import('./src/constants/supabase-rpc.ts').then(m => console.log(m.SUPABASE_RPC_SCHEMA_SQL))"
```

Re-running is safe (`CREATE OR REPLACE`); legacy `anon` JWTs skip this entirely.

## Notion test data source

The Notion sync suite reads and mutates whatever the integration can see and asserts *relationships* (`Doubled === 2 × Score`), not fixed seeds. It needs a data source with this schema (see `run-notion-e2e.mjs` header):

```
Name      title        Notes    rich_text     Score  number
Category  select       Tags     multi_select  Due    date
Done      checkbox     Link     url           Doubled formula = prop("Score") * 2
```

The body-sync scenario creates and archives its own page — no manual cleanup needed.

## .env keys

```ini
# Airtable (token itself is reused from the vault's first Airtable credential)
AIRTABLE_E2E_BASE_ID=app…        AIRTABLE_E2E_TABLE_ID=tbl…      AIRTABLE_E2E_FOLDER_PATH=Airtable-E2E
# SeaTable
SEATABLE_SERVER_URL=https://cloud.seatable.io
SEATABLE_API_TOKEN=…             SEATABLE_TABLE_ID=0000
SEATABLE_VIEW_ID=                SEATABLE_FOLDER_PATH=SeaTable-E2E
# Supabase
SUPABASE_URL=https://<ref>.supabase.co
SUPABASE_KEY=sb_publishable_…
# Notion
NOTION_TOKEN=ntn_…               NOTION_DATA_SOURCE_ID=…
NOTION_DATABASE_ID=              NOTION_FOLDER_PATH=NotionE2E
```

[`./.env.example`](./.env.example) carries the fully annotated version (copy it to the repo root as `.env`).
