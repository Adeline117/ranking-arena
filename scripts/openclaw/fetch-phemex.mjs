#!/usr/bin/env node
/**
 * Phemex Copy Trading Fetcher — Mac Mini (residential IP + real Chrome)
 *
 * CloudFront blocks all direct API/curl calls. Browser requests pass.
 *
 * Strategy:
 * 1. Launch Chrome → phemex.com/copy-trading/leaderboard
 * 2. Capture API responses via page.on('response')
 * 3. Scroll down to trigger pagination / lazy loading
 * 4. Parse captured data, write to Supabase
 *
 * Discovered endpoint (2026-03-08):
 *   api10.phemex.com/phemex-lb/public/data/user/leaders
 *   Fields: userId, nickName, avatar, pnl30d, pnlRate30d, pnl90d, pnlRate90d,
 *           totalPnl, totalPnlRate, followerCount, ranking
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

const SOURCE = 'phemex'
const TARGET = 200
const PERIODS = { '7D': 7, '30D': 30, '90D': 90 }

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

// ── Parse leader from api10 response ──
function parseLeader(item, period) {
  const id = String(item.userId || '')
  if (!id || id === '0') return null

  const days = PERIODS[period]
  // Period-specific fields: pnl30d / pnlRate30d / pnl90d / pnlRate90d
  let pnl = parseNum(item[`pnl${days}d`]) ?? parseNum(item.totalPnl)
  let roi = parseNum(item[`pnlRate${days}d`]) ?? parseNum(item.totalPnlRate)

  // pnlRate is already percentage (e.g. -19.53 = -19.53%)
  if (roi === null && pnl !== null && pnl !== 0) {
    roi = (pnl / 10000) * 100
  }
  if (roi === null) return null

  const followers = parseNum(item.followerCount)
  const handle = item.nickName || `Trader_${id.slice(0, 8)}`

  return {
    source: SOURCE,
    source_trader_id: id,
    handle,
    profile_url: `https://phemex.com/copy-trading/trader/${id}`,
    season_id: period,
    rank: item.ranking || 0,
    roi,
    pnl,
    win_rate: null,
    max_drawdown: null,
    followers: followers ? Math.round(followers) : null,
    arena_score: calculateArenaScore(roi, pnl, period),
    captured_at: new Date().toISOString(),
    avatar_url: item.avatar ? `https://static.phemex.com/avatar/${item.avatar}` : null,
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

    // Collect all intercepted API responses
    const allCaptured = []
    const allUrls = []

    page.on('response', async (response) => {
      const url = response.url()
      // Capture leader/trader list responses
      if (
        url.includes('/leaders') ||
        url.includes('/traders') ||
        url.includes('queryTrader') ||
        url.includes('copy-trad')
      ) {
        try {
          const ct = response.headers()['content-type'] || ''
          if (!ct.includes('json') && !ct.includes('text')) return

          const text = await response.text()
          if (!text.startsWith('{') && !text.startsWith('[')) return

          const json = JSON.parse(text)
          let list = []
          if (Array.isArray(json.data)) list = json.data
          else if (json.data?.rows) list = json.data.rows
          else if (json.data?.list) list = json.data.list
          else if (Array.isArray(json)) list = json

          // Filter: only keep objects with userId or traderUid
          list = list.filter(item =>
            item && typeof item === 'object' &&
            (item.userId || item.traderUid || item.uid)
          )

          if (list.length > 0) {
            console.log(`  [capture] ${list.length} traders from ${url.slice(0, 120)}`)
            allCaptured.push(...list)
            allUrls.push(url)
          }
        } catch { /* not JSON */ }
      }
    })

    // Step 1: Navigate
    console.log('  Loading phemex.com/copy-trading/leaderboard...')
    await page.goto('https://phemex.com/copy-trading/leaderboard', {
      waitUntil: 'networkidle0',
      timeout: 45000,
    })
    await new Promise(r => setTimeout(r, 3000))
    console.log(`  After initial load: ${allCaptured.length} traders captured`)

    // Step 2: Trigger more data by scrolling (the page uses infinite scroll or pagination)
    console.log('  Scrolling to trigger more data loads...')
    const prevCount = allCaptured.length

    // Scroll aggressively within the page
    for (let round = 0; round < 15; round++) {
      await page.evaluate(() => {
        window.scrollTo(0, document.body.scrollHeight)
      })
      await new Promise(r => setTimeout(r, 1200))

      if (allCaptured.length > prevCount + round * 5) {
        console.log(`    Scroll ${round + 1}: ${allCaptured.length} traders`)
      }
    }

    // Click pagination "next" buttons, waiting for new data after each click
    let noNewDataStreak = 0
    for (let attempt = 0; attempt < 30 && noNewDataStreak < 3; attempt++) {
      const countBefore = allCaptured.length

      const clickResult = await page.evaluate(() => {
        const selectors = [
          '.ant-pagination-next:not(.ant-pagination-disabled)',
          '[class*="pagination"] [class*="next"]:not([class*="disabled"])',
        ]
        for (const sel of selectors) {
          const el = document.querySelector(sel)
          if (el) { el.click(); return sel }
        }
        return null
      })

      if (!clickResult) break

      // Wait for API response to arrive
      await new Promise(r => setTimeout(r, 2500))

      if (allCaptured.length > countBefore) {
        noNewDataStreak = 0
      } else {
        noNewDataStreak++
      }
    }

    // Step 3: Try using XMLHttpRequest (sometimes passes where fetch doesn't)
    if (allCaptured.length <= 10) {
      console.log('  Trying XHR from browser context...')
      const leaderUrl = allUrls.find(u => u.includes('phemex-lb/public/data/user/leaders'))
      if (leaderUrl) {
        const baseUrl = new URL(leaderUrl)
        const sortBy = baseUrl.searchParams.get('sortBy') || 'Pnl30d'

        for (let pageNum = 2; pageNum <= 20; pageNum++) {
          const xhrResult = await page.evaluate(async (params) => {
            return new Promise((resolve) => {
              const xhr = new XMLHttpRequest()
              xhr.open('GET', `${params.origin}/phemex-lb/public/data/user/leaders?pageNum=${params.pageNum}&pageSize=10&sortBy=${params.sortBy}`)
              xhr.withCredentials = true
              xhr.onload = () => {
                try {
                  resolve(JSON.parse(xhr.responseText))
                } catch { resolve(null) }
              }
              xhr.onerror = () => resolve(null)
              xhr.send()
            })
          }, { origin: baseUrl.origin, pageNum, sortBy })

          if (!xhrResult?.data || !Array.isArray(xhrResult.data) || xhrResult.data.length === 0) {
            console.log(`    XHR page ${pageNum}: empty`)
            break
          }

          const newTraders = xhrResult.data.filter(item => item?.userId)
          allCaptured.push(...newTraders)
          console.log(`    XHR page ${pageNum}: +${newTraders.length} (total: ${allCaptured.length})`)

          if (newTraders.length < 10) break
          await new Promise(r => setTimeout(r, 500))
        }
      }
    }

    console.log(`  Total captured: ${allCaptured.length} unique traders`)

    // Step 4: Process captured data for each period
    // The data has period-specific fields (pnl7d, pnl30d, pnl90d, etc.)
    // so the same traders can be scored differently per period
    if (allCaptured.length === 0) {
      for (const period of periods) {
        results[period] = { total: 0, saved: 0, error: 'No data captured from browser' }
      }
    } else {
      for (const period of periods) {
        const seen = new Set()
        const traders = []
        for (const item of allCaptured) {
          const parsed = parseLeader(item, period)
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
          results[period] = { total: 0, saved: 0, error: 'No parseable traders' }
        }
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
    market_type: 'futures',
    trader_key: t.source_trader_id,
    display_name: t.handle || null,
    avatar_url: t.avatar_url,
    profile_url: t.profile_url,
    followers: t.followers || 0,
    copiers: 0,
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

  // 3. trader_snapshots_v2
  const snapshotsV2 = traders.map(t => ({
    platform: t.source,
    market_type: 'futures',
    trader_key: t.source_trader_id,
    window: t.season_id,
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
      data_completeness: 0.7,
    },
    updated_at: new Date().toISOString(),
  }))
  const { error: v2Err } = await supabase
    .from('trader_snapshots_v2')
    .upsert(snapshotsV2, { onConflict: 'platform,market_type,trader_key,window,as_of_ts' })
  // Ignore duplicate key errors (expected on re-runs)
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
  const periods = arg && PERIODS[arg] ? [arg] : ['7D', '30D', '90D']

  console.log(`[${new Date().toISOString()}] Phemex Mac Mini fetcher (${periods.join(', ')})`)
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
    await sendTelegram(`✅ <b>Phemex (Mac Mini)</b>\n${lines.join('\n')}\n⏱ ${duration}s`)
  } else {
    const errors = Object.entries(results)
      .filter(([, r]) => r.error)
      .map(([p, r]) => `${p}: ${r.error}`)
    await sendTelegram(`❌ <b>Phemex (Mac Mini) failed</b>\n${errors.join('\n')}`)
  }
}

main().catch(err => {
  console.error('Fatal:', err)
  process.exit(1)
})
