/**
 * OKX Web3 交易员详情抓取
 * 
 * 获取每个交易员的详细数据
 * 
 * 用法: node scripts/fetch_okx_trader_details.mjs [--limit=N]
 */

import 'dotenv/config'
import { chromium } from 'playwright'
import { createClient } from '@supabase/supabase-js'
import pLimit from 'p-limit'

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Error: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set')
  process.exit(1)
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

const SOURCE = 'okx_web3'
const DEFAULT_LIMIT = 50
const CONCURRENCY = 2

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * 标准化 ROI 值
 * OKX 可能返回小数形式（如 0.25 表示 25%），需要转换为百分比
 */
function normalizeROI(value) {
  if (value === null || value === undefined) return null
  // 如果绝对值小于 10，可能是小数形式，需要乘以 100
  if (Math.abs(value) < 10 && Math.abs(value) > 0) {
    return value * 100
  }
  return value
}

/**
 * 标准化 Win Rate 值
 * 确保在 0-100 范围（百分比形式）
 */
function normalizeWinRate(value) {
  if (value === null || value === undefined) return null
  // 如果在 0-1 范围，转换为百分比
  if (value > 0 && value <= 1) {
    return value * 100
  }
  return value
}

function parseLimit() {
  const arg = process.argv.find(a => a.startsWith('--limit='))
  return arg ? parseInt(arg.split('=')[1]) : DEFAULT_LIMIT
}

/**
 * 获取所有 OKX 交易员
 */
async function getOkxTraders(limit) {
  const { data, error } = await supabase
    .from('trader_sources')
    .select('source_trader_id, handle')
    .eq('source', SOURCE)
    .eq('is_active', true)
    .order('created_at', { ascending: false })
    .limit(limit)

  if (error) {
    console.error('获取交易员列表失败:', error)
    return []
  }
  return data || []
}

/**
 * 抓取单个交易员详情
 */
async function fetchTraderDetail(context, traderId, handle) {
  const page = await context.newPage()
  const capturedAt = new Date().toISOString()
  const details = {
    stats: {},
    positions: [],
    assetBreakdown: [],
  }

  try {
    // 访问交易员详情页
    // OKX Web3 的详情页 URL 格式
    const url = `https://web3.okx.com/copy-trade/trader/${traderId}/solana`
    console.log(`  📱 访问: ${handle || traderId}`)
    
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 })
    } catch (e) {
      console.log(`    ⚠ 加载超时，继续...`)
    }
    await sleep(5000)

    // 关闭弹窗
    try {
      await page.click('text=I understand', { timeout: 2000 })
    } catch {}
    try {
      await page.click('text=Accept All Cookies', { timeout: 2000 })
    } catch {}
    await sleep(1000)

    // 从页面提取详情数据
    const pageData = await page.evaluate(() => {
      const text = document.body.innerText
      const result = {}

      // ROI - 注意：OKX 可能返回小数形式，后续会标准化
      const roiMatch = text.match(/(?:ROI|收益率)[:\s]*\+?([+-]?\d+(?:,\d+)*\.?\d*)%?/i)
      if (roiMatch) result.roi = parseFloat(roiMatch[1].replace(/,/g, ''))

      // PnL
      const pnlMatch = text.match(/(?:PnL|Profit|收益)[:\s]*\+?\$?([+-]?[\d,]+\.?\d*)([KM])?/i)
      if (pnlMatch) {
        let pnl = parseFloat(pnlMatch[1].replace(/,/g, ''))
        if (pnlMatch[2] === 'K') pnl *= 1000
        if (pnlMatch[2] === 'M') pnl *= 1000000
        result.pnl = pnl
      }

      // 胜率 - 注意：可能是 0-1 或 0-100 格式，后续会标准化
      const winRateMatch = text.match(/(?:Win Rate|胜率)[:\s]*(\d+\.?\d*)%?/i)
      if (winRateMatch) result.winRate = parseFloat(winRateMatch[1])

      // 最大回撤
      const mddMatch = text.match(/(?:Max Drawdown|MDD|Drawdown|回撤)[:\s]*([+-]?\d+\.?\d*)%/i)
      if (mddMatch) result.maxDrawdown = parseFloat(mddMatch[1])

      // 跟随者
      const followersMatch = text.match(/(?:Followers|Copiers|跟随者)[:\s]*([\d,]+)/i)
      if (followersMatch) result.followers = parseInt(followersMatch[1].replace(/,/g, ''))

      // 交易次数
      const tradesMatch = text.match(/(?:Total Trades|Trades|交易次数)[:\s]*(\d+)/i)
      if (tradesMatch) result.totalTrades = parseInt(tradesMatch[1])

      // 资产偏好
      const assetBreakdown = []
      const assetRegex = /([A-Z]{2,10})\s+(\d+\.?\d*)%/g
      let match
      while ((match = assetRegex.exec(text)) !== null) {
        const symbol = match[1]
        const pct = parseFloat(match[2])
        if (pct > 0 && pct <= 100 && symbol.length <= 10) {
          assetBreakdown.push({ symbol, percentage: pct })
        }
      }
      result.assetBreakdown = assetBreakdown.slice(0, 10)

      return result
    })

    // 标准化数据
    if (pageData.roi !== undefined) {
      pageData.roi = normalizeROI(pageData.roi)
    }
    if (pageData.winRate !== undefined) {
      pageData.winRate = normalizeWinRate(pageData.winRate)
    }

    Object.assign(details.stats, pageData)
    details.assetBreakdown = pageData.assetBreakdown || []

    // 尝试提取持仓/交易历史
    try {
      const positions = await page.evaluate(() => {
        const results = []
        const text = document.body.innerText
        
        // 匹配代币交易
        const tokenRegex = /([A-Z]{2,10})\s+(?:Buy|Sell|买入|卖出)\s+([+-]?\d+\.?\d*)%/gi
        let match
        while ((match = tokenRegex.exec(text)) !== null) {
          results.push({
            symbol: match[1].toUpperCase(),
            pnlPct: parseFloat(match[2]),
            direction: match[0].toLowerCase().includes('sell') || match[0].includes('卖') ? 'short' : 'long',
          })
        }
        
        return results.slice(0, 20)
      })

      details.positions = positions
    } catch (e) {
      // 忽略
    }

    console.log(`    ✓ ROI: ${details.stats.roi || '-'}%, PnL: $${details.stats.pnl || '-'}`)

    // 保存到数据库
    await saveTraderDetails(traderId, details, capturedAt)

  } catch (error) {
    console.log(`    ✗ 错误: ${error.message}`)
  } finally {
    await page.close()
  }

  return details
}

/**
 * 保存交易员详情
 */
async function saveTraderDetails(traderId, details, capturedAt) {
  const { stats, positions, assetBreakdown } = details

  // 1. 保存 stats_detail
  if (Object.keys(stats).length > 0) {
    await supabase.from('trader_stats_detail').delete()
      .eq('source', SOURCE)
      .eq('source_trader_id', traderId)

    const statsData = {
      source: SOURCE,
      source_trader_id: traderId,
      period: '7D', // OKX Web3 主要是 7D 数据
      sharpe_ratio: 0,
      max_drawdown: stats.maxDrawdown || 0,
      copiers_pnl: 0,
      winning_positions: 0,
      total_positions: stats.totalTrades || 0,
      captured_at: capturedAt,
    }

    await supabase.from('trader_stats_detail').insert(statsData)
  }

  // 2. 保存资产偏好
  if (assetBreakdown?.length > 0) {
    await supabase.from('trader_asset_breakdown').delete()
      .eq('source', SOURCE)
      .eq('source_trader_id', traderId)

    const assetData = assetBreakdown.map(a => ({
      source: SOURCE,
      source_trader_id: traderId,
      period: '7D',
      symbol: a.symbol,
      weight_pct: a.percentage,
      captured_at: capturedAt,
    }))

    await supabase.from('trader_asset_breakdown').insert(assetData)
  }

  // 3. 保存持仓历史
  if (positions?.length > 0) {
    for (const pos of positions) {
      await supabase.from('trader_position_history').upsert({
        source: SOURCE,
        source_trader_id: traderId,
        symbol: pos.symbol,
        direction: pos.direction,
        pnl_pct: pos.pnlPct,
        open_time: capturedAt,
        status: 'closed',
        captured_at: capturedAt,
      }, { onConflict: 'source,source_trader_id,symbol,open_time' }).catch(() => {})
    }
  }
}

async function main() {
  const limit = parseLimit()
  console.log(`\n========================================`)
  console.log(`OKX Web3 交易员详情抓取`)
  console.log(`========================================`)
  console.log(`时间: ${new Date().toISOString()}`)
  console.log(`限制: ${limit} 个交易员`)
  console.log(`并发: ${CONCURRENCY}`)

  // 获取交易员列表
  const traders = await getOkxTraders(limit)
  console.log(`\n找到 ${traders.length} 个交易员\n`)

  if (traders.length === 0) {
    console.log('没有交易员，请先运行排行榜抓取')
    return
  }

  const browser = await chromium.launch({
    headless: true,
    args: ['--disable-blink-features=AutomationControlled', '--no-sandbox'],
  })

  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
    viewport: { width: 1440, height: 900 },
    locale: 'en-US',
  })

  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined })
  })

  const startTime = Date.now()
  let success = 0, fail = 0

  try {
    const limitFn = pLimit(CONCURRENCY)
    
    const tasks = traders.map((trader, idx) => 
      limitFn(async () => {
        console.log(`[${idx + 1}/${traders.length}] --------------------------------`)
        try {
          await fetchTraderDetail(context, trader.source_trader_id, trader.handle)
          success++
        } catch (e) {
          console.log(`  ✗ ${trader.handle}: ${e.message}`)
          fail++
        }
      })
    )

    await Promise.all(tasks)

  } finally {
    await browser.close()
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)

  console.log(`\n========================================`)
  console.log(`✅ 完成！`)
  console.log(`   成功: ${success}`)
  console.log(`   失败: ${fail}`)
  console.log(`   耗时: ${elapsed}s`)
  console.log(`========================================`)
}

main().catch(console.error)
