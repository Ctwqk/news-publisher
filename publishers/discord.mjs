const MAX_MESSAGE_LENGTH = 1990;

export function validateConfig() {
  const webhook = getWebhookUrl();
  if (webhook) {
    console.log('[Discord] Webhook configured');
  } else {
    console.log('[Discord] No webhook configured; channel will run in dry mode');
  }
}

export function formatItems(items, context = {}) {
  if (!Array.isArray(items) || items.length === 0) {
    return [];
  }

  const generatedAt = context.generatedAt || new Date().toISOString();
  const text = buildDiscordMessage(items, generatedAt);

  return [{
    title: `Discord digest (${items.length} items)`,
    source: 'discord',
    text,
    itemIds: items.map((item) => item.id),
    itemCount: items.length,
  }];
}

export async function post(payload, opts) {
  if (opts.dryRun) {
    console.log('[Discord] DRY RUN: digest preview');
    console.log(payload.text);
    return { ok: true };
  }

  const webhookUrl = getWebhookUrl();
  if (!webhookUrl) {
    return { ok: false, error: 'Discord webhook not configured' };
  }

  const chunks = splitDiscordMessage(payload.text, MAX_MESSAGE_LENGTH);
  for (let index = 0; index < chunks.length; index += 1) {
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: chunks[index] }),
      signal: AbortSignal.timeout(15000),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      return { ok: false, error: `Discord webhook failed (${response.status}): ${body.slice(0, 300)}` };
    }

    if (index < chunks.length - 1) {
      await sleep(1000);
    }
  }

  return { ok: true, id: `discord:${Date.now()}` };
}

function getWebhookUrl() {
  return String(
    process.env.NP_DISCORD_WEBHOOK_URL
    || process.env.DISCORD_WEBHOOK_URL
    || '',
  ).trim();
}

function buildDiscordMessage(items, generatedAt) {
  const header = `News Digest (${generatedAt})`;
  const lines = items.flatMap((item) => [
    `- [${item.source}] ${truncate(item.title, 220)}`,
    item.link ? `  ${item.link}` : null,
  ].filter(Boolean));

  return `${header}\n\n${lines.join('\n')}`;
}

function splitDiscordMessage(message, maxLength) {
  if (message.length <= maxLength) {
    return [message];
  }

  const chunks = [];
  let current = '';
  for (const line of message.split('\n')) {
    const next = current ? `${current}\n${line}` : line;
    if (next.length <= maxLength) {
      current = next;
      continue;
    }

    if (current) {
      chunks.push(current);
      current = line;
      continue;
    }

    let remaining = line;
    while (remaining.length > maxLength) {
      chunks.push(remaining.slice(0, maxLength));
      remaining = remaining.slice(maxLength);
    }
    current = remaining;
  }

  if (current) {
    chunks.push(current);
  }

  return chunks;
}

function truncate(text, max) {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
