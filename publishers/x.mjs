/**
 * X (Twitter) publisher — posts tweets via Playwright browser automation.
 *
 * Connects to a Chromium instance running on the host via Chrome DevTools
 * Protocol (CDP). Uses playwright-core (no bundled browser needed).
 *
 * Start the host browser before launching the container:
 *   ./scripts/start-chrome.sh                    # headless
 *   HEADLESS=false ./scripts/start-chrome.sh     # headed, for first-time login
 *
 * Required env vars:
 *   X_CDP_URL        CDP base URL (default http://127.0.0.1:18810)
 *
 * Optional:
 *   X_POST_DELAY_MS  Delay between posts in ms (default 3000)
 */

import { chromium } from 'playwright-core';

const TWEET_MAX_LENGTH = 280;
const TCO_URL_LENGTH = 23;

/* ------------------------------------------------------------------ */
/*  Publisher interface                                               */
/* ------------------------------------------------------------------ */

export function validateConfig() {
  const cdp = process.env.X_CDP_URL || 'http://127.0.0.1:18810';
  console.log(`[X] CDP endpoint: ${cdp}`);
}

export function formatItems(items) {
  return items.map((item) => ({
    text: buildTweetText(item.source, item.title, item.link),
    itemId: item.id,
  }));
}

export async function post(payload, opts) {
  if (opts.dryRun) {
    console.log(`[X] DRY RUN:\n${payload.text}`);
    return { ok: true };
  }

  const cdpBase = (process.env.X_CDP_URL || 'http://127.0.0.1:18810').replace(/\/$/, '');
  const delayMs = Number(process.env.X_POST_DELAY_MS || 3000);

  try {
    const wsUrl = await getCdpWsUrl(cdpBase);
    const result = await postTweet(wsUrl, payload.text);
    if (delayMs > 0) await sleep(delayMs);
    return result;
  } catch (err) {
    console.error('[X] Post error:', err.message);
    return { ok: false, error: err.message };
  }
}

/* ------------------------------------------------------------------ */
/*  CDP target discovery                                              */
/* ------------------------------------------------------------------ */

async function getCdpWsUrl(cdpBase) {
  let res;
  try {
    res = await fetch(`${cdpBase}/json/version`, { signal: AbortSignal.timeout(5000) });
  } catch (err) {
    throw new Error(
      `Cannot reach Chrome CDP at ${cdpBase} — is the browser running? ` +
      `Run: scripts/start-chrome.sh (${err.message})`,
    );
  }

  if (!res.ok) throw new Error(`CDP /json/version HTTP ${res.status}`);
  const info = await res.json();
  if (!info.webSocketDebuggerUrl) throw new Error('No webSocketDebuggerUrl from CDP /json/version');
  return info.webSocketDebuggerUrl;
}

/* ------------------------------------------------------------------ */
/*  Playwright automation — post a tweet                             */
/* ------------------------------------------------------------------ */

async function postTweet(wsUrl, tweetText) {
  const browser = await chromium.connectOverCDP(wsUrl);
  try {
    // Use existing X page or open a new one
    const contexts = browser.contexts();
    let page = contexts
      .flatMap((c) => c.pages())
      .find((p) => p.url().includes('x.com') || p.url().includes('twitter.com'));

    if (!page) {
      const ctx = contexts[0] ?? await browser.newContext();
      page = await ctx.newPage();
    }

    // Navigate to compose intent URL — pre-fills the text box
    await page.goto(
      `https://x.com/intent/post?text=${encodeURIComponent(tweetText)}`,
      { waitUntil: 'domcontentloaded', timeout: 15000 },
    );

    // Detect login redirect
    if (/\/login|\/i\/flow\/login/.test(page.url())) {
      return {
        ok: false,
        error: 'Not logged into X. Run: HEADLESS=false scripts/start-chrome.sh and log in.',
      };
    }

    // Wait for the Post button to become enabled
    const postBtn = page.locator('[data-testid="tweetButton"],[data-testid="postButton"]').first();
    await postBtn.waitFor({ state: 'visible', timeout: 10000 });

    // Sometimes the button is rendered disabled while React hydrates; wait for enabled
    await page.waitForFunction(
      () => {
        const btn = document.querySelector('[data-testid="tweetButton"],[data-testid="postButton"]');
        return btn && !btn.disabled;
      },
      { timeout: 10000 },
    );

    await postBtn.click();

    // Wait for navigation away from compose (confirms post was accepted)
    try {
      await page.waitForURL((url) => !url.toString().includes('/intent/post'), { timeout: 8000 });
    } catch {
      // Some flows stay on same page — not necessarily an error
    }

    // Try to grab the new tweet ID from the page
    const tweetId = await page.evaluate(() =>
      ([...document.querySelectorAll('a[href*="/status/"]')].pop()?.href || '')
        .match(/status\/(\d+)/)?.[1] ?? null,
    ).catch(() => null);

    console.log(`[X] Posted${tweetId ? ` (id=${tweetId})` : ''}`);
    return { ok: true, id: tweetId };
  } finally {
    await browser.close();
  }
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                           */
/* ------------------------------------------------------------------ */

function buildTweetText(source, title, link) {
  const tag = `[${source}] `;
  const urlCost = link ? TCO_URL_LENGTH + 1 : 0;
  const available = TWEET_MAX_LENGTH - urlCost - tag.length;
  const body = available > 0 ? truncate(title.replace(/\s+/g, ' ').trim(), available) : '';
  return link ? `${tag}${body}\n${link}` : `${tag}${body}`;
}

function truncate(text, max) {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
