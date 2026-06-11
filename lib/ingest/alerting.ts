/**
 * Alerting discipline for a solo operator (spec §15):
 *   - ONLY Tier-A failures on phase<=1 sources page in real time (Telegram)
 *   - everything else accumulates in a Redis list, flushed once a day by
 *     the daily-digest processor
 * A solo founder cannot be woken by 31 sources; the system degrades
 * quietly and reports in batch.
 *
 * WORKER-ONLY MODULE (Redis via ioredis instance passed in).
 */

import type IORedis from 'ioredis'

export const DIGEST_KEY = 'arena:ingest:digest'

export interface IngestAlert {
  sourceSlug: string
  phase: number
  tier: 'A' | 'B' | 'C' | 'D' | 'maint'
  message: string
  at: string
}

async function sendTelegram(text: string): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN
  const chatId = process.env.TELEGRAM_ALERT_CHAT_ID ?? process.env.TELEGRAM_CHAT_ID
  if (!token || !chatId) {
    console.error('[ingest-alert] Telegram not configured; alert only logged:', text)
    return
  }
  const resp = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text }),
  })
  if (!resp.ok) {
    console.error('[ingest-alert] Telegram send failed:', resp.status, await resp.text())
  }
}

/** Route an alert: page now (phase<=1 Tier A) or queue for the digest. */
export async function alert(redis: IORedis, a: Omit<IngestAlert, 'at'>): Promise<void> {
  const full: IngestAlert = { ...a, at: new Date().toISOString() }
  const pages = a.tier === 'A' && a.phase <= 1
  if (pages) {
    await sendTelegram(`🚨 [ingest ${full.sourceSlug} Tier-${full.tier}] ${full.message}`)
  }
  // Everything (paged or not) lands in the digest for the daily summary.
  await redis.rpush(DIGEST_KEY, JSON.stringify(full))
  await redis.ltrim(DIGEST_KEY, -2000, -1) // bound the list
}

/** Drain and send the daily digest; returns the number of items flushed. */
export async function flushDigest(redis: IORedis): Promise<number> {
  const items = await redis.lrange(DIGEST_KEY, 0, -1)
  if (items.length === 0) return 0
  await redis.del(DIGEST_KEY)

  const bySource = new Map<string, IngestAlert[]>()
  for (const item of items) {
    try {
      const a = JSON.parse(item) as IngestAlert
      const list = bySource.get(a.sourceSlug) ?? []
      list.push(a)
      bySource.set(a.sourceSlug, list)
    } catch {
      // skip malformed entries
    }
  }

  const lines: string[] = [`📋 Ingest daily digest — ${items.length} events`]
  for (const [slug, alerts] of bySource) {
    lines.push(`\n${slug} (${alerts.length}):`)
    for (const a of alerts.slice(0, 5)) {
      lines.push(`  · [${a.tier}] ${a.message.slice(0, 160)}`)
    }
    if (alerts.length > 5) lines.push(`  · …and ${alerts.length - 5} more`)
  }
  await sendTelegram(lines.join('\n').slice(0, 4000))
  return items.length
}
