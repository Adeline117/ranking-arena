/**
 * OKX Futures Copy Trading 排行榜数据抓取
 *
 * API: https://www.okx.com/api/v5/copytrading/public-lead-traders?instType=SWAP
 * 分页: page=1..N (每页10条, totalPage~24)
 * 字段: uniqueCode, nickName, portLink, pnlRatio(小数), pnl, winRatio(小数), copyTraderNum, pnlRatios[]
 *
 * 用法: node scripts/import/import_okx_futures.mjs [7D|30D|90D|ALL]
 */

import {
  getSupabaseClient,
  calculateArenaScore,
  sleep,
  getTargetPeriods,
} from '../lib/shared.mjs'

const supabase = getSupabaseClient()

const SOURCE = 'okx_futures'
const API_URL = 'https://www.okx.com/api/v5/copytrading/public-lead-traders'
const TARGET_COUNT = 1000
const DELAY_MS = 500

const WINDOW_DAYS = { '7D': 7, '30D': 30, '90D': 90 }

/**
 * 从 pnlRatios 数组计算特定窗口的 ROI 和最大回撤
 * pnlRatios 按时间从新到旧排列: [{beginTs, pnlRatio}, ...]
 * pnlRatio 是累计收益率 (小数，如 1.0058 = 100.58%)
 */
function computePeriodMetrics(pnlRatios, period) {
  if (!Array.isArray(pnlRatios) || pnlRatios.length < 2) {
    return { roi: null, maxDrawdown: null }
  }

  // pnlRatios from API is newest first; reverse for chronological order
  const sorted = [...pnlRatios].sort((a, b) => parseInt(a.beginTs) - parseInt(b.beginTs))
  const days = WINDOW_DAYS[period] || 90
  const relevant = sorted.slice(-days)

  if (relevant.length < 2) {
    return { roi: null, maxDrawdown: null }
  }

  // ROI for the window: from earliest to latest ratio in window
  const firstRatio = parseFloat(relevant[0].pnlRatio)
  const lastRatio = parseFloat(relevant[relevant.length - 1].pnlRatio)
  // Each pnlRatio is cumulative from account start. Period ROI = (1+last)/(1+first) - 1
  const roi = ((1 + lastRatio) / (1 + firstRatio) - 1) * 100

  // MDD calculation from equity curve within window
  const equityCurve = relevant.map(r => 1 + parseFloat(r.pnlRatio))
  let peak = equityCurve[0]
  let maxDrawdown = 0
  for (const eq of equityCurve) {
    if (eq > peak) peak = eq
    if (peak > 0) {
      const dd = ((peak - eq) / peak) * 100
      if (dd > maxDrawdown) maxDrawdown = dd
    }
  }

  return {
    roi: isFinite(roi) ? roi : null,
    maxDrawdown: maxDrawdown > 0 && maxDrawdown < 100 ? maxDrawdown : null
  }
}

/**
 * 获取所有页的排行榜数据
 */
async function fetchLeaderboard(period) {
  console.log(`\n📊 获取 OKX Futures 排行榜 (${period})...`)

  const allTraders = []
  let totalPages = 1

  for (let page = 1; page <= Math.min(totalPages, 50); page++) {
    try {
      const url = `${API_URL}?instType=SWAP&page=${page}`
      const response = await fetch(url, {
        headers: { 'Accept': '*/*', 'Accept-Language': 'en-US,en;q=0.9' }
      })

      if (!response.ok) {
        console.log(`  ⚠ Page ${page} HTTP ${response.status}`)
        break
      }

      const json = await response.json()
      if (json.code !== '0' || !json.data?.length) {
        console.log(`  ⚠ API error: ${json.code} - ${json.msg}`)
        break
      }

      const item = json.data[0]
      totalPages = parseInt(item.totalPage) || totalPages
      const ranks = item.ranks || []

      if (page === 1) {
        console.log(`  📋 总页数: ${totalPages} (约 ${totalPages * 10} 交易员)`)
      }

      if (ranks.length === 0) break

      for (const t of ranks) {
        const uniqueCode = t.uniqueCode
        if (!uniqueCode) continue

        // pnlRatio 是总累计收益率 (小数), 需要 *100 转百分比
        const totalRoi = parseFloat(t.pnlRatio || 0) * 100
        const totalPnl = parseFloat(t.pnl || 0)
        const winRate = t.winRatio != null ? parseFloat(t.winRatio) * 100 : null
        const followers = parseInt(t.copyTraderNum || 0)

        // 从 pnlRatios 计算特定周期的 ROI 和 MDD
        const pnlRatios = t.pnlRatios || []
        const metrics = computePeriodMetrics(pnlRatios, period)

        allTraders.push({
          traderId: uniqueCode,
          nickname: t.nickName || 'Unknown',
          avatar: t.portLink || null,
          roi: metrics.roi !== null ? metrics.roi : totalRoi,
          pnl: totalPnl,
          winRate,
          maxDrawdown: metrics.maxDrawdown,
          followers,
        })
      }

      if (allTraders.length >= TARGET_COUNT) break
      await sleep(DELAY_MS)
    } catch (e) {
      console.log(`  ⚠ Page ${page} error: ${e.message}`)
    }
  }

  const traders = allTraders
    .filter(t => t.roi !== null)
    .sort((a, b) => b.roi - a.roi)
    .slice(0, TARGET_COUNT)

  console.log(`  ✓ 获取到 ${traders.length} 个交易员`)
  return traders
}

/**
 * 保存交易员数据 (UPSERT)
 */
async function saveTraders(traders, period) {
  console.log(`\n💾 保存 ${traders.length} 个交易员 (${period})...`)
  if (traders.length === 0) return 0

  const capturedAt = new Date().toISOString()

  // upsert trader_sources
  const sourcesData = traders.map(t => ({
    source: SOURCE,
    source_type: 'leaderboard',
    source_trader_id: t.traderId,
    handle: t.nickname,
    avatar_url: t.avatar || null,
    profile_url: `https://www.okx.com/copy-trading/account/${t.traderId}`,
    is_active: true,
  }))

  const { error: srcErr } = await supabase
    .from('trader_sources')
    .upsert(sourcesData, { onConflict: 'source,source_trader_id' })
  if (srcErr) console.log(`  ⚠ trader_sources error: ${srcErr.message}`)

  // upsert trader_snapshots
  const snapshotsData = traders.map((t, idx) => ({
    source: SOURCE,
    source_trader_id: t.traderId,
    season_id: period,
    rank: idx + 1,
    roi: t.roi,
    pnl: t.pnl || null,
    win_rate: t.winRate,
    max_drawdown: t.maxDrawdown || null,
    followers: t.followers || null,
    arena_score: calculateArenaScore(t.roi, t.pnl, t.maxDrawdown, t.winRate, period).totalScore,
    captured_at: capturedAt,
  }))

  const { error } = await supabase.from('trader_snapshots').upsert(snapshotsData, {
    onConflict: 'source,source_trader_id,season_id'
  })

  if (error) {
    console.log(`  ⚠ 批量 upsert 失败: ${error.message}`)
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

  const withWr = traders.filter(t => t.winRate !== null && t.winRate > 0).length
  const withMdd = traders.filter(t => t.maxDrawdown !== null).length
  console.log(`  ✓ 保存成功: ${traders.length} 条`)
  console.log(`    胜率覆盖: ${withWr}/${traders.length}`)
  console.log(`    MDD覆盖: ${withMdd}/${traders.length}`)
  return traders.length
}

async function main() {
  const periods = getTargetPeriods(['7D', '30D', '90D'])

  console.log(`\n${'='.repeat(60)}`)
  console.log(`OKX Futures 数据抓取`)
  console.log(`目标周期: ${periods.join(', ')}`)
  console.log(`${'='.repeat(60)}`)

  const results = []

  for (const period of periods) {
    const traders = await fetchLeaderboard(period)

    if (traders.length > 0) {
      console.log(`\n📋 ${period} TOP 5:`)
      traders.slice(0, 5).forEach((t, idx) => {
        const wr = t.winRate !== null ? `${t.winRate.toFixed(1)}%` : 'N/A'
        const mdd = t.maxDrawdown !== null ? `${t.maxDrawdown.toFixed(1)}%` : 'N/A'
        console.log(`  ${idx + 1}. ${t.nickname}: ROI ${t.roi.toFixed(2)}%, WR ${wr}, MDD ${mdd}`)
      })

      const saved = await saveTraders(traders, period)
      results.push({ period, count: traders.length, saved })
    } else {
      console.log(`\n⚠ ${period} 无数据`)
    }

    await sleep(2000)
  }

  console.log(`\n${'='.repeat(60)}`)
  console.log(`✅ OKX Futures 完成`)
  for (const r of results) {
    console.log(`   ${r.period}: ${r.saved} 条`)
  }
  console.log(`${'='.repeat(60)}`)
}

main().catch(console.error)
