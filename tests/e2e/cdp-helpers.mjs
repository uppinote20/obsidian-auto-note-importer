/**
 * Shared CDP (Chrome DevTools Protocol) helpers for E2E tests.
 *
 * Usage:
 *   import { findPageTarget, evalInObsidian } from './cdp-helpers.mjs';
 */

const CDP_PORT = process.env.CDP_PORT || 9222;

export async function findPageTarget() {
  const override = process.env.CDP_TARGET_ID;
  if (override) return override;

  const resp = await fetch(`http://localhost:${CDP_PORT}/json/list`);
  const targets = await resp.json();
  const page = targets.find(t => t.type === 'page' && t.url.includes('obsidian'));
  if (!page) throw new Error('No Obsidian page target found. Is Obsidian running with --remote-debugging-port?');
  return page.id;
}

export function evalInObsidian(targetId, expression, timeout = 20000) {
  const wsUrl = `ws://localhost:${CDP_PORT}/devtools/page/${targetId}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout (${timeout}ms)`)), timeout);
    const ws = new WebSocket(wsUrl);
    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({
        id: 1,
        method: 'Runtime.evaluate',
        params: { expression, awaitPromise: true, returnByValue: true }
      }));
    });
    ws.addEventListener('message', (e) => {
      const result = JSON.parse(e.data);
      if (result.id === 1) {
        clearTimeout(timer);
        if (result.result?.exceptionDetails) {
          resolve({ __error: result.result.exceptionDetails.exception?.description || 'Unknown error' });
        } else {
          try { resolve(JSON.parse(result.result.result.value)); }
          catch { resolve(result.result.result.value); }
        }
        ws.close();
      }
    });
    ws.addEventListener('error', (err) => { clearTimeout(timer); ws.close(); reject(err); });
  });
}
