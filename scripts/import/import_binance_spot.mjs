/**
 * Binance Spot Copy Trading 排行榜数据抓取
 * 
 * 直接调用 API 获取 ROI 排序的数据（不需要 Playwright）
 * 
 * 用法: node scripts/import/import_binance_spot.mjs [7D|30D|90D]
 * 
 * 数据源: https://www.binance.com/copy-trading/spot
 * API: https://www.binance.com/bapi/futures/v1/friendly/future/spot-copy-trade/common/home-page-list
 */

import { validateTraderData, deduplicateTraders, printValidationResult } from './lib/data-validation.mjs'
import {
  getSupabaseClient,
  calculateArenaScore,
  sleep,
  getTargetPeriods,
} from '../lib/shared.mjs'

const supabase = getSupabaseClient()

const SOURCE = 'binance_spot'
const API_URL = 'https://www.binance.com/bapi/futures/v1/friendly/future/spot-copy-trade/common/home-page-list'

const TARGET_COUNT = 2000
const PER_PAGE = 100
const MAX_PAGES = 25  // 2500 traders max

function parseTraderFromApi(item, rank) {
  const traderId = String(item.leadPortfolioId || item.portfolioId || item.encryptedUid || '')
  if (!traderId) return null

  const roi = parseFloat(item.roi ?? 0)

  let winRate = parseFloat(item.winRate ?? 0)
  if (winRate > 1) {
    winRate = winRate / 100
  }

  return {
    traderId,
    nickname: item.nickname || item.nickName || item.displayName || null,
    avatar: item.avatarUrl || item.userPhoto || item.avatar || null,
    roi,
    pnl: parseFloat(item.pnl ?? item.profit ?? 0),
    winRate,
    maxDrawdown: parseFloat(item.mdd ?? item.maxDrawdown ?? 0),
    followers: parseInt(item.currentCopyCount ?? item.copierCount ?? item.followerCount ?? 0),
    aum: parseFloat(item.aum ?? item.totalAsset ?? 0),
    rank,
  }
}

async function fetchLeaderboardData(period) {
  console.log(`\n=== 抓取 Binance Spot ${period} 排行榜 ===`)
  console.log('时间:', new Date().toISOString())
  console.log(`目标: ${TARGET_COUNT} 个交易员，最多翻 ${MAX_PAGES} 页`)

  const traders = new Map()

  for (let page = 1; page <= MAX_PAGES; page++) {
    const body = {
      pageNumber: page,
      pageSize: PER_PAGE,
      timeRange: period,
      dataType: 'ROI',
      order: 'DESC',
    }

    console.log(`  📡 请求第 ${page} 页...`)

    try {
      const res = await fetch(API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept-Encoding': 'identity',
        },
        body: JSON.stringify(body),
      })

      const json = await res.json()

      if (json.code !== '000000' || !json.data) {
        console.log(`  ⚠ API 错误: ${json.message || json.code}`)
        break
      }

      const list = json.data.list || []
      const total = json.data.total || 0

      if (list.length === 0) {
        console.log(`  ℹ 第 ${page} 页无数据，停止`)
        break
      }

      for (let i = 0; i < list.length; i++) {
        const rank = (page - 1) * PER_PAGE + i + 1
        const trader = parseTraderFromApi(list[i], rank)
        if (trader && trader.traderId && !traders.has(trader.traderId)) {
          traders.set(trader.traderId, trader)
        }
      }

      console.log(`  ✓ 收到 ${list.length} 条，累计 ${traders.size}/${total}`)

      if (traders.size >= TARGET_COUNT || traders.size >= total) {
        break
      }

      // Rate limit: small delay between pages
      await sleep(500)
    } catch (e) {
      console.log(`  ✗ 请求失败: ${e.message}`)
      break
    }
  }

  console.log(`\n📊 共获取 ${traders.size} 个交易员数据`)
  return Array.from(traders.values())
}

async function saveTraders(traders, period) {
  console.log(`\n💾 保存 ${traders.length} 个交易员到数据库 (${SOURCE} - ${period})...`)
  
  const capturedAt = new Date().toISOString()
  let saved = 0
  let errors = 0

  for (const trader of traders) {
    try {
      await supabase.from('trader_sources').upsert({
        source: SOURCE,
        source_type: 'leaderboard',
        source_trader_id: trader.traderId,
        handle: trader.nickname,
        avatar_url: trader.avatar || null,
        is_active: true,
      }, { onConflict: 'source,source_trader_id' })

      const normalizedWr = trader.winRate !== null ? (trader.winRate <= 1 ? trader.winRate * 100 : trader.winRate) : null
      const { error } = await supabase.from('trader_snapshots').upsert({
        source: SOURCE,
        source_trader_id: trader.traderId,
        season_id: period,
        rank: trader.rank,
        roi: trader.roi,
        pnl: trader.pnl,
        win_rate: normalizedWr,
        max_drawdown: trader.maxDrawdown,
        aum: trader.aum || null,
        followers: trader.followers || 0,
        arena_score: calculateArenaScore(trader.roi, trader.pnl, trader.maxDrawdown, normalizedWr, period).totalScore,
        captured_at: capturedAt,
      }, { onConflict: 'source,source_trader_id,season_id' })

      if (error) {
        console.log(`    ✗ 保存失败 ${trader.traderId}: ${error.message}`)
        errors++
      } else {
        saved++
      }
    } catch (error) {
      console.log(`    ✗ 异常 ${trader.traderId}: ${error.message}`)
      errors++
    }
  }

  console.log(`  ✓ 保存成功: ${saved}`)
  if (errors > 0) console.log(`  ✗ 保存失败: ${errors}`)

  return { saved, errors }
}

async function main() {
  const periods = getTargetPeriods()
  const totalStartTime = Date.now()
  
  console.log(`\n========================================`)
  console.log(`Binance Spot Copy Trading 数据抓取`)
  console.log(`目标周期: ${periods.join(', ')}`)
  console.log(`数据源: ${SOURCE}`)
  console.log(`目标数量: ${TARGET_COUNT} 个交易员/周期`)
  console.log(`========================================`)

  const results = []

  try {
    for (const period of periods) {
      console.log(`\n${'='.repeat(50)}`)
      console.log(`📊 开始抓取 ${period} 排行榜...`)
      console.log(`${'='.repeat(50)}`)
      
      const traders = await fetchLeaderboardData(period)

      if (traders.length === 0) {
        console.log(`\n⚠ ${period} 未获取到任何数据，跳过`)
        continue
      }

      const uniqueTraders = deduplicateTraders(traders)
      uniqueTraders.sort((a, b) => (b.roi || 0) - (a.roi || 0))
      uniqueTraders.forEach((t, idx) => t.rank = idx + 1)

      const top100 = uniqueTraders.slice(0, TARGET_COUNT)

      console.log(`\n📋 ${period} TOP 10 (按 ROI 排序):`)
      top100.slice(0, 10).forEach((t, idx) => {
        console.log(`  ${idx + 1}. ${t.nickname || t.traderId}: ROI ${t.roi?.toFixed(2)}%`)
      })

      const validation = validateTraderData(top100, {}, SOURCE)
      const isValid = printValidationResult(validation, SOURCE)

      if (!isValid) {
        console.log(`\n⚠ ${period} 数据质量验证失败，跳过保存`)
        continue
      }

      const result = await saveTraders(top100, period)
      results.push({ period, count: top100.length, saved: result.saved, topRoi: validation.stats.topRoi })
      
      console.log(`\n✅ ${period} 完成！保存了 ${result.saved} 条数据`)
      
      if (periods.indexOf(period) < periods.length - 1) {
        console.log(`\n⏳ 等待 3 秒后抓取下一个时间段...`)
        await sleep(3000)
      }
    }
    
    const totalElapsed = ((Date.now() - totalStartTime) / 1000).toFixed(1)

    console.log(`\n${'='.repeat(60)}`)
    console.log(`✅ 全部完成！`)
    console.log(`${'='.repeat(60)}`)
    console.log(`📊 抓取结果:`)
    for (const r of results) {
      console.log(`   ${r.period}: ${r.saved} 条, TOP ROI ${r.topRoi?.toFixed(2)}%`)
    }
    console.log(`   总耗时: ${totalElapsed}s`)
    console.log(`   时间: ${new Date().toISOString()}`)
    console.log(`${'='.repeat(60)}`)
  } catch (error) {
    console.error('\n❌ 执行失败:', error.message)
    console.error(error.stack)
    process.exit(1)
  }
}

main()
