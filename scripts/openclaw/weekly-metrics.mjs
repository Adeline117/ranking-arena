#!/usr/bin/env node
/**
 * Weekly Product Metrics → Telegram
 *
 * Reads the same exact B2C KPI contract as the admin dashboard and Vercel
 * cron, then adds the top-10 ranking trust ratio. One database function owns
 * the definitions so these reporting surfaces cannot drift apart.
 *
 *   1. Acquisition and journey funnel
 *   2. Seven-day activation and WAU
 *   3. Paying subscribers and new paying subscribers
 *   4. Top-10 trust ratio — fraction of top-10 leaderboard_ranks where
 *      joined trader_sources.score_confidence = 'full'
 *
 * CEO review 2026-04-09 flagged that without these numbers, every product
 * decision is a guess. This script is designed to run weekly on Fridays
 * from the OpenClaw scheduler and post the result to Telegram.
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

// ---------------------------------------------------------------------------
// Metric fetchers
// ---------------------------------------------------------------------------

/** Exact B2C metrics owned by public.b2c_product_metrics(). */
async function fetchB2CMetrics() {
  const { data } = await supabase('rpc/b2c_product_metrics', {
    method: 'POST',
    body: JSON.stringify({ p_window_days: 7 }),
    prefer: 'count=none',
  })
  const requiredCounts = [
    'wau',
    'total_paying',
    'new_paying',
    'new_signups',
    'activation_eligible',
    'activated_7d',
  ]
  if (!data || requiredCounts.some((key) => !Number.isInteger(data[key]) || data[key] < 0)) {
    throw new Error('Invalid b2c_product_metrics response')
  }
  return data
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
  const { data } = await supabase(`rpc/get_top_trust_ratio`, {
    method: 'POST',
    body: JSON.stringify({ p_season_id: '90D', p_top_n: 10 }),
    prefer: 'count=none',
  })

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
  try {
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
      console.error(`Telegram send failed: ${res.status} ${await res.text().catch(() => '')}`)
    }
  } catch (err) {
    console.error('Telegram send error:', err.message)
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const started = Date.now()
  const [metrics, trust] = await Promise.allSettled([fetchB2CMetrics(), fetchTop10TrustRatio()])

  const metricValue = metrics.status === 'fulfilled' ? metrics.value : null
  const trustValue = trust.status === 'fulfilled' ? trust.value : null
  const funnel = metricValue?.funnel || {}
  const activationRate = metricValue?.activation_eligible
    ? Math.round((metricValue.activated_7d / metricValue.activation_eligible) * 100)
    : null

  const lines = [
    '<b>📊 Arena Weekly Metrics</b>',
    '',
    `<b>WAU (7d):</b> ${metricValue?.wau ?? '<i>failed</i>'}`,
    `<b>Total paying:</b> ${metricValue?.total_paying ?? '<i>failed</i>'}`,
    `<b>New paying:</b> ${metricValue?.new_paying ?? '<i>failed</i>'}`,
    `<b>New signups:</b> ${metricValue?.new_signups ?? '<i>failed</i>'}`,
    `<b>7d activation:</b> ${metricValue ? `${metricValue.activated_7d}/${metricValue.activation_eligible}${activationRate === null ? '' : ` (${activationRate}%)`}` : '<i>failed</i>'}`,
    `<b>Journey:</b> ${funnel.landing_view ?? 0} land → ${funnel.ranking_visible ?? 0} rank → ${funnel.view_trader ?? 0} trader → ${funnel.signup ?? 0} signup → ${funnel.start_checkout ?? 0} checkout`,
    `<i>Event collection: ${metricValue?.event_collection_started_at || 'not started; funnel zeros are not historical zeros'}</i>`,
    trustValue
      ? `<b>Top-10 trust (full confidence):</b> ${trustValue.fullCount}/${trustValue.totalCount} (${Math.round(trustValue.ratio * 100)}%)`
      : `<b>Top-10 trust:</b> <i>failed</i>`,
    '',
    `<i>${new Date().toISOString()} · ${Date.now() - started}ms</i>`,
  ]

  // Failure notes so they land in logs even on success send
  if (metrics.status === 'rejected')
    console.error('B2C metrics failed:', metrics.reason?.message || metrics.reason)
  if (trust.status === 'rejected')
    console.error('trust ratio failed:', trust.reason?.message || trust.reason)

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
