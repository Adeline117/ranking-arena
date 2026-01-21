/**
 * Bitget Spot Copy Trading 排行榜数据抓取
 * 
 * 通过拦截 API 请求，获取 ROI 排序的数据
 * 
 * 用法: node scripts/import_bitget_spot.mjs [7D|30D|90D]
 * 
 * 数据源: https://www.bitget.com/zh-CN/copy-trading/leaderboard-ranking/spot-roi/1
 * API: https://www.bitget.com/v1/trace/spot/public/traderRankingList
 */

import 'dotenv/config'
import { chromium } from 'playwright'
import { createClient } from '@supabase/supabase-js'
import { validateTraderData, deduplicateTraders, printValidationResult } from './lib/data-validation.mjs'

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Error: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set')
  process.exit(1)
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

const SOURCE = 'bitget_spot'

// 时间段配置（Bitget 使用天数）
const PERIOD_CONFIG = {
  '7D': { days: '7', url: 'https://www.bitget.com/zh-CN/copy-trading/leaderboard-ranking/spot-roi/1?dateType=7' },
  '30D': { days: '30', url: 'https://www.bitget.com/zh-CN/copy-trading/leaderboard-ranking/spot-roi/1?dateType=30' },
  '90D': { days: '90', url: 'https://www.bitget.com/zh-CN/copy-trading/leaderboard-ranking/spot-roi/1?dateType=90' },
}

const TARGET_COUNT = 100
const PER_PAGE = 20

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function getTargetPeriods() {
  const arg = process.argv[2]?.toUpperCase()
  if (arg === 'ALL') return ['7D', '30D', '90D']
  if (arg && ['7D', '30D', '90D'].includes(arg)) return [arg]
  return ['7D', '30D', '90D'] // 默认抓取所有时间段
}

function parseTraderFromApi(item, rank) {
  const traderId = String(item.traderId || item.traderUid || '')
  if (!traderId) return null

  // Bitget API 返回的 ROI 是字符串形式的百分比值，如 "7583.61" 表示 7583.61%
  const roi = parseFloat(item.roi ?? 0)

  return {
    traderId,
    nickname: item.nickName || item.displayName || item.userName || null,
    avatar: item.headPic || null,
    roi,
    pnl: parseFloat(item.totalPnl ?? 0),
    winRate: null,  // Bitget Spot API 不返回 winRate
    maxDrawdown: null,
    followers: parseInt(item.followCount ?? 0),
    aum: parseFloat(item.aum ?? 0),
    rank: item.rankingNo || rank,
  }
}

async function fetchLeaderboardData(period) {
  const config = PERIOD_CONFIG[period]
  console.log(`\n=== 抓取 Bitget Spot ${period} 排行榜 ===`)
  console.log('时间:', new Date().toISOString())
  console.log('URL:', config.url)
  console.log(`目标: ${TARGET_COUNT} 个交易员`)

  const traders = new Map()

  const browser = await chromium.launch({
    headless: true,
    args: ['--disable-blink-features=AutomationControlled', '--disable-dev-shm-usage', '--no-sandbox'],
  })

  try {
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      viewport: { width: 1920, height: 1080 },
      locale: 'zh-CN',
    })

    await context.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined })
      window.chrome = { runtime: {} }
    })

    const page = await context.newPage()

    // 监听 API 响应
    page.on('response', async (response) => {
      const url = response.url()
      if (url.includes('traderRankingList')) {
        try {
          const json = await response.json()
          const rows = json.data?.rows || []
          if (rows.length > 0) {
            console.log(`  ✓ 收到 ${rows.length} 条数据`)
            
            rows.forEach((item, idx) => {
              const trader = parseTraderFromApi(item, traders.size + idx + 1)
              if (trader && trader.traderId && !traders.has(trader.traderId)) {
                traders.set(trader.traderId, trader)
                if (traders.size <= 3) {
                  console.log(`    #${trader.rank}: ROI ${trader.roi.toFixed(2)}%, 昵称: ${trader.nickname || '未知'}`)
                }
              }
            })
          }
        } catch (e) {
          console.log(`  ⚠ 解析响应失败: ${e.message}`)
        }
      }
    })

    console.log('\n📱 访问页面...')
    try {
      await page.goto(config.url, { waitUntil: 'networkidle', timeout: 60000 })
    } catch (e) {
      console.log('  ⚠ 页面加载超时，继续尝试...')
    }
    await sleep(5000)
    
    console.log(`\n📄 当前已获取: ${traders.size} 个交易员`)

    // 分页获取更多数据（滚动加载）
    let lastCount = 0
    let scrollAttempts = 0
    const maxScrollAttempts = 10
    
    while (traders.size < TARGET_COUNT && scrollAttempts < maxScrollAttempts) {
      lastCount = traders.size
      
      // 滚动到底部
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
      await sleep(2000)
      
      // 检查是否有新数据
      if (traders.size === lastCount) {
        scrollAttempts++
        console.log(`  滚动尝试 ${scrollAttempts}/${maxScrollAttempts}，无新数据`)
      } else {
        scrollAttempts = 0
        console.log(`  当前已获取: ${traders.size} 个交易员`)
      }
    }

    console.log(`\n📊 共获取 ${traders.size} 个交易员数据`)

    const screenshotPath = `/tmp/bitget_spot_${period}_${Date.now()}.png`
    await page.screenshot({ path: screenshotPath, fullPage: true })
    console.log(`📸 截图保存到: ${screenshotPath}`)

  } finally {
    await browser.close()
  }

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
        profile_url: trader.avatar,
        is_active: true,
      }, { onConflict: 'source,source_trader_id' })

      const { error } = await supabase.from('trader_snapshots').insert({
        source: SOURCE,
        source_trader_id: trader.traderId,
        season_id: period,
        rank: trader.rank,
        roi: trader.roi,
        pnl: trader.pnl,
        win_rate: trader.winRate,
        max_drawdown: trader.maxDrawdown,
        followers: trader.followers || 0,
        captured_at: capturedAt,
      })

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
  console.log(`Bitget Spot Copy Trading 数据抓取`)
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

      const topTraders = uniqueTraders.slice(0, TARGET_COUNT)

      console.log(`\n📋 ${period} TOP 10 (按 ROI 排序):`)
      topTraders.slice(0, 10).forEach((t, idx) => {
        console.log(`  ${idx + 1}. ${t.nickname || t.traderId}: ROI ${t.roi?.toFixed(2)}%`)
      })

      const validation = validateTraderData(topTraders, {}, SOURCE)
      printValidationResult(validation, SOURCE)

      const result = await saveTraders(topTraders, period)
      results.push({ period, count: topTraders.length, saved: result.saved, topRoi: validation.stats.topRoi })
      
      console.log(`\n✅ ${period} 完成！保存了 ${result.saved} 条数据`)
      
      if (periods.indexOf(period) < periods.length - 1) {
        console.log(`\n⏳ 等待 5 秒后抓取下一个时间段...`)
        await sleep(5000)
      }
    }
    
    const totalTime = ((Date.now() - totalStartTime) / 1000).toFixed(1)

    console.log(`\n${'='.repeat(60)}`)
    console.log(`✅ 全部完成！`)
    console.log(`${'='.repeat(60)}`)
    console.log(`📊 抓取结果:`)
    for (const r of results) {
      console.log(`   ${r.period}: ${r.saved} 条, TOP ROI ${r.topRoi?.toFixed(2)}%`)
    }
    console.log(`   总耗时: ${totalTime}s`)
    console.log(`${'='.repeat(60)}`)
  } catch (error) {
    console.error('\n❌ 执行失败:', error.message)
    console.error(error.stack)
    process.exit(1)
  }
}

main()
