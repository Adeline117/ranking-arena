#!/usr/bin/env node
/**
 * KuCoin Copy Trading Fetcher (Mac Mini / Residential IP only)
 *
 * KuCoin's new ct-copy-trade API requires browser session cookies.
 * Datacenter IPs (VPS) get 404 on the SPA — it won't render.
 * This script uses Playwright to:
 *   1. Navigate to kucoin.com/copy-trading
 *   2. Accept cookie consent
 *   3. Intercept the leaderboard API response
 *   4. Write traders to Supabase via the connector-db-adapter pattern
 *
 * Run: node scripts/openclaw/fetch-kucoin.mjs
 * Cron: every 6h (Mac Mini only)
 */

import { chromium } from 'playwright'
import { createClient } from '@supabase/supabase-js'
import { config } from 'dotenv'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
config({ path: resolve(__dirname, '../../.env.local') })

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Missing SUPABASE env vars')
  process.exit(1)
}
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)

const PLATFORM = 'kucoin'
const MARKET_TYPE = 'futures'

async function fetchKuCoinLeaderboard() {
  console.log('[kucoin] Starting Playwright fetch...')
  // KuCoin detects headless browsers — use headed mode or Xvfb on Linux
  const isLinux = process.platform === 'linux'
  const browser = await chromium.launch({
    headless: false,
    args: isLinux ? ['--no-sandbox', '--disable-gpu'] : [],
  })
  const page = await browser.newPage()

  // Intercept leaderboard API responses
  const captured = []
  page.on('response', async (response) => {
    try {
      const url = response.url()
      if (url.includes('ct-copy-trade') && url.includes('leaderboard') && response.status() === 200) {
        const ct = response.headers()['content-type'] || ''
        if (ct.includes('json')) {
          const data = await response.json()
          captured.push({ url, data, size: JSON.stringify(data).length })
        }
      }
    } catch {}
  })

  await page.goto('https://www.kucoin.com/copy-trading', {
    waitUntil: 'domcontentloaded',
    timeout: 60000,
  })

  // Accept cookie consent
  await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('button'))
    const accept = btns.find(b => b.textContent && b.textContent.includes('Accept All'))
    if (accept) accept.click()
  }).catch(() => {})

  // Wait for SPA to render and fire API calls
  await page.waitForTimeout(10000)
  await page.evaluate(() => window.scrollTo(0, 500)).catch(() => {})
  await page.waitForTimeout(5000)

  // First page comes from interception (SPA auto-loads it)
  let traders = []
  const seen = new Set()

  if (captured.length > 0) {
    captured.sort((a, b) => b.size - a.size)
    const data = captured[0].data
    const items = data?.data?.items || data?.data || []
    if (Array.isArray(items)) {
      for (const t of items) {
        const id = String(t.leadConfigId || t.uid || t.id || '')
        if (id && !seen.has(id)) { seen.add(id); traders.push(t) }
      }
    }
    console.log(`[kucoin] Intercepted page 1: ${traders.length} traders`)
  }

  // Paginate remaining pages via page context (session cookies now established)
  if (traders.length > 0) {
    const moreTraders = await page.evaluate(async (startPage) => {
      const all = []
      const seenIds = new Set()
      for (let pageNo = startPage; pageNo <= 65; pageNo++) {
        try {
          const r = await fetch(
            `/_api/ct-copy-trade/v1/copyTrading/rn/leaderboard/query?lang=en_US&pageNo=${pageNo}&pageSize=12`,
            { credentials: 'include' }
          )
          if (!r.ok) break
          const json = await r.json()
          const items = json?.data?.items || json?.data || []
          if (!Array.isArray(items) || items.length === 0) break
          for (const t of items) {
            const id = String(t.leadConfigId || t.uid || t.id || '')
            if (id && !seenIds.has(id)) { seenIds.add(id); all.push(t) }
          }
          if (items.length < 12) break
        } catch { break }
        await new Promise(resolve => setTimeout(resolve, 500))
      }
      return all
    }, 2).catch(() => [])

    if (moreTraders?.length) {
      for (const t of moreTraders) {
        const id = String(t.leadConfigId || t.uid || t.id || '')
        if (id && !seen.has(id)) { seen.add(id); traders.push(t) }
      }
    }
    console.log(`[kucoin] Total after pagination: ${traders.length} traders`)
  }

  await browser.close()
  return traders
}

async function writeToSupabase(traders) {
  if (!traders.length) {
    console.log('[kucoin] No traders to write')
    return
  }

  const now = new Date()
  now.setMinutes(0, 0, 0)
  const dateBucket = now.toISOString()

  // Write to trader_profiles_v2 — frontend API reads display_name from this table
  const profileRows = traders.map(t => {
    const key = String(t.leadConfigId || t.uid || t.id || '')
    return {
      platform: PLATFORM, market_type: MARKET_TYPE, trader_key: key,
      display_name: t.nickName || null, avatar_url: t.avatarUrl || null,
      profile_url: `https://www.kucoin.com/copy-trading/leader/${key}`,
      followers: t.maxCopyUserCount != null ? Number(t.maxCopyUserCount) : 0,
      copiers: t.currentCopyUserCount != null ? Number(t.currentCopyUserCount) : 0,
      updated_at: new Date().toISOString(),
    }
  })
  const { error: profErr } = await supabase
    .from('trader_profiles_v2').upsert(profileRows, { onConflict: 'platform,trader_key' })
  if (profErr) console.error('[kucoin] profiles error:', profErr.message)

  // Write to trader_snapshots_v2
  const snapshots = traders.map(t => {
    const traderKey = String(t.leadConfigId || t.uid || t.id || '')
    const roi = t.totalPnlRatio != null ? Number(t.totalPnlRatio) : null
    const pnl = t.totalPnl != null ? Number(t.totalPnl) : null
    return {
      platform: PLATFORM,
      market_type: MARKET_TYPE,
      trader_key: traderKey,
      window: '30D',
      as_of_ts: dateBucket,
      roi_pct: roi,
      pnl_usd: pnl,
      copiers: t.currentCopyUserCount != null ? Number(t.currentCopyUserCount) : null,
      followers: t.maxCopyUserCount != null ? Number(t.maxCopyUserCount) : null,
      metrics: {
        display_name: t.nickName,
        avatar_url: t.avatarUrl,
        follower_pnl: t.followerPnl != null ? Number(t.followerPnl) : null,
        days_as_leader: t.daysAsLeader,
        aum: t.leadPrincipal != null ? Number(t.leadPrincipal) : null,
      },
    }
  })

  const { error: snapErr } = await supabase
    .from('trader_snapshots_v2')
    .upsert(snapshots, { onConflict: 'platform,market_type,trader_key,window' })

  // Write equity curves from totalPnlDate (30-day daily PnL array)
  const now2 = new Date()
  const equityCurveRows = []
  for (const t of traders) {
    const traderKey = String(t.leadConfigId || t.uid || t.id || '')
    const pnlDates = t.totalPnlDate
    if (!traderKey || !Array.isArray(pnlDates) || pnlDates.length === 0) continue
    // totalPnlDate is 30 items, newest last. Generate dates backwards from today.
    for (let i = 0; i < pnlDates.length; i++) {
      const date = new Date(now2)
      date.setDate(date.getDate() - (pnlDates.length - 1 - i))
      const pnlVal = Number(pnlDates[i])
      if (isNaN(pnlVal)) continue
      equityCurveRows.push({
        source: PLATFORM,
        source_trader_id: traderKey,
        period: '30d',
        data_date: date.toISOString().split('T')[0],
        pnl_usd: pnlVal,
        captured_at: now2.toISOString(),
      })
    }
  }
  if (equityCurveRows.length > 0) {
    // Batch insert (no upsert — append new data points)
    for (let i = 0; i < equityCurveRows.length; i += 500) {
      const batch = equityCurveRows.slice(i, i + 500)
      const { error: ecErr } = await supabase
        .from('trader_equity_curve')
        .upsert(batch, { onConflict: 'source,source_trader_id,period,data_date', ignoreDuplicates: true })
      if (ecErr) console.error('[kucoin] equity curve error:', ecErr.message)
    }
    console.log(`[kucoin] Wrote ${equityCurveRows.length} equity curve points`)
  }
  if (snapErr) console.error('[kucoin] snapshots error:', snapErr.message)
  else console.log(`[kucoin] Wrote ${snapshots.length} snapshots`)
}

// Main
try {
  const traders = await fetchKuCoinLeaderboard()
  await writeToSupabase(traders)
  console.log(`[kucoin] Done: ${traders.length} traders`)
} catch (err) {
  console.error('[kucoin] Fatal:', err.message)
  process.exit(1)
}
