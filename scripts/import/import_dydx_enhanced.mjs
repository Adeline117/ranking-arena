/**
 * dYdX v4 增强版导入脚本
 *
 * 通过 dYdX Indexer API 获取完整数据:
 * 1. 排行榜: 活跃账户 + PnL 数据
 * 2. 胜率: /v4/perpetualPositions?status=CLOSED
 * 3. 最大回撤: /v4/historical-pnl
 *
 * 用法: node scripts/import/import_dydx_enhanced.mjs [7D|30D|90D|ALL]
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

const SOURCE = 'dydx'
const CHAIN_API = 'https://dydx-rest.publicnode.com'
const INDEXER_API = 'https://indexer.dydx.trade/v4'
const TARGET_COUNT = 500
const CONCURRENCY = 5
const DELAY_MS = 150

const WINDOW_DAYS = { '7D': 7, '30D': 30, '90D': 90 }

// Arena Score 计算
const clip = (v, min, max) => Math.max(min, Math.min(max, v))
const safeLog1p = x => x <= -1 ? 0 : Math.log(1 + x)

function calculateArenaScore(roi, pnl, maxDrawdown, winRate, period) {
  const params = {
    '7D': { tanhCoeff: 0.08, roiExponent: 1.8, mddThreshold: 15, winRateCap: 62 },
    '30D': { tanhCoeff: 0.15, roiExponent: 1.6, mddThreshold: 30, winRateCap: 68 },
    '90D': { tanhCoeff: 0.18, roiExponent: 1.6, mddThreshold: 40, winRateCap: 70 },
  }[period] || { tanhCoeff: 0.18, roiExponent: 1.6, mddThreshold: 40, winRateCap: 70 }

  const days = WINDOW_DAYS[period] || 90
  const wr = winRate !== null ? (winRate <= 1 ? winRate * 100 : winRate) : null
  const intensity = (365 / days) * safeLog1p((roi || 0) / 100)
  const r0 = Math.tanh(params.tanhCoeff * intensity)
  const returnScore = r0 > 0 ? clip(85 * Math.pow(r0, params.roiExponent), 0, 85) : 0
  const drawdownScore = maxDrawdown !== null ? clip(8 * clip(1 - Math.abs(maxDrawdown) / params.mddThreshold, 0, 1), 0, 8) : 4
  const stabilityScore = wr !== null ? clip(7 * clip((wr - 45) / (params.winRateCap - 45), 0, 1), 0, 7) : 3.5
  return Math.round((returnScore + drawdownScore + stabilityScore) * 100) / 100
}

const sleep = ms => new Promise(r => setTimeout(r, ms))

function getTargetPeriods() {
  const arg = process.argv[2]?.toUpperCase()
  if (arg === 'ALL') return ['30D', '90D']
  if (arg && ['7D', '30D', '90D'].includes(arg)) return [arg]
  return ['30D']
}

/**
 * 获取所有子账户 (不限制必须有 open positions)
 */
async function fetchActiveSubaccounts(limit = 500) {
  console.log('\n📊 获取子账户...')

  const allAccounts = new Map()
  let nextKey = null
  let page = 0
  const maxPages = 50  // 最多扫描50页

  while (allAccounts.size < limit && page < maxPages) {
    page++
    let url = `${CHAIN_API}/dydxprotocol/subaccounts/subaccount?pagination.limit=100`
    if (nextKey) {
      url += `&pagination.key=${encodeURIComponent(nextKey)}`
    }

    try {
      const response = await fetch(url)
      const data = await response.json()

      if (!data.subaccount || data.subaccount.length === 0) break

      for (const sub of data.subaccount) {
        const owner = sub.id.owner
        // 只添加 subaccountNumber=0 的主账户
        if (sub.id.number === 0 && !allAccounts.has(owner)) {
          // 检查账户是否有任何资金或历史活动
          const hasEquity = sub.asset_positions?.some(p => parseFloat(p.quantums || '0') > 0)
          const hasPositions = sub.perpetual_positions && sub.perpetual_positions.length > 0

          if (hasEquity || hasPositions) {
            allAccounts.set(owner, { address: owner, hasPositions })
          }
        }
      }

      if (page % 10 === 0) {
        console.log(`  页 ${page}: 累计 ${allAccounts.size} 个账户`)
      }

      nextKey = data.pagination?.next_key
      if (!nextKey) break

      await sleep(30)
    } catch (e) {
      console.error(`  ✗ 获取失败:`, e.message)
      break
    }
  }

  console.log(`  ✓ 总计: ${allAccounts.size} 个账户`)
  return Array.from(allAccounts.values()).slice(0, limit)
}

/**
 * 获取账户 PnL 和基本数据 (通过 historical-pnl)
 */
async function fetchAddressData(address) {
  try {
    // 先获取基础账户信息
    const addressUrl = `${INDEXER_API}/addresses/${address}`
    const addressResponse = await fetch(addressUrl)
    if (!addressResponse.ok) return null

    const addressData = await addressResponse.json()
    if (!addressData.subaccounts || addressData.subaccounts.length === 0) return null

    const mainAccount = addressData.subaccounts.find(s => s.subaccountNumber === 0)
    if (!mainAccount) return null

    const equity = parseFloat(mainAccount.equity) || 0

    // 获取历史 PnL 来计算 ROI
    const pnlUrl = `${INDEXER_API}/historical-pnl?address=${address}&subaccountNumber=0&limit=100`
    const pnlResponse = await fetch(pnlUrl)

    if (!pnlResponse.ok) {
      // 如果没有历史 PnL，尝试从 open positions 获取
      if (equity <= 0) return null

      let totalPnl = 0
      const positions = mainAccount.openPerpetualPositions || {}
      for (const [market, pos] of Object.entries(positions)) {
        const realized = parseFloat(pos.realizedPnl) || 0
        const unrealized = parseFloat(pos.unrealizedPnl) || 0
        totalPnl += realized + unrealized
      }

      if (totalPnl === 0) return null
      const initialEquity = equity - totalPnl
      const roi = initialEquity > 0 ? (totalPnl / initialEquity) * 100 : 0

      return { address, roi, pnl: totalPnl, equity, initialEquity }
    }

    const pnlData = await pnlResponse.json()
    const pnlHistory = pnlData.historicalPnl || []

    if (pnlHistory.length === 0) {
      // 如果没有历史记录，尝试从 open positions
      if (equity <= 0) return null

      let totalPnl = 0
      const positions = mainAccount.openPerpetualPositions || {}
      for (const [market, pos] of Object.entries(positions)) {
        const realized = parseFloat(pos.realizedPnl) || 0
        const unrealized = parseFloat(pos.unrealizedPnl) || 0
        totalPnl += realized + unrealized
      }

      if (totalPnl === 0) return null
      const initialEquity = equity - totalPnl
      const roi = initialEquity > 0 ? (totalPnl / initialEquity) * 100 : 0

      return { address, roi, pnl: totalPnl, equity, initialEquity }
    }

    // 从历史 PnL 计算总收益
    // 取最新的 totalPnl
    const latestPnl = parseFloat(pnlHistory[0]?.totalPnl || '0')
    const latestEquity = parseFloat(pnlHistory[0]?.equity || equity.toString())

    // 找最早的记录来估算初始权益
    const earliestEquity = parseFloat(pnlHistory[pnlHistory.length - 1]?.equity || '0')
    const earliestPnl = parseFloat(pnlHistory[pnlHistory.length - 1]?.totalPnl || '0')

    // 计算周期内的 PnL
    const periodPnl = latestPnl - earliestPnl

    // 初始权益 = 最早权益 - 最早累计 PnL
    const initialEquity = earliestEquity - earliestPnl

    if (initialEquity <= 0) return null

    const roi = (periodPnl / initialEquity) * 100

    return {
      address,
      roi,
      pnl: periodPnl,
      equity: latestEquity,
      initialEquity,
      totalPnl: latestPnl
    }
  } catch (e) {
    return null
  }
}

/**
 * 获取胜率 (通过已平仓头寸)
 */
async function fetchWinRate(address) {
  try {
    const url = `${INDEXER_API}/perpetualPositions?address=${address}&subaccountNumber=0&status=CLOSED&limit=200`
    const response = await fetch(url)
    if (!response.ok) return null

    const data = await response.json()
    const positions = data.positions || []

    if (positions.length < 2) return null

    let wins = 0
    let losses = 0

    for (const p of positions) {
      const entry = parseFloat(p.entryPrice) || 0
      const exit = parseFloat(p.exitPrice) || 0
      const size = parseFloat(p.sumClose) || 0

      if (entry === 0 || exit === 0 || size === 0) continue

      const pnl = (exit - entry) * size * (p.side === 'LONG' ? 1 : -1)
      if (pnl > 0) wins++
      else losses++
    }

    const total = wins + losses
    if (total === 0) return null

    return (wins / total) * 100
  } catch (e) {
    return null
  }
}

/**
 * 获取最大回撤 (通过历史 PnL)
 */
async function fetchMaxDrawdown(address) {
  try {
    const url = `${INDEXER_API}/historical-pnl?address=${address}&subaccountNumber=0&limit=300`
    const response = await fetch(url)
    if (!response.ok) return null

    const data = await response.json()
    const pnlHistory = data.historicalPnl || []

    if (pnlHistory.length < 5) return null

    // 从最旧到最新排序
    const equities = pnlHistory
      .map(p => parseFloat(p.equity))
      .reverse()

    let peak = 0
    let maxDrawdown = 0

    for (const equity of equities) {
      if (equity > peak) peak = equity
      if (peak > 0) {
        const dd = ((peak - equity) / peak) * 100
        if (dd > maxDrawdown) maxDrawdown = dd
      }
    }

    return maxDrawdown > 0 ? maxDrawdown : null
  } catch (e) {
    return null
  }
}

/**
 * 批量获取完整数据
 */
async function fetchAllData(accounts, period) {
  console.log(`\n📈 获取 ${period} 完整数据...`)
  console.log(`  账户数: ${accounts.length}, 并发: ${CONCURRENCY}`)

  const results = []
  let processed = 0

  for (let i = 0; i < accounts.length; i += CONCURRENCY) {
    const batch = accounts.slice(i, i + CONCURRENCY)

    const batchResults = await Promise.all(
      batch.map(async (acc) => {
        const basicData = await fetchAddressData(acc.address)
        if (!basicData) return null

        const [winRate, maxDrawdown] = await Promise.all([
          fetchWinRate(acc.address),
          fetchMaxDrawdown(acc.address)
        ])

        return {
          ...basicData,
          displayName: `${acc.address.slice(0, 8)}...${acc.address.slice(-4)}`,
          winRate,
          maxDrawdown
        }
      })
    )

    for (const result of batchResults) {
      if (result && Math.abs(result.pnl) > 0.01) {
        results.push(result)
      }
    }

    processed += batch.length
    if (processed % 30 === 0 || processed === accounts.length) {
      const withWr = results.filter(t => t.winRate !== null).length
      const withMdd = results.filter(t => t.maxDrawdown !== null).length
      console.log(`  进度: ${processed}/${accounts.length}, 有效: ${results.length}, WR: ${withWr}, MDD: ${withMdd}`)
    }

    await sleep(DELAY_MS)
  }

  console.log(`  ✓ 获取完成: ${results.length} 条有效数据`)
  return results
}

/**
 * 保存数据到数据库
 */
async function saveTraders(traders, period) {
  if (traders.length === 0) {
    console.log('  无数据保存')
    return 0
  }

  console.log(`\n💾 保存 ${traders.length} 个交易员...`)

  traders.sort((a, b) => (b.roi || 0) - (a.roi || 0))
  const top100 = traders.slice(0, TARGET_COUNT)
  const capturedAt = new Date().toISOString()

  const sourcesData = top100.map(t => ({
    source: SOURCE,
    source_type: 'defi',
    source_trader_id: t.address,
    handle: t.displayName,
    profile_url: `https://dydx.trade/portfolio/${t.address}`,
    is_active: true
  }))

  await supabase.from('trader_sources').upsert(sourcesData, {
    onConflict: 'source,source_trader_id'
  })

  const snapshotsData = top100.map((t, idx) => ({
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

  const { error } = await supabase.from('trader_snapshots').insert(snapshotsData)

  if (error) {
    console.log('  ⚠ 批量保存失败:', error.message)
    let saved = 0
    for (const s of snapshotsData) {
      const { error: e } = await supabase.from('trader_snapshots').insert(s)
      if (!e) saved++
    }
    return saved
  }

  const withWr = top100.filter(t => t.winRate !== null).length
  const withMdd = top100.filter(t => t.maxDrawdown !== null).length
  console.log(`  ✓ 保存成功: ${top100.length} 条`)
  console.log(`    胜率覆盖: ${withWr}/${top100.length} (${((withWr/top100.length)*100).toFixed(0)}%)`)
  console.log(`    MDD覆盖: ${withMdd}/${top100.length} (${((withMdd/top100.length)*100).toFixed(0)}%)`)

  return top100.length
}

async function main() {
  const periods = getTargetPeriods()
  const startTime = Date.now()

  console.log('\n' + '='.repeat(60))
  console.log('dYdX v4 增强版数据抓取')
  console.log('='.repeat(60))
  console.log('时间:', new Date().toISOString())
  console.log('目标周期:', periods.join(', '))
  console.log('数据源: dYdX Chain + Indexer API')
  console.log('增强功能: 胜率 (perpetualPositions) + 最大回撤 (historical-pnl)')
  console.log('='.repeat(60))

  // 获取活跃账户
  const accounts = await fetchActiveSubaccounts(300)

  if (accounts.length === 0) {
    console.log('\n❌ 未获取到活跃账户')
    return
  }

  const results = []

  for (const period of periods) {
    console.log('\n' + '='.repeat(50))
    console.log(`📊 处理 ${period}...`)
    console.log('='.repeat(50))

    const traders = await fetchAllData(accounts, period)

    if (traders.length === 0) {
      console.log(`\n⚠ ${period} 未获取到有效数据`)
      continue
    }

    traders.sort((a, b) => (b.roi || 0) - (a.roi || 0))

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
