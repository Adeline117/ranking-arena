#!/usr/bin/env node
/**
 * KuCoin Copy Trading Fetcher — Mac Mini (residential IP + real Chrome)
 *
 * KuCoin's copy trading APIs return 404 and VPS headless browser gets
 * blocked (SPA doesn't render trader data from SG/JP IPs).
 * Mac Mini with real Chrome + residential IP works.
 *
 * Strategy:
 * 1. Launch Chrome → kucoin.com/copytrading
 * 2. Accept cookie consent
 * 3. Capture API responses via page.on('response')
 * 4. If no API captured, extract data directly from DOM
 * 5. Parse, write to Supabase
 *
 * Cron: every 6h (0 */6 * * *)
 * Install: npm install puppeteer dotenv @supabase/supabase-js
 */

import path from 'path'
import { fileURLToPath } from 'url'
import { config as dotenvConfig } from 'dotenv'
import { createClient } from '@supabase/supabase-js'
import puppeteer from 'puppeteer'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
dotenvConfig({ path: path.resolve(__dirname, '../../.env') })
dotenvConfig({ path: path.resolve(__dirname, '../../.env.local') })

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY')
  process.exit(1)
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)
const SOURCE = 'kucoin'
const TARGET = 200

// Arena Score (synced with lib/utils/arena-score.ts)
const ARENA_PARAMS = {
  '7D':  { tanhCoeff: 0.08, roiExponent: 1.8 },
  '30D': { tanhCoeff: 0.15, roiExponent: 1.6 },
  '90D': { tanhCoeff: 0.18, roiExponent: 1.6 },
}
const PNL_PARAMS = {
  '7D':  { base: 300,  coeff: 0.42 },
  '30D': { base: 600,  coeff: 0.30 },
  '90D': { base: 650,  coeff: 0.27 },
}
const clip = (v, min, max) => Math.max(min, Math.min(max, v))
const safeLog1p = x => x <= -1 ? 0 : Math.log(1 + x)
function calculateArenaScore(roi, pnl, period) {
  const params = ARENA_PARAMS[period] || ARENA_PARAMS['90D']
  const days = period === '7D' ? 7 : period === '30D' ? 30 : 90
  const cappedRoi = Math.min(roi || 0, 10000)
  const intensity = (365 / days) * safeLog1p(cappedRoi / 100)
  const r0 = Math.tanh(params.tanhCoeff * intensity)
  const returnScore = r0 > 0 ? clip(60 * Math.pow(r0, params.roiExponent), 0, 60) : 0
  let pnlScore = 0
  if (pnl > 0) {
    const pp = PNL_PARAMS[period] || PNL_PARAMS['90D']
    const logArg = 1 + pnl / pp.base
    if (logArg > 0) pnlScore = clip(40 * Math.tanh(pp.coeff * Math.log(logArg)), 0, 40)
  }
  return Math.round(clip(returnScore + pnlScore, 0, 100) * 100) / 100
}

function parseNum(v) {
  if (v === null || v === undefined || v === '') return null
  const n = typeof v === 'number' ? v : parseFloat(String(v).replace(/[,%]/g, ''))
  return isNaN(n) || !isFinite(n) ? null : n
}

function parseTrader(item, period) {
  const id = String(item.leaderId || item.uid || item.userId || item.id || '')
  if (!id) return null

  let roi = parseNum(item.roi || item.returnRate || item.profitRate)
  let pnl = parseNum(item.pnl || item.profit || item.totalProfit)
  const winRate = parseNum(item.winRate || item.winRatio)
  const mdd = parseNum(item.maxDrawdown || item.mdd)
  const followers = parseNum(item.followerCount || item.followers || item.copyCount)
  const handle = item.nickName || item.nickname || item.name || `Trader_${id.slice(0, 8)}`

  // ROI may be decimal (0.5 = 50%) or percentage (50 = 50%)
  if (roi !== null && Math.abs(roi) <= 1 && Math.abs(roi) > 0) roi = roi * 100

  if (roi === null && pnl === null) return null

  return {
    source: SOURCE,
    source_trader_id: id,
    handle,
    profile_url: `https://www.kucoin.com/copytrading/trader/${id}`,
    season_id: period,
    rank: parseNum(item.rank) || null,
    roi,
    pnl,
    win_rate: winRate !== null ? (winRate <= 1 ? winRate * 100 : winRate) : null,
    max_drawdown: mdd !== null ? Math.abs(mdd <= 1 ? mdd * 100 : mdd) : null,
    followers: followers ? Math.round(followers) : null,
    arena_score: calculateArenaScore(roi || 0, pnl || 0, period),
    captured_at: new Date().toISOString(),
    avatar_url: item.avatar || item.avatarUrl || null,
  }
}

async function fetchWithBrowser() {
  const browser = await puppeteer.launch({
    headless: 'shell',
    executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--window-size=1440,900'],
  })

  const allCaptured = []

  try {
    const page = await browser.newPage()
    await page.setViewport({ width: 1440, height: 900 })
    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36')

    // Intercept all JSON API responses
    page.on('response', async (response) => {
      const url = response.url()
      if (url.includes('copy') || url.includes('leader') || url.includes('trader') || url.includes('rank')) {
        try {
          const ct = response.headers()['content-type'] || ''
          if (!ct.includes('json')) return
          const text = await response.text()
          if (!text.startsWith('{') && !text.startsWith('[')) return
          const json = JSON.parse(text)
          let list = json.data?.items || json.data?.list || json.data?.records || json.data || []
          if (!Array.isArray(list)) list = []
          list = list.filter(item => item && typeof item === 'object' && (item.leaderId || item.uid || item.userId))
          if (list.length > 0) {
            console.log(`  [capture] ${list.length} traders from ${url.slice(0, 120)}`)
            allCaptured.push(...list)
          }
        } catch { /* not JSON */ }
      }
    })

    console.log('  Loading kucoin.com/copytrading...')
    await page.goto('https://www.kucoin.com/copytrading', { waitUntil: 'networkidle0', timeout: 45000 })
    await new Promise(r => setTimeout(r, 3000))

    // Accept cookies if present
    try {
      await page.click('[class*="accept"], button:has-text("Accept")', { timeout: 3000 })
      console.log('  Accepted cookies')
      await new Promise(r => setTimeout(r, 5000))
    } catch { /* no cookie banner */ }

    console.log(`  After initial load: ${allCaptured.length} traders captured via interception`)

    // Scroll to trigger lazy loading
    for (let i = 0; i < 10; i++) {
      await page.evaluate(() => window.scrollBy(0, 500))
      await new Promise(r => setTimeout(r, 2000))
      if (allCaptured.length >= TARGET) break
    }

    console.log(`  After scrolling: ${allCaptured.length} traders captured`)

    // If no API captured, try extracting from DOM
    if (allCaptured.length === 0) {
      console.log('  No API data captured, trying DOM extraction...')
      const domData = await page.evaluate(() => {
        const cards = document.querySelectorAll('[class*="trader"], [class*="leader"], [class*="card"]')
        const results = []
        cards.forEach(card => {
          const text = card.innerText
          const pctMatch = text.match(/([+-]?\d+\.?\d*)%/)
          const nameEl = card.querySelector('[class*="name"], [class*="nick"]')
          if (pctMatch) {
            results.push({
              name: nameEl?.innerText || 'Unknown',
              roi: parseFloat(pctMatch[1]),
              rawText: text.substring(0, 200),
            })
          }
        })
        return results
      })
      console.log(`  DOM extraction found ${domData.length} trader-like elements`)
      // Convert DOM data to trader format
      for (const d of domData) {
        allCaptured.push({
          uid: `dom_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          nickname: d.name,
          roi: d.roi,
        })
      }
    }

    return allCaptured
  } finally {
    await browser.close()
  }
}

async function upsertBatch(traders) {
  const BATCH = 100
  let saved = 0
  for (let i = 0; i < traders.length; i += BATCH) {
    const batch = traders.slice(i, i + BATCH)

    // trader_sources
    const sources = batch.map(t => ({
      source: t.source,
      source_trader_id: t.source_trader_id,
      handle: t.handle,
      avatar_url: t.avatar_url,
      profile_url: t.profile_url,
      is_active: true,
      updated_at: new Date().toISOString(),
    }))
    await supabase.from('trader_sources').upsert(sources, { onConflict: 'source,source_trader_id' })

    // trader_snapshots
    const snapshots = batch.map(t => ({
      source: t.source,
      source_trader_id: t.source_trader_id,
      season_id: t.season_id,
      rank: t.rank,
      roi: t.roi,
      pnl: t.pnl,
      followers: t.followers,
      win_rate: t.win_rate,
      max_drawdown: t.max_drawdown,
      arena_score: t.arena_score,
      captured_at: t.captured_at,
    }))
    const { error } = await supabase.from('trader_snapshots').upsert(snapshots, { onConflict: 'source,source_trader_id,season_id' })
    if (error) console.error(`  Upsert error: ${error.message}`)
    else saved += batch.length
  }
  return saved
}

async function main() {
  const start = Date.now()
  console.log(`[${new Date().toISOString()}] KuCoin fetch starting...`)

  try {
    const raw = await fetchWithBrowser()
    console.log(`  Raw captured: ${raw.length} traders`)

    if (raw.length === 0) {
      console.log('  No data captured — KuCoin may be geo-blocked or copy trading disabled')
      process.exit(0)
    }

    // Dedupe by ID
    const byId = new Map()
    for (const t of raw) {
      const id = t.leaderId || t.uid || t.userId || t.id
      if (id && !byId.has(id)) byId.set(id, t)
    }
    console.log(`  Unique traders: ${byId.size}`)

    // Parse for all periods (KuCoin API may not have period-specific data)
    const allTraders = []
    for (const period of ['7D', '30D', '90D']) {
      for (const [, item] of byId) {
        const parsed = parseTrader(item, period)
        if (parsed) allTraders.push(parsed)
      }
    }
    console.log(`  Parsed: ${allTraders.length} trader-period records`)

    const saved = await upsertBatch(allTraders)
    const duration = ((Date.now() - start) / 1000).toFixed(1)
    console.log(`[${new Date().toISOString()}] KuCoin done: ${saved} saved in ${duration}s`)
  } catch (err) {
    console.error(`[${new Date().toISOString()}] KuCoin error:`, err.message)
    process.exit(1)
  }
}

main()
