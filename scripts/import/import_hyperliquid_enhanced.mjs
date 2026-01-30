/**
 * Hyperliquid 增强版导入脚本
 *
 * 通过以下 API 获取完整数据:
 * 1. 排行榜: https://stats-data.hyperliquid.xyz/Mainnet/leaderboard
 * 2. 胜率: https://api.hyperliquid.xyz/info (userFillsByTime)
 * 3. 最大回撤: https://api.hyperliquid.xyz/info (portfolio)
 *
 * 用法: node scripts/import/import_hyperliquid_enhanced.mjs [7D|30D|90D|ALL]
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

const SOURCE = 'hyperliquid'
const STATS_API = 'https://stats-data.hyperliquid.xyz/Mainnet'
const INFO_API = 'https://api.hyperliquid.xyz/info'
const TARGET_COUNT = 500
const CONCURRENCY = 5
const DELAY_MS = 200

const WINDOW_MAP = {
  '7D': 'week',
  '30D': 'month',
  '90D': 'allTime'
}

const WINDOW_DAYS = {
  '7D': 7,
  '30D': 30,
  '90D': 90
}

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
  return ['30D']
}

/**
 * 获取排行榜数据
 */
async function fetchLeaderboard(period) {
  console.log(`\n📊 获取排行榜数据 (${period})...`)

  const response = await fetch(`${STATS_API}/leaderboard`)
  const data = await response.json()

  if (!data?.leaderboardRows) {
    throw new Error('无法获取排行榜数据')
  }

  const windowKey = WINDOW_MAP[period]

  const traders = data.leaderboardRows
    .map(item => {
      // windowPerformances 是数组格式: [["day", {...}], ["week", {...}], ...]
      const windowData = Array.isArray(item.windowPerformances)
        ? item.windowPerformances.find(([key]) => key === windowKey)?.[1]
        : item.windowPerformances?.[windowKey]

      const pnl = windowData?.pnl ? Number(windowData.pnl) : 0
      const accountValue = Number(item.accountValue) || 0
      let roi = windowData?.roi ? Number(windowData.roi) * 100 : 0

      // ROI 合理性校验：
      // Hyperliquid API 有时返回 PNL 金额作为 roi 字段，导致 roi * 100 = PNL 值
      // 如果 roi 和 pnl 完全相同（或极其接近），说明数据异常
      const ROI_MAX_CAP = 99999 // 最大 ROI 上限 99999%
      const roiRaw = roi

      if (pnl !== 0 && Math.abs(roi - pnl) < 0.01) {
        // roi 字段实际是 PNL 金额，需要重新计算
        if (accountValue > 0) {
          roi = (pnl / accountValue) * 100
          console.log(`  ⚠ ROI异常修正: ${item.ethAddress.slice(0, 10)}... raw_roi=${roiRaw} == pnl=${pnl}, 重算 ROI=${roi.toFixed(2)}% (pnl/accountValue)`)
        } else {
          roi = 0
          console.log(`  ⚠ ROI异常且无accountValue: ${item.ethAddress.slice(0, 10)}... raw_roi=${roiRaw}, 设为0`)
        }
      }

      // ROI 上限 cap
      if (Math.abs(roi) > ROI_MAX_CAP) {
        console.log(`  ⚠ ROI超限: ${item.ethAddress.slice(0, 10)}... roi=${roi.toFixed(2)}%, capped to ${ROI_MAX_CAP}%`)
        roi = roi > 0 ? ROI_MAX_CAP : -ROI_MAX_CAP
      }

      return {
        address: item.ethAddress.toLowerCase(),
        displayName: item.displayName || `${item.ethAddress.slice(0, 6)}...${item.ethAddress.slice(-4)}`,
        roi,
        pnl,
        accountValue
      }
    })
    .filter(t => t.roi > 0) // 只保留正收益的交易员
    .sort((a, b) => b.roi - a.roi)
    .slice(0, TARGET_COUNT)

  console.log(`  ✓ 获取到 ${traders.length} 个交易员`)
  return traders
}

/**
 * 获取交易员的胜率 (通过 userFillsByTime)
 */
async function fetchWinRate(address, period) {
  try {
    const days = WINDOW_DAYS[period]
    const startTime = Date.now() - days * 24 * 60 * 60 * 1000

    const response = await fetch(INFO_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'userFillsByTime',
        user: address,
        startTime,
        aggregateByTime: true
      })
    })

    const fills = await response.json()

    if (!Array.isArray(fills) || fills.length === 0) {
      return null
    }

    // 过滤有 closedPnl 的交易（实际平仓）
    const closedTrades = fills.filter(f => {
      const pnl = parseFloat(f.closedPnl || '0')
      return pnl !== 0
    })

    if (closedTrades.length === 0) {
      return null
    }

    const winningTrades = closedTrades.filter(f => parseFloat(f.closedPnl) > 0)
    return (winningTrades.length / closedTrades.length) * 100
  } catch (e) {
    return null
  }
}

/**
 * 获取交易员的最大回撤 (通过 portfolio)
 */
async function fetchMaxDrawdown(address, period) {
  try {
    const response = await fetch(INFO_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'portfolio',
        user: address
      })
    })

    const portfolio = await response.json()

    if (!Array.isArray(portfolio)) {
      return null
    }

    // 根据周期选择数据: week=7D, month=30D, allTime=90D
    const periodKey = { '7D': 'perpWeek', '30D': 'perpMonth', '90D': 'perpAllTime' }[period] || 'perpMonth'
    const periodData = portfolio.find(([key]) => key === periodKey)?.[1]

    if (!periodData?.accountValueHistory || !periodData?.pnlHistory) {
      return null
    }

    const accountValueHistory = periodData.accountValueHistory
    const pnlHistory = periodData.pnlHistory

    if (accountValueHistory.length === 0 || pnlHistory.length === 0) {
      return null
    }

    // 计算最大回撤
    // Hyperliquid 公式: max((pnl(end) - pnl(start)) / account_value(start)) for all end > start
    let maxDrawdown = 0

    for (let i = 0; i < pnlHistory.length; i++) {
      const startAccountValue = parseFloat(accountValueHistory[i][1])
      const startPnl = parseFloat(pnlHistory[i][1])

      if (startAccountValue <= 0) continue

      for (let j = i + 1; j < pnlHistory.length; j++) {
        const endPnl = parseFloat(pnlHistory[j][1])
        const drawdown = (endPnl - startPnl) / startAccountValue

        if (drawdown < maxDrawdown) {
          maxDrawdown = drawdown
        }
      }
    }

    // 返回正值百分比
    return Math.abs(maxDrawdown) * 100
  } catch (e) {
    return null
  }
}

/**
 * 批量获取详细数据
 */
async function enrichTraders(traders, period) {
  console.log(`\n📈 获取详细数据 (胜率 + 最大回撤)...`)
  console.log(`  交易员数: ${traders.length}, 并发: ${CONCURRENCY}`)

  let processed = 0

  // 分批处理
  for (let i = 0; i < traders.length; i += CONCURRENCY) {
    const batch = traders.slice(i, i + CONCURRENCY)

    await Promise.all(batch.map(async (trader) => {
      const [winRate, maxDrawdown] = await Promise.all([
        fetchWinRate(trader.address, period),
        fetchMaxDrawdown(trader.address, period)
      ])

      trader.winRate = winRate
      trader.maxDrawdown = maxDrawdown
    }))

    processed += batch.length
    if (processed % 20 === 0 || processed === traders.length) {
      const withWr = traders.filter(t => t.winRate !== null).length
      const withMdd = traders.filter(t => t.maxDrawdown !== null).length
      console.log(`  进度: ${processed}/${traders.length} | 胜率: ${withWr} | MDD: ${withMdd}`)
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

  // 排序
  traders.sort((a, b) => (b.roi || 0) - (a.roi || 0))

  // 批量 upsert trader_sources
  const sourcesData = traders.map(t => ({
    source: SOURCE,
    source_type: 'defi',
    source_trader_id: t.address,
    handle: t.displayName,
    profile_url: `https://app.hyperliquid.xyz/@${t.address}`,
    is_active: true
  }))

  await supabase.from('trader_sources').upsert(sourcesData, {
    onConflict: 'source,source_trader_id'
  })

  // 批量 insert trader_snapshots
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

  // Upsert: 按 (source, source_trader_id, season_id) 冲突时更新
  // 需要数据库有 unique constraint: uq_trader_snapshots_source_trader_season
  const { error } = await supabase
    .from('trader_snapshots')
    .upsert(snapshotsData, {
      onConflict: 'source,source_trader_id,season_id',
      ignoreDuplicates: false
    })

  if (error) {
    console.log('  ⚠ 批量 upsert 失败:', error.message)
    let saved = 0
    for (const s of snapshotsData) {
      const { error: e } = await supabase
        .from('trader_snapshots')
        .upsert(s, {
          onConflict: 'source,source_trader_id,season_id',
          ignoreDuplicates: false
        })
      if (!e) saved++
    }
    return saved
  }

  // 统计
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
  console.log('Hyperliquid 增强版数据抓取')
  console.log('='.repeat(60))
  console.log('时间:', new Date().toISOString())
  console.log('目标周期:', periods.join(', '))
  console.log('数据源: Hyperliquid Stats API + Info API')
  console.log('增强功能: 胜率 (userFillsByTime) + 最大回撤 (portfolio)')
  console.log('='.repeat(60))

  const results = []

  for (const period of periods) {
    console.log('\n' + '='.repeat(50))
    console.log(`📊 处理 ${period}...`)
    console.log('='.repeat(50))

    try {
      // 1. 获取排行榜
      const traders = await fetchLeaderboard(period)

      if (traders.length === 0) {
        console.log(`\n⚠ ${period} 未获取到数据`)
        continue
      }

      // 2. 增强数据（获取胜率和最大回撤）
      await enrichTraders(traders, period)

      // 3. 显示 TOP 5
      console.log(`\n📋 ${period} TOP 5:`)
      traders.slice(0, 5).forEach((t, i) => {
        const wr = t.winRate !== null ? `${t.winRate.toFixed(1)}%` : 'N/A'
        const mdd = t.maxDrawdown !== null ? `${t.maxDrawdown.toFixed(1)}%` : 'N/A'
        console.log(`  ${i + 1}. ${t.displayName}: ROI ${t.roi.toFixed(2)}%, WR ${wr}, MDD ${mdd}`)
      })

      // 4. 保存
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
