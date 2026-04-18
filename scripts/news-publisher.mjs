#!/usr/bin/env node

import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { validatePublisher } from '../publishers/_interface.mjs';

const CACHE_KEY = 'worldmonitor:hourly-news:latest';
const MAX_RECENT_POSTS = 120;
const DEFAULT_CHANNELS = ['x', 'discord'];
const DEFAULT_CHANNEL_LIMITS = {
  x: 5,
  discord: 15,
};
const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  printHelp();
  process.exit(0);
}

const configuredChannels = parseChannels(args.channels || process.env.NP_CHANNELS || DEFAULT_CHANNELS.join(','));
if (configuredChannels.length === 0) {
  console.error('[Publisher] No channels configured. Set NP_CHANNELS to at least one channel.');
  process.exit(1);
}

const config = {
  newsApiBase: normalizeBaseUrl(process.env.NP_NEWS_API_BASE || ''),
  newsLimit: clampNumber(Number(args['news-limit'] ?? process.env.NP_NEWS_LIMIT ?? 100), 1, 100, 100),
  newsPage: clampNumber(Number(args['news-page'] ?? process.env.NP_NEWS_PAGE ?? 1), 1, 1000, 1),
  newsSearchBody: parseJsonObjectEnv(process.env.NP_NEWS_SEARCH_BODY),
  lookbackHours: clampNumber(Number(args['lookback-hours'] ?? process.env.NP_LOOKBACK_HOURS ?? 24), 1, 24 * 14, 24),
  retainHours: clampNumber(Number(args['retain-hours'] ?? process.env.NP_RETAIN_HOURS ?? 24 * 7), 24, 24 * 600, 24 * 7),
  statePath: resolve(ROOT_DIR, args['state-path'] || process.env.NP_STATE_PATH || 'data/distributor-state.json'),
  historyPath: resolve(ROOT_DIR, args['history-path'] || process.env.NP_HISTORY_PATH || 'data/distributor-history.json'),
  lockPath: resolve(ROOT_DIR, args['lock-path'] || process.env.NP_LOCK_PATH || 'data/distributor-run.lock'),
  dryRun: isTruthy(args['dry-run'] || process.env.NP_DRY_RUN),
  channels: configuredChannels.map((name) => buildChannelConfig(name, args)),
  cache: {
    enabled: !isFalsey(process.env.NP_CACHE_ENABLED),
    maxItems: clampNumber(Number(args['cache-max-items'] ?? process.env.NP_CACHE_MAX_ITEMS ?? 15), 1, 50, 15),
    path: resolve(ROOT_DIR, args['cache-path'] || process.env.NP_CACHE_PATH || 'data/hourly-news-cache.json'),
  },
};

if (!config.newsApiBase) {
  console.error('[Publisher] Missing NP_NEWS_API_BASE env var');
  process.exit(1);
}

const publishers = await loadPublishers(config.channels);
for (const channel of config.channels) {
  const entry = publishers.get(channel.name);
  validatePublisher(entry.mod, channel.name);
  if (!channel.enabled) {
    console.log(`[Publisher] Skipping validation for disabled channel: ${channel.name}`);
    continue;
  }
  await entry.mod.validateConfig(channel);
}
console.log(`[Publisher] Loaded channels: ${config.channels.map((channel) => channel.name).join(', ')}`);

const ok = await runOnce(config, publishers);
process.exit(ok ? 0 : 1);

async function runOnce(config, publishers) {
  let releaseLock = null;
  const startedAt = Date.now();

  try {
    releaseLock = acquireLock(config.lockPath);
  } catch (err) {
    console.warn(`[Publisher] ${err.message}`);
    return false;
  }

  const state = loadState(config);
  const history = loadHistory(config.historyPath);

  state.lastError = null;
  syncStateConfig(state, config);
  state.totalRuns += 1;

  try {
    const { items, endpoint } = await fetchNewsItems(config);
    console.log(`[Publisher] Loaded ${items.length} items from ${endpoint}`);

    const now = Date.now();
    pruneState(state, config.retainHours);

    const eligible = items
      .filter((item) => now - item.pubDateMs <= config.lookbackHours * 60 * 60 * 1000)
      .sort((a, b) => b.pubDateMs - a.pubDateMs);

    state.lastRunAt = now;
    state.lastRunDurationMs = Date.now() - startedAt;
    state.lastFetchedCount = items.length;
    state.lastEligibleCount = eligible.length;
    state.lastError = null;

    const cachePayload = buildCachePayload(eligible, items.length, config);
    if (config.cache.enabled) {
      writeJson(config.cache.path, cachePayload);
      await writeRemoteCache(cachePayload);
      state.cache.lastGeneratedAt = cachePayload.generatedAt;
      state.cache.postedItemCount = cachePayload.postedItemCount;
      state.cache.lastPath = config.cache.path;
    }

    for (const channelConfig of config.channels) {
      const channelState = state.channels[channelConfig.name];
      channelState.enabled = channelConfig.enabled;
      channelState.dryRun = channelConfig.dryRun;
      channelState.maxPostItems = channelConfig.maxPostItems;

      if (!channelConfig.enabled) {
        channelState.lastPostedCount = 0;
        channelState.lastSkippedReason = 'disabled';
        continue;
      }

      const pendingItems = eligible
        .filter((item) => !channelState.sent[item.id])
        .slice(0, channelConfig.maxPostItems);

      channelState.lastRunAt = new Date(now).toISOString();
      channelState.lastError = null;
      channelState.lastSkippedReason = '';
      channelState.lastSelectedCount = pendingItems.length;

      if (pendingItems.length === 0) {
        channelState.lastPostedCount = 0;
        console.log(`[Publisher] Channel ${channelConfig.name}: no new items`);
        continue;
      }

      const payloadItems = pendingItems.map((item) => ({
        id: item.id,
        source: item.source,
        title: item.title,
        link: item.link,
        summary: item.summary,
        pubDate: new Date(item.pubDateMs).toISOString(),
      }));

      const publisher = publishers.get(channelConfig.name).mod;
      const payloads = publisher.formatItems(payloadItems, {
        channel: channelConfig.name,
        generatedAt: cachePayload.generatedAt,
      });

      let postedCount = 0;
      for (const payload of payloads) {
        const result = await publisher.post(payload, {
          dryRun: channelConfig.dryRun,
          channel: channelConfig.name,
        });
        const itemIds = Array.isArray(payload.itemIds)
          ? payload.itemIds.filter(Boolean)
          : payload.itemId ? [payload.itemId] : [];

        if (!result.ok) {
          channelState.lastError = result.error || 'unknown error';
          channelState.totalErrors += 1;
          state.totalErrors += 1;
          console.warn(`[Publisher] Channel ${channelConfig.name} failed: ${channelState.lastError}`);
          continue;
        }

        for (const itemId of itemIds) {
          channelState.sent[itemId] = now;
        }

        postedCount += itemIds.length || 1;
        channelState.totalPosted += itemIds.length || 1;
        history.unshift({
          channel: channelConfig.name,
          title: String(payload.title || payload.text || '').trim().slice(0, 200),
          source: String(payload.source || (itemIds.length > 1 ? 'digest' : pendingItems.find((item) => item.id === itemIds[0])?.source || '')).trim(),
          link: String(payload.link || (itemIds.length === 1 ? pendingItems.find((item) => item.id === itemIds[0])?.link || '' : '')).trim(),
          itemCount: itemIds.length || 1,
          itemIds,
          postedAt: new Date(now).toISOString(),
          platformId: result.id || null,
          dryRun: channelConfig.dryRun,
        });
      }

      channelState.lastPostedCount = postedCount;
    }

    history.length = Math.min(history.length, MAX_RECENT_POSTS);
    writeJson(config.statePath, state);
    writeJson(config.historyPath, history);

    const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
    console.log(`[Publisher] Done in ${elapsed}s`);
    return true;
  } catch (err) {
    state.lastRunAt = Date.now();
    state.lastRunDurationMs = Date.now() - startedAt;
    state.totalErrors += 1;
    state.lastError = err?.message || String(err);
    writeJson(config.statePath, state);
    writeJson(config.historyPath, history);
    console.error('[Publisher] Run failed:', state.lastError);
    return false;
  } finally {
    if (releaseLock) {
      releaseLock();
    }
  }
}

function buildChannelConfig(name, args) {
  const upper = name.toUpperCase().replace(/-/g, '_');
  const enabled = !isFalsey(process.env[`NP_${upper}_ENABLED`]);
  const explicitDryRun = process.env[`NP_${upper}_DRY_RUN`];
  const maxDefault = DEFAULT_CHANNEL_LIMITS[name] || 5;
  const maxPostItems = clampNumber(
    Number(args[`${name}-max-items`] ?? process.env[`NP_${upper}_MAX_POST_ITEMS`] ?? maxDefault),
    1,
    50,
    maxDefault,
  );

  const dryRun = name === 'discord'
    ? (isTruthy(explicitDryRun) || isTruthy(args['dry-run'] || process.env.NP_DRY_RUN) || !getDiscordWebhookUrl())
    : isTruthy(explicitDryRun) || isTruthy(args['dry-run'] || process.env.NP_DRY_RUN);

  return {
    name,
    enabled,
    dryRun,
    maxPostItems,
  };
}

async function loadPublishers(channels) {
  const loaded = new Map();
  for (const channel of channels) {
    const mod = await import(resolve(ROOT_DIR, 'publishers', `${channel.name}.mjs`));
    loaded.set(channel.name, { name: channel.name, mod });
  }
  return loaded;
}

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
      'User-Agent': 'NewsPublisher/2.0',
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
  const source = String(row?.newsType || row?.engineType || safeHostname(link) || 'news').trim();
  const identity = String(row?.id || `${source}|${link || title}`).trim();
  if (!identity) return null;

  return {
    id: identity,
    source,
    title,
    link,
    summary: String(row?.summary || row?.abstract || '').trim(),
    pubDateMs: parseDateMs(row?.ts),
  };
}

function loadState(config) {
  const base = {
    lastRunAt: 0,
    lastRunDurationMs: 0,
    lastFetchedCount: 0,
    lastEligibleCount: 0,
    totalRuns: 0,
    totalErrors: 0,
    lastError: null,
    cache: {
      lastGeneratedAt: null,
      postedItemCount: 0,
      lastPath: config.cache.path,
    },
    channels: {},
  };

  if (!existsSync(config.statePath)) {
    syncStateConfig(base, config);
    return base;
  }

  try {
    const parsed = JSON.parse(readFileSync(config.statePath, 'utf8'));
    const merged = {
      ...base,
      ...parsed,
      cache: {
        ...base.cache,
        ...(parsed?.cache || {}),
      },
      channels: typeof parsed?.channels === 'object' && parsed.channels ? parsed.channels : {},
    };
    syncStateConfig(merged, config);
    return merged;
  } catch {
    syncStateConfig(base, config);
    return base;
  }
}

function syncStateConfig(state, config) {
  for (const channel of config.channels) {
    const current = state.channels[channel.name] || {};
    state.channels[channel.name] = {
      enabled: channel.enabled,
      dryRun: channel.dryRun,
      maxPostItems: channel.maxPostItems,
      lastRunAt: current.lastRunAt || null,
      lastPostedCount: Number(current.lastPostedCount || 0),
      lastSelectedCount: Number(current.lastSelectedCount || 0),
      totalPosted: Number(current.totalPosted || 0),
      totalErrors: Number(current.totalErrors || 0),
      lastError: current.lastError || null,
      lastSkippedReason: current.lastSkippedReason || '',
      sent: typeof current.sent === 'object' && current.sent ? current.sent : {},
    };
  }
}

function pruneState(state, retainHours) {
  const cutoff = Date.now() - retainHours * 60 * 60 * 1000;
  for (const channelState of Object.values(state.channels)) {
    for (const [key, ts] of Object.entries(channelState.sent || {})) {
      if (!Number.isFinite(Number(ts)) || Number(ts) < cutoff) {
        delete channelState.sent[key];
      }
    }
  }
}

function loadHistory(historyPath) {
  if (!existsSync(historyPath)) {
    return [];
  }
  try {
    const parsed = JSON.parse(readFileSync(historyPath, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function buildCachePayload(eligibleItems, fetchedItemCount, config) {
  const now = new Date().toISOString();
  const selected = eligibleItems.slice(0, config.cache.maxItems);
  return {
    generatedAt: now,
    fetchedAt: now,
    fetchedFeedCount: 1,
    fetchedItemCount,
    postedItemCount: selected.length,
    sourceMode: 'news-api',
    items: selected.map((item) => ({
      id: item.id,
      source: item.source,
      title: item.title,
      link: item.link,
      pubDate: new Date(item.pubDateMs).toISOString(),
    })),
  };
}

async function writeRemoteCache(payload) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) {
    return;
  }

  try {
    const endpoint = `${url.replace(/\/$/, '')}/set/${encodeURIComponent(CACHE_KEY)}`;
    await fetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify([JSON.stringify(payload), 'EX', 60 * 60 * 24 * 3]),
    });
  } catch (err) {
    console.warn('[Publisher] Upstash cache write failed:', err?.message || String(err));
  }
}

function acquireLock(lockPath) {
  mkdirSync(dirname(lockPath), { recursive: true });

  if (existsSync(lockPath)) {
    try {
      const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
      if (Number.isInteger(lock?.pid) && processExists(lock.pid)) {
        throw new Error(`Another publisher run is active (pid=${lock.pid})`);
      }
      unlinkSync(lockPath);
    } catch (err) {
      if (err instanceof SyntaxError) {
        unlinkSync(lockPath);
      } else {
        throw err;
      }
    }
  }

  const fd = openSync(lockPath, 'wx');
  writeFileSync(fd, JSON.stringify({
    pid: process.pid,
    startedAt: new Date().toISOString(),
  }, null, 2));
  closeSync(fd);

  return () => {
    try {
      unlinkSync(lockPath);
    } catch {
      // best effort
    }
  };
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function writeJson(path, payload) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(payload, null, 2), 'utf8');
}

function getDiscordWebhookUrl() {
  return String(process.env.NP_DISCORD_WEBHOOK_URL || process.env.DISCORD_WEBHOOK_URL || process.env.WM_DISCORD_WEBHOOK_URL || '').trim();
}

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
    console.warn('[Publisher] Failed to parse NP_NEWS_SEARCH_BODY:', error?.message || String(error));
    return {};
  }
}

function parseChannels(raw) {
  return [...new Set(String(raw || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean))];
}

function isTruthy(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value || '').trim().toLowerCase());
}

function isFalsey(value) {
  return ['0', 'false', 'no', 'off'].includes(String(value || '').trim().toLowerCase());
}

function parseArgs(argv) {
  const out = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--help' || token === '-h') {
      out.help = true;
      continue;
    }
    if (token === '--dry-run') {
      out['dry-run'] = true;
      continue;
    }
    if (token.startsWith('--')) {
      const [key, value] = token.slice(2).split('=');
      if (value !== undefined) {
        out[key] = value;
      } else if (argv[index + 1] && !argv[index + 1].startsWith('--')) {
        out[key] = argv[index + 1];
        index += 1;
      } else {
        out[key] = true;
      }
    }
  }
  return out;
}

function printHelp() {
  console.log(`news-publisher — unified multi-channel news distributor

Usage:
  node scripts/news-publisher.mjs [--dry-run] [--channels=x,discord]

Core env vars:
  NP_NEWS_API_BASE              News server base URL (required)
  NP_CHANNELS                   Comma-separated channels (default: x,discord)
  NP_LOOKBACK_HOURS             Freshness window in hours (default 24)
  NP_RETAIN_HOURS               State retention in hours (default 168)
  NP_STATE_PATH                 Distributor state file
  NP_HISTORY_PATH               Delivery history file
  NP_LOCK_PATH                  Run lock file
  NP_CACHE_PATH                 World Monitor cache file
  NP_CACHE_MAX_ITEMS            Cache item count (default 15)
  NP_DRY_RUN                    Dry-run all channels

Channel env vars:
  NP_X_ENABLED                  Enable X posting
  NP_X_MAX_POST_ITEMS           Max X posts per run
  NP_DISCORD_ENABLED            Enable Discord digest posting
  NP_DISCORD_MAX_POST_ITEMS     Max news items included in the Discord digest
  NP_DISCORD_WEBHOOK_URL        Discord webhook URL

Support env vars:
  XBOT_URL                      x-bot service base URL for X delivery
  UPSTASH_REDIS_REST_URL        Optional remote cache write
  UPSTASH_REDIS_REST_TOKEN      Optional remote cache write
`);
}
