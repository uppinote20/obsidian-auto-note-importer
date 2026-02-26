#!/bin/bash
set -euo pipefail

# Obsidian E2E Test Runner
# Usage: ./tests/e2e/start-e2e.sh [--cleanup]

CDP_PORT=9222

echo "=== Obsidian E2E Test Runner ==="

# 1. Check if Obsidian is already running with debug port
if curl -s "http://localhost:${CDP_PORT}/json/version" >/dev/null 2>&1; then
  echo "✓ Obsidian debug port already open on :${CDP_PORT}"
else
  echo "→ Restarting Obsidian with --remote-debugging-port=${CDP_PORT}..."
  pkill -f "Obsidian" 2>/dev/null || true
  sleep 2
  /Applications/Obsidian.app/Contents/MacOS/Obsidian --remote-debugging-port=${CDP_PORT} &>/dev/null &
  disown

  # Wait for CDP to be ready
  echo -n "→ Waiting for CDP"
  for i in $(seq 1 30); do
    if curl -s "http://localhost:${CDP_PORT}/json/version" >/dev/null 2>&1; then
      echo " ✓"
      break
    fi
    echo -n "."
    sleep 1
  done

  if ! curl -s "http://localhost:${CDP_PORT}/json/version" >/dev/null 2>&1; then
    echo " ✗ Failed to connect to CDP after 30s"
    exit 1
  fi
fi

# 2. Build & deploy latest plugin
echo "→ Building plugin..."
npm run build

VAULT_PLUGIN_DIR=$(node -e "
const ws = new WebSocket('ws://localhost:${CDP_PORT}/json');
// Find vault path from CDP
" 2>/dev/null || true)

# Try to find vault plugin directory from Obsidian
TARGET_ID=$(curl -s "http://localhost:${CDP_PORT}/json/list" | node -e "
const data=require('fs').readFileSync('/dev/stdin','utf8');
const targets=JSON.parse(data);
const page=targets.find(t=>t.type==='page'&&t.url.includes('obsidian'));
if(page) console.log(page.id);
")

if [ -n "$TARGET_ID" ]; then
  PLUGIN_DIR=$(node -e "
    const ws = new WebSocket('ws://localhost:${CDP_PORT}/devtools/page/${TARGET_ID}');
    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({
        id: 1,
        method: 'Runtime.evaluate',
        params: {
          expression: \`(() => {
            const adapter = app.vault.adapter;
            const basePath = adapter.basePath || adapter.getBasePath?.() || '';
            return JSON.stringify(basePath + '/.obsidian/plugins/auto-note-importer');
          })()\`,
          returnByValue: true
        }
      }));
    });
    ws.addEventListener('message', (e) => {
      const r = JSON.parse(e.data);
      if (r.id === 1) {
        console.log(JSON.parse(r.result.result.value));
        ws.close();
      }
    });
  " 2>/dev/null)

  if [ -n "$PLUGIN_DIR" ] && [ -d "$PLUGIN_DIR" ]; then
    echo "→ Deploying to ${PLUGIN_DIR}..."
    cp main.js manifest.json "$PLUGIN_DIR/"
    echo "✓ Plugin deployed"

    # Reload plugin
    echo "→ Reloading plugin..."
    node -e "
      const ws = new WebSocket('ws://localhost:${CDP_PORT}/devtools/page/${TARGET_ID}');
      ws.addEventListener('open', () => {
        ws.send(JSON.stringify({
          id: 1,
          method: 'Runtime.evaluate',
          params: {
            expression: \`(async () => {
              await app.plugins.disablePlugin('auto-note-importer');
              await app.plugins.enablePlugin('auto-note-importer');
              return 'ok';
            })()\`,
            awaitPromise: true,
            returnByValue: true
          }
        }));
      });
      ws.addEventListener('message', (e) => {
        const r = JSON.parse(e.data);
        if (r.id === 1) { console.log('✓ Plugin reloaded'); ws.close(); }
      });
    " 2>/dev/null
  fi
fi

# 3. Run E2E tests
echo ""
echo "=== Running E2E Tests ==="
node tests/e2e/run-e2e.mjs "$@"
EXIT_CODE=$?

# 4. Restart Obsidian in normal mode if tests passed
if [ $EXIT_CODE -eq 0 ]; then
  echo ""
  echo "→ Restarting Obsidian in normal mode..."
  pkill -f "Obsidian" 2>/dev/null || true
  sleep 1
  open /Applications/Obsidian.app
  echo "✓ Done!"
fi

exit $EXIT_CODE
