/**
 * x-bot publisher bridge — delegates to the standalone x-bot service.
 *
 * The x-bot service handles MiniMax content generation and Playwright posting.
 * This plugin just formats the request and forwards it over HTTP.
 *
 * Required env vars:
 *   XBOT_URL   x-bot service base URL (default http://127.0.0.1:7710)
 */

const XBOT_URL = (process.env.XBOT_URL || 'http://127.0.0.1:7710').replace(/\/$/, '');

/* ------------------------------------------------------------------ */
/*  Publisher interface                                               */
/* ------------------------------------------------------------------ */

export async function validateConfig() {
  if (isTruthy(process.env.NP_DRY_RUN) || isTruthy(process.env.NP_X_DRY_RUN)) {
    console.log('[x-bot] Dry-run enabled; skipping backend health check');
    return;
  }

  let res;
  try {
    res = await fetch(`${XBOT_URL}/health`, { signal: AbortSignal.timeout(10000) });
  } catch (err) {
    throw new Error(`[x-bot] Cannot reach x-bot service at ${XBOT_URL}: ${err.message}`);
  }
  if (!res.ok) {
    throw new Error(`[x-bot] Health check failed with HTTP ${res.status}`);
  }
  const data = await res.json();
  console.log(`[x-bot] Service ok — model: ${data.model}, cdp: ${data.cdp}`);
  if (!data.cdp) {
    console.warn('[x-bot] Warning: backend reachable but /health reported cdp=false');
  }
}

export function formatItems(items) {
  // Formatting (LLM generation) happens inside the x-bot service
  return items.map((item) => ({
    source: item.source,
    title: item.title,
    link: item.link,
    summary: item.summary,
    itemId: item.id,
  }));
}

export async function post(payload, opts) {
  if (opts.dryRun) {
    console.log(`[x-bot] DRY RUN: ${payload.title} (${payload.source})`);
    return { ok: true };
  }

  try {
    const res = await fetch(`${XBOT_URL}/post`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        source: payload.source,
        title: payload.title,
        link: payload.link,
        summary: payload.summary,
      }),
      signal: AbortSignal.timeout(60000),
    });
    const data = await res.json();
    return data;
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

function isTruthy(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value || '').trim().toLowerCase());
}
