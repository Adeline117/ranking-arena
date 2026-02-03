#!/usr/bin/env node
/**
 * HTX Futures data import script
 * Based on lib/cron/fetchers/htx.ts
 */

import { createClient } from '@supabase/supabase-js'
import dotenv from 'dotenv'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: path.join(__dirname, '../../.env.local') })

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY')
  process.exit(1)
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)

const SOURCE = 'htx_futures'
const API_URL = 'https://futures.htx.com/-/x/hbg/v1/futures/copytrading/rank'
const TARGET = 500
const PAGE_SIZE = 50

const WINDOW_DAYS = { '7D': 7, '30D': 30, '90D': 90 }

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function calcPeriodRoi(profitList, period) {
  if (!Array.isArray(profitList) || profitList.length < 2) return null
  const days = WINDOW_DAYS[period] || 30
  const last = profitList[profitList.length - 1]
  if (profitList.length >= days) {
    const startIdx = profitList.length - days
    const startVal = startIdx > 0 ? profitList[startIdx - 1] : 0
    return (last - startVal) * 100
  }
  return (last - profitList[0]) * 100
}

function calcMaxDrawdown(profitList, period) {
  if (!Array.isArray(profitList) || profitList.length < 2) return null
  const days = WINDOW_DAYS[period] || 30
  const relevant = profitList.slice(-days)
  if (relevant.length < 2) return null
  const equity = relevant.map(r => 1 + r)
  let peak = equity[0]
  let maxDD = 0
  for (const e of equity) {
    if (e > peak) peak = e
    if (peak > 0) {
      const dd = ((peak - e) / peak) * 100
      if (dd > maxDD) maxDD = dd
    }
  }
  return maxDD > 0 && maxDD < 100 ? maxDD : null
}

// Arena Score V2 calculation (matching lib/cron/fetchers/shared.ts)
const clip = (v, min, max) => Math.max(min, Math.min(max, v))
const safeLog1p = x => x <= -1 ? 0 : Math.log(1 + x)

const ARENA_PARAMS = {
  '7D': { tanhCoeff: 0.08, roiExponent: 1.8, mddThreshold: 15, winRateCap: 62 },
  '30D': { tanhCoeff: 0.15, roiExponent: 1.6, mddThreshold: 30, winRateCap: 68 },
  '90D': { tanhCoeff: 0.18, roiExponent: 1.6, mddThreshold: 40, winRateCap: 70 },
}
const PNL_PARAMS = {
  '7D': { base: 500, coeff: 0.40 },
  '30D': { base: 2000, coeff: 0.35 },
  '90D': { base: 5000, coeff: 0.30 },
}
const MAX_RETURN = 70, MAX_PNL = 15, MAX_DD = 8, MAX_STAB = 7, WR_BASELINE = 45

function calcPnlScore(pnl, period) {
  if (pnl == null || pnl <= 0) return 0
  const p = PNL_PARAMS[period] || PNL_PARAMS['90D']
  const logArg = 1 + pnl / p.base
  if (logArg <= 0) return 0
  return clip(MAX_PNL * Math.tanh(p.coeff * Math.log(logArg)), 0, MAX_PNL)
}

function calculateArenaScore(roi, pnl, maxDrawdown, winRate, period) {
  const params = ARENA_PARAMS[period] || ARENA_PARAMS['90D']
  const days = WINDOW_DAYS[period] || 90
  const wr = winRate != null ? (winRate <= 1 ? winRate * 100 : winRate) : null
  
  const intensity = (365 / days) * safeLog1p(roi / 100)
  const r0 = Math.tanh(params.tanhCoeff * intensity)
  const returnScore = r0 > 0 ? clip(MAX_RETURN * Math.pow(r0, params.roiExponent), 0, MAX_RETURN) : 0
  const pnlScore = calcPnlScore(pnl, period)
  const drawdownScore = maxDrawdown != null 
    ? clip(MAX_DD * clip(1 - Math.abs(maxDrawdown) / params.mddThreshold, 0, 1), 0, MAX_DD) 
    : 4
  const stabilityScore = wr != null 
    ? clip(MAX_STAB * clip((wr - WR_BASELINE) / (params.winRateCap - WR_BASELINE), 0, 1), 0, MAX_STAB) 
    : 3.5

  return Math.round((returnScore + pnlScore + drawdownScore + stabilityScore) * 100) / 100
}

async function fetchJson(url) {
  const resp = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      'Accept': 'application/json',
    }
  })
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
  return resp.json()
}

async function upsertTraders(traders) {
  if (traders.length === 0) return { saved: 0 }
  
  const BATCH = 100
  let saved = 0

  for (let i = 0; i < traders.length; i += BATCH) {
    const batch = traders.slice(i, i + BATCH)

    // Upsert trader_sources
    const sources = batch.map(t => ({
      source: t.source,
      source_trader_id: t.source_trader_id,
      handle: t.handle,
      profile_url: t.profile_url || null,
      is_active: true,
    }))

    const { error: srcErr } = await supabase
      .from('trader_sources')
      .upsert(sources, { onConflict: 'source,source_trader_id' })

    if (srcErr) console.warn(`[upsert] trader_sources error: ${srcErr.message}`)

    // Upsert trader_snapshots
    const snapshots = batch.map(t => ({
      source: t.source,
      source_trader_id: t.source_trader_id,
      season_id: t.season_id,
      rank: t.rank || null,
      roi: t.roi,
      pnl: t.pnl,
      win_rate: t.win_rate,
      max_drawdown: t.max_drawdown,
      followers: t.followers || null,
      trades_count: t.trades_count || null,
      arena_score: t.arena_score,
      captured_at: t.captured_at,
    }))

    const { error: snapErr } = await supabase
      .from('trader_snapshots')
      .upsert(snapshots, { onConflict: 'source,source_trader_id,season_id' })

    if (snapErr) {
      console.warn(`[upsert] trader_snapshots error: ${snapErr.message}`)
      return { saved, error: snapErr.message }
    }

    saved += batch.length
  }

  return { saved }
}

async function fetchPeriod(period) {
  console.log(`\nFetching ${SOURCE} period ${period}...`)
  const allTraders = new Map()
  const maxPages = Math.ceil(TARGET / PAGE_SIZE)

  for (let page = 1; page <= maxPages; page++) {
    try {
      const url = `${API_URL}?rankType=1&pageNo=${page}&pageSize=${PAGE_SIZE}`
      console.log(`  Page ${page}...`)
      const data = await fetchJson(url)

      if (data.code !== 200 || !data.data?.itemList) {
        console.log(`  API returned code ${data.code}, stopping`)
        break
      }
      
      const list = data.data.itemList
      if (list.length === 0) break

      for (const item of list) {
        const id = item.userSign || String(item.uid || '')
        if (!id || allTraders.has(id)) continue
        allTraders.set(id, item)
      }

      console.log(`  Got ${list.length} traders, total unique: ${allTraders.size}`)
      
      if (list.length < PAGE_SIZE || allTraders.size >= TARGET) break
      await sleep(500)
    } catch (err) {
      console.error(`  Error on page ${page}:`, err.message)
      break
    }
  }

  const capturedAt = new Date().toISOString()
  const traders = []

  for (const [id, item] of Array.from(allTraders)) {
    const profitList = item.profitList || []
    let roi = null
    let maxDrawdown = null

    if (period === '90D') {
      roi = item.profitRate90 != null ? Number(item.profitRate90) : null
      maxDrawdown = item.mdd != null ? Number(item.mdd) * 100 : null
    } else {
      roi = calcPeriodRoi(profitList, period)
      maxDrawdown = calcMaxDrawdown(profitList, period)
      if (roi === null) roi = item.profitRate90 != null ? Number(item.profitRate90) : null
      if (maxDrawdown === null && item.mdd != null) maxDrawdown = Number(item.mdd) * 100
    }

    if (roi === null || roi === 0) continue
    const winRate = item.winRate != null ? Number(item.winRate) * 100 : null
    const pnl = Number(item.profit90 || item.copyProfit || 0) || null

    traders.push({
      source: SOURCE,
      source_trader_id: id,
      handle: item.nickName || `HTX_${item.uid}`,
      profile_url: `https://futures.htx.com/en-us/copytrading/futures/detail/${id}`,
      season_id: period,
      roi,
      pnl,
      win_rate: winRate,
      max_drawdown: maxDrawdown,
      followers: item.copyUserNum || null,
      arena_score: calculateArenaScore(roi, pnl, maxDrawdown, winRate, period),
      captured_at: capturedAt,
    })
  }

  traders.sort((a, b) => (b.roi ?? 0) - (a.roi ?? 0))
  const top = traders.slice(0, TARGET)
  
  console.log(`  Processing ${top.length} traders for upsert...`)
  const { saved, error } = await upsertTraders(top)
  
  return { total: top.length, saved, error }
}

async function main() {
  const periods = process.argv.slice(2)
  const periodsToRun = periods.length > 0 ? periods : ['7D', '30D', '90D']
  
  console.log(`HTX Futures Import - Periods: ${periodsToRun.join(', ')}`)
  console.log('='.repeat(50))
  
  const results = {}
  
  for (const period of periodsToRun) {
    results[period] = await fetchPeriod(period)
    if (periodsToRun.indexOf(period) < periodsToRun.length - 1) {
      await sleep(1000)
    }
  }
  
  console.log('\n' + '='.repeat(50))
  console.log('Summary:')
  for (const [period, res] of Object.entries(results)) {
    console.log(`  ${period}: ${res.saved}/${res.total} saved${res.error ? ` (error: ${res.error})` : ''}`)
  }
}

main().catch(console.error)
