#!/usr/bin/env node
/**
 * Hyperliquid Data Enrichment - 分批处理版本
 * 
 * 每批处理固定数量的 trader，避免长时间运行被 SIGKILL
 * 支持断点续传 - 记录进度到文件
 * 
 * 用法: 
 *   node scripts/import/enrich_hyperliquid_batched.mjs [30D] [--batch=50] [--resume]
 */

import { getSupabaseClient, calculateArenaScore, sleep } from '../lib/shared.mjs'
import { readFileSync, writeFileSync, existsSync, appendFileSync, mkdirSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '../..')
const LOGS_DIR = join(ROOT, 'logs')
const PROGRESS_FILE = join(LOGS_DIR, 'hyperliquid-enrich-progress.json')

if (!existsSync(LOGS_DIR)) mkdirSync(LOGS_DIR, { recursive: true })

const supabase = getSupabaseClient()
const SOURCE = 'hyperliquid'
const INFO_API = 'https://api.hyperliquid.xyz/info'

const WINDOW_DAYS = { '7D': 7, '30D': 30, '90D': 90 }
const PORTFOLIO_KEY = { '7D': 'perpWeek', '30D': 'perpMonth', '90D': 'perpAllTime' }

// 日志
const TODAY = new Date().toISOString().split('T')[0]
const LOG_FILE = join(LOGS_DIR, `enrich-hyperliquid-${TODAY}.log`)

function log(msg) {
  const ts = new Date().toISOString()
  const line = `[${ts}] ${msg}`
  console.log(line)
  try { appendFileSync(LOG_FILE, line + '\n') } catch {}
}

// 进度管理
function loadProgress(period) {
  try {
    if (existsSync(PROGRESS_FILE)) {
      const data = JSON.parse(readFileSync(PROGRESS_FILE, 'utf8'))
      if (data.period === period && data.completed) {
        return data.completed
      }
    }
  } catch {}
  return []
}

function saveProgress(period, completed) {
  try {
    writeFileSync(PROGRESS_FILE, JSON.stringify({
      period,
      completed,
      updatedAt: new Date().toISOString()
    }, null, 2))
  } catch {}
}

// API 调用
async function apiFetch(body) {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const res = await fetch(INFO_API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30000)
      })
      if (res.status === 200) {
        return res.json()
      }
      if (res.status === 429) {
        const wait = 3000 * (attempt + 1)
        log(`  Rate limited, waiting ${wait}ms`)
        await sleep(wait)
        continue
      }
      throw new Error(`API ${res.status}`)
    } catch (e) {
      if (attempt < 4) {
        await sleep(2000 * (attempt + 1))
        continue
      }
      throw e
    }
  }
  return null
}

async function fetchWinRate(address, period) {
  try {
    const fills = await apiFetch({ type: 'userFills', user: address })
    if (!Array.isArray(fills) || fills.length === 0) return null

    const days = WINDOW_DAYS[period]
    const cutoff = Date.now() - days * 24 * 3600 * 1000

    let closed = fills.filter(f => f.time >= cutoff && parseFloat(f.closedPnl || '0') !== 0)
    if (closed.length < 3) {
      closed = fills.filter(f => parseFloat(f.closedPnl || '0') !== 0)
    }
    if (closed.length < 3) return null

    const wins = closed.filter(f => parseFloat(f.closedPnl) > 0).length
    return (wins / closed.length) * 100
  } catch { return null }
}

async function fetchMaxDrawdown(address, period) {
  try {
    const portfolio = await apiFetch({ type: 'portfolio', user: address })
    if (!Array.isArray(portfolio)) return null

    const key = PORTFOLIO_KEY[period]
    const periodData = portfolio.find(([k]) => k === key)?.[1]
    if (!periodData?.accountValueHistory || !periodData?.pnlHistory) return null

    const avh = periodData.accountValueHistory
    const ph = periodData.pnlHistory
    if (avh.length === 0 || ph.length === 0) return null

    let maxDD = 0
    for (let i = 0; i < ph.length; i++) {
      const startAV = parseFloat(avh[i]?.[1] || '0')
      const startPnl = parseFloat(ph[i][1])
      if (startAV <= 0) continue
      for (let j = i + 1; j < ph.length; j++) {
        const endPnl = parseFloat(ph[j][1])
        const dd = (endPnl - startPnl) / startAV
        if (dd < maxDD) maxDD = dd
      }
    }
    return Math.abs(maxDD) > 0.001 ? Math.abs(maxDD) * 100 : null
  } catch { return null }
}

async function main() {
  const args = process.argv.slice(2)
  const period = (args.find(a => !a.startsWith('--')) || '30D').toUpperCase()
  const batchSize = parseInt(args.find(a => a.startsWith('--batch='))?.split('=')[1] || '50')
  const resume = args.includes('--resume')

  if (!['7D', '30D', '90D'].includes(period)) {
    console.error('Invalid period')
    process.exit(1)
  }

  log('='.repeat(60))
  log(`Hyperliquid Enrichment (Batched) — ${period}`)
  log(`Batch size: ${batchSize} | Resume: ${resume}`)
  log('='.repeat(60))

  // 加载进度
  let completed = resume ? loadProgress(period) : []
  if (completed.length > 0) {
    log(`Resuming from checkpoint: ${completed.length} already done`)
  }

  // 获取需要处理的 traders
  const { data: missingWr } = await supabase
    .from('trader_snapshots')
    .select('id, source_trader_id, roi, pnl, win_rate, max_drawdown')
    .eq('source', SOURCE).eq('season_id', period).is('win_rate', null)

  const { data: missingDd } = await supabase
    .from('trader_snapshots')
    .select('id, source_trader_id, roi, pnl, win_rate, max_drawdown')
    .eq('source', SOURCE).eq('season_id', period).is('max_drawdown', null)

  const traderMap = new Map()
  for (const row of [...(missingWr || []), ...(missingDd || [])]) {
    if (!traderMap.has(row.source_trader_id)) traderMap.set(row.source_trader_id, row)
  }

  // 过滤已完成的
  const completedSet = new Set(completed)
  const traders = Array.from(traderMap.values()).filter(t => !completedSet.has(t.source_trader_id))

  log(`Total missing: ${traderMap.size}`)
  log(`Already done: ${completed.length}`)
  log(`Remaining: ${traders.length}`)

  if (traders.length === 0) {
    log('Nothing to do!')
    return
  }

  // 只处理一批
  const batch = traders.slice(0, batchSize)
  log(`Processing batch of ${batch.length} traders...`)
  log(`Estimated time: ~${Math.ceil(batch.length * 5 / 60)} min`)

  let enriched = 0, wrFilled = 0, ddFilled = 0, errors = 0
  const startTime = Date.now()

  for (let i = 0; i < batch.length; i++) {
    const trader = batch[i]
    try {
      const needWr = trader.win_rate === null
      const needDd = trader.max_drawdown === null

      let wr = null, dd = null

      if (needWr) {
        wr = await fetchWinRate(trader.source_trader_id, period)
        await sleep(2500)
      }

      if (needDd) {
        dd = await fetchMaxDrawdown(trader.source_trader_id, period)
        await sleep(2500)
      }

      const newWr = needWr && wr !== null ? wr : trader.win_rate
      const newDd = needDd && dd !== null ? dd : trader.max_drawdown

      if ((needWr && wr !== null) || (needDd && dd !== null)) {
        const { totalScore } = calculateArenaScore(trader.roi || 0, trader.pnl, newDd, newWr, period)
        const update = { arena_score: totalScore }
        if (needWr && wr !== null) { update.win_rate = wr; wrFilled++ }
        if (needDd && dd !== null) { update.max_drawdown = dd; ddFilled++ }
        await supabase.from('trader_snapshots').update(update).eq('id', trader.id)
        enriched++
      }

      // 记录完成
      completed.push(trader.source_trader_id)
      
      // 每10条保存一次进度
      if ((i + 1) % 10 === 0) {
        saveProgress(period, completed)
      }

    } catch (e) {
      errors++
      log(`  Error on ${trader.source_trader_id}: ${e.message}`)
    }

    if ((i + 1) % 10 === 0 || i === batch.length - 1) {
      const elapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(1)
      const eta = batch.length > 0 ? ((Date.now() - startTime) / (i + 1) * (batch.length - i - 1) / 60000).toFixed(1) : '0'
      log(`  [${i + 1}/${batch.length}] wr+=${wrFilled} dd+=${ddFilled} err=${errors} | ${elapsed}m, ~${eta}m left`)
    }
  }

  // 最终保存进度
  saveProgress(period, completed)

  const remaining = traders.length - batch.length
  log('\n' + '='.repeat(60))
  log(`✅ Batch complete`)
  log(`   Enriched: ${enriched}/${batch.length}`)
  log(`   Win rate filled: ${wrFilled}`)
  log(`   Max drawdown filled: ${ddFilled}`)
  log(`   Errors: ${errors}`)
  log(`   Total completed: ${completed.length}`)
  log(`   Remaining: ${remaining}`)
  if (remaining > 0) {
    log(`\n💡 Run again with --resume to continue`)
  }
  log('='.repeat(60))
}

main().catch(e => {
  log(`Fatal: ${e.message}`)
  process.exit(1)
})
