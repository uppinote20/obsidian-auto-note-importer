/**
 * Minimal .env loader for the e2e harnesses.
 *
 * Reads `.env` at the repo root (resolved relative to process.cwd()) and
 * sets any keys that are not already present in process.env. Quotes around
 * values are stripped, comments (lines starting with `#`) are skipped, and
 * malformed lines are silently ignored.
 *
 * Kept dependency-free on purpose so the e2e suites can run with just
 * `node tests/e2e/run-*.mjs` without a `npm install` for dotenv.
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

export function loadEnv(filename = '.env') {
  const path = resolve(process.cwd(), filename);
  if (!existsSync(path)) return false;

  const raw = readFileSync(path, 'utf8');
  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    const key = match[1];
    let value = match[2].trim();
    // Strip surrounding single or double quotes if balanced
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
  return true;
}
