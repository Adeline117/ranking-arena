/**
 * HTX Futures 增强版导入脚本
 *
 * API: https://futures.htx.com/-/x/hbg/v1/futures/copytrading/rank
 * 字段: userSign, nickName, imgUrl, copyUserNum, winRate, profitRate90, profit90, mdd, profitList
 *
 * 用法: node scripts/import/import_htx_enhanced.mjs [7D|30D|90D|ALL]
 */

import {
  getSupabaseClient,
  calculateArenaScore,
  sleep,
  getTargetPeriods,
} from '../../lib/shared.mjs'

const supabase = getSupabaseClient()

const SOURCE = 'htx_futures'
const API_URL = 'https://futures.htx.com/-/x/hbg/v1/futures/copytrading/rank'
const TARGET_COUNT = 500
const PAGE_SIZE = 50
const DELAY_MS = 500

const WINDOW_DAYS = { '7D': 7, '30D': 30, '90D': 90 }

/**
 * 从 profitList 计算特定窗口的 ROI (百分比)
 * profitList 是每日累计收益率数组（小数形式），从旧到新
 */
function calculatePeriodRoi(profitList, period) {
  if (!Array.isArray(profitList) || profitList.length < 2) return null

  const days = WINDOW_DAYS[period] || 30
  const last = parseFloat(profitList[profitList.length - 1])

  if (profitList.length >= days) {
    const startIdx = profitList.length - days
    const startVal = startIdx > 0 ? parseFloat(profitList[startIdx - 1]) : 0
    return (last - startVal) * 100
  } else {
    const first = parseFloat(profitList[0] || 0)
    return (last - first) * 100
  }
}

/**
 * 从 profitList 计算最大回撤 (百分比)
 */
function calculateMaxDrawdown(profitList, period) {
  if (!Array.isArray(profitList) || profitList.length < 2) return null

  const days = WINDOW_DAYS[period] || 30
  const relevantData = profitList.slice(-days)
  if (relevantData.length < 2) return null

  const equityCurve = relevantData.map(r => 1 + parseFloat(r))
  let peak = equityCurve[0]
  let maxDrawdown = 0

  for (const equity of equityCurve) {
    if (equity > peak) peak = equity
    if (peak > 0) {
      const dd = ((peak - equity) / peak) * 100
      if (dd > maxDrawdown) maxDrawdown = dd
    }
  }

  return maxDrawdown > 0 && maxDrawdown < 100 ? maxDrawdown : null
}

/**
 * 获取排行榜数据
 */
async function fetchLeaderboard(period) {
  console.log(`\n📊 获取排行榜数据 (${period})...`)

  const allTraders = new Map()
  const maxPages = Math.ceil(TARGET_COUNT / PAGE_SIZE)

  for (let pageNo = 1; pageNo <= maxPages; pageNo++) {
    try {
      const url = `${API_URL}?rankType=1&pageNo=${pageNo}&pageSize=${PAGE_SIZE}`
      const response = await fetch(url, {
        headers: {
          'Accept': 'application/json',
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        }
      })

      const data = await response.json()

      if (data.code !== 200 || !data.data?.itemList) {
        console.log(`  ⚠ API 返回错误: ${data.code}`)
        break
      }

      const list = data.data.itemList
      console.log(`  📋 页 ${pageNo}: ${list.length} 条数据`)

      if (list.length === 0) break

      for (const item of list) {
        const sourceId = item.userSign || String(item.uid || '')
        if (!sourceId || allTraders.has(sourceId)) continue

        // profitRate90 是90天 ROI (百分比), mdd 是最大回撤 (小数)
        // 对于 7D/30D 周期，从 profitList 计算
        const profitList = item.profitList || []
        let roi = null
        let maxDrawdown = null

        if (period === '90D') {
          // API 直接给 90D 数据
          roi = parseFloat(item.profitRate90 || 0)
          maxDrawdown = item.mdd != null ? parseFloat(item.mdd) * 100 : null
        } else {
          // 从 profitList 计算 7D/30D
          roi = calculatePeriodRoi(profitList, period)
          maxDrawdown = calculateMaxDrawdown(profitList, period)
          // fallback: 如果 profitList 不够长，用 90D 数据
          if (roi === null) {
            roi = parseFloat(item.profitRate90 || 0)
          }
          if (maxDrawdown === null && item.mdd != null) {
            maxDrawdown = parseFloat(item.mdd) * 100
          }
        }

        const winRate = parseFloat(item.winRate || 0) * 100

        allTraders.set(sourceId, {
          traderId: sourceId,
          nickname: item.nickName || `HTX_${item.uid}`,
          avatar: item.imgUrl || null,
          roi,
          pnl: parseFloat(item.profit90 || item.copyProfit || 0),
          winRate,
          maxDrawdown,
          followers: parseInt(item.copyUserNum || 0),
        })
      }

      if (list.length < PAGE_SIZE) break // last page
      if (allTraders.size >= TARGET_COUNT) break
      await sleep(DELAY_MS)
    } catch (e) {
      console.log(`  ⚠ 页 ${pageNo} 请求失败: ${e.message}`)
    }
  }

  const traders = Array.from(allTraders.values())
    .filter(t => t.roi !== null && t.roi !== 0)
    .sort((a, b) => b.roi - a.roi)
    .slice(0, TARGET_COUNT)

  console.log(`  ✓ 获取到 ${traders.length} 个交易员`)
  return traders
}

/**
 * 保存数据到数据库 (UPSERT)
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

  const { error: srcErr } = await supabase.from('trader_sources').upsert(sourcesData, {
    onConflict: 'source,source_trader_id'
  })
  if (srcErr) console.log(`  ⚠ trader_sources upsert error: ${srcErr.message}`)

  // 批量 upsert trader_snapshots
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
    arena_score: calculateArenaScore(t.roi, t.pnl, t.maxDrawdown, t.winRate, period).totalScore,
    captured_at: capturedAt
  }))

  // Use upsert with onConflict to avoid duplicates
  const { error } = await supabase.from('trader_snapshots').upsert(snapshotsData, {
    onConflict: 'source,source_trader_id,season_id'
  })

  if (error) {
    console.log('  ⚠ 批量 upsert 失败:', error.message)
    // 逐条尝试
    let saved = 0
    for (const s of snapshotsData) {
      const { error: e } = await supabase.from('trader_snapshots').upsert(s, {
        onConflict: 'source,source_trader_id,season_id'
      })
      if (!e) saved++
    }
    console.log(`  ✓ 逐条保存: ${saved}/${snapshotsData.length}`)
    return saved
  }

  const withWr = traders.filter(t => t.winRate > 0).length
  const withMdd = traders.filter(t => t.maxDrawdown !== null && t.maxDrawdown > 0).length
  console.log(`  ✓ 保存成功: ${traders.length} 条`)
  console.log(`    胜率覆盖: ${withWr}/${traders.length} (${((withWr/traders.length)*100).toFixed(0)}%)`)
  console.log(`    MDD覆盖: ${withMdd}/${traders.length} (${((withMdd/traders.length)*100).toFixed(0)}%)`)

  return traders.length
}

async function main() {
  const periods = getTargetPeriods(['30D'])
  const startTime = Date.now()

  console.log('\n' + '='.repeat(60))
  console.log('HTX Futures 增强版数据抓取')
  console.log('='.repeat(60))
  console.log('时间:', new Date().toISOString())
  console.log('目标周期:', periods.join(', '))
  console.log('='.repeat(60))

  const results = []

  for (const period of periods) {
    console.log('\n' + '='.repeat(50))
    console.log(`📊 处理 ${period}...`)

    try {
      const traders = await fetchLeaderboard(period)

      if (traders.length === 0) {
        console.log(`\n⚠ ${period} 未获取到数据`)
        continue
      }

      console.log(`\n📋 ${period} TOP 5:`)
      traders.slice(0, 5).forEach((t, i) => {
        const wr = t.winRate > 0 ? `${t.winRate.toFixed(1)}%` : 'N/A'
        const mdd = t.maxDrawdown !== null ? `${t.maxDrawdown.toFixed(1)}%` : 'N/A'
        console.log(`  ${i + 1}. ${t.nickname}: ROI ${t.roi.toFixed(2)}%, WR ${wr}, MDD ${mdd}`)
      })

      const saved = await saveTraders(traders, period)
      results.push({ period, count: traders.length, saved })

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
  for (const r of results) {
    console.log(`   ${r.period}: ${r.saved} 条`)
  }
  console.log(`   总耗时: ${totalTime}s`)
  console.log('='.repeat(60))
}

main().catch(console.error)
