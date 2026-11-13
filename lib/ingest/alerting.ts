/**
 * Alerting discipline for a solo operator (spec §15):
 *   - ONLY Tier-A failures on phase<=1 sources page in real time (Telegram)
 *   - everything else accumulates in a Redis list, flushed once a day by
 *     the daily-digest processor
 * A solo founder cannot be woken by 31 sources; the system degrades
 * quietly and reports in batch.
 *
 * Delivery reliability (2026-11 audit P1-5 / P1-3):
 *   - every Telegram call has a hard timeout and a bounded retry
 *     (network error / 429 / 5xx only — a 401 will not heal by retrying);
 *   - the page cooldown is released when the page was NOT delivered, so a
 *     Telegram outage does not silently swallow the same page for 6h;
 *   - the digest is drained atomically (MULTI LRANGE+DEL) and restored to
 *     the head of the list when the send fails, so a 401 day loses nothing;
 *   - every undelivered alert leaves a trace in Redis
 *     (ALERT_FAILURE_COUNT_KEY counter + ALERT_FAILURE_LOG_KEY bounded list)
 *     that an out-of-band check can read without Telegram working.
 *
 * WORKER-ONLY MODULE (Redis via ioredis instance passed in).
 */

import type IORedis from 'ioredis'

export const DIGEST_KEY = 'arena:ingest:digest'
export const ALERT_FAILURE_COUNT_KEY = 'arena:ingest:alert-failures:count'
export const ALERT_FAILURE_LOG_KEY = 'arena:ingest:alert-failures:log'
const ALERT_FAILURE_LOG_MAX = 200
const DIGEST_MAX = 2000

export interface IngestAlert {
  sourceSlug: string
  phase: number
  tier: 'A' | 'B' | 'C' | 'D' | 'maint'
  message: string
  at: string
}

export type TelegramDelivery =
  | { ok: true; attempts: number }
  | { ok: false; attempts: number; reason: string }

export interface TelegramSendOptions {
  /** Per-attempt timeout. */
  timeoutMs?: number
  /** Total attempts including the first. */
  maxAttempts?: number
  /** Injected for tests; defaults to a real timer. */
  sleep?: (ms: number) => Promise<void>
}

const DEFAULT_TIMEOUT_MS = 10_000
const DEFAULT_MAX_ATTEMPTS = 3

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500
}

/**
 * Send one Telegram message. Never throws: the caller gets an explicit
 * delivery result so it can release cooldowns / restore the digest and
 * record the failure.
 */
export async function sendTelegram(
  text: string,
  opts: TelegramSendOptions = {}
): Promise<TelegramDelivery> {
  const token = process.env.TELEGRAM_BOT_TOKEN
  const chatId = process.env.TELEGRAM_ALERT_CHAT_ID ?? process.env.TELEGRAM_CHAT_ID
  if (!token || !chatId) {
    console.error('[ingest-alert] Telegram not configured; alert only logged:', text)
    return { ok: false, attempts: 0, reason: 'telegram_not_configured' }
  }
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const maxAttempts = Math.max(1, opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS)
  const sleep = opts.sleep ?? realSleep

  let reason = 'unknown'
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let retryable = true
    try {
      const resp = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text }),
        signal: AbortSignal.timeout(timeoutMs),
      })
      if (resp.ok) return { ok: true, attempts: attempt }
      const body = await resp.text().catch(() => '')
      // Never echo the token: the response body is Telegram's own error text.
      reason = `http_${resp.status}${body ? `: ${body.slice(0, 200)}` : ''}`
      retryable = isRetryableStatus(resp.status)
    } catch (err) {
      reason = `network: ${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}`
    }
    console.error(
      `[ingest-alert] Telegram send failed (attempt ${attempt}/${maxAttempts}):`,
      reason
    )
    if (!retryable || attempt === maxAttempts) {
      return { ok: false, attempts: attempt, reason }
    }
    await sleep(500 * attempt)
  }
  return { ok: false, attempts: maxAttempts, reason }
}

/** Leave a durable trace of an undelivered alert. Best-effort: a Redis
 *  error here is logged, never thrown (the caller is already failing). */
async function recordDeliveryFailure(
  redis: IORedis,
  kind: 'page' | 'digest',
  reason: string,
  subject: string
): Promise<void> {
  try {
    await redis.incr(ALERT_FAILURE_COUNT_KEY)
    await redis.lpush(
      ALERT_FAILURE_LOG_KEY,
      JSON.stringify({ kind, reason, subject: subject.slice(0, 200), at: new Date().toISOString() })
    )
    await redis.ltrim(ALERT_FAILURE_LOG_KEY, 0, ALERT_FAILURE_LOG_MAX - 1)
  } catch (err) {
    console.error('[ingest-alert] could not record delivery failure in Redis:', err)
  }
}

/** A paged (source, tier) re-pages at most once per this window. The
 *  condition is re-asserted by the 30-min sentinel anyway — repeating the
 *  same page 48×/day is how 几百条/天 happened (2026-06-12: stalled sources
 *  × per-surface alerts × no cooldown). The daily digest keeps the full
 *  history regardless. */
const PAGE_COOLDOWN_SECONDS = 6 * 3600

export function pageCooldownKey(sourceSlug: string, tier: IngestAlert['tier']): string {
  return `arena:ingest:page-cooldown:${sourceSlug}:${tier}`
}

/** Route an alert: page now (phase<=1 Tier A, cooldown-gated) or queue for
 *  the digest. */
export async function alert(
  redis: IORedis,
  a: Omit<IngestAlert, 'at'>,
  sendOpts?: TelegramSendOptions
): Promise<void> {
  const full: IngestAlert = { ...a, at: new Date().toISOString() }
  const pages = a.tier === 'A' && a.phase <= 1
  // Everything (paged, cooled-down, or digest-tier) lands in the daily
  // digest — queued FIRST so a paging failure can never drop the record.
  await redis.rpush(DIGEST_KEY, JSON.stringify(full))
  await redis.ltrim(DIGEST_KEY, -DIGEST_MAX, -1) // bound the list

  if (!pages) return
  const key = pageCooldownKey(full.sourceSlug, full.tier)
  // Claim token: unique per call so the release below only deletes OUR claim.
  const token = `${full.at}#${Math.random().toString(36).slice(2, 10)}`
  // SET NX EX = atomic "first pager in the window wins" across workers.
  const gate = await redis.set(key, token, 'EX', PAGE_COOLDOWN_SECONDS, 'NX')
  if (gate !== 'OK') return

  const text = `🚨 [ingest ${full.sourceSlug} Tier-${full.tier}] ${full.message}`
  const delivery = await sendTelegram(text, sendOpts)
  if (delivery.ok) return

  // Not delivered: release the cooldown so the next sentinel pass retries
  // instead of being muted for 6h. Compare first so we never delete a
  // claim that expired and was re-taken by another worker.
  try {
    if ((await redis.get(key)) === token) await redis.del(key)
  } catch (err) {
    console.error('[ingest-alert] could not release page cooldown:', err)
  }
  await recordDeliveryFailure(redis, 'page', delivery.reason, text)
}

export class DigestDeliveryError extends Error {
  constructor(
    readonly itemCount: number,
    readonly reason: string
  ) {
    super(`ingest daily digest not delivered (${itemCount} events restored): ${reason}`)
    this.name = 'DigestDeliveryError'
  }
}

/** Atomically take every queued digest item. MULTI/EXEC guarantees no
 *  RPUSH can land between the read and the delete. */
async function drainDigest(redis: IORedis): Promise<string[]> {
  const res = await redis.multi().lrange(DIGEST_KEY, 0, -1).del(DIGEST_KEY).exec()
  if (!res) throw new Error('digest drain transaction aborted')
  const [lrangeErr, items] = res[0] ?? []
  if (lrangeErr) throw lrangeErr
  return Array.isArray(items) ? (items as string[]) : []
}

/** Put undelivered items back at the HEAD (preserving order), ahead of
 *  anything queued meanwhile, then re-apply the size bound. */
async function restoreDigest(redis: IORedis, items: string[]): Promise<void> {
  if (items.length === 0) return
  await redis.lpush(DIGEST_KEY, ...[...items].reverse())
  await redis.ltrim(DIGEST_KEY, -DIGEST_MAX, -1)
}

export function formatDigest(items: string[]): string {
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
  return lines.join('\n').slice(0, 4000)
}

/**
 * Drain and send the daily digest; returns the number of items flushed.
 * Throws DigestDeliveryError (after restoring the items) when the send
 * fails, so the BullMQ job is visibly failed instead of "succeeded".
 */
export async function flushDigest(redis: IORedis, sendOpts?: TelegramSendOptions): Promise<number> {
  const items = await drainDigest(redis)
  if (items.length === 0) return 0

  const delivery = await sendTelegram(formatDigest(items), sendOpts)
  if (delivery.ok) return items.length

  await restoreDigest(redis, items)
  await recordDeliveryFailure(redis, 'digest', delivery.reason, `digest of ${items.length} events`)
  throw new DigestDeliveryError(items.length, delivery.reason)
}
