/**
 * GMX 增强版导入脚本
 *
 * 通过 Subsquid GraphQL API 获取完整数据:
 * 1. 排行榜: accountStats (wins, losses, realizedPnl)
 * 2. 最大回撤: tradeActions 历史计算
 *
 * 用法: node scripts/import/import_gmx_enhanced.mjs [7D|30D|90D|ALL]
 */

import 'dotenv/config'
import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Missing env: SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY')
  process.exit(1)
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

const SOURCE = 'gmx'
const SUBSQUID_URL = 'https://gmx.squids.live/gmx-synthetics-arbitrum:prod/api/graphql'
const TARGET_COUNT = 500
const CONCURRENCY = 3
const DELAY_MS = 500
const VALUE_SCALE = 1e30

const WINDOW_DAYS = { '7D': 7, '30D': 30, '90D': 90 }

// Arena Score 计算
const clip = (v, min, max) => Math.max(min, Math.min(max, v))
const safeLog1p = x => x <= -1 ? 0 : Math.log(1 + x)

const ARENA_CONFIG = {
  MAX_RETURN_SCORE: 70,
  MAX_PNL_SCORE: 15,
  MAX_DRAWDOWN_SCORE: 8,
  MAX_STABILITY_SCORE: 7,
  PARAMS: {
    '7D': { tanhCoeff: 0.08, roiExponent: 1.8, mddThreshold: 15, winRateCap: 62 },
    '30D': { tanhCoeff: 0.15, roiExponent: 1.6, mddThreshold: 30, winRateCap: 68 },
    '90D': { tanhCoeff: 0.18, roiExponent: 1.6, mddThreshold: 40, winRateCap: 70 },
  },
  PNL_PARAMS: {
    '7D': { base: 500, coeff: 0.40 },
    '30D': { base: 2000, coeff: 0.35 },
    '90D': { base: 5000, coeff: 0.30 },
  },
}

function calculateArenaScore(roi, pnl, maxDrawdown, winRate, period) {
  const params = ARENA_CONFIG.PARAMS[period] || ARENA_CONFIG.PARAMS['90D']

  const days = WINDOW_DAYS[period] || 90
  const wr = winRate !== null ? (winRate <= 1 ? winRate * 100 : winRate) : null
  const intensity = (365 / days) * safeLog1p((roi || 0) / 100)
  const r0 = Math.tanh(params.tanhCoeff * intensity)
  const returnScore = r0 > 0 ? clip(ARENA_CONFIG.MAX_RETURN_SCORE * Math.pow(r0, params.roiExponent), 0, ARENA_CONFIG.MAX_RETURN_SCORE) : 0

  // PnL score (0-15)
  const pnlParams = ARENA_CONFIG.PNL_PARAMS[period] || ARENA_CONFIG.PNL_PARAMS['90D']
  let pnlScore = 0
  if (pnl !== null && pnl !== undefined && pnl > 0) {
    const logArg = 1 + pnl / pnlParams.base
    if (logArg > 0) {
      pnlScore = clip(ARENA_CONFIG.MAX_PNL_SCORE * Math.tanh(pnlParams.coeff * Math.log(logArg)), 0, ARENA_CONFIG.MAX_PNL_SCORE)
    }
  }

  const drawdownScore = maxDrawdown !== null ? clip(8 * clip(1 - Math.abs(maxDrawdown) / params.mddThreshold, 0, 1), 0, 8) : 4
  const stabilityScore = wr !== null ? clip(7 * clip((wr - 45) / (params.winRateCap - 45), 0, 1), 0, 7) : 3.5
  return Math.round((returnScore + pnlScore + drawdownScore + stabilityScore) * 100) / 100
}

const sleep = ms => new Promise(r => setTimeout(r, ms))

function getTargetPeriods() {
  const arg = process.argv[2]?.toUpperCase()
  if (arg === 'ALL') return ['7D', '30D', '90D']
  if (arg && ['7D', '30D', '90D'].includes(arg)) return [arg]
  return ['7D', '30D', '90D']
}

/**
 * 获取排行榜数据
 * 对于 90D，通过 positionChanges 时间过滤来获取时间窗口内的数据
 */
async function fetchLeaderboard(period) {
  console.log(`\n📊 获取排行榜数据 (${period})...`)

  // accountStats 是累计数据，不区分时间窗口
  // 但我们仍然获取它用于基础排名
  const query = `{
    accountStats(
      limit: ${TARGET_COUNT * 2},
      orderBy: realizedPnl_DESC
    ) {
      id
      wins
      losses
      realizedPnl
      volume
      netCapital
      maxCapital
      closedCount
    }
  }`

  const response = await fetch(SUBSQUID_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query })
  })

  const result = await response.json()

  if (!result?.data?.accountStats) {
    throw new Error('无法获取排行榜数据')
  }

  const traders = result.data.accountStats
    .map(item => {
      const pnl = Number(BigInt(item.realizedPnl || '0')) / VALUE_SCALE
      const maxCapital = Number(BigInt(item.maxCapital || '0')) / VALUE_SCALE
      const netCapital = Number(BigInt(item.netCapital || '0')) / VALUE_SCALE
      const volume = Number(BigInt(item.volume || '0')) / VALUE_SCALE

      // ROI 基于最大资本
      const roi = maxCapital > 100 ? (pnl / maxCapital) * 100 : 0

      // 胜率从 wins/losses 计算
      const totalTrades = (item.wins || 0) + (item.losses || 0)
      const winRate = totalTrades > 0 ? (item.wins / totalTrades) * 100 : null

      return {
        address: item.id.toLowerCase(),
        originalAddress: item.id, // Keep original case for API queries
        displayName: `${item.id.slice(0, 6)}...${item.id.slice(-4)}`,
        roi,
        pnl,
        winRate,
        maxDrawdown: null, // 需要单独计算
        tradesCount: item.closedCount || totalTrades,
        aum: netCapital > 0 ? netCapital : maxCapital,
        volume
      }
    })
    .filter(t => t.roi >= -100 && t.roi <= 10000 && t.pnl >= -10000000 && t.pnl <= 100000000)
    .sort((a, b) => b.roi - a.roi)
    .slice(0, TARGET_COUNT)

  console.log(`  ✓ 获取到 ${traders.length} 个交易员`)
  return traders
}

/**
 * 获取交易员的最大回撤 (通过 positionChanges 历史)
 * @param {string} originalAddress - Must use original case from API
 * @param {string} period - '7D', '30D', '90D'
 */
async function fetchMaxDrawdown(originalAddress, period) {
  try {
    // 计算时间窗口
    const days = WINDOW_DAYS[period] || 90
    const windowStart = Math.floor((Date.now() - days * 24 * 60 * 60 * 1000) / 1000)

    // GMX GraphQL API is case-sensitive, must use exact case
    // Filter by timestamp for period-specific data
    const query = `{
      positionChanges(
        where: { 
          account_eq: "${originalAddress}"
          timestamp_gte: ${windowStart}
        }
        orderBy: timestamp_ASC
        limit: 500
      ) {
        timestamp
        basePnlUsd
        sizeDeltaUsd
      }
    }`

    const response = await fetch(SUBSQUID_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query })
    })

    const result = await response.json()
    let changes = result?.data?.positionChanges

    if (!changes || changes.length < 2) {
      // Fallback: try without time filter for broader data
      if (period !== '90D') return null

      const fallbackQuery = `{
        positionChanges(
          where: { account_eq: "${originalAddress}" }
          orderBy: timestamp_ASC
          limit: 500
        ) {
          timestamp
          basePnlUsd
          sizeDeltaUsd
        }
      }`
      const fbResponse = await fetch(SUBSQUID_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: fallbackQuery })
      })
      const fbResult = await fbResponse.json()
      changes = fbResult?.data?.positionChanges
      if (!changes || changes.length < 2) return null
    }

    // 只处理有 basePnlUsd 的 position changes (平仓操作)
    const closingChanges = changes.filter(c => {
      const pnl = c.basePnlUsd ? Number(BigInt(c.basePnlUsd)) / VALUE_SCALE : 0
      return pnl !== 0
    })

    if (closingChanges.length < 2) {
      return null
    }

    // 计算累计权益曲线和最大回撤
    let cumulativePnl = 0
    let peakEquity = 0
    let maxDrawdown = 0

    for (const change of closingChanges) {
      const pnl = Number(BigInt(change.basePnlUsd || '0')) / VALUE_SCALE
      cumulativePnl += pnl

      if (cumulativePnl > peakEquity) {
        peakEquity = cumulativePnl
      }

      if (peakEquity > 0) {
        const currentDrawdown = ((peakEquity - cumulativePnl) / peakEquity) * 100
        if (currentDrawdown > maxDrawdown) {
          maxDrawdown = currentDrawdown
        }
      }
    }

    return maxDrawdown > 0 && maxDrawdown < 200 ? maxDrawdown : null
  } catch (e) {
    return null
  }
}

/**
 * 批量获取最大回撤数据
 */
async function enrichTraders(traders, period) {
  console.log(`\n📈 获取最大回撤数据 (${period})...`)
  console.log(`  交易员数: ${traders.length}, 并发: ${CONCURRENCY}`)

  let processed = 0

  for (let i = 0; i < traders.length; i += CONCURRENCY) {
    const batch = traders.slice(i, i + CONCURRENCY)

    await Promise.all(batch.map(async (trader) => {
      // Use originalAddress for case-sensitive API query
      trader.maxDrawdown = await fetchMaxDrawdown(trader.originalAddress, period)
    }))

    processed += batch.length
    if (processed % 15 === 0 || processed === traders.length) {
      const withMdd = traders.filter(t => t.maxDrawdown !== null).length
      console.log(`  进度: ${processed}/${traders.length} | MDD: ${withMdd}`)
    }

    await sleep(DELAY_MS)
  }

  return traders
}

/**
 * 保存数据到数据库
 */
async function saveTraders(traders, period) {
  console.log(`\n💾 保存 ${traders.length} 个交易员...`)

  const capturedAt = new Date().toISOString()
  traders.sort((a, b) => (b.roi || 0) - (a.roi || 0))

  const sourcesData = traders.map(t => ({
    source: SOURCE,
    source_type: 'defi',
    source_trader_id: t.address,
    handle: t.displayName,
    profile_url: `https://app.gmx.io/#/actions/${t.address}`,
    is_active: true
  }))

  await supabase.from('trader_sources').upsert(sourcesData, {
    onConflict: 'source,source_trader_id'
  })

  const snapshotsData = traders.map((t, idx) => ({
    source: SOURCE,
    source_trader_id: t.address,
    season_id: period,
    rank: idx + 1,
    roi: t.roi,
    pnl: t.pnl,
    win_rate: t.winRate,
    max_drawdown: t.maxDrawdown,
    followers: 0,
    arena_score: calculateArenaScore(t.roi, t.pnl, t.maxDrawdown, t.winRate, period),
    captured_at: capturedAt
  }))

  const { error } = await supabase.from('trader_snapshots').upsert(snapshotsData, {
    onConflict: 'source,source_trader_id,season_id'
  })

  if (error) {
    console.log('  ⚠ 批量保存失败:', error.message)
    let saved = 0
    for (const s of snapshotsData) {
      const { error: e } = await supabase.from('trader_snapshots').upsert(s, {
        onConflict: 'source,source_trader_id,season_id'
      })
      if (!e) saved++
    }
    return saved
  }

  const withWr = traders.filter(t => t.winRate !== null).length
  const withMdd = traders.filter(t => t.maxDrawdown !== null).length
  console.log(`  ✓ 保存成功: ${traders.length} 条`)
  console.log(`    胜率覆盖: ${withWr}/${traders.length} (${((withWr/traders.length)*100).toFixed(0)}%)`)
  console.log(`    MDD覆盖: ${withMdd}/${traders.length} (${((withMdd/traders.length)*100).toFixed(0)}%)`)

  return traders.length
}

async function main() {
  const periods = getTargetPeriods()
  const startTime = Date.now()

  console.log('\n' + '='.repeat(60))
  console.log('GMX 增强版数据抓取')
  console.log('='.repeat(60))
  console.log('时间:', new Date().toISOString())
  console.log('目标周期:', periods.join(', '))
  console.log('数据源: GMX Subsquid GraphQL API')
  console.log('增强功能: 胜率 (wins/losses) + 最大回撤 (tradeActions 历史)')
  console.log('='.repeat(60))

  const results = []

  for (const period of periods) {
    console.log('\n' + '='.repeat(50))
    console.log(`📊 处理 ${period}...`)
    console.log('='.repeat(50))

    try {
      const traders = await fetchLeaderboard(period)

      if (traders.length === 0) {
        console.log(`\n⚠ ${period} 未获取到数据`)
        continue
      }

      await enrichTraders(traders, period)

      console.log(`\n📋 ${period} TOP 5:`)
      traders.slice(0, 5).forEach((t, i) => {
        const wr = t.winRate !== null ? `${t.winRate.toFixed(1)}%` : 'N/A'
        const mdd = t.maxDrawdown !== null ? `${t.maxDrawdown.toFixed(1)}%` : 'N/A'
        console.log(`  ${i + 1}. ${t.displayName}: ROI ${t.roi.toFixed(2)}%, WR ${wr}, MDD ${mdd}`)
      })

      const saved = await saveTraders(traders, period)
      results.push({
        period,
        count: traders.length,
        saved,
        topRoi: traders[0]?.roi || 0,
        winRateCoverage: traders.filter(t => t.winRate !== null).length,
        mddCoverage: traders.filter(t => t.maxDrawdown !== null).length
      })

      console.log(`\n✅ ${period} 完成！`)

      if (periods.indexOf(period) < periods.length - 1) {
        await sleep(2000)
      }
    } catch (e) {
      console.error(`\n❌ ${period} 失败:`, e.message)
    }
  }

  const totalTime = ((Date.now() - startTime) / 1000).toFixed(1)

  console.log('\n' + '='.repeat(60))
  console.log('✅ 全部完成！')
  console.log('='.repeat(60))
  console.log('📊 抓取结果:')
  for (const r of results) {
    console.log(`   ${r.period}: ${r.saved} 条, TOP ROI ${r.topRoi?.toFixed?.(2) || r.topRoi}%`)
    console.log(`      胜率: ${r.winRateCoverage}/${r.saved}, MDD: ${r.mddCoverage}/${r.saved}`)
  }
  console.log(`   总耗时: ${totalTime}s`)
  console.log('='.repeat(60))
}

main().catch(console.error)
