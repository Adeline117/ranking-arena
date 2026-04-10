#!/usr/bin/env node
/**
 * Weekly Product Metrics → Telegram
 *
 * Tracks the three numbers that matter most post-paywall:
 *   1. WAU (Weekly Active Users) — distinct users in user_activity in last 7d
 *   2. Paying subscribers — subscriptions with status in (active, trialing) and tier != free
 *   3. Top-10 trust ratio — fraction of top-10 leaderboard_ranks where
 *      joined trader_sources.score_confidence = 'full'
 *
 * CEO review 2026-04-09 flagged that without these numbers, every product
 * decision is a guess. This script is designed to run weekly on Fridays
 * from the OpenClaw scheduler and post the result to Telegram.
 *
 * Known limitations (2026-04-09):
 *   - WAU relies on user_activity table being populated by client tracking,
 *     which may be sparse if analytics aren't firing on all pages.
 *
 * Usage:
 *   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... TELEGRAM_BOT_TOKEN=... \
 *   TELEGRAM_ALERT_CHAT_ID=... node scripts/openclaw/weekly-metrics.mjs
 *
 * Flags:
 *   --dry-run   Print the report but don't send to Telegram
 *   --silent    Skip if Telegram env vars missing (cron-friendly)
 */

import path from 'path'
import { fileURLToPath } from 'url'
import { config as dotenvConfig } from 'dotenv'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
dotenvConfig({ path: path.resolve(__dirname, '../../.env') })
dotenvConfig({ path: path.resolve(__dirname, '../../.env.local'), override: false })

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_ALERT_CHAT_ID

const isDryRun = process.argv.includes('--dry-run')
const isSilent = process.argv.includes('--silent')

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY env vars')
  process.exit(1)
}

// ---------------------------------------------------------------------------
// Supabase REST helper (no SDK dep — this runs on Mac Mini, keep it light)
// ---------------------------------------------------------------------------
async function supabase(pathAndQuery, options = {}) {
  const url = `${SUPABASE_URL}/rest/v1/${pathAndQuery}`
  const res = await fetch(url, {
    ...options,
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: options.prefer || 'count=exact',
      ...(options.headers || {}),
    },
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`Supabase ${res.status}: ${body.slice(0, 200)}`)
  }
  return { res, data: await res.json().catch(() => null) }
}

function getCountHeader(res) {
  const range = res.headers.get('content-range') || ''
  const total = range.split('/')[1]
  const n = Number.parseInt(total || '0', 10)
  return Number.isFinite(n) ? n : 0
}

// ---------------------------------------------------------------------------
// Metric fetchers
// ---------------------------------------------------------------------------

/** WAU: distinct users with any activity in the last 7 days */
async function fetchWAU() {
  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()
  // Supabase REST doesn't support DISTINCT directly, so we fetch user_ids and
  // dedupe client-side. For <10k active users this is <100kb of payload.
  const { data } = await supabase(
    `user_activity?select=user_id&created_at=gte.${encodeURIComponent(since)}&limit=50000`,
    { prefer: 'count=none' },
  )
  const unique = new Set((data || []).map((r) => r.user_id))
  return unique.size
}

/** Paying subscribers: status active|trialing AND tier in ('pro', 'lifetime') */
async function fetchPayingSubscribers() {
  const { res } = await supabase(
    `subscriptions?select=id&status=in.(active,trialing)&tier=in.(pro,lifetime)&limit=1`,
    { prefer: 'count=exact,head=true', method: 'HEAD' },
  )
  return getCountHeader(res)
}

/**
 * Top-10 trust ratio: of the top-10 traders in the 90D leaderboard, how many
 * have score_confidence='full' on the joined trader_sources row.
 *
 * Calls the get_top_trust_ratio() RPC (single round-trip + planner-friendly
 * JOIN), replacing the old N+1 REST loop that timed out at Supabase's 30s
 * statement limit. See migration 20260409173653_get_top_trust_ratio_rpc.sql.
 *
 * Returns { fullCount, totalCount, ratio }.
 */
async function fetchTop10TrustRatio() {
  const { data } = await supabase(
    `rpc/get_top_trust_ratio`,
    {
      method: 'POST',
      body: JSON.stringify({ p_season_id: '90D', p_top_n: 10 }),
      prefer: 'count=none',
    },
  )

  // RPC returns an array of rows; we expect exactly one.
  const row = Array.isArray(data) ? data[0] : data
  if (!row) return { fullCount: 0, totalCount: 0, ratio: 0 }

  return {
    fullCount: Number(row.full_count) || 0,
    totalCount: Number(row.total_count) || 0,
    ratio: Number(row.ratio) || 0,
  }
}

// ---------------------------------------------------------------------------
// Telegram helper
// ---------------------------------------------------------------------------
async function sendTelegram(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    if (isSilent) return
    console.log('[Telegram disabled — no bot token / chat id]\n')
    console.log(text)
    return
  }
  const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: TELEGRAM_CHAT_ID,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    }),
  })
  if (!res.ok) {
    throw new Error(`Telegram ${res.status}: ${await res.text().catch(() => '')}`)
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const started = Date.now()
  const [wau, paying, trust] = await Promise.allSettled([
    fetchWAU(),
    fetchPayingSubscribers(),
    fetchTop10TrustRatio(),
  ])

  const wauValue = wau.status === 'fulfilled' ? wau.value : null
  const payingValue = paying.status === 'fulfilled' ? paying.value : null
  const trustValue = trust.status === 'fulfilled' ? trust.value : null

  const lines = [
    '<b>📊 Arena Weekly Metrics</b>',
    '',
    `<b>WAU (7d):</b> ${wauValue ?? '<i>failed</i>'}`,
    `<b>Paying subscribers:</b> ${payingValue ?? '<i>failed</i>'}`,
    trustValue
      ? `<b>Top-10 trust (full confidence):</b> ${trustValue.fullCount}/${trustValue.totalCount} (${Math.round(trustValue.ratio * 100)}%)`
      : `<b>Top-10 trust:</b> <i>failed</i>`,
    '',
    `<i>${new Date().toISOString()} · ${Date.now() - started}ms</i>`,
  ]

  // Failure notes so they land in logs even on success send
  if (wau.status === 'rejected') console.error('WAU failed:', wau.reason?.message || wau.reason)
  if (paying.status === 'rejected') console.error('paying subs failed:', paying.reason?.message || paying.reason)
  if (trust.status === 'rejected') console.error('trust ratio failed:', trust.reason?.message || trust.reason)

  const report = lines.join('\n')
  if (isDryRun) {
    console.log(report)
    return
  }
  await sendTelegram(report)
  console.log('Weekly metrics report sent')
}

main().catch((err) => {
  console.error('weekly-metrics failed:', err)
  process.exit(1)
})
