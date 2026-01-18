/**
 * Bitget 交易员详情页数据抓取
 * 抓取每个交易员主页的完整数据
 */

import 'dotenv/config'
import puppeteer from 'puppeteer'
import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

async function main() {
  console.log('=== Bitget 交易员详情抓取 ===\n')

  // 获取已有的 Bitget 交易员
  const { data: traders } = await supabase
    .from('trader_sources')
    .select('source, source_trader_id, handle, profile_url')
    .in('source', ['bitget_futures', 'bitget_spot'])
    .limit(100)

  if (!traders || traders.length === 0) {
    console.log('没有 Bitget 交易员数据，先运行排行榜抓取')
    return
  }

  console.log(`找到 ${traders.length} 个交易员\n`)

  const browser = await puppeteer.launch({
    headless: false,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
    ],
  })

  try {
    const page = await browser.newPage()
    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36')
    
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => false })
    })

    // 先访问 Bitget 主页通过 Cloudflare
    console.log('访问 Bitget 主页...')
    await page.goto('https://www.bitget.com/zh-CN/copy-trading', { waitUntil: 'domcontentloaded' })
    await sleep(10000)

    // 抓取排行榜前几名的详情
    for (let i = 0; i < Math.min(20, traders.length); i++) {
      const trader = traders[i]
      await scrapeTraderDetail(page, trader)
      await sleep(3000)
    }

    console.log('\n✅ 完成!')

  } finally {
    await browser.close()
  }
}

async function scrapeTraderDetail(page, trader) {
  // 构建详情页 URL
  let url = trader.profile_url
  if (!url || !url.includes('bitget.com')) {
    // 尝试用 source_trader_id 构建 URL
    url = `https://www.bitget.com/zh-CN/copy-trading/trader/${trader.source_trader_id}/futures`
  }

  console.log(`\n抓取: ${trader.handle || trader.source_trader_id}`)
  console.log(`  URL: ${url}`)

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 })
    await sleep(5000)

    // 提取详情数据
    const details = await page.evaluate(() => {
      const text = document.body.innerText || ''
      const result = {}

      // 总收益 / PnL
      const pnlMatch = text.match(/总收益[:\s]*\$?([\d,]+\.?\d*)/i) || 
                       text.match(/累计收益[:\s]*\$?([\d,]+\.?\d*)/i) ||
                       text.match(/\$\s*([\d,]+\.?\d*)\s*总收益/i)
      if (pnlMatch) {
        result.pnl = parseFloat(pnlMatch[1].replace(/,/g, ''))
      }

      // ROI / 收益率
      const roiMatch = text.match(/收益率[:\s]*([+-]?\d+\.?\d*)%/i) ||
                       text.match(/ROI[:\s]*([+-]?\d+\.?\d*)%/i)
      if (roiMatch) {
        result.roi = parseFloat(roiMatch[1])
      }

      // 最大回撤
      const mddMatch = text.match(/最大回撤[:\s]*([+-]?\d+\.?\d*)%/i) ||
                       text.match(/MDD[:\s]*([+-]?\d+\.?\d*)%/i)
      if (mddMatch) {
        result.maxDrawdown = parseFloat(mddMatch[1])
      }

      // 胜率
      const winRateMatch = text.match(/胜率[:\s]*(\d+\.?\d*)%/i)
      if (winRateMatch) {
        result.winRate = parseFloat(winRateMatch[1])
      }

      // 累计跟单人数
      const followersMatch = text.match(/累计跟单人数[:\s]*([\d,]+)/i) ||
                             text.match(/跟随者[:\s]*([\d,]+)/i)
      if (followersMatch) {
        result.totalCopiers = parseInt(followersMatch[1].replace(/,/g, ''))
      }

      // 交易频率
      const freqMatch = text.match(/交易频率[:\s]*(\d+)/i)
      if (freqMatch) {
        result.tradeFrequency = parseInt(freqMatch[1])
      }

      // 平均持仓时长
      const avgHoldingMatch = text.match(/平均持仓时长[:\s]*(\d+)天?(\d+)?小时?/i)
      if (avgHoldingMatch) {
        const days = parseInt(avgHoldingMatch[1]) || 0
        const hours = parseInt(avgHoldingMatch[2]) || 0
        result.avgHoldingHours = days * 24 + hours
      }

      // 最长持仓时长
      const maxHoldingMatch = text.match(/最长持仓时长[:\s]*(\d+)天?(\d+)?小时?/i)
      if (maxHoldingMatch) {
        const days = parseInt(maxHoldingMatch[1]) || 0
        const hours = parseInt(maxHoldingMatch[2]) || 0
        result.maxHoldingHours = days * 24 + hours
      }

      // 跟单者收益
      const copierPnlMatch = text.match(/跟单者收益[:\s]*\$?([+-]?[\d,]+\.?\d*)/i)
      if (copierPnlMatch) {
        result.copierPnl = parseFloat(copierPnlMatch[1].replace(/,/g, ''))
      }

      // 总交易次数
      const tradesMatch = text.match(/(?:总交易|交易次数)[:\s]*(\d+)/i)
      if (tradesMatch) {
        result.totalTrades = parseInt(tradesMatch[1])
      }

      // 7D/30D/90D ROI
      const roi7dMatch = text.match(/7[天dD]\s*(?:收益率|ROI)?[:\s]*([+-]?\d+\.?\d*)%/i)
      const roi30dMatch = text.match(/30[天dD]\s*(?:收益率|ROI)?[:\s]*([+-]?\d+\.?\d*)%/i)
      const roi90dMatch = text.match(/90[天dD]\s*(?:收益率|ROI)?[:\s]*([+-]?\d+\.?\d*)%/i)
      
      if (roi7dMatch) result.roi_7d = parseFloat(roi7dMatch[1])
      if (roi30dMatch) result.roi_30d = parseFloat(roi30dMatch[1])
      if (roi90dMatch) result.roi_90d = parseFloat(roi90dMatch[1])

      // 品种偏好 - 提取持仓分布
      const positions = []
      const positionRegex = /([A-Z]+USDT?)\s*(\d+\.?\d*)%/gi
      let match
      while ((match = positionRegex.exec(text)) !== null) {
        positions.push({
          symbol: match[1].toUpperCase(),
          percentage: parseFloat(match[2]),
        })
      }
      if (positions.length > 0) {
        result.positions = positions
      }

      return result
    })

    console.log('  数据:', JSON.stringify(details, null, 2).substring(0, 200))

    // 更新数据库
    if (Object.keys(details).length > 0) {
      await updateTraderData(trader, details)
    }

    // 抓取历史订单
    await scrapePositionHistory(page, trader)

  } catch (error) {
    console.log(`  ❌ 错误: ${error.message}`)
  }
}

async function scrapePositionHistory(page, trader) {
  try {
    // 点击历史订单标签
    await page.evaluate(() => {
      const tabs = document.querySelectorAll('[class*="tab"], button')
      for (const tab of tabs) {
        if (tab.innerText.includes('历史') || tab.innerText.includes('History')) {
          tab.click()
          break
        }
      }
    })
    await sleep(2000)

    // 提取历史订单
    const history = await page.evaluate(() => {
      const results = []
      const rows = document.querySelectorAll('[class*="history"] tr, [class*="order"] [class*="item"]')
      
      rows.forEach(row => {
        const text = row.innerText || ''
        
        const symbolMatch = text.match(/([A-Z]+USDT?)/i)
        const pnlMatch = text.match(/([+-]?\d+\.?\d*)%/)
        const priceMatch = text.match(/\$?([\d,]+\.?\d*)/g)
        
        if (symbolMatch && pnlMatch) {
          results.push({
            symbol: symbolMatch[1].toUpperCase(),
            pnlPct: parseFloat(pnlMatch[1]),
            direction: text.toLowerCase().includes('空') || text.toLowerCase().includes('short') ? 'short' : 'long',
          })
        }
      })
      
      return results.slice(0, 20) // 只取前20条
    })

    if (history.length > 0) {
      console.log(`  历史订单: ${history.length} 条`)
      
      // 保存到数据库
      for (const order of history) {
        await supabase.from('trader_position_history').upsert({
          source: trader.source,
          source_trader_id: trader.source_trader_id,
          symbol: order.symbol,
          direction: order.direction,
          pnl_pct: order.pnlPct,
          created_at: new Date().toISOString(),
        }, { onConflict: 'source,source_trader_id,symbol,open_time' }).catch(() => {})
      }
    }

  } catch (e) {
    // 静默处理
  }
}

async function updateTraderData(trader, details) {
  try {
    // 更新 trader_snapshots
    const updateData = {}
    
    if (details.roi !== undefined) updateData.roi = details.roi
    if (details.roi_7d !== undefined) updateData.roi_7d = details.roi_7d
    if (details.roi_30d !== undefined) updateData.roi_30d = details.roi_30d
    if (details.pnl !== undefined) updateData.pnl = details.pnl
    if (details.winRate !== undefined) updateData.win_rate = details.winRate
    if (details.maxDrawdown !== undefined) updateData.max_drawdown = details.maxDrawdown
    if (details.totalTrades !== undefined) updateData.trades_count = details.totalTrades
    if (details.avgHoldingHours !== undefined) updateData.holding_days = details.avgHoldingHours / 24

    if (Object.keys(updateData).length > 0) {
      await supabase
        .from('trader_snapshots')
        .update(updateData)
        .eq('source', trader.source)
        .eq('source_trader_id', trader.source_trader_id)
        .order('captured_at', { ascending: false })
        .limit(1)
      
      console.log(`  ✅ 更新: ROI=${details.roi || '-'}%, PnL=$${details.pnl || '-'}, WinRate=${details.winRate || '-'}%`)
    }

    // 保存持仓分布
    if (details.positions && details.positions.length > 0) {
      for (const pos of details.positions) {
        await supabase.from('trader_portfolio').upsert({
          source: trader.source,
          source_trader_id: trader.source_trader_id,
          symbol: pos.symbol,
          weight_pct: pos.percentage,
          updated_at: new Date().toISOString(),
        }, { onConflict: 'source,source_trader_id,symbol' }).catch(() => {})
      }
      console.log(`  ✅ 保存 ${details.positions.length} 个持仓`)
    }

  } catch (error) {
    console.log(`  更新失败: ${error.message}`)
  }
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms))
}

main().catch(console.error)



