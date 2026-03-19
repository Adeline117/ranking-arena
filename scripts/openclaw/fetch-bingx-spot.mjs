#!/usr/bin/env node
/**
 * BingX Spot Copy Trading Fetcher (Mac Mini only)
 *
 * BingX spot copy trading data requires:
 * 1. Headed browser (CF blocks headless)
 * 2. Residential IP (datacenter IPs blocked)
 * 3. Navigate to copy trading page, click Spot tab
 * 4. Intercept API response or scrape DOM
 *
 * Run: node scripts/openclaw/fetch-bingx-spot.mjs
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

const PLATFORM = 'bingx_spot'

async function fetchBingXSpot() {
  console.log('[bingx_spot] Starting Playwright fetch...')
  const browser = await chromium.launch({ headless: false })
  const page = await browser.newPage()

  // Intercept copy trading API
  let mainData = null
  page.on('response', async (r) => {
    if (r.url().includes('trader/new/recommend') && r.status() === 200) {
      try { mainData = await r.json() } catch {}
    }
  })

  await page.goto('https://bingx.com/en/CopyTrading', {
    waitUntil: 'domcontentloaded', timeout: 60000,
  })

  // Wait for CF challenge
  for (let i = 0; i < 15; i++) {
    const title = await page.title()
    if (!title.includes('moment')) break
    await page.waitForTimeout(2000)
  }
  await page.waitForTimeout(8000)

  // Click Spot tab to filter
  await page.evaluate(() => {
    const all = document.querySelectorAll('*')
    for (const el of all) {
      if (el.textContent.trim() === 'Spot' && el.offsetHeight > 0 && el.children.length === 0) {
        el.click()
        return true
      }
    }
    return false
  }).catch(() => {})
  await page.waitForTimeout(5000)

  // Capture new API calls after clicking Spot
  let spotData = null
  page.on('response', async (r) => {
    if (r.url().includes('api-app') && r.status() === 200) {
      const ct = r.headers()['content-type'] || ''
      if (ct.includes('json')) {
        try {
          const d = await r.json()
          const result = d?.data?.result || []
          if (Array.isArray(result) && result.length > 0) {
            const acct = result[0]?.rankStat?.accountEnum || ''
            if (acct.includes('SPOT')) spotData = d
          }
        } catch {}
      }
    }
  })
  await page.waitForTimeout(5000)

  // Extract traders - check if mainData has spot traders or if spotData was captured
  let traders = []
  const dataSource = spotData || mainData
  if (dataSource) {
    const result = dataSource.data?.result || []
    for (const t of result) {
      const acct = t.rankStat?.accountEnum || ''
      // Include spot traders or all if no spot-specific data
      if (acct.includes('SPOT') || !acct || spotData) {
        const trader = t.trader || {}
        const stat = t.rankStat || {}
        // Parse profitRate from string (e.g. "+12.34%" or "12.34")
        const parseNum = (v) => { if (v == null || v === '') return null; const n = Number(String(v).replace(/[+,%\s]/g, '')); return isNaN(n) ? null : n }
        const parsePercent = (v) => { if (v == null || v === '') return null; const s = String(v).replace(/[+%\s]/g, ''); const n = Number(s); return isNaN(n) ? null : n }
        traders.push({
          uid: String(stat.apiIdentity || trader.uid || ''),
          name: trader.nickName || trader.realNickName || stat.disPlayName || '',
          avatar: trader.avatar || '',
          roi: parsePercent(stat.strRecent30DaysRate),
          pnl: parseNum(stat.totalEarnings),
          win_rate: stat.winRate30d != null ? Number(stat.winRate30d) * 100 : parsePercent(stat.winRate),
          max_drawdown: parsePercent(stat.maxDrawDown30dV2),
          sharpe_ratio: parseNum(stat.sharpe30d),
          copiers: parseNum(stat.strFollowerNum),
          followers: parseNum(stat.maxFollowerNum),
          trades_count: parseNum(stat.totalTransactions),
          accountEnum: acct,
        })
      }
    }
  }

  // If no API data, try DOM extraction
  if (traders.length === 0) {
    const domTraders = await page.evaluate(() => {
      const cards = document.querySelectorAll('[class*="trader"], [class*="card"]')
      const out = []
      cards.forEach(card => {
        const name = card.querySelector('[class*="name"]')?.textContent?.trim()
        const roi = card.querySelector('[class*="roi"], [class*="profit"]')?.textContent?.trim()
        if (name && roi) out.push({ name, roi_text: roi, source: 'dom' })
      })
      return out
    }).catch(() => [])
    traders = domTraders || []
  }

  console.log(`[bingx_spot] Found ${traders.length} traders`)
  await browser.close()
  return traders
}

async function writeToSupabase(traders) {
  if (!traders.length) {
    console.log('[bingx_spot] No traders to write')
    return
  }

  const now = new Date()
  now.setMinutes(0, 0, 0)
  const dateBucket = now.toISOString()

  // Write to trader_profiles_v2 — frontend API reads display_name from this table
  const profileRows = traders.filter(t => t.uid).map(t => ({
    platform: PLATFORM, market_type: 'spot', trader_key: t.uid,
    display_name: t.name || null, avatar_url: t.avatar || null,
    profile_url: `https://bingx.com/en/copy-trading/trader/${t.uid}`,
    followers: t.followers != null ? Number(t.followers) : 0,
    copiers: t.copiers != null ? Number(t.copiers) : 0,
    updated_at: new Date().toISOString(),
  }))
  const { error: profErr } = await supabase
    .from('trader_profiles_v2').upsert(profileRows, { onConflict: 'platform,trader_key' })
  if (profErr) console.error('[bingx_spot] profiles error:', profErr.message)

  const snapshots = traders.filter(t => t.uid).map(t => ({
    platform: PLATFORM,
    market_type: 'spot',
    trader_key: t.uid,
    window: '30D',
    as_of_ts: dateBucket,
    roi_pct: t.roi,
    pnl_usd: t.pnl,
    win_rate: t.win_rate,
    max_drawdown: t.max_drawdown,
    sharpe_ratio: t.sharpe_ratio,
    trades_count: t.trades_count,
    copiers: t.copiers,
    followers: t.followers,
    metrics: { display_name: t.name, avatar_url: t.avatar, accountEnum: t.accountEnum },
  }))

  const { error: snapErr } = await supabase
    .from('trader_snapshots_v2')
    .upsert(snapshots, { onConflict: 'platform,market_type,trader_key,window' })
  if (snapErr) console.error('[bingx_spot] snapshots error:', snapErr.message)
  else console.log(`[bingx_spot] Wrote ${snapshots.length} snapshots`)
}

try {
  const traders = await fetchBingXSpot()
  await writeToSupabase(traders)
  console.log(`[bingx_spot] Done: ${traders.length} traders`)
} catch (err) {
  console.error('[bingx_spot] Fatal:', err.message)
  process.exit(1)
}
