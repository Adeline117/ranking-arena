#!/usr/bin/env node
/**
 * WEEX Copy Trading Fetcher — Mac Mini (residential IP + real Chrome)
 *
 * WEEX API returns 521 from all IPs. VPS headless browser sees the page
 * framework but trader data doesn't render (geo/anti-bot block).
 * Mac Mini with real Chrome + residential IP sees full trader data.
 *
 * Strategy:
 * 1. Launch Chrome → weex.com/en/copy-trading
 * 2. Accept cookie consent
 * 3. Click "All elite traders" tab
 * 4. Intercept XHR responses for trader data
 * 5. If no XHR, extract directly from DOM
 * 6. Parse, write to Supabase
 *
 * Cron: every 6h (30 */6 * * *)
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
const SOURCE = 'weex'

// Arena Score
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

    // Intercept all JSON responses
    page.on('response', async (response) => {
      const url = response.url()
      if (url.includes('copy') || url.includes('trader') || url.includes('leader') || url.includes('rank') || url.includes('elite')) {
        try {
          const ct = response.headers()['content-type'] || ''
          if (!ct.includes('json')) return
          const text = await response.text()
          if (!text.startsWith('{') && !text.startsWith('[')) return
          const json = JSON.parse(text)
          let list = json.data?.list || json.data?.rows || json.data?.records || json.data || []
          if (!Array.isArray(list)) list = []
          list = list.filter(item => item && typeof item === 'object' && (item.uid || item.traderId || item.id))
          if (list.length > 0) {
            console.log(`  [capture] ${list.length} traders from ${url.slice(0, 120)}`)
            allCaptured.push(...list)
          }
        } catch { /* not JSON */ }
      }
    })

    console.log('  Loading weex.com/en/copy-trading...')
    await page.goto('https://www.weex.com/en/copy-trading', { waitUntil: 'networkidle0', timeout: 45000 })
    await new Promise(r => setTimeout(r, 3000))

    // Accept cookies
    try {
      const acceptBtn = await page.$('button:has-text("Accept"), [class*="accept"]')
      if (acceptBtn) { await acceptBtn.click(); console.log('  Accepted cookies'); await new Promise(r => setTimeout(r, 3000)) }
    } catch { /* no cookie banner */ }

    // Click "All elite traders" tab
    try {
      await page.click('text=All elite traders', { timeout: 5000 })
      console.log('  Clicked "All elite traders" tab')
      await new Promise(r => setTimeout(r, 5000))
    } catch {
      console.log('  "All elite traders" tab not found, continuing...')
    }

    console.log(`  After initial load: ${allCaptured.length} traders captured via interception`)

    // Scroll to trigger more data
    for (let i = 0; i < 10; i++) {
      await page.evaluate(() => window.scrollBy(0, 500))
      await new Promise(r => setTimeout(r, 2000))
    }

    console.log(`  After scrolling: ${allCaptured.length} traders captured`)

    // DOM extraction fallback
    if (allCaptured.length === 0) {
      console.log('  No API data captured, trying DOM extraction...')
      const domData = await page.evaluate(() => {
        // Look for elements with percentage values (ROI indicators)
        const results = []
        const allElements = document.querySelectorAll('*')
        for (const el of allElements) {
          const text = el.innerText || ''
          // Look for cards with ROI-like data
          if (text.match(/[+-]?\d+\.\d+%/) && text.length < 500 && text.length > 20) {
            const pctMatches = text.match(/([+-]?\d+\.?\d*)%/g)
            const nameMatch = text.match(/^([^\n\d%]+)/)?.[1]?.trim()
            if (pctMatches && pctMatches.length >= 1 && nameMatch) {
              results.push({
                name: nameMatch.substring(0, 50),
                percentages: pctMatches.map(p => parseFloat(p)),
                rawText: text.substring(0, 200),
              })
            }
          }
        }
        // Dedupe by name
        const seen = new Set()
        return results.filter(r => {
          if (seen.has(r.name)) return false
          seen.add(r.name)
          return true
        })
      })
      console.log(`  DOM extraction found ${domData.length} trader-like elements`)

      for (const d of domData) {
        allCaptured.push({
          uid: `dom_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          nickname: d.name,
          roi: d.percentages[0] || null,
          pnl: null,
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
    const sources = batch.map(t => ({
      source: t.source, source_trader_id: t.source_trader_id,
      handle: t.handle, avatar_url: t.avatar_url,
      profile_url: t.profile_url, is_active: true, updated_at: new Date().toISOString(),
    }))
    await supabase.from('trader_sources').upsert(sources, { onConflict: 'source,source_trader_id' })

    // v1 snapshots (legacy)
    const snapshots = batch.map(t => ({
      source: t.source, source_trader_id: t.source_trader_id,
      season_id: t.season_id, rank: t.rank, roi: t.roi, pnl: t.pnl,
      followers: t.followers, win_rate: t.win_rate, max_drawdown: t.max_drawdown,
      arena_score: t.arena_score, captured_at: t.captured_at,
    }))
    const { error } = await supabase.from('trader_snapshots').upsert(snapshots, { onConflict: 'source,source_trader_id,season_id' })
    if (error) console.error(`  Upsert v1 error: ${error.message}`)

    // v2 snapshots (PRIMARY — read by compute-leaderboard)
    const snapshotsV2 = batch.map(t => ({
      platform: t.source,
      market_type: 'futures',
      trader_key: t.source_trader_id,
      window: t.season_id,
      as_of_ts: t.captured_at,
      roi_pct: t.roi ?? null,
      pnl_usd: t.pnl ?? null,
      win_rate: t.win_rate ?? null,
      max_drawdown: t.max_drawdown ?? null,
      arena_score: t.arena_score ?? null,
      metrics: {
        roi: t.roi ?? null, pnl: t.pnl ?? null,
        win_rate: t.win_rate ?? null, max_drawdown: t.max_drawdown ?? null,
        followers: t.followers ?? null, arena_score: t.arena_score ?? null,
      },
      quality_flags: { is_suspicious: false, suspicion_reasons: [], data_completeness: 0.6 },
      updated_at: new Date().toISOString(),
    }))
    const { error: v2Err } = await supabase.from('trader_snapshots_v2').upsert(snapshotsV2, { onConflict: 'platform,market_type,trader_key,window,as_of_ts' })
    if (v2Err && !v2Err.message.includes('duplicate')) console.error(`  Upsert v2 error: ${v2Err.message}`)
    else saved += batch.length
  }
  return saved
}

async function main() {
  const start = Date.now()
  console.log(`[${new Date().toISOString()}] WEEX fetch starting...`)

  try {
    const raw = await fetchWithBrowser()
    console.log(`  Raw captured: ${raw.length} traders`)

    if (raw.length === 0) {
      console.log('  No data captured — WEEX may be geo-blocked or copy trading disabled')
      process.exit(0)
    }

    const byId = new Map()
    for (const t of raw) {
      const id = t.uid || t.traderId || t.id || t.nickname
      if (id && !byId.has(id)) byId.set(id, t)
    }
    console.log(`  Unique traders: ${byId.size}`)

    const allTraders = []
    for (const period of ['7D', '30D', '90D']) {
      for (const [, item] of byId) {
        const id = String(item.uid || item.traderId || item.id || '')
        let roi = parseNum(item.roi || item.returnRate)
        let pnl = parseNum(item.pnl || item.profit)
        if (roi !== null && Math.abs(roi) <= 1 && roi !== 0) roi = roi * 100
        if (roi === null && pnl === null) continue
        allTraders.push({
          source: SOURCE,
          source_trader_id: id || `dom_${Date.now()}`,
          handle: item.nickName || item.nickname || item.name || `Trader_${id.slice(0, 8)}`,
          profile_url: null,
          season_id: period,
          rank: null,
          roi, pnl,
          win_rate: null, max_drawdown: null,
          followers: parseNum(item.followerCount || item.followers),
          arena_score: calculateArenaScore(roi || 0, pnl || 0, period),
          captured_at: new Date().toISOString(),
          avatar_url: item.avatar || null,
        })
      }
    }

    const saved = await upsertBatch(allTraders)
    const duration = ((Date.now() - start) / 1000).toFixed(1)
    console.log(`[${new Date().toISOString()}] WEEX done: ${saved} saved in ${duration}s`)
  } catch (err) {
    console.error(`[${new Date().toISOString()}] WEEX error:`, err.message)
    process.exit(1)
  }
}

main()
