/**
 * HTX Futures 增强版导入脚本
 *
 * 从 profitList (每日累计收益率) 计算最大回撤
 *
 * 用法: node scripts/import/import_htx_enhanced.mjs [7D|30D|90D|ALL]
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

const SOURCE = 'htx_futures'
const API_URL = 'https://futures.htx.com/-/x/hbg/v1/futures/copytrading/rank'
const TARGET_COUNT = 500
const DELAY_MS = 500

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
  if (arg === 'ALL') return ['7D', '30D', '90D']
  if (arg && ['7D', '30D', '90D'].includes(arg)) return [arg]
  return ['30D']
}

/**
 * 从 profitList 计算最大回撤
 * profitList 是每日累计收益率数组，从旧到新
 * 例如: [0.01, 0.05, 0.03, 0.08] 表示第1天+1%, 第2天累计+5%, 第3天累计+3%, 第4天累计+8%
 */
function calculateMaxDrawdown(profitList, period) {
  if (!Array.isArray(profitList) || profitList.length < 2) {
    return null
  }

  // 根据周期选择要分析的数据范围
  const days = WINDOW_DAYS[period] || 30
  const relevantData = profitList.slice(-days)

  if (relevantData.length < 2) {
    return null
  }

  // 将累计收益率转换为模拟权益曲线 (假设初始权益 = 1)
  // equity = 1 + cumulative_return
  const equityCurve = relevantData.map(r => 1 + parseFloat(r))

  let peak = equityCurve[0]
  let maxDrawdown = 0

  for (const equity of equityCurve) {
    if (equity > peak) {
      peak = equity
    }
    if (peak > 0) {
      const drawdown = ((peak - equity) / peak) * 100
      if (drawdown > maxDrawdown) {
        maxDrawdown = drawdown
      }
    }
  }

  // 返回合理范围内的 MDD
  return maxDrawdown > 0 && maxDrawdown < 100 ? maxDrawdown : null
}

/**
 * 获取排行榜数据
 */
async function fetchLeaderboard(period) {
  console.log(`\n📊 获取排行榜数据 (${period})...`)

  const allTraders = new Map()

  // rankType: 1=收益率排序(ROI)
  for (let pageNo = 1; pageNo <= 2; pageNo++) {
    try {
      const url = `${API_URL}?rankType=1&pageNo=${pageNo}&pageSize=50`
      const response = await fetch(url, {
        headers: {
          'Accept': 'application/json',
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        }
      })

      const data = await response.json()

      if (data.code !== 200 || !data.data?.itemList) {
        console.log(`  ⚠ API 返回错误: ${data.code}`)
        continue
      }

      const list = data.data.itemList
      console.log(`  📋 页 ${pageNo}: ${list.length} 条数据`)

      for (const item of list) {
        const uid = String(item.uid || '')
        const sourceId = item.userSign || uid
        if (!sourceId || allTraders.has(sourceId)) continue

        // 从 profitList 计算各时间段的 ROI 和 MDD
        const profitList = item.profitList || []
        let roi = null
        let maxDrawdown = null

        if (profitList.length > 0) {
          const last = parseFloat(profitList[profitList.length - 1])
          const days = WINDOW_DAYS[period] || 30

          if (profitList.length >= days) {
            const startIdx = profitList.length - days
            const startVal = startIdx > 0 ? parseFloat(profitList[startIdx - 1]) : 0
            roi = (last - startVal) * 100
          } else {
            const first = parseFloat(profitList[0] || 0)
            roi = (last - first) * 100
          }

          // 计算最大回撤
          maxDrawdown = calculateMaxDrawdown(profitList, period)
        }

        const winRate = parseFloat(item.winRate || 0) * 100

        allTraders.set(sourceId, {
          traderId: sourceId,
          uid,
          nickname: item.nickName || `HTX_${uid}`,
          avatar: item.imgUrl || null,
          roi,
          pnl: parseFloat(item.copyProfit || 0) || 0,
          winRate,
          maxDrawdown,
          followers: parseInt(item.copyUserNum || 0) || 0,
          profitList,
        })
      }

      if (allTraders.size >= TARGET_COUNT) break
      await sleep(DELAY_MS)
    } catch (e) {
      console.log(`  ⚠ 请求失败: ${e.message}`)
    }
  }

  const traders = Array.from(allTraders.values())
    .filter(t => t.roi !== null)
    .sort((a, b) => b.roi - a.roi)
    .slice(0, TARGET_COUNT)

  console.log(`  ✓ 获取到 ${traders.length} 个交易员`)
  return traders
}

/**
 * 保存数据到数据库
 */
async function saveTraders(traders, period) {
  console.log(`\n💾 保存 ${traders.length} 个交易员...`)

  const capturedAt = new Date().toISOString()

  // 批量 upsert trader_sources
  const sourcesData = traders.map(t => ({
    source: SOURCE,
    source_type: 'leaderboard',
    source_trader_id: t.traderId,
    handle: t.nickname,
    avatar_url: t.avatar || null,
    profile_url: `https://futures.htx.com/en-us/copytrading/futures/detail/${t.traderId}`,
    is_active: true
  }))

  await supabase.from('trader_sources').upsert(sourcesData, {
    onConflict: 'source,source_trader_id'
  })

  // 批量 insert trader_snapshots
  const snapshotsData = traders.map((t, idx) => ({
    source: SOURCE,
    source_trader_id: t.traderId,
    season_id: period,
    rank: idx + 1,
    roi: t.roi,
    pnl: t.pnl,
    win_rate: t.winRate,
    max_drawdown: t.maxDrawdown,
    followers: t.followers,
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

  const withWr = traders.filter(t => t.winRate !== null && t.winRate > 0).length
  const withMdd = traders.filter(t => t.maxDrawdown !== null && t.maxDrawdown > 0).length
  console.log(`  ✓ 保存成功: ${traders.length} 条`)
  console.log(`    胜率覆盖: ${withWr}/${traders.length} (${((withWr/traders.length)*100).toFixed(0)}%)`)
  console.log(`    MDD覆盖: ${withMdd}/${traders.length} (${((withMdd/traders.length)*100).toFixed(0)}%)`)

  return traders.length
}

async function main() {
  const periods = getTargetPeriods()
  const startTime = Date.now()

  console.log('\n' + '='.repeat(60))
  console.log('HTX Futures 增强版数据抓取')
  console.log('='.repeat(60))
  console.log('时间:', new Date().toISOString())
  console.log('目标周期:', periods.join(', '))
  console.log('增强功能: 从 profitList 计算最大回撤')
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

      console.log(`\n📋 ${period} TOP 5:`)
      traders.slice(0, 5).forEach((t, i) => {
        const wr = t.winRate !== null ? `${t.winRate.toFixed(1)}%` : 'N/A'
        const mdd = t.maxDrawdown !== null ? `${t.maxDrawdown.toFixed(1)}%` : 'N/A'
        console.log(`  ${i + 1}. ${t.nickname}: ROI ${t.roi.toFixed(2)}%, WR ${wr}, MDD ${mdd}`)
      })

      const saved = await saveTraders(traders, period)
      results.push({
        period,
        count: traders.length,
        saved,
        topRoi: traders[0]?.roi || 0,
        winRateCoverage: traders.filter(t => t.winRate > 0).length,
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
