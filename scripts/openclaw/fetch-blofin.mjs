#!/usr/bin/env node
/**
 * BloFin Copy Trading Fetcher — Mac Mini (residential IP + real Chrome)
 *
 * BloFin's openapi.blofin.com returns 401 without auth.
 * VPS SG is geo-blocked by BloFin ("restricted countries or regions").
 * Mac Mini with residential US IP + real Chrome bypasses Cloudflare.
 *
 * Discovered API (2026-03-10):
 *   POST /uapi/v1/copy/v2/trader/list
 *   Header: blofin-copy-trading-user: 1
 *   Body: { hide_full_portfolios, sort_field, range_time, sort_order, nick_name,
 *           trading_bots_type, tag_list, page_num, page_size, ... }
 *   Response: { code: 200, data: { trader_info: [...] } }
 *   Fields: uid, nick_name, profile, range_time, roi (decimal string, 5.22 = 522%),
 *           pnl (string), mdd (decimal string), aum (string), sharpe_ratio (string),
 *           followers (number), followers_max (number), chart_data
 *   Max 20 per page, ~600 traders total. Pagination: page_num 1..N
 *
 * Also available: POST /uapi/v1/copy/trader/rank (15 per category, 4 categories)
 *
 * Strategy:
 * 1. Launch Chrome headless:'new' → blofin.com/en/copy-trade (bypasses CF challenge)
 * 2. Use page.evaluate(fetch) to call internal API with pagination
 * 3. Parse per-period data, write to Supabase
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
const SOURCE = 'blofin'
const TARGET = 200
const PAGE_SIZE = 20 // BloFin caps at 20 per page regardless of page_size param
const MAX_PAGES = 15 // 15 pages * 20 = 300 traders max per period

// Period mapping: '7D' -> '1', '30D' -> '2', '90D' -> '3'
const RANGE_TIME = { '7D': '1', '30D': '2', '90D': '3' }

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

function parseTrader(item, period) {
  const id = String(item.uid || '')
  if (!id || id === 'undefined' || id === '0') return null

  const handle = item.nick_name || `Trader_${id.slice(0, 8)}`

  // BloFin ROI is decimal: 5.22 = 522%. Convert to percentage.
  let roi = parseNum(item.roi)
  if (roi === null) return null
  roi = roi * 100

  const pnl = parseNum(item.pnl)

  // MDD is also decimal: 0.2464 = 24.64%
  let mdd = parseNum(item.mdd)
  if (mdd !== null) mdd = Math.abs(mdd) * 100

  const sharpeRatio = parseNum(item.sharpe_ratio)
  const aum = parseNum(item.aum)
  const followers = item.followers != null ? Math.round(item.followers) : null

  return {
    source: SOURCE, source_trader_id: id, handle,
    profile_url: `https://blofin.com/en/copy-trade/trader/${id}`,
    season_id: period, rank: 0, roi, pnl,
    win_rate: null, // BloFin API does not return win_rate in list endpoint
    max_drawdown: mdd,
    sharpe_ratio: sharpeRatio,
    aum,
    followers,
    arena_score: calculateArenaScore(roi, pnl, period),
    captured_at: new Date().toISOString(),
    avatar_url: item.profile || null,
  }
}

async function fetchWithBrowser(periods) {
  const browser = await puppeteer.launch({
    headless: 'new', // CRITICAL: 'new' bypasses CF challenge, 'shell' does NOT
    executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    args: [
      '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
      '--disable-gpu', '--window-size=1440,900',
      '--disable-blink-features=AutomationControlled',
    ],
  })

  const results = {}

  try {
    const page = await browser.newPage()
    await page.setViewport({ width: 1440, height: 900 })
    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36')

    // Step 1: Navigate to copy-trade page to establish session + pass CF
    console.log('  Loading blofin.com/en/copy-trade...')
    await page.goto('https://blofin.com/en/copy-trade', { waitUntil: 'domcontentloaded', timeout: 45000 })

    // Wait for CF challenge to resolve
    for (let i = 0; i < 6; i++) {
      await new Promise(r => setTimeout(r, 3000))
      const title = await page.title()
      if (!title.includes('moment')) {
        console.log(`  CF challenge passed (title: ${title.slice(0, 50)})`)
        break
      }
      if (i === 5) console.log('  WARNING: CF challenge may not have resolved')
    }
    await new Promise(r => setTimeout(r, 2000))

    // Step 2: For each period, paginate through /uapi/v1/copy/v2/trader/list
    for (const period of periods) {
      const rangeTime = RANGE_TIME[period] || '2'
      const allItems = []
      const seen = new Set()
      let emptyPages = 0

      console.log(`  Fetching ${period} (range_time=${rangeTime})...`)

      for (let pageNum = 1; pageNum <= MAX_PAGES && emptyPages < 2; pageNum++) {
        try {
          const data = await page.evaluate(async (opts) => {
            try {
              const r = await fetch('/uapi/v1/copy/v2/trader/list', {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  'Accept': 'application/json',
                  'blofin-copy-trading-user': '1',
                },
                body: JSON.stringify({
                  hide_full_portfolios: 0,
                  sort_field: 'roi',
                  range_time: opts.rt,
                  sort_order: 'DESC',
                  nick_name: '',
                  trading_bots_type: [],
                  tag_list: [],
                  page_num: opts.pn,
                  page_size: 50,
                  pnl_lower: '',
                  pnl_upper: '',
                  copier_pnl_lower: '',
                  copier_pnl_upper: '',
                }),
                credentials: 'include',
              })
              return await r.json()
            } catch (e) { return { error: e.message } }
          }, { rt: rangeTime, pn: pageNum })

          if (data.error) {
            console.log(`    Page ${pageNum}: fetch error: ${data.error}`)
            emptyPages++
            continue
          }

          if (data.code !== 200) {
            console.log(`    Page ${pageNum}: API error code=${data.code} msg=${data.msg}`)
            emptyPages++
            continue
          }

          const traderInfo = data.data?.trader_info || []
          if (traderInfo.length === 0) {
            emptyPages++
            continue
          }

          let newCount = 0
          for (const item of traderInfo) {
            const uid = String(item.uid || '')
            if (uid && !seen.has(uid)) {
              seen.add(uid)
              allItems.push(item)
              newCount++
            }
          }

          if (newCount === 0) {
            emptyPages++
          } else {
            emptyPages = 0
          }

          // Brief delay between pages
          if (pageNum < MAX_PAGES) await new Promise(r => setTimeout(r, 500))
        } catch (err) {
          console.log(`    Page ${pageNum}: error: ${err.message}`)
          emptyPages++
        }
      }

      console.log(`  ${period}: fetched ${allItems.length} unique traders`)

      if (allItems.length === 0) {
        // Fallback: try /rank endpoint which gives top 15 per category
        console.log(`  ${period}: trying /rank fallback...`)
        try {
          const rankData = await page.evaluate(async () => {
            try {
              const r = await fetch('/uapi/v1/copy/trader/rank', {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  'Accept': 'application/json',
                  'blofin-copy-trading-user': '1',
                },
                body: JSON.stringify({ nick_name: '', limit: 15 }),
                credentials: 'include',
              })
              return await r.json()
            } catch (e) { return { error: e.message } }
          })

          if (rankData.code === 200 && rankData.data) {
            for (const listName of ['top_roi_list', 'top_predunt_list', 'highest_copier_pnl_list', 'top_new_talent_list']) {
              const list = rankData.data[listName] || []
              for (const item of list) {
                const uid = String(item.uid || '')
                if (uid && !seen.has(uid)) {
                  seen.add(uid)
                  allItems.push(item)
                }
              }
            }
            console.log(`  ${period}: rank fallback got ${allItems.length} unique traders`)
          }
        } catch (err) {
          console.log(`  ${period}: rank fallback error: ${err.message}`)
        }
      }

      // Parse and save
      const traders = []
      for (const item of allItems) {
        const parsed = parseTrader(item, period)
        if (parsed) traders.push(parsed)
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

  const sources = traders.map(t => ({
    source: t.source, source_trader_id: t.source_trader_id,
    handle: t.handle, profile_url: t.profile_url, avatar_url: t.avatar_url,
  }))
  const { error: srcErr } = await supabase.from('trader_sources').upsert(sources, { onConflict: 'source,source_trader_id' })
  if (srcErr) console.error('trader_sources error:', srcErr.message)

  const profiles = traders.map(t => ({
    platform: t.source, market_type: 'futures', trader_key: t.source_trader_id,
    display_name: t.handle || null, avatar_url: t.avatar_url, profile_url: t.profile_url,
    followers: t.followers ?? 0, copiers: 0, tags: [], bio: null, aum: t.aum ?? null,
    provenance: { source_url: t.profile_url, created_by: 'mac-mini-fetcher', created_at: new Date().toISOString() },
    updated_at: new Date().toISOString(),
  }))
  const { error: profileErr } = await supabase.from('trader_profiles_v2').upsert(profiles, { onConflict: 'platform,market_type,trader_key' })
  if (profileErr) console.error('trader_profiles_v2 error:', profileErr.message)

  const snapshotsV1 = traders.map(t => ({
    source: t.source, source_trader_id: t.source_trader_id, season_id: t.season_id,
    rank: t.rank, roi: t.roi, pnl: t.pnl, win_rate: t.win_rate, max_drawdown: t.max_drawdown,
    followers: t.followers, arena_score: t.arena_score, captured_at: t.captured_at,
  }))
  const { error: v1Err } = await supabase.from('trader_snapshots').upsert(snapshotsV1, { onConflict: 'source,source_trader_id,season_id' })
  if (v1Err) return { total: traders.length, saved: 0, error: v1Err.message }

  const snapshotsV2 = traders.map(t => ({
    platform: t.source, market_type: 'futures', trader_key: t.source_trader_id, window: t.season_id, as_of_ts: t.captured_at,
    metrics: {
      roi: t.roi ?? 0, pnl: t.pnl ?? 0, win_rate: t.win_rate ?? null,
      max_drawdown: t.max_drawdown ?? null, sharpe_ratio: t.sharpe_ratio ?? null,
      followers: t.followers ?? null, arena_score: t.arena_score ?? null,
      aum: t.aum ?? null,
    },
    quality_flags: { is_suspicious: false, suspicion_reasons: [], data_completeness: 0.8 },
    updated_at: new Date().toISOString(),
  }))
  const { error: v2Err } = await supabase.from('trader_snapshots_v2').upsert(snapshotsV2, { onConflict: 'platform,market_type,trader_key,window,as_of_ts' })
  if (v2Err && !v2Err.message.includes('duplicate') && !v2Err.message.includes('unique')) console.error('v2 error:', v2Err.message)

  return { total: traders.length, saved: traders.length }
}

async function sendTelegram(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text, parse_mode: 'HTML' }),
    })
  } catch (err) { console.error('Telegram failed:', err.message) }
}

async function main() {
  const arg = process.argv[2]?.toUpperCase()
  const periods = arg && { '7D': 1, '30D': 1, '90D': 1 }[arg] ? [arg] : ['7D', '30D', '90D']
  console.log(`[${new Date().toISOString()}] BloFin Mac Mini fetcher (${periods.join(', ')})`)
  const start = Date.now()
  const results = await fetchWithBrowser(periods)
  const duration = ((Date.now() - start) / 1000).toFixed(1)
  const totalSaved = Object.values(results).reduce((s, r) => s + (r.saved || 0), 0)
  for (const [p, r] of Object.entries(results)) console.log(`  ${p}: ${r.saved}/${r.total} saved ${r.error ? `(${r.error})` : ''}`)
  console.log(`\nDone in ${duration}s. Total saved: ${totalSaved}`)
  if (totalSaved > 0) {
    await sendTelegram(`✅ <b>BloFin (Mac Mini)</b>\n${Object.entries(results).map(([p, r]) => `${p}: ${r.saved} traders`).join('\n')}\n⏱ ${duration}s`)
  } else {
    await sendTelegram(`❌ <b>BloFin (Mac Mini) failed</b>\n${Object.entries(results).filter(([, r]) => r.error).map(([p, r]) => `${p}: ${r.error}`).join('\n')}`)
  }
}

main().catch(err => { console.error('Fatal:', err); process.exit(1) })
