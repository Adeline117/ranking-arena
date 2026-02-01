/**
 * 直接 API 数据导入（无 Puppeteer）
 *
 * 支持的平台:
 * - OKX Futures (v5 API)
 * - Hyperliquid (stats API)
 * - GMX (GraphQL API)
 *
 * 用法: node scripts/import/import_all_api.mjs [platform] [period]
 */

import 'dotenv/config'
import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Error: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set')
  process.exit(1)
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

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

  const days = period === '7D' ? 7 : period === '30D' ? 30 : 90
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

// ============================================
// OKX Futures API
// ============================================
async function fetchOKX(period) {
  console.log('\n📡 获取 OKX Futures 数据...')

  try {
    const response = await fetch('https://www.okx.com/api/v5/copytrading/public-lead-traders?instType=SWAP')
    const data = await response.json()

    if (data.code !== '0' || !data.data?.[0]?.ranks) {
      console.log('  ⚠ API 返回错误:', data.msg || data.code)
      return []
    }

    const ranks = data.data[0].ranks
    console.log(`  ✓ 获取到 ${ranks.length} 个交易员`)

    return ranks.map(r => ({
      traderId: r.uniqueCode || r.nickName || '',
      nickname: r.nickName || '',
      roi: parseFloat(r.pnlRatio || 0) * 100,
      pnl: parseFloat(r.pnl || 0),
      winRate: null,
      maxDrawdown: null,
      followers: parseInt(r.copyTraderNum || 0),
      aum: parseFloat(r.aum || 0),
    }))
  } catch (e) {
    console.log('  ✗ 错误:', e.message)
    return []
  }
}

// ============================================
// Hyperliquid API
// ============================================
async function fetchHyperliquid(period) {
  console.log('\n📡 获取 Hyperliquid 数据...')

  const windowMap = { '7D': 'week', '30D': 'month', '90D': 'allTime' }
  const windowKey = windowMap[period] || 'month'

  try {
    const response = await fetch('https://stats-data.hyperliquid.xyz/Mainnet/leaderboard')
    const data = await response.json()

    if (!data.leaderboardRows) {
      console.log('  ⚠ 无数据')
      return []
    }

    console.log(`  ✓ 获取到 ${data.leaderboardRows.length} 个交易员`)

    return data.leaderboardRows.map(row => {
      // 找到对应时间窗口的数据
      const perf = row.windowPerformances?.find(p => p[0] === windowKey)?.[1] || {}

      return {
        traderId: row.ethAddress?.toLowerCase() || '',
        nickname: row.ethAddress ? row.ethAddress.slice(0, 6) + '...' + row.ethAddress.slice(-4) : '',
        roi: parseFloat(perf.roi || 0) * 100,
        pnl: parseFloat(perf.pnl || 0),
        winRate: null,
        maxDrawdown: null,
        followers: 0,
        volume: parseFloat(perf.vlm || 0),
        accountValue: parseFloat(row.accountValue || 0),
      }
    })
  } catch (e) {
    console.log('  ✗ 错误:', e.message)
    return []
  }
}

// ============================================
// GMX GraphQL API
// ============================================
async function fetchGMX(period) {
  console.log('\n📡 获取 GMX 数据...')

  const query = `{
    accountStats(limit: 200, orderBy: realizedPnl_DESC) {
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

  try {
    const response = await fetch('https://gmx.squids.live/gmx-synthetics-arbitrum:prod/api/graphql', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query }),
    })

    const data = await response.json()

    if (!data.data?.accountStats) {
      console.log('  ⚠ 无数据')
      return []
    }

    const VALUE_SCALE = 1e30
    const traders = data.data.accountStats
    console.log(`  ✓ 获取到 ${traders.length} 个交易员`)

    return traders.map(item => {
      const pnl = Number(BigInt(item.realizedPnl || '0')) / VALUE_SCALE
      const maxCapital = Number(BigInt(item.maxCapital || '0')) / VALUE_SCALE
      const roi = maxCapital > 100 ? (pnl / maxCapital) * 100 : 0
      const totalTrades = (item.wins || 0) + (item.losses || 0)
      const winRate = totalTrades > 0 ? (item.wins / totalTrades) * 100 : null

      return {
        traderId: item.id?.toLowerCase() || '',
        nickname: item.id ? item.id.slice(0, 6) + '...' + item.id.slice(-4) : '',
        roi,
        pnl,
        winRate,
        maxDrawdown: null,
        followers: 0,
        volume: Number(BigInt(item.volume || '0')) / VALUE_SCALE,
      }
    }).filter(t => t.roi > -100 && t.roi < 10000 && Math.abs(t.pnl) < 100000000)
  } catch (e) {
    console.log('  ✗ 错误:', e.message)
    return []
  }
}

// ============================================
// 保存数据
// ============================================
async function saveTraders(traders, source, period) {
  if (traders.length === 0) return 0

  console.log(`\n💾 保存 ${traders.length} 条 ${source} ${period} 数据...`)

  // 排序并取 TOP 100
  traders.sort((a, b) => (b.roi || 0) - (a.roi || 0))
  const top100 = traders.slice(0, 100)
  const capturedAt = new Date().toISOString()

  // Upsert trader_sources
  const sourcesData = top100.map(t => ({
    source,
    source_type: 'leaderboard',
    source_trader_id: t.traderId,
    handle: t.nickname,
    is_active: true,
  }))

  await supabase.from('trader_sources').upsert(sourcesData, { onConflict: 'source,source_trader_id' })

  // Insert trader_snapshots
  const snapshotsData = top100.map((t, idx) => ({
    source,
    source_trader_id: t.traderId,
    season_id: period,
    rank: idx + 1,
    roi: t.roi || 0,
    pnl: t.pnl || 0,
    win_rate: t.winRate,
    max_drawdown: t.maxDrawdown,
    followers: t.followers || 0,
    arena_score: calculateArenaScore(t.roi, t.pnl, t.maxDrawdown, t.winRate, period),
    captured_at: capturedAt,
  }))

  const { error } = await supabase.from('trader_snapshots').upsert(snapshotsData, { onConflict: 'source,source_trader_id,season_id' })

  if (error) {
    if (error.code === '23505') {
      // 重复键，尝试更新
      let saved = 0
      for (const s of snapshotsData) {
        const { error: updateErr } = await supabase
          .from('trader_snapshots')
          .update({ roi: s.roi, pnl: s.pnl, arena_score: s.arena_score, captured_at: capturedAt })
          .eq('source', source)
          .eq('source_trader_id', s.source_trader_id)
          .eq('season_id', period)
        if (!updateErr) saved++
      }
      console.log(`  ✓ 更新成功: ${saved} 条`)
      return saved
    }
    console.log(`  ⚠ 错误: ${error.message}`)
    return 0
  }

  console.log(`  ✓ 保存成功: ${snapshotsData.length} 条`)
  return snapshotsData.length
}

// ============================================
// 主函数
// ============================================
async function main() {
  const platformArg = process.argv[2]?.toLowerCase() || 'all'
  const periodArg = process.argv[3]?.toUpperCase() || 'ALL'

  const periods = periodArg === 'ALL' ? ['7D', '30D', '90D'] : [periodArg]

  console.log('\n' + '='.repeat(60))
  console.log('直接 API 数据导入')
  console.log('='.repeat(60))
  console.log('时间:', new Date().toISOString())
  console.log('平台:', platformArg)
  console.log('周期:', periods.join(', '))
  console.log('='.repeat(60))

  const results = []
  const startTime = Date.now()

  // 定义平台
  const platforms = {
    okx: { fetch: fetchOKX, source: 'okx_futures', name: 'OKX Futures' },
    hyperliquid: { fetch: fetchHyperliquid, source: 'hyperliquid', name: 'Hyperliquid' },
    gmx: { fetch: fetchGMX, source: 'gmx', name: 'GMX' },
  }

  const targetPlatforms = platformArg === 'all' ? Object.keys(platforms) : [platformArg]

  for (const p of targetPlatforms) {
    const config = platforms[p]
    if (!config) {
      console.log(`\n⚠ 未知平台: ${p}`)
      continue
    }

    for (const period of periods) {
      console.log(`\n${'='.repeat(50)}`)
      console.log(`📊 ${config.name} - ${period}`)
      console.log('='.repeat(50))

      const traders = await config.fetch(period)

      if (traders.length > 0) {
        // 显示 TOP 5
        traders.sort((a, b) => (b.roi || 0) - (a.roi || 0))
        console.log(`\n📋 TOP 5:`)
        traders.slice(0, 5).forEach((t, i) => {
          console.log(`  ${i + 1}. ${t.nickname}: ROI ${t.roi?.toFixed(2)}%`)
        })

        const saved = await saveTraders(traders, config.source, period)
        results.push({ platform: p, period, count: traders.length, saved })
      } else {
        results.push({ platform: p, period, count: 0, saved: 0 })
      }
    }
  }

  const totalTime = ((Date.now() - startTime) / 1000).toFixed(1)

  console.log('\n' + '='.repeat(60))
  console.log('✅ 全部完成！')
  console.log('='.repeat(60))
  console.log('📊 结果:')
  for (const r of results) {
    console.log(`   ${r.platform} ${r.period}: ${r.saved} 条`)
  }
  console.log(`   总耗时: ${totalTime}s`)
  console.log('='.repeat(60))
}

main().catch(console.error)
