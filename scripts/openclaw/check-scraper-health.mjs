#!/usr/bin/env node
/**
 * Mac Mini Scraper Health Check
 *
 * Checks data freshness for platforms that run exclusively on the Mac Mini:
 *   - lbank    (fetch-lbank.mjs, crontab every 6h at :20)
 *   - phemex   (fetch-phemex.mjs, crontab every 6h at :00)
 *
 * Reports last update time, trader count, and sends Telegram alert if stale >12h.
 *
 * Usage:
 *   node scripts/openclaw/check-scraper-health.mjs          # console report
 *   node scripts/openclaw/check-scraper-health.mjs --alert   # also send Telegram alert if stale
 */

import path from 'path'
import { fileURLToPath } from 'url'
import { config as dotenvConfig } from 'dotenv'
import { createClient } from '@supabase/supabase-js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
dotenvConfig({ path: path.resolve(__dirname, '../../.env') })
dotenvConfig({ path: path.resolve(__dirname, '../../.env.local') })

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_ALERT_CHAT_ID

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY')
  process.exit(1)
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)

const MAC_MINI_PLATFORMS = [
  {
    source: 'lbank',
    script: 'fetch-lbank.mjs',
    cron: 'Every 6h at :20 (10 0,6,12,18 * * *)',
    url: 'lbank.com/copy-trading (browser intercept via uuapi.rerrkvifj.com)',
    target: 200,
  },
  {
    source: 'phemex',
    script: 'fetch-phemex.mjs',
    cron: 'Every 6h at :00 (0 0,6,12,18 * * *)',
    url: 'api10.phemex.com/phemex-lb/public/data/user/leaders (browser intercept)',
    target: 200,
  },
]

const STALE_THRESHOLD_HOURS = 12

async function checkPlatform(platform) {
  // Query trader_snapshots (v1) for latest data
  const { data: v1Data, error: v1Err } = await supabase
    .from('trader_snapshots')
    .select('captured_at, season_id')
    .eq('source', platform.source)
    .order('captured_at', { ascending: false })
    .limit(1)

  // Count total traders in v1
  const { count: v1Count, error: v1CountErr } = await supabase
    .from('trader_snapshots')
    .select('*', { count: 'exact', head: true })
    .eq('source', platform.source)

  // Query trader_snapshots_v2 for latest data
  const { data: v2Data, error: v2Err } = await supabase
    .from('trader_snapshots_v2')
    .select('updated_at, window')
    .eq('platform', platform.source)
    .order('updated_at', { ascending: false })
    .limit(1)

  // Count total traders in v2
  const { count: v2Count, error: v2CountErr } = await supabase
    .from('trader_snapshots_v2')
    .select('*', { count: 'exact', head: true })
    .eq('platform', platform.source)

  const v1Latest = v1Data?.[0]?.captured_at || null
  const v2Latest = v2Data?.[0]?.updated_at || null
  const latestTs = v1Latest && v2Latest
    ? (new Date(v1Latest) > new Date(v2Latest) ? v1Latest : v2Latest)
    : v1Latest || v2Latest

  let hoursAgo = null
  let isStale = true
  if (latestTs) {
    hoursAgo = ((Date.now() - new Date(latestTs).getTime()) / (1000 * 60 * 60)).toFixed(1)
    isStale = parseFloat(hoursAgo) > STALE_THRESHOLD_HOURS
  }

  return {
    source: platform.source,
    script: platform.script,
    cron: platform.cron,
    url: platform.url,
    target: platform.target,
    v1: {
      latest: v1Latest,
      count: v1Count ?? 0,
      period: v1Data?.[0]?.season_id || 'N/A',
      error: v1Err?.message || v1CountErr?.message || null,
    },
    v2: {
      latest: v2Latest,
      count: v2Count ?? 0,
      window: v2Data?.[0]?.window || 'N/A',
      error: v2Err?.message || v2CountErr?.message || null,
    },
    hoursAgo,
    isStale,
    hasData: (v1Count ?? 0) > 0 || (v2Count ?? 0) > 0,
  }
}

function formatReport(results) {
  const lines = [
    '=== Mac Mini Scraper Health Check ===',
    `Timestamp: ${new Date().toISOString()}`,
    `Stale threshold: ${STALE_THRESHOLD_HOURS}h`,
    '',
  ]

  for (const r of results) {
    const status = r.hasData
      ? (r.isStale ? 'STALE' : 'OK')
      : 'NO DATA'
    const icon = status === 'OK' ? '[OK]' : status === 'STALE' ? '[STALE]' : '[EMPTY]'

    lines.push(`${icon} ${r.source}`)
    lines.push(`  Script:    ${r.script}`)
    lines.push(`  Cron:      ${r.cron}`)
    lines.push(`  API:       ${r.url}`)
    lines.push(`  Target:    ${r.target} traders`)
    lines.push(`  v1 (trader_snapshots):`)
    lines.push(`    Latest:  ${r.v1.latest || 'never'} (${r.v1.period})`)
    lines.push(`    Count:   ${r.v1.count} snapshots`)
    lines.push(`  v2 (trader_snapshots_v2):`)
    lines.push(`    Latest:  ${r.v2.latest || 'never'} (${r.v2.window})`)
    lines.push(`    Count:   ${r.v2.count} snapshots`)
    lines.push(`  Hours ago: ${r.hoursAgo ?? 'N/A'}`)
    if (r.v1.error) lines.push(`  v1 Error:  ${r.v1.error}`)
    if (r.v2.error) lines.push(`  v2 Error:  ${r.v2.error}`)
    lines.push('')
  }

  const stale = results.filter(r => r.isStale)
  const ok = results.filter(r => !r.isStale && r.hasData)
  const empty = results.filter(r => !r.hasData)

  lines.push('--- Summary ---')
  lines.push(`OK:      ${ok.length} (${ok.map(r => r.source).join(', ') || 'none'})`)
  lines.push(`Stale:   ${stale.length} (${stale.map(r => r.source).join(', ') || 'none'})`)
  lines.push(`No data: ${empty.length} (${empty.map(r => r.source).join(', ') || 'none'})`)

  return lines.join('\n')
}

async function sendTelegram(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.log('\n[skip] Telegram alert not sent (missing TELEGRAM_BOT_TOKEN or TELEGRAM_ALERT_CHAT_ID)')
    return
  }
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text, parse_mode: 'HTML' }),
    })
    console.log('[ok] Telegram alert sent')
  } catch (err) {
    console.error('[fail] Telegram send failed:', err.message)
  }
}

async function main() {
  const shouldAlert = process.argv.includes('--alert')

  console.log(`[${new Date().toISOString()}] Checking Mac Mini scraper health...`)

  const results = await Promise.all(MAC_MINI_PLATFORMS.map(checkPlatform))
  const report = formatReport(results)
  console.log('\n' + report)

  const stale = results.filter(r => r.isStale)

  if (shouldAlert && stale.length > 0) {
    const alertLines = stale.map(r => {
      const age = r.hoursAgo ? `${r.hoursAgo}h ago` : 'never'
      const count = r.v1.count + r.v2.count
      return `  <b>${r.source}</b>: last update ${age}, ${count} snapshots`
    })
    await sendTelegram(
      `<b>Mac Mini Scraper Alert</b>\n` +
      `${stale.length}/${MAC_MINI_PLATFORMS.length} platforms stale (>${STALE_THRESHOLD_HOURS}h):\n` +
      alertLines.join('\n') +
      `\n\nCheck crontab on Mac Mini.`
    )
  } else if (shouldAlert && stale.length === 0) {
    console.log('\n[ok] All platforms fresh, no alert needed')
  }
}

main().catch(err => {
  console.error('Fatal:', err)
  process.exit(1)
})
