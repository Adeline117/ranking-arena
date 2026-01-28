/**
 * dYdX v4 自建排行榜
 *
 * 从链上获取所有活跃子账户，查询 PnL 数据，构建排行榜
 *
 * 数据源:
 * - 子账户列表: https://dydx-rest.publicnode.com/dydxprotocol/subaccounts/subaccount
 * - PnL 数据: https://indexer.dydx.trade/v4/addresses/{address}/parentSubaccount
 *
 * 用法: node scripts/import/import_dydx_v4.mjs [30D|90D|ALL]
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
const TARGET_COUNT = 500
const CHAIN_API = 'https://dydx-rest.publicnode.com'
const INDEXER_API = 'https://indexer.dydx.trade/v4'

// 并发控制
const CONCURRENCY = 10
const DELAY_MS = 100

const clip = (v, min, max) => Math.max(min, Math.min(max, v))
const safeLog1p = x => x <= -1 ? 0 : Math.log(1 + x)
const sleep = ms => new Promise(r => setTimeout(r, ms))

function calculateArenaScore(roi, pnl, maxDrawdown, winRate, period) {
  const params = { tanhCoeff: 0.18, roiExponent: 1.6, mddThreshold: 40, winRateCap: 70 }
  const days = period === '7D' ? 7 : period === '30D' ? 30 : 90
  const wr = winRate !== null ? (winRate <= 1 ? winRate * 100 : winRate) : null
  const intensity = (365 / days) * safeLog1p((roi || 0) / 100)
  const r0 = Math.tanh(params.tanhCoeff * intensity)
  const returnScore = r0 > 0 ? clip(85 * Math.pow(r0, params.roiExponent), 0, 85) : 0
  const drawdownScore = maxDrawdown !== null ? clip(8 * clip(1 - Math.abs(maxDrawdown) / params.mddThreshold, 0, 1), 0, 8) : 4
  const stabilityScore = wr !== null ? clip(7 * clip((wr - 45) / (params.winRateCap - 45), 0, 1), 0, 7) : 3.5
  return Math.round((returnScore + drawdownScore + stabilityScore) * 100) / 100
}

function getTargetPeriods() {
  const arg = process.argv[2]?.toUpperCase()
  if (arg === 'ALL') return ['30D', '90D']
  if (arg && ['7D', '30D', '90D'].includes(arg)) return [arg]
  return ['30D', '90D']
}

/**
 * 获取所有活跃子账户（有持仓的）
 */
async function fetchActiveSubaccounts(limit = 500) {
  console.log('\n📊 获取活跃子账户...')

  const activeAccounts = new Map()
  let nextKey = null
  let page = 0

  while (true) {
    page++
    let url = `${CHAIN_API}/dydxprotocol/subaccounts/subaccount?pagination.limit=100`
    if (nextKey) {
      url += `&pagination.key=${encodeURIComponent(nextKey)}`
    }

    try {
      const response = await fetch(url)
      const data = await response.json()

      if (!data.subaccount || data.subaccount.length === 0) {
        break
      }

      // 过滤有持仓的账户
      for (const sub of data.subaccount) {
        if (sub.perpetual_positions && sub.perpetual_positions.length > 0) {
          const owner = sub.id.owner
          if (!activeAccounts.has(owner)) {
            // 计算 USDC 余额 (quantums / 10^6)
            const usdcBalance = sub.asset_positions?.[0]?.quantums
              ? parseInt(sub.asset_positions[0].quantums) / 1e6
              : 0

            activeAccounts.set(owner, {
              address: owner,
              positions: sub.perpetual_positions.length,
              usdcBalance
            })
          }
        }
      }

      console.log(`  页 ${page}: 累计 ${activeAccounts.size} 个活跃账户`)

      // 检查是否达到目标
      if (activeAccounts.size >= limit) {
        console.log(`  ✓ 已获取 ${limit} 个活跃账户`)
        break
      }

      // 下一页
      nextKey = data.pagination?.next_key
      if (!nextKey) {
        break
      }

      await sleep(50)
    } catch (e) {
      console.error(`  ✗ 获取失败:`, e.message)
      break
    }
  }

  console.log(`  总计: ${activeAccounts.size} 个活跃账户`)
  return Array.from(activeAccounts.values()).slice(0, limit)
}

/**
 * 获取单个地址的账户数据和 PnL
 */
async function fetchAddressPnL(address, period) {
  try {
    // 使用 /addresses/{address} 端点获取完整账户数据
    const url = `${INDEXER_API}/addresses/${address}`

    const response = await fetch(url)
    if (!response.ok) {
      return null
    }

    const data = await response.json()

    if (!data.subaccounts || data.subaccounts.length === 0) {
      return null
    }

    // 找到主子账户 (subaccountNumber = 0)
    const mainAccount = data.subaccounts.find(s => s.subaccountNumber === 0)
    if (!mainAccount) {
      return null
    }

    const equity = parseFloat(mainAccount.equity) || 0
    if (equity <= 0) {
      return null
    }

    // 计算总 PnL (realized + unrealized)
    let totalPnl = 0
    let positionCount = 0

    const positions = mainAccount.openPerpetualPositions || {}
    for (const [market, pos] of Object.entries(positions)) {
      const realized = parseFloat(pos.realizedPnl) || 0
      const unrealized = parseFloat(pos.unrealizedPnl) || 0
      totalPnl += realized + unrealized
      positionCount++
    }

    // 如果没有持仓，跳过
    if (positionCount === 0) {
      return null
    }

    // 估算初始本金 (equity - totalPnl)
    const initialEquity = equity - totalPnl
    const roi = initialEquity > 0 ? (totalPnl / initialEquity) * 100 : 0

    return {
      address,
      roi,
      pnl: totalPnl,
      equity,
      initialEquity,
      positionCount
    }
  } catch (e) {
    return null
  }
}

/**
 * 批量获取 PnL 数据
 */
async function fetchAllPnL(accounts, period) {
  console.log(`\n📈 获取 ${period} PnL 数据...`)
  console.log(`  账户数: ${accounts.length}, 并发: ${CONCURRENCY}`)

  const results = []
  let processed = 0

  // 分批处理
  for (let i = 0; i < accounts.length; i += CONCURRENCY) {
    const batch = accounts.slice(i, i + CONCURRENCY)

    const batchResults = await Promise.all(
      batch.map(acc => fetchAddressPnL(acc.address, period))
    )

    for (const result of batchResults) {
      if (result && Math.abs(result.pnl) > 0.01) {
        results.push(result)
      }
    }

    processed += batch.length
    if (processed % 50 === 0 || processed === accounts.length) {
      console.log(`  进度: ${processed}/${accounts.length}, 有效数据: ${results.length}`)
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

  // 按 ROI 排序
  traders.sort((a, b) => (b.roi || 0) - (a.roi || 0))
  const top100 = traders.slice(0, TARGET_COUNT)
  const capturedAt = new Date().toISOString()

  // 批量 upsert trader_sources
  const sourcesData = top100.map(t => ({
    source: SOURCE,
    source_type: 'chain',
    source_trader_id: t.address,
    handle: t.address.slice(0, 8) + '...' + t.address.slice(-4),
    profile_url: `https://dydx.trade/portfolio/${t.address}`,
    is_active: true
  }))

  await supabase.from('trader_sources').upsert(sourcesData, {
    onConflict: 'source,source_trader_id'
  })

  // 批量 insert trader_snapshots
  const snapshotsData = top100.map((t, idx) => ({
    source: SOURCE,
    source_trader_id: t.address,
    season_id: period,
    rank: idx + 1,
    roi: t.roi,
    pnl: t.pnl,
    win_rate: null,
    max_drawdown: null,
    followers: 0,
    arena_score: calculateArenaScore(t.roi, t.pnl, null, null, period),
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

  console.log('  ✓ 保存成功:', top100.length)
  return top100.length
}

async function main() {
  const periods = getTargetPeriods()
  const startTime = Date.now()

  console.log('\n' + '='.repeat(60))
  console.log('dYdX v4 自建排行榜')
  console.log('='.repeat(60))
  console.log('时间:', new Date().toISOString())
  console.log('目标周期:', periods.join(', '))
  console.log('数据源: dYdX Chain + Indexer')
  console.log('='.repeat(60))

  // 1. 获取活跃账户
  const accounts = await fetchActiveSubaccounts(300)

  if (accounts.length === 0) {
    console.log('\n❌ 未获取到活跃账户')
    return
  }

  const results = []

  // 2. 为每个周期获取 PnL 并保存
  for (const period of periods) {
    console.log('\n' + '='.repeat(50))
    console.log(`📊 处理 ${period}...`)
    console.log('='.repeat(50))

    const pnlData = await fetchAllPnL(accounts, period)

    if (pnlData.length === 0) {
      console.log(`\n⚠ ${period} 未获取到有效数据`)
      continue
    }

    // 排序并显示 TOP 5
    pnlData.sort((a, b) => (b.roi || 0) - (a.roi || 0))

    console.log(`\n📋 ${period} TOP 5:`)
    pnlData.slice(0, 5).forEach((t, i) => {
      console.log(`  ${i + 1}. ${t.address.slice(0, 12)}...: ROI ${t.roi?.toFixed(2) || 0}%, PnL $${t.pnl?.toFixed(0) || 0}`)
    })

    const saved = await saveTraders(pnlData, period)
    results.push({ period, count: pnlData.length, saved, topRoi: pnlData[0]?.roi || 0 })

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
  }
  console.log(`   总耗时: ${totalTime}s`)
  console.log('='.repeat(60))
}

main().catch(console.error)
