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
  const browser = await chromium.launch({ headless: true })
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

  // If interception captured data, use it
  let traders = []
  if (captured.length > 0) {
    captured.sort((a, b) => b.size - a.size)
    const data = captured[0].data
    const items = data?.data?.items || data?.data || []
    if (Array.isArray(items)) traders = items
    console.log(`[kucoin] Intercepted ${traders.length} traders from API`)
  }

  // Fallback: direct fetch from page context
  if (traders.length === 0) {
    const result = await page.evaluate(async () => {
      const endpoints = [
        '/_api/ct-copy-trade/v1/copyTrading/rn/leaderboard/query?lang=en_US&pageNo=1&pageSize=100',
        '/_api/ct-copy-trade/v1/copyTrading/rn/leaderboard/query?lang=en_US&pageNo=2&pageSize=100',
        '/_api/ct-copy-trade/v1/copyTrading/rn/leaderboard/query?lang=en_US&pageNo=3&pageSize=100',
      ]
      const all = []
      for (const ep of endpoints) {
        try {
          const r = await fetch(ep, { credentials: 'include' })
          if (!r.ok) continue
          const json = await r.json()
          const items = json?.data?.items || json?.data || []
          if (Array.isArray(items)) all.push(...items)
        } catch {}
        await new Promise(r => setTimeout(r, 1000))
      }
      return all
    }).catch(() => [])
    traders = result || []
    console.log(`[kucoin] Fetched ${traders.length} traders via page context`)
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

  // Write to trader_sources
  const sources = traders.map(t => ({
    source: PLATFORM,
    source_trader_id: String(t.leadConfigId || t.uid || t.id || ''),
    display_name: t.nickName || null,
    created_at: new Date().toISOString(),
  }))

  const { error: srcErr } = await supabase
    .from('trader_sources')
    .upsert(sources, { onConflict: 'source,source_trader_id', ignoreDuplicates: true })
  if (srcErr) console.error('[kucoin] trader_sources error:', srcErr.message)

  // Write to trader_snapshots_v2
  const snapshots = traders.map(t => {
    const traderKey = String(t.leadConfigId || t.uid || t.id || '')
    const roi = t.totalPnlRatio != null ? Number(t.totalPnlRatio) : null
    const pnl = t.totalPnl != null ? Number(t.totalPnl) : null
    return {
      platform: PLATFORM,
      market_type: MARKET_TYPE,
      trader_key: traderKey,
      window: '30d',
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

  const { error: snapErr, count } = await supabase
    .from('trader_snapshots_v2')
    .upsert(snapshots, { onConflict: 'platform,trader_key,window,as_of_ts' })
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
