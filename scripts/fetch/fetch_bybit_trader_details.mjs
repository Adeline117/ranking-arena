/**
 * Bybit 交易员详情抓取
 * 
 * 获取每个交易员的：
 * - 详细统计（收益曲线、资产偏好等）
 * - 持仓历史
 * 
 * 用法: node scripts/fetch_bybit_trader_details.mjs [--limit=N]
 */

import 'dotenv/config'
import puppeteer from 'puppeteer-extra'
import StealthPlugin from 'puppeteer-extra-plugin-stealth'
import { createClient } from '@supabase/supabase-js'
import pLimit from 'p-limit'

puppeteer.use(StealthPlugin())

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Error: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set')
  process.exit(1)
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

const SOURCE = 'bybit'
const DEFAULT_LIMIT = 50
const CONCURRENCY = 3
const TIME_RANGES = ['7D', '30D', '90D']

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
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
 * 获取所有 Bybit 交易员
 */
async function getBybitTraders(limit) {
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
async function fetchTraderDetail(browser, traderId, handle) {
  const page = await browser.newPage()
  const capturedAt = new Date().toISOString()
  const details = {
    stats: {},
    positions: [],
    assetBreakdown: [],
  }

  try {
    await page.setViewport({ width: 1440, height: 900 })
    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36')

    // 访问交易员详情页
    const url = `https://www.bybit.com/copyTrade/trade-center/detail?leaderMark=${traderId}`
    console.log(`  📱 访问: ${handle || traderId}`)
    
    try {
      await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 })
    } catch (e) {
      console.log(`    ⚠ 加载超时，继续...`)
    }
    await sleep(5000)

    // 关闭弹窗
    await page.evaluate(() => {
      document.querySelectorAll('button, [class*="close"]').forEach(el => {
        const text = (el.textContent || '').toLowerCase()
        if (text.includes('ok') || text.includes('got it') || text.includes('confirm') || text.includes('close')) {
          try { el.click() } catch {}
        }
      })
    })
    await sleep(1000)

    // 从页面提取详情数据
    const pageData = await page.evaluate(() => {
      const text = document.body.innerText
      const result = {}

      // 匹配各种数据模式
      // ROI
      const roiMatch = text.match(/(?:ROI|收益率)[:\s]*([+-]?\d+(?:,\d+)*\.?\d*)%/i)
      if (roiMatch) result.roi = parseFloat(roiMatch[1].replace(/,/g, ''))

      // PnL
      const pnlMatch = text.match(/(?:PnL|收益|Profit)[:\s]*\$?([+-]?[\d,]+\.?\d*)/i)
      if (pnlMatch) result.pnl = parseFloat(pnlMatch[1].replace(/,/g, ''))

      // 胜率
      const winRateMatch = text.match(/(?:Win Rate|胜率)[:\s]*(\d+\.?\d*)%/i)
      if (winRateMatch) result.winRate = parseFloat(winRateMatch[1])

      // 最大回撤
      const mddMatch = text.match(/(?:Max Drawdown|MDD|最大回撤)[:\s]*([+-]?\d+\.?\d*)%/i)
      if (mddMatch) result.maxDrawdown = parseFloat(mddMatch[1])

      // 跟随者
      const followersMatch = text.match(/(?:Followers|Copiers|跟随者)[:\s]*([\d,]+)/i)
      if (followersMatch) result.followers = parseInt(followersMatch[1].replace(/,/g, ''))

      // 交易次数
      const tradesMatch = text.match(/(?:Total Trades|交易次数)[:\s]*(\d+)/i)
      if (tradesMatch) result.totalTrades = parseInt(tradesMatch[1])

      // 平均持仓时长
      const holdingMatch = text.match(/(?:Avg Holding|平均持仓)[:\s]*(\d+)(?:D|天|days?)?/i)
      if (holdingMatch) result.avgHoldingDays = parseInt(holdingMatch[1])

      // Sharpe Ratio
      const sharpeMatch = text.match(/(?:Sharpe Ratio|夏普比率)[:\s]*([+-]?\d+\.?\d*)/i)
      if (sharpeMatch) result.sharpeRatio = parseFloat(sharpeMatch[1])

      // 跟单者收益
      const copierPnlMatch = text.match(/(?:Copier(?:s)? PnL|跟单者收益)[:\s]*\$?([+-]?[\d,]+\.?\d*)/i)
      if (copierPnlMatch) result.copierPnl = parseFloat(copierPnlMatch[1].replace(/,/g, ''))

      // AUM
      const aumMatch = text.match(/(?:AUM|管理资产)[:\s]*\$?([\d,]+\.?\d*)([KM])?/i)
      if (aumMatch) {
        let aum = parseFloat(aumMatch[1].replace(/,/g, ''))
        if (aumMatch[2] === 'K') aum *= 1000
        if (aumMatch[2] === 'M') aum *= 1000000
        result.aum = aum
      }

      // 资产偏好
      const assetBreakdown = []
      const assetRegex = /([A-Z]+(?:USDT?)?)\s+(\d+\.?\d*)%/g
      let match
      while ((match = assetRegex.exec(text)) !== null) {
        const symbol = match[1]
        const pct = parseFloat(match[2])
        if (pct > 0 && pct <= 100 && !assetBreakdown.find(a => a.symbol === symbol)) {
          assetBreakdown.push({ symbol, percentage: pct })
        }
      }
      result.assetBreakdown = assetBreakdown.slice(0, 10)

      return result
    })

    // 标准化 Win Rate
    if (pageData.winRate !== undefined) {
      pageData.winRate = normalizeWinRate(pageData.winRate)
    }

    Object.assign(details.stats, pageData)
    details.assetBreakdown = pageData.assetBreakdown || []

    // 尝试提取持仓历史
    try {
      // 点击历史 Tab
      await page.evaluate(() => {
        const tabs = document.querySelectorAll('button, [role="tab"], [class*="tab"]')
        for (const tab of tabs) {
          const text = (tab.textContent || '').toLowerCase()
          if (text.includes('history') || text.includes('历史') || text.includes('position')) {
            tab.click()
            return true
          }
        }
        return false
      })
      await sleep(3000)

      const positions = await page.evaluate(() => {
        const results = []
        const rows = document.querySelectorAll('tr, [class*="row"], [class*="item"]')
        
        rows.forEach(row => {
          const text = row.innerText || ''
          const symbolMatch = text.match(/([A-Z]+(?:USDT|PERP))/i)
          const pnlMatch = text.match(/([+-]?\d+\.?\d*)%/)
          
          if (symbolMatch && pnlMatch) {
            const direction = text.toLowerCase().includes('short') || text.toLowerCase().includes('空') ? 'short' : 'long'
            results.push({
              symbol: symbolMatch[1].toUpperCase(),
              pnlPct: parseFloat(pnlMatch[1]),
              direction,
            })
          }
        })
        
        return results.slice(0, 20)
      })

      details.positions = positions
    } catch (e) {
      // 忽略持仓历史提取失败
    }

    console.log(`    ✓ ROI: ${details.stats.roi || '-'}%, WinRate: ${details.stats.winRate || '-'}%`)

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
    for (const period of TIME_RANGES) {
      await supabase.from('trader_stats_detail').delete()
        .eq('source', SOURCE)
        .eq('source_trader_id', traderId)
        .eq('period', period)

      const statsData = {
        source: SOURCE,
        source_trader_id: traderId,
        period,
        sharpe_ratio: stats.sharpeRatio || 0,
        max_drawdown: stats.maxDrawdown || 0,
        copiers_pnl: stats.copierPnl || 0,
        winning_positions: 0,
        total_positions: stats.totalTrades || 0,
        captured_at: capturedAt,
      }

      await supabase.from('trader_stats_detail').insert(statsData)
    }
  }

  // 2. 保存资产偏好
  if (assetBreakdown?.length > 0) {
    await supabase.from('trader_asset_breakdown').delete()
      .eq('source', SOURCE)
      .eq('source_trader_id', traderId)

    const assetData = assetBreakdown.map(a => ({
      source: SOURCE,
      source_trader_id: traderId,
      period: '90D',
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
  console.log(`Bybit 交易员详情抓取`)
  console.log(`========================================`)
  console.log(`时间: ${new Date().toISOString()}`)
  console.log(`限制: ${limit} 个交易员`)
  console.log(`并发: ${CONCURRENCY}`)

  // 获取交易员列表
  const traders = await getBybitTraders(limit)
  console.log(`\n找到 ${traders.length} 个交易员\n`)

  if (traders.length === 0) {
    console.log('没有交易员，请先运行排行榜抓取')
    return
  }

  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled'],
  })

  const startTime = Date.now()
  let success = 0, fail = 0

  try {
    // 使用并发控制
    const limitFn = pLimit(CONCURRENCY)
    
    const tasks = traders.map((trader, idx) => 
      limitFn(async () => {
        console.log(`[${idx + 1}/${traders.length}] --------------------------------`)
        try {
          await fetchTraderDetail(browser, trader.source_trader_id, trader.handle)
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
