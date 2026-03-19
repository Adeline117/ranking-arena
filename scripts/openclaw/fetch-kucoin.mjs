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

/** Compute derived metrics from totalPnlDate equity curve */
function computeDerivedMetrics(pnlDates) {
  if (!Array.isArray(pnlDates) || pnlDates.length < 2) return {}

  const values = pnlDates.map(Number).filter(v => !isNaN(v))
  if (values.length < 2) return {}

  // Daily returns (differences)
  const returns = []
  for (let i = 1; i < values.length; i++) {
    returns.push(values[i] - values[i - 1])
  }

  // Win rate: % of positive daily returns
  const wins = returns.filter(r => r > 0).length
  const winRate = returns.length > 0 ? (wins / returns.length) * 100 : null

  // Max drawdown from cumulative PnL curve
  let peak = -Infinity
  let maxDD = 0
  for (const v of values) {
    if (v > peak) peak = v
    const dd = peak > 0 ? ((peak - v) / peak) * 100 : 0
    if (dd > maxDD) maxDD = dd
  }

  // Sharpe ratio (annualized from daily returns)
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length
  const variance = returns.reduce((a, r) => a + (r - mean) ** 2, 0) / returns.length
  const stdDev = Math.sqrt(variance)
  const sharpe = stdDev > 0 ? (mean / stdDev) * Math.sqrt(365) : null

  return {
    win_rate: winRate != null ? Math.round(winRate * 100) / 100 : null,
    max_drawdown: maxDD > 0 ? Math.round(maxDD * 100) / 100 : null,
    sharpe_ratio: sharpe != null ? Math.round(sharpe * 100) / 100 : null,
    trades_count: returns.length,
  }
}

async function writeToSupabase(traders) {
  if (!traders.length) {
    console.log('[kucoin] No traders to write')
    return
  }

  const now = new Date()
  now.setMinutes(0, 0, 0)
  const dateBucket = now.toISOString()

  // 1. Write to traders table (required for resolveTrader step 1)
  const traderRows = traders.map(t => {
    const key = String(t.leadConfigId || t.uid || t.id || '')
    return {
      platform: PLATFORM, trader_key: key,
      handle: t.nickName || key,
      avatar_url: t.avatarUrl || null,
      profile_url: `https://www.kucoin.com/copy-trading/leader/${key}`,
      market_type: MARKET_TYPE,
    }
  })
  for (let i = 0; i < traderRows.length; i += 500) {
    const batch = traderRows.slice(i, i + 500)
    const { error } = await supabase
      .from('traders').upsert(batch, { onConflict: 'platform,trader_key' })
    if (error) console.error('[kucoin] traders error:', error.message)
  }
  console.log(`[kucoin] Wrote ${traderRows.length} traders`)

  // 2. Write to trader_profiles_v2 — frontend API reads display_name from this table
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

  // 3. Write to trader_snapshots_v2 — 30D + 7D windows with derived metrics
  const allSnapshots = []
  for (const t of traders) {
    const traderKey = String(t.leadConfigId || t.uid || t.id || '')
    const roi = t.totalPnlRatio != null ? Number(t.totalPnlRatio) : null
    const pnl = t.totalPnl != null ? Number(t.totalPnl) : null
    const derived = computeDerivedMetrics(t.totalPnlDate)

    const baseRow = {
      platform: PLATFORM,
      market_type: MARKET_TYPE,
      trader_key: traderKey,
      as_of_ts: dateBucket,
      roi_pct: roi,
      pnl_usd: pnl,
      win_rate: derived.win_rate ?? null,
      max_drawdown: derived.max_drawdown ?? null,
      sharpe_ratio: derived.sharpe_ratio ?? null,
      trades_count: derived.trades_count ?? null,
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

    // 30D snapshot
    allSnapshots.push({ ...baseRow, window: '30D' })

    // 7D snapshot — derive from last 7 days of totalPnlDate
    if (Array.isArray(t.totalPnlDate) && t.totalPnlDate.length >= 7) {
      const last7 = t.totalPnlDate.slice(-7)
      const derived7d = computeDerivedMetrics(last7)
      const first = Number(last7[0]) || 0
      const last = Number(last7[last7.length - 1]) || 0
      const roi7d = first !== 0 ? ((last - first) / Math.abs(first)) * 100 : null
      const pnl7d = last - first
      allSnapshots.push({
        ...baseRow,
        window: '7D',
        roi_pct: roi7d,
        pnl_usd: pnl7d,
        win_rate: derived7d.win_rate ?? null,
        max_drawdown: derived7d.max_drawdown ?? null,
        sharpe_ratio: derived7d.sharpe_ratio ?? null,
        trades_count: derived7d.trades_count ?? null,
      })
    }
  }

  for (let i = 0; i < allSnapshots.length; i += 500) {
    const batch = allSnapshots.slice(i, i + 500)
    const { error: snapErr } = await supabase
      .from('trader_snapshots_v2')
      .upsert(batch, { onConflict: 'platform,market_type,trader_key,window' })
    if (snapErr) console.error('[kucoin] snapshots error:', snapErr.message)
  }
  console.log(`[kucoin] Wrote ${allSnapshots.length} snapshots (30D + 7D)`)

  // 4. Write equity curves from totalPnlDate — both 30D and 7D periods
  const now2 = new Date()
  const equityCurveRows = []
  for (const t of traders) {
    const traderKey = String(t.leadConfigId || t.uid || t.id || '')
    const pnlDates = t.totalPnlDate
    if (!traderKey || !Array.isArray(pnlDates) || pnlDates.length === 0) continue

    for (let i = 0; i < pnlDates.length; i++) {
      const date = new Date(now2)
      date.setDate(date.getDate() - (pnlDates.length - 1 - i))
      const pnlVal = Number(pnlDates[i])
      if (isNaN(pnlVal)) continue
      const dateStr = date.toISOString().split('T')[0]

      // 30D period — all days
      equityCurveRows.push({
        source: PLATFORM, source_trader_id: traderKey,
        period: '30D', data_date: dateStr,
        pnl_usd: pnlVal, captured_at: now2.toISOString(),
      })

      // 7D period — last 7 days only
      if (i >= pnlDates.length - 7) {
        equityCurveRows.push({
          source: PLATFORM, source_trader_id: traderKey,
          period: '7D', data_date: dateStr,
          pnl_usd: pnlVal, captured_at: now2.toISOString(),
        })
      }
    }
  }
  if (equityCurveRows.length > 0) {
    for (let i = 0; i < equityCurveRows.length; i += 500) {
      const batch = equityCurveRows.slice(i, i + 500)
      const { error: ecErr } = await supabase
        .from('trader_equity_curve')
        .upsert(batch, { onConflict: 'source,source_trader_id,period,data_date', ignoreDuplicates: true })
      if (ecErr) console.error('[kucoin] equity curve error:', ecErr.message)
    }
    console.log(`[kucoin] Wrote ${equityCurveRows.length} equity curve points (30D + 7D)`)
  }
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
