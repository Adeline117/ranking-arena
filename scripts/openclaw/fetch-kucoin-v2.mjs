#!/usr/bin/env node
//
// KuCoin Copy Trading Fetcher — Mac Mini (residential IP + real Chrome)
//
// KuCoin's copy trading APIs return 404 via curl but work inside browser context.
// Discovered endpoint (2026-03-13):
//   /_api/ct-copy-trade/v1/copyTrading/rn/leaderboard/query
//
// Strategy:
// 1. Launch Chrome, navigate to kucoin.com/copytrading
// 2. Click "Hub" tab + Accept cookies to trigger SPA module load
// 3. Intercept the leaderboard/query API response
// 4. If interception fails, use page.evaluate to fetch from browser context
// 5. Parse, write to Supabase
//
// Cron: every 6h
//

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
if (!SUPABASE_URL || !SUPABASE_KEY) { console.error('Missing Supabase env'); process.exit(1) }

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)
const SOURCE = 'kucoin'

const clip = (v, min, max) => Math.max(min, Math.min(max, v))
const safeLog1p = x => x <= -1 ? 0 : Math.log(1 + x)
const AP = { '7D': { c: 0.08, e: 1.8 }, '30D': { c: 0.15, e: 1.6 }, '90D': { c: 0.18, e: 1.6 } }
const PP = { '7D': { b: 300, c: 0.42 }, '30D': { b: 600, c: 0.30 }, '90D': { b: 650, c: 0.27 } }
function score(roi, pnl, period) {
  const { c, e } = AP[period] || AP['90D']
  const days = period === '7D' ? 7 : period === '30D' ? 30 : 90
  const r0 = Math.tanh(c * (365 / days) * safeLog1p(Math.min(roi || 0, 10000) / 100))
  const rs = r0 > 0 ? clip(60 * Math.pow(r0, e), 0, 60) : 0
  let ps = 0
  if (pnl > 0) { const p = PP[period] || PP['90D']; const la = 1 + pnl / p.b; if (la > 0) ps = clip(40 * Math.tanh(p.c * Math.log(la)), 0, 40) }
  return Math.round(clip(rs + ps, 0, 100) * 100) / 100
}

function parseNum(v) {
  if (v == null || v === '') return null
  const n = typeof v === 'number' ? v : parseFloat(String(v).replace(/[,%]/g, ''))
  return isNaN(n) || !isFinite(n) ? null : n
}

async function fetchWithBrowser() {
  const browser = await puppeteer.launch({
    headless: 'shell',
    executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--window-size=1440,900'],
  })
  try {
    const page = await browser.newPage()
    await page.setViewport({ width: 1440, height: 900 })
    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36')

    let leaderboardData = null
    page.on('response', async (r) => {
      if (r.url().includes('leaderboard/query') && r.status() === 200) {
        try {
          const json = await r.json()
          if (json.data) { leaderboardData = json.data; console.log(`  [capture] leaderboard API intercepted`) }
        } catch {}
      }
    })

    console.log('  Loading kucoin.com/copytrading...')
    await page.goto('https://www.kucoin.com/copytrading', { waitUntil: 'networkidle0', timeout: 45000 })
    await new Promise(r => setTimeout(r, 3000))

    try { await page.click('text=Hub', { timeout: 5000 }); console.log('  Clicked Hub tab') } catch { console.log('  Hub tab not found') }
    try { await page.click('text=Accept All', { timeout: 3000 }); console.log('  Accepted cookies') } catch {}
    await new Promise(r => setTimeout(r, 8000))

    if (!leaderboardData) {
      console.log('  Trying in-browser fetch...')
      leaderboardData = await page.evaluate(async () => {
        try {
          const r = await fetch('/_api/ct-copy-trade/v1/copyTrading/rn/leaderboard/query?lang=en_US', { credentials: 'include' })
          if (!r.ok) return null
          const text = await r.text()
          return text.startsWith('{') ? JSON.parse(text).data : null
        } catch { return null }
      })
      if (leaderboardData) console.log('  In-browser fetch succeeded')
    }

    if (!leaderboardData) {
      // DOM extraction fallback
      for (let i = 0; i < 5; i++) { await page.evaluate(() => window.scrollBy(0, 500)); await new Promise(r => setTimeout(r, 1500)) }
      const dom = await page.evaluate(() => {
        const results = []
        const seen = new Set()
        document.querySelectorAll('*').forEach(el => {
          const t = el.innerText || ''
          if (t.match(/[+-]?\d+\.\d+%/) && t.length < 300 && t.length > 20) {
            const card = el.closest('[class*=card], [class*=item]') || el
            if (seen.has(card)) return
            seen.add(card)
            const pct = t.match(/([+-]?\d+\.?\d*)%/)
            const lines = t.split('\n').filter(l => l.trim())
            if (pct) results.push({ name: lines[0]?.substring(0, 30), roi: parseFloat(pct[1]) })
          }
        })
        return results
      })
      if (dom.length > 0) {
        console.log(`  DOM extraction: ${dom.length} traders`)
        return dom.map(d => ({ uid: d.name, nickname: d.name, roi: d.roi }))
      }
      return []
    }

    // Parse leaderboard response
    let traders = []
    if (Array.isArray(leaderboardData)) traders = leaderboardData
    else if (typeof leaderboardData === 'object') {
      for (const [k, v] of Object.entries(leaderboardData)) {
        if (Array.isArray(v) && v.length > 0 && typeof v[0] === 'object') {
          console.log(`  Found traders in "${k}": ${v.length}`)
          traders.push(...v)
        }
      }
    }
    return traders
  } finally { await browser.close() }
}

async function upsertBatch(traders) {
  const BATCH = 100; let saved = 0
  for (let i = 0; i < traders.length; i += BATCH) {
    const batch = traders.slice(i, i + BATCH)
    await supabase.from('trader_sources').upsert(
      batch.map(t => ({ source: t.source, source_trader_id: t.source_trader_id, handle: t.handle, avatar_url: t.avatar_url, profile_url: t.profile_url, is_active: true, updated_at: new Date().toISOString() })),
      { onConflict: 'source,source_trader_id' }
    )
    const { error } = await supabase.from('trader_snapshots').upsert(
      batch.map(t => ({ source: t.source, source_trader_id: t.source_trader_id, season_id: t.season_id, rank: t.rank, roi: t.roi, pnl: t.pnl, followers: t.followers, win_rate: t.win_rate, max_drawdown: t.max_drawdown, arena_score: t.arena_score, captured_at: t.captured_at })),
      { onConflict: 'source,source_trader_id,season_id' }
    )
    if (error) console.error(`  Upsert error: ${error.message}`)
    else saved += batch.length
  }
  return saved
}

async function main() {
  const start = Date.now()
  console.log(`[${new Date().toISOString()}] KuCoin fetch starting...`)
  const raw = await fetchWithBrowser()
  console.log(`  Raw: ${raw.length} traders`)
  if (!raw.length) { console.log('  No data'); process.exit(0) }

  const byId = new Map()
  for (const t of raw) {
    const id = String(t.leadConfigId || t.leaderId || t.uid || t.userId || t.id || t.nickName || '')
    if (id && !byId.has(id)) byId.set(id, t)
  }

  const all = []
  for (const period of ['7D', '30D', '90D']) {
    for (const [id, item] of byId) {
      // KuCoin fields: thirtyDayPnlRatio (decimal ROI), totalPnl, totalPnlRatio
      let roi = parseNum(item.thirtyDayPnlRatio || item.totalPnlRatio || item.roi || item.returnRate)
      let pnl = parseNum(item.thirtyDayPnl || item.totalPnl || item.pnl || item.profit)
      // ROI is decimal (e.g., 3.8043 = 380.43%)
      if (roi != null) roi = roi * 100
      if (roi == null && pnl == null) continue
      all.push({
        source: SOURCE, source_trader_id: id,
        handle: item.nickName || item.nickname || `Trader_${id}`,
        profile_url: `https://www.kucoin.com/copytrading`,
        season_id: period, rank: null, roi, pnl,
        win_rate: null, max_drawdown: null,
        followers: parseNum(item.currentCopyUserCount || item.followerCount),
        arena_score: score(roi || 0, pnl || 0, period),
        captured_at: new Date().toISOString(), avatar_url: item.avatarUrl || null,
      })
    }
  }

  const saved = await upsertBatch(all)
  console.log(`[${new Date().toISOString()}] KuCoin done: ${saved} saved in ${((Date.now() - start) / 1000).toFixed(1)}s`)
}

main().catch(e => { console.error(e.message); process.exit(1) })
