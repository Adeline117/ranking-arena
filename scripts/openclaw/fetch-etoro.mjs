#!/usr/bin/env node
/**
 * eToro Copy Trading Fetcher — Mac Mini (browser automation)
 *
 * Problem: eToro API blocked by Cloudflare protection
 * Solution: Browser-based scraping using real Chrome (like Phemex)
 *
 * Strategy:
 * 1. Launch Chrome → etoro.com/sapi/rankings/rankings/
 * 2. Capture API responses via page.on('response')
 * 3. Filter crypto traders (exclude Stocks, ETFs, Currencies)
 * 4. Parse captured data, write to Supabase
 *
 * Discovered endpoint:
 *   https://www.etoro.com/sapi/rankings/rankings/?Period={period}&page={page}&pagesize=100
 *   Fields: CustomerId, UserName, Gain (ROI), WinRatio, PeakToValley (MDD),
 *           Copiers, AUMValue, TopTradedAssetClassName
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
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_ALERT_CHAT_ID

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY')
  process.exit(1)
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)

const SOURCE = 'etoro'
const TARGET = 200
const EXCLUDED_ASSET_CLASSES = new Set([
  'Stocks', 'ETFs', 'Currencies', 'Commodities', 'Indices',
])

// Period mapping: Arena window → eToro API period
const PERIOD_MAP = {
  '7D': 'CurrMonth',
  '30D': 'OneMonthAgo',
  '90D': 'ThreeMonthsAgo',
}

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
const getPeriodDays = p => p === '7D' ? 7 : p === '30D' ? 30 : 90

function calculateArenaScore(roi, pnl, period) {
  const params = ARENA_PARAMS[period] || ARENA_PARAMS['90D']
  const days = getPeriodDays(period)
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
  const n = typeof v === 'number' ? v : parseFloat(String(v))
  return isNaN(n) ? null : n
}

// ── Parse trader from eToro API response ──
function parseTrader(item, period) {
  const id = String(item.CustomerId || '')
  if (!id || id === '0') return null

  // Filter out non-crypto traders
  if (EXCLUDED_ASSET_CLASSES.has(item.TopTradedAssetClassName)) return null

  const roi = parseNum(item.Gain) // Already percentage
  if (roi === null) return null

  const aum = parseNum(item.AUMValue)
  // Estimate PnL from AUM × Gain
  const pnl = (roi != null && aum != null && aum > 0)
    ? aum * roi / 100
    : null

  const handle = item.UserName || `Trader_${id.slice(0, 8)}`
  const winRate = parseNum(item.WinRatio)
  const mdd = item.PeakToValley != null ? Math.abs(parseNum(item.PeakToValley)) : null
  const copiers = parseNum(item.Copiers)

  return {
    source: SOURCE,
    source_trader_id: id,
    handle,
    profile_url: `https://www.etoro.com/people/${handle}`,
    season_id: period,
    rank: 0, // Will be assigned after sorting
    roi,
    pnl,
    win_rate: winRate,
    max_drawdown: mdd,
    followers: copiers ? Math.round(copiers) : null,
    arena_score: calculateArenaScore(roi, pnl, period),
    captured_at: new Date().toISOString(),
    avatar_url: item.HasAvatar
      ? `https://etoro-cdn.etorostatic.com/avatars/${id}/150x150.jpg`
      : null,
  }
}

// ── Browser session ──
async function fetchWithBrowser(periods) {
  const browser = await puppeteer.launch({
    headless: 'shell',
    executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--window-size=1440,900',
    ],
  })

  const results = {}

  try {
    const page = await browser.newPage()
    await page.setViewport({ width: 1440, height: 900 })
    await page.setUserAgent(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
    )

    for (const period of periods) {
      console.log(`\n[${period}] Fetching eToro leaderboard...`)
      const etoroApiPeriod = PERIOD_MAP[period]
      const allCaptured = []

      // Intercept API responses
      page.on('response', async (response) => {
        const url = response.url()
        if (url.includes('/sapi/rankings/rankings/')) {
          try {
            const ct = response.headers()['content-type'] || ''
            if (!ct.includes('json')) return

            const text = await response.text()
            if (!text.startsWith('{')) return

            const json = JSON.parse(text)
            if (json.Items && Array.isArray(json.Items)) {
              console.log(`  [capture] ${json.Items.length} traders from API`)
              allCaptured.push(...json.Items)
            }
          } catch { /* not JSON */ }
        }
      })

      // Navigate to trigger API calls
      const baseUrl = `https://www.etoro.com/sapi/rankings/rankings/?Period=${etoroApiPeriod}&page=1&pagesize=100`
      console.log(`  Loading: ${baseUrl}`)
      
      try {
        await page.goto(baseUrl, {
          waitUntil: 'networkidle0',
          timeout: 30000,
        })
        await new Promise(r => setTimeout(r, 2000))
      } catch (err) {
        console.error(`  Initial load failed: ${err.message}`)
      }

      console.log(`  After initial load: ${allCaptured.length} traders captured`)

      // Try fetching multiple pages via browser context (bypasses Cloudflare)
      for (let pageNum = 2; pageNum <= 20 && allCaptured.length < TARGET; pageNum++) {
        const pageUrl = `https://www.etoro.com/sapi/rankings/rankings/?Period=${etoroApiPeriod}&page=${pageNum}&pagesize=100`
        
        const pageResult = await page.evaluate(async (url) => {
          return new Promise((resolve) => {
            fetch(url, {
              credentials: 'include',
              headers: {
                'Accept': 'application/json',
                'Referer': 'https://www.etoro.com/',
              },
            })
              .then(r => r.json())
              .then(data => resolve(data))
              .catch(() => resolve(null))
          })
        }, pageUrl)

        if (!pageResult?.Items || pageResult.Items.length === 0) {
          console.log(`    Page ${pageNum}: empty`)
          break
        }

        allCaptured.push(...pageResult.Items)
        console.log(`    Page ${pageNum}: +${pageResult.Items.length} (total: ${allCaptured.length})`)
        await new Promise(r => setTimeout(r, 800))
      }

      console.log(`  Total captured for ${period}: ${allCaptured.length} traders`)

      // Parse and filter crypto traders
      const seen = new Set()
      const traders = []
      for (const item of allCaptured) {
        const parsed = parseTrader(item, period)
        if (!parsed || seen.has(parsed.source_trader_id)) continue
        seen.add(parsed.source_trader_id)
        traders.push(parsed)
      }

      traders.sort((a, b) => (b.roi ?? 0) - (a.roi ?? 0))
      const top = traders.slice(0, TARGET)
      top.forEach((t, i) => { t.rank = i + 1 })

      if (top.length > 0) {
        results[period] = await saveTraders(top)
      } else {
        results[period] = { total: 0, saved: 0, error: 'No crypto traders found' }
      }
    }
  } catch (err) {
    console.error(`  Browser error: ${err.message}`)
    for (const period of periods) {
      if (!results[period]) results[period] = { total: 0, saved: 0, error: err.message }
    }
  } finally {
    await browser.close()
  }

  return results
}

async function saveTraders(traders) {
  if (traders.length === 0) return { total: 0, saved: 0, error: 'Empty' }

  // 1. trader_sources (v1 compatibility)
  const sources = traders.map(t => ({
    source: t.source,
    source_trader_id: t.source_trader_id,
    handle: t.handle,
    profile_url: t.profile_url,
    avatar_url: t.avatar_url,
  }))
  const { error: srcErr } = await supabase
    .from('trader_sources')
    .upsert(sources, { onConflict: 'source,source_trader_id' })
  if (srcErr) console.error('trader_sources error:', srcErr.message)

  // 2. trader_profiles_v2 (new schema)
  const profiles = traders.map(t => ({
    platform: t.source,
    market_type: 'spot',
    trader_key: t.source_trader_id,
    display_name: t.handle || null,
    avatar_url: t.avatar_url,
    profile_url: t.profile_url,
    followers: t.followers || 0,
    copiers: t.followers || 0,
    tags: [],
    bio: null,
    aum: null,
    provenance: {
      source_url: t.profile_url,
      created_by: 'mac-mini-fetcher',
      created_at: new Date().toISOString(),
    },
    updated_at: new Date().toISOString(),
  }))
  const { error: profileErr } = await supabase
    .from('trader_profiles_v2')
    .upsert(profiles, { onConflict: 'platform,market_type,trader_key' })
  if (profileErr) console.error('trader_profiles_v2 error:', profileErr.message)

  // 3. trader_snapshots (v1 — primary table for frontend)
  const snapshotsV1 = traders.map(t => ({
    source: t.source,
    source_trader_id: t.source_trader_id,
    season_id: t.season_id,
    rank: t.rank,
    roi: t.roi,
    pnl: t.pnl,
    win_rate: t.win_rate,
    max_drawdown: t.max_drawdown,
    followers: t.followers,
    arena_score: t.arena_score,
    captured_at: t.captured_at,
  }))
  const { error: v1Err } = await supabase
    .from('trader_snapshots')
    .upsert(snapshotsV1, { onConflict: 'source,source_trader_id,season_id' })
  if (v1Err) {
    console.error('trader_snapshots v1 error:', v1Err.message)
    return { total: traders.length, saved: 0, error: v1Err.message }
  }

  // 4. trader_snapshots_v2 (new schema)
  const snapshotsV2 = traders.map(t => ({
    platform: t.source,
    market_type: 'spot',
    trader_key: t.source_trader_id,
    window: t.season_id.toLowerCase(),
    as_of_ts: t.captured_at,
    metrics: {
      roi: t.roi ?? 0,
      pnl: t.pnl ?? 0,
      win_rate: t.win_rate ?? null,
      max_drawdown: t.max_drawdown ?? null,
      followers: t.followers ?? null,
      arena_score: t.arena_score ?? null,
    },
    quality_flags: {
      is_suspicious: false,
      suspicion_reasons: [],
      data_completeness: 0.8,
    },
    updated_at: new Date().toISOString(),
  }))
  const { error: v2Err } = await supabase
    .from('trader_snapshots_v2')
    .upsert(snapshotsV2, { onConflict: 'platform,market_type,trader_key,window,as_of_ts' })
  if (v2Err && !v2Err.message.includes('duplicate') && !v2Err.message.includes('unique')) {
    console.error('trader_snapshots_v2 error:', v2Err.message)
  }

  return { total: traders.length, saved: traders.length }
}

async function sendTelegram(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text, parse_mode: 'HTML' }),
    })
  } catch (err) {
    console.error('Telegram send failed:', err.message)
  }
}

async function main() {
  const arg = process.argv[2]?.toUpperCase()
  const periods = arg && PERIOD_MAP[arg] ? [arg] : ['7D', '30D', '90D']

  console.log(`[${new Date().toISOString()}] eToro Mac Mini fetcher (${periods.join(', ')})`)
  const start = Date.now()

  const results = await fetchWithBrowser(periods)

  const duration = ((Date.now() - start) / 1000).toFixed(1)
  const totalSaved = Object.values(results).reduce((s, r) => s + (r.saved || 0), 0)

  for (const [p, r] of Object.entries(results)) {
    console.log(`  ${p}: ${r.saved}/${r.total} saved ${r.error ? `(${r.error})` : ''}`)
  }
  console.log(`\nDone in ${duration}s. Total saved: ${totalSaved}`)

  if (totalSaved > 0) {
    const lines = Object.entries(results).map(([p, r]) => `${p}: ${r.saved} traders`)
    await sendTelegram(`✅ <b>eToro (Mac Mini)</b>\n${lines.join('\n')}\n⏱ ${duration}s`)
  } else {
    const errors = Object.entries(results)
      .filter(([, r]) => r.error)
      .map(([p, r]) => `${p}: ${r.error}`)
    await sendTelegram(`❌ <b>eToro (Mac Mini) failed</b>\n${errors.join('\n')}`)
  }
}

main().catch(err => {
  console.error('Fatal:', err)
  process.exit(1)
})
