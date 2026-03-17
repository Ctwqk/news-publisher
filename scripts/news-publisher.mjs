#!/usr/bin/env node

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

import { validatePublisher } from '../publishers/_interface.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

/* ------------------------------------------------------------------ */
/*  CLI args                                                          */
/* ------------------------------------------------------------------ */

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  printHelp();
  process.exit(0);
}

/* ------------------------------------------------------------------ */
/*  Config                                                            */
/* ------------------------------------------------------------------ */

const publisherName = (args.publisher || process.env.NP_PUBLISHER || '').trim();
if (!publisherName) {
  console.error('[Publisher] Missing --publisher or NP_PUBLISHER env var');
  process.exit(1);
}

const intervalMinutes = clampNumber(
  Number(args['interval-minutes'] ?? process.env.NP_INTERVAL_MINUTES ?? 60),
  5,
  24 * 60,
  60,
);

const dashboardPort = Number(args['dashboard-port'] || process.env.NP_DASHBOARD_PORT || 0);

const config = {
  publisherName,
  newsApiBase: normalizeBaseUrl(process.env.NP_NEWS_API_BASE || ''),
  newsLimit: clampNumber(Number(process.env.NP_NEWS_LIMIT || 100), 1, 100, 100),
  newsPage: clampNumber(Number(process.env.NP_NEWS_PAGE || 1), 1, 1000, 1),
  newsSearchBody: parseJsonObjectEnv(process.env.NP_NEWS_SEARCH_BODY),
  maxPostItems: clampNumber(Number(process.env.NP_MAX_POST_ITEMS || 5), 1, 50, 5),
  lookbackHours: clampNumber(Number(process.env.NP_LOOKBACK_HOURS || 24), 1, 24 * 14, 24),
  retainHours: clampNumber(Number(process.env.NP_RETAIN_HOURS || 24 * 7), 24, 24 * 600, 24 * 7),
  intervalMinutes,
  statePath: resolve(
    process.cwd(),
    args['state-path'] ||
      process.env.NP_STATE_PATH ||
      `data/${publisherName}-state.json`,
  ),
  dryRun: Boolean(args['dry-run'] || process.env.NP_DRY_RUN),
};

if (!config.newsApiBase) {
  console.error('[Publisher] Missing NP_NEWS_API_BASE env var');
  process.exit(1);
}

/* ------------------------------------------------------------------ */
/*  Runtime state (shared with dashboard)                             */
/* ------------------------------------------------------------------ */

const runtime = {
  startedAt: Date.now(),
  lastRunAt: 0,
  lastRunDurationMs: 0,
  lastPostedCount: 0,
  lastFetchedCount: 0,
  totalRuns: 0,
  totalPosted: 0,
  totalErrors: 0,
  isRunning: false,
  lastError: null,
  recentPosts: [],      // last N posts: { id, title, source, link, postedAt, platformId }
};

const MAX_RECENT_POSTS = 50;

/* ------------------------------------------------------------------ */
/*  Load publisher                                                    */
/* ------------------------------------------------------------------ */

const publisherPath = resolve(__dirname, '..', 'publishers', `${publisherName}.mjs`);
if (!existsSync(publisherPath)) {
  console.error(`[Publisher] Publisher module not found: publishers/${publisherName}.mjs`);
  process.exit(1);
}

const publisher = await import(publisherPath);
validatePublisher(publisher, publisherName);
publisher.validateConfig();

console.log(`[Publisher] Loaded publisher: ${publisherName}`);

/* ------------------------------------------------------------------ */
/*  Dashboard server                                                  */
/* ------------------------------------------------------------------ */

if (dashboardPort > 0) {
  startDashboard(dashboardPort);
}

/* ------------------------------------------------------------------ */
/*  Main loop                                                         */
/* ------------------------------------------------------------------ */

if (args.loop) {
  await runOnce(config, publisher);
  setInterval(() => {
    runOnce(config, publisher).catch((err) =>
      console.error('[Publisher] Loop run failed:', err?.message || err),
    );
  }, intervalMinutes * 60 * 1000);
  console.log(`[Publisher] Loop started. Interval: ${intervalMinutes} minutes`);
} else {
  const ok = await runOnce(config, publisher);
  if (!dashboardPort) process.exit(ok ? 0 : 1);
}

/* ------------------------------------------------------------------ */
/*  Core pipeline                                                     */
/* ------------------------------------------------------------------ */

async function runOnce(config, publisher) {
  if (runtime.isRunning) {
    console.warn('[Publisher] Already running, skipping');
    return false;
  }
  runtime.isRunning = true;
  const startedAt = Date.now();

  try {
    // 1. Fetch news from API
    const { items, endpoint } = await fetchNewsItems(config);
    console.log(`[Publisher] Loaded ${items.length} items from ${endpoint}`);
    runtime.lastFetchedCount = items.length;

    // 2. Load & prune state
    const state = loadState(config.statePath);
    pruneState(state, config.retainHours);

    // 3. Dedupe, filter, select
    const now = Date.now();
    const lookbackMs = config.lookbackHours * 60 * 60 * 1000;
    const selected = items
      .filter((item) => now - item.pubDateMs <= lookbackMs)
      .filter((item) => !state.sent[item.id])
      .sort((a, b) => b.pubDateMs - a.pubDateMs)
      .slice(0, config.maxPostItems);

    if (selected.length === 0) {
      console.log('[Publisher] No new items to post');
      runtime.lastRunAt = now;
      runtime.lastRunDurationMs = Date.now() - startedAt;
      runtime.lastPostedCount = 0;
      runtime.totalRuns += 1;
      runtime.lastError = null;
      return true;
    }

    // 4. Format via publisher
    const payloadItems = selected.map((item) => ({
      id: item.id,
      source: item.source,
      title: item.title,
      link: item.link,
      pubDate: new Date(item.pubDateMs).toISOString(),
    }));

    const formatted = publisher.formatItems(payloadItems);

    // 5. Post each payload
    let posted = 0;
    for (const payload of formatted) {
      const result = await publisher.post(payload, { dryRun: config.dryRun });
      if (result.ok) {
        posted += 1;
        if (payload.itemId) {
          state.sent[payload.itemId] = now;
        }
        // Track in recent posts
        const matchedItem = selected.find((s) => s.id === payload.itemId);
        runtime.recentPosts.unshift({
          id: payload.itemId || '',
          title: matchedItem?.title || payload.text?.slice(0, 80) || '',
          source: matchedItem?.source || '',
          link: matchedItem?.link || '',
          postedAt: new Date(now).toISOString(),
          platformId: result.id || null,
          dryRun: config.dryRun,
        });
        if (runtime.recentPosts.length > MAX_RECENT_POSTS) {
          runtime.recentPosts.length = MAX_RECENT_POSTS;
        }
        if (result.id) {
          console.log(`[Publisher] Posted (id=${result.id})`);
        }
      } else {
        runtime.totalErrors += 1;
        console.warn(`[Publisher] Post failed: ${result.error || 'unknown'}`);
        if (result.error === 'rate_limited') {
          console.warn('[Publisher] Rate limited — skipping remaining items this run');
          break;
        }
      }
    }

    // Mark all selected items as sent
    for (const item of selected) {
      if (!state.sent[item.id]) {
        state.sent[item.id] = now;
      }
    }

    state.lastRunAt = now;
    state.lastPostedCount = posted;
    writeJson(config.statePath, state);

    runtime.lastRunAt = now;
    runtime.lastRunDurationMs = Date.now() - startedAt;
    runtime.lastPostedCount = posted;
    runtime.totalPosted += posted;
    runtime.totalRuns += 1;
    runtime.lastError = null;

    const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
    console.log(`[Publisher] Done: ${posted}/${selected.length} posted in ${elapsed}s`);
    return true;
  } catch (err) {
    runtime.totalErrors += 1;
    runtime.totalRuns += 1;
    runtime.lastRunAt = Date.now();
    runtime.lastRunDurationMs = Date.now() - startedAt;
    runtime.lastError = err?.message || String(err);
    console.error('[Publisher] Run failed:', err?.message || err);
    return false;
  } finally {
    runtime.isRunning = false;
  }
}

/* ------------------------------------------------------------------ */
/*  Dashboard HTTP server                                             */
/* ------------------------------------------------------------------ */

function startDashboard(port) {
  const dashboardHtmlPath = resolve(__dirname, '..', 'dashboard', 'index.html');

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${port}`);
    const path = url.pathname;

    // CORS headers for local dev
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    try {
      if (path === '/api/status') {
        const state = loadState(config.statePath);
        const sentCount = Object.keys(state.sent).length;
        const nextRunAt = runtime.lastRunAt > 0
          ? runtime.lastRunAt + config.intervalMinutes * 60 * 1000
          : runtime.startedAt + config.intervalMinutes * 60 * 1000;

        json(res, {
          publisher: config.publisherName,
          dryRun: config.dryRun,
          isRunning: runtime.isRunning,
          uptime: Date.now() - runtime.startedAt,
          lastRunAt: runtime.lastRunAt ? new Date(runtime.lastRunAt).toISOString() : null,
          lastRunDurationMs: runtime.lastRunDurationMs,
          lastFetchedCount: runtime.lastFetchedCount,
          lastPostedCount: runtime.lastPostedCount,
          nextRunAt: new Date(nextRunAt).toISOString(),
          totalRuns: runtime.totalRuns,
          totalPosted: runtime.totalPosted,
          totalErrors: runtime.totalErrors,
          lastError: runtime.lastError,
          sentTracked: sentCount,
          config: {
            newsApiBase: config.newsApiBase,
            maxPostItems: config.maxPostItems,
            lookbackHours: config.lookbackHours,
            intervalMinutes: config.intervalMinutes,
            retainHours: config.retainHours,
          },
        });
      } else if (path === '/api/history') {
        json(res, { posts: runtime.recentPosts });
      } else if (path === '/api/run' && req.method === 'POST') {
        if (runtime.isRunning) {
          json(res, { ok: false, error: 'Already running' }, 409);
        } else {
          // Fire and forget — respond immediately
          runOnce(config, publisher).catch((err) =>
            console.error('[Publisher] Manual run failed:', err?.message || err),
          );
          json(res, { ok: true, message: 'Run triggered' });
        }
      } else if (path === '/' || path === '/index.html') {
        if (existsSync(dashboardHtmlPath)) {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(readFileSync(dashboardHtmlPath, 'utf8'));
        } else {
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          res.end('Dashboard HTML not found');
        }
      } else {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not found');
      }
    } catch (err) {
      console.error('[Dashboard] Error:', err?.message || err);
      json(res, { error: 'Internal server error' }, 500);
    }
  });

  server.listen(port, '0.0.0.0', () => {
    console.log(`[Dashboard] Listening on http://0.0.0.0:${port}`);
  });
}

function json(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

/* ------------------------------------------------------------------ */
/*  News API fetcher                                                  */
/* ------------------------------------------------------------------ */

async function fetchNewsItems(config) {
  const endpoint = `${config.newsApiBase}/open/news_search`;
  const requestBody = {
    ...config.newsSearchBody,
    limit: config.newsLimit,
    page: config.newsPage,
  };

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': 'NewsPublisher/1.0',
    },
    body: JSON.stringify(requestBody),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`News API failed (${response.status}): ${body.slice(0, 300)}`);
  }

  const payload = await response.json();
  const rows = Array.isArray(payload?.data) ? payload.data : [];
  const items = rows.map((row) => mapNewsItem(row)).filter(Boolean);

  return { items, endpoint };
}

function mapNewsItem(row) {
  const title = String(row?.text || '').trim();
  if (!title) return null;

  const link = String(row?.link || '').trim();
  const source = String(
    row?.newsType || row?.engineType || safeHostname(link) || 'news',
  ).trim();
  const identity = String(row?.id || `${source}|${link || title}`).trim();
  if (!identity) return null;

  return {
    id: identity,
    source,
    title,
    link,
    pubDateMs: parseDateMs(row?.ts),
  };
}

/* ------------------------------------------------------------------ */
/*  State management                                                  */
/* ------------------------------------------------------------------ */

function loadState(statePath) {
  if (!existsSync(statePath)) {
    return { lastRunAt: 0, lastPostedCount: 0, sent: {} };
  }
  try {
    const parsed = JSON.parse(readFileSync(statePath, 'utf8'));
    return {
      lastRunAt: Number(parsed?.lastRunAt || 0),
      lastPostedCount: Number(parsed?.lastPostedCount || 0),
      sent: typeof parsed?.sent === 'object' && parsed.sent ? parsed.sent : {},
    };
  } catch {
    return { lastRunAt: 0, lastPostedCount: 0, sent: {} };
  }
}

function pruneState(state, retainHours) {
  const cutoff = Date.now() - retainHours * 60 * 60 * 1000;
  for (const [key, ts] of Object.entries(state.sent)) {
    if (!Number.isFinite(Number(ts)) || Number(ts) < cutoff) {
      delete state.sent[key];
    }
  }
}

function writeJson(path, payload) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(payload, null, 2), 'utf8');
}

/* ------------------------------------------------------------------ */
/*  Utilities                                                         */
/* ------------------------------------------------------------------ */

function safeHostname(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return 'unknown';
  }
}

function parseDateMs(raw) {
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    return raw > 1e12 ? raw : raw * 1000;
  }
  const ms = Date.parse(raw);
  if (Number.isFinite(ms)) return ms;
  return Date.now();
}

function stableHash(input) {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
  }
  return (hash >>> 0).toString(36);
}

function clampNumber(value, min, max, fallback) {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

function normalizeBaseUrl(value) {
  const trimmed = String(value || '').trim();
  if (!trimmed) return '';
  return trimmed.replace(/\/+$/, '');
}

function parseJsonObjectEnv(value) {
  const trimmed = String(value || '').trim();
  if (!trimmed) return {};
  try {
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (error) {
    console.warn(
      '[Publisher] Failed to parse NP_NEWS_SEARCH_BODY:',
      error?.message || String(error),
    );
    return {};
  }
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--loop') {
      out.loop = true;
      continue;
    }
    if (token === '--dry-run') {
      out['dry-run'] = true;
      continue;
    }
    if (token === '--help' || token === '-h') {
      out.help = true;
      continue;
    }
    if (token.startsWith('--')) {
      const [key, value] = token.slice(2).split('=');
      if (value !== undefined) {
        out[key] = value;
      } else if (argv[i + 1] && !argv[i + 1].startsWith('--')) {
        out[key] = argv[i + 1];
        i += 1;
      } else {
        out[key] = true;
      }
    }
  }
  return out;
}

function printHelp() {
  console.log(`news-publisher — extensible multi-platform news publisher

Usage:
  node scripts/news-publisher.mjs --publisher=x [--loop] [--dry-run] [--interval-minutes=60]
                                  [--dashboard-port=7700]

Core env vars (NP_ prefix):
  NP_PUBLISHER            Publisher module name (required, e.g. "x")
  NP_NEWS_API_BASE        News server base URL (required, e.g. http://localhost:6551)
  NP_NEWS_LIMIT           Items per API page (default 100)
  NP_NEWS_PAGE            API page number (default 1)
  NP_NEWS_SEARCH_BODY     Extra JSON merged into /open/news_search body
  NP_MAX_POST_ITEMS       Max posts per run (default 5)
  NP_LOOKBACK_HOURS       Freshness window in hours (default 24)
  NP_RETAIN_HOURS         State retention in hours (default 168 = 7 days)
  NP_INTERVAL_MINUTES     Loop interval in minutes (default 60)
  NP_STATE_PATH           State file path (default data/{publisher}-state.json)
  NP_DRY_RUN              Truthy = dry run mode
  NP_DASHBOARD_PORT       Dashboard HTTP port (default 0 = disabled)

Publisher-specific env vars depend on the selected publisher module.
See publishers/*.mjs for details.

Dashboard API (when NP_DASHBOARD_PORT is set):
  GET  /              Dashboard UI
  GET  /api/status    Publisher status & config
  GET  /api/history   Recent post history
  POST /api/run       Trigger a manual run
`);
}
