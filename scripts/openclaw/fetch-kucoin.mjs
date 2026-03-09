#!/usr/bin/env node
/**
 * KuCoin Copy Trading Fetcher — Mac Mini (residential IP + real Chrome)
 *
 * KuCoin APIs return 404 from all endpoints. The copy trading feature may
 * still be accessible via browser (kucoin.com/copytrading).
 *
 * Strategy:
 * 1. Launch Chrome → kucoin.com/copytrading
 * 2. Capture API responses via page.on('response')
 * 3. Use pagination clicks for more data
 * 4. Parse captured data, write to Supabase
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
const SOURCE = 'kucoin'
const TARGET = 200

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
  const id = String(item.leadConfigId || item.leaderId || item.uid || item.id || '')
  if (!id || id === 'undefined' || id === '0') return null

  // KuCoin APIs use various field names for ROI depending on endpoint
  let roi = parseNum(item.roi ?? item.totalReturn ?? item.returnRate ?? item.roiRate ?? item.thirtyDayPnlRatio ?? item.totalPnlRatio)
  // thirtyDayPnlRatio/totalPnlRatio are decimal (0.5 = 50%), convert to percentage
  if (roi !== null && Math.abs(roi) > 0 && Math.abs(roi) < 10) roi *= 100

  const pnl = parseNum(item.totalPnl ?? item.pnl ?? item.thirtyDayPnl ?? item.totalProfit ?? item.profit)
  // Accept trader if we have ROI or PnL (don't require both)
  if (roi === null && pnl === null) return null
  if (roi === null) roi = 0

  let winRate = parseNum(item.winRatio ?? item.winRate)
  if (winRate !== null && winRate > 0 && winRate <= 1) winRate *= 100
  let mdd = parseNum(item.maxDrawdown ?? item.mdd)
  if (mdd !== null && Math.abs(mdd) > 0 && Math.abs(mdd) <= 1) mdd *= 100
  const followers = parseNum(item.followerCount ?? item.copierCount ?? item.currentCopyCount)
  const handle = item.nickName || item.nickname || `Trader_${id.slice(0, 8)}`

  return {
    source: SOURCE, source_trader_id: id, handle,
    profile_url: `https://www.kucoin.com/copytrading/leader/${id}`,
    season_id: period, rank: 0, roi, pnl,
    win_rate: winRate, max_drawdown: mdd,
    followers: followers ? Math.round(followers) : null,
    arena_score: calculateArenaScore(roi, pnl, period),
    captured_at: new Date().toISOString(),
    avatar_url: item.avatarUrl || item.avatar || null,
  }
}

async function fetchWithBrowser(periods) {
  const browser = await puppeteer.launch({
    headless: 'shell',
    executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--window-size=1440,900'],
  })

  const results = {}

  try {
    const page = await browser.newPage()
    await page.setViewport({ width: 1440, height: 900 })
    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36')

    const allCaptured = []

    page.on('response', async (response) => {
      const url = response.url()
      if (url.includes('copy-trade') || url.includes('leaderboard') || url.includes('rank-list') || url.includes('leader')) {
        try {
          const ct = response.headers()['content-type'] || ''
          if (!ct.includes('json') && !ct.includes('text')) return
          const text = await response.text()
          if (!text.startsWith('{') && !text.startsWith('[')) return
          const json = JSON.parse(text)

          let list = []
          if (json.data?.items) list = json.data.items
          else if (json.data?.list) list = json.data.list
          else if (Array.isArray(json.data)) list = json.data
          else if (json.items) list = json.items

          list = list.filter(item => item && typeof item === 'object' && (item.leadConfigId || item.leaderId || item.uid))
          if (list.length > 0) {
            console.log(`  [capture] ${list.length} traders from ${url.slice(0, 120)}`)
            if (allCaptured.length === 0) console.log(`  [debug] First item keys: ${Object.keys(list[0]).join(', ')}`)
            allCaptured.push(...list)
          }
        } catch { /* not JSON */ }
      }
    })

    console.log('  Loading kucoin.com/copytrading...')
    await page.goto('https://www.kucoin.com/copytrading', { waitUntil: 'networkidle2', timeout: 60000 })
    await new Promise(r => setTimeout(r, 5000))
    console.log(`  After initial load: ${allCaptured.length} traders captured`)

    // Check if page has content (KuCoin may have removed copy trading entirely)
    const hasContent = await page.evaluate(() => {
      return document.body.innerText.length > 500
    })

    if (!hasContent) {
      console.log('  Page appears empty — KuCoin copy trading may be discontinued')
      for (const period of periods) results[period] = { total: 0, saved: 0, error: 'Page empty — feature may be discontinued' }
      return results
    }

    // Scroll
    for (let round = 0; round < 10; round++) {
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
      await new Promise(r => setTimeout(r, 2000))
    }

    // Click pagination
    let noNewStreak = 0
    for (let attempt = 0; attempt < 20 && noNewStreak < 3; attempt++) {
      const countBefore = allCaptured.length
      const clicked = await page.evaluate(() => {
        const selectors = [
          '.ant-pagination-next:not(.ant-pagination-disabled)',
          '[class*="pagination"] [class*="next"]:not([class*="disabled"])',
          'button[class*="next"]:not([disabled])',
        ]
        for (const sel of selectors) {
          const el = document.querySelector(sel)
          if (el) { el.click(); return sel }
        }
        return null
      })
      if (!clicked) break
      await new Promise(r => setTimeout(r, 2500))
      noNewStreak = allCaptured.length > countBefore ? 0 : noNewStreak + 1
    }

    console.log(`  Total captured: ${allCaptured.length} traders`)

    if (allCaptured.length === 0) {
      for (const period of periods) results[period] = { total: 0, saved: 0, error: 'No data captured from browser' }
    } else {
      for (const period of periods) {
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
        results[period] = top.length > 0 ? await saveTraders(top) : { total: 0, saved: 0, error: 'No parseable traders' }
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
    followers: t.followers ?? 0, copiers: 0, tags: [], bio: null, aum: null,
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
    metrics: { roi: t.roi ?? 0, pnl: t.pnl ?? 0, win_rate: t.win_rate ?? null, max_drawdown: t.max_drawdown ?? null, followers: t.followers ?? null, arena_score: t.arena_score ?? null },
    quality_flags: { is_suspicious: false, suspicion_reasons: [], data_completeness: 0.7 },
    updated_at: new Date().toISOString(),
  }))
  const { error: v2Err } = await supabase.from('trader_snapshots_v2').upsert(snapshotsV2, { onConflict: 'platform,market_type,trader_key,window' })
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
  console.log(`[${new Date().toISOString()}] KuCoin Mac Mini fetcher (${periods.join(', ')})`)
  const start = Date.now()
  const results = await fetchWithBrowser(periods)
  const duration = ((Date.now() - start) / 1000).toFixed(1)
  const totalSaved = Object.values(results).reduce((s, r) => s + (r.saved || 0), 0)
  for (const [p, r] of Object.entries(results)) console.log(`  ${p}: ${r.saved}/${r.total} saved ${r.error ? `(${r.error})` : ''}`)
  console.log(`\nDone in ${duration}s. Total saved: ${totalSaved}`)
  if (totalSaved > 0) {
    await sendTelegram(`✅ <b>KuCoin (Mac Mini)</b>\n${Object.entries(results).map(([p, r]) => `${p}: ${r.saved} traders`).join('\n')}\n⏱ ${duration}s`)
  } else {
    await sendTelegram(`❌ <b>KuCoin (Mac Mini) failed</b>\n${Object.entries(results).filter(([, r]) => r.error).map(([p, r]) => `${p}: ${r.error}`).join('\n')}`)
  }
}

main().catch(err => { console.error('Fatal:', err); process.exit(1) })
