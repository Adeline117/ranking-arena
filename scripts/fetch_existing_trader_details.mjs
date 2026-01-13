/**
 * 抓取已有交易员的详情页数据
 * 从 Bitget/Binance 交易员主页获取完整数据
 */

import 'dotenv/config'
import puppeteer from 'puppeteer'
import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

async function main() {
  console.log('=== 抓取交易员详情数据 ===\n')

  // 获取所有交易员（已有 ROI 数据的）
  const { data: snapshots } = await supabase
    .from('trader_snapshots')
    .select('source, source_trader_id, roi')
    .in('source', ['binance', 'bitget'])
    .not('roi', 'is', null)
    .order('roi', { ascending: false })
    .limit(50)

  const uniqueTraders = new Map()
  snapshots?.forEach(s => {
    const key = `${s.source}_${s.source_trader_id}`
    if (!uniqueTraders.has(key)) {
      uniqueTraders.set(key, { source: s.source, source_trader_id: s.source_trader_id, roi: s.roi })
    }
  })

  console.log(`找到 ${uniqueTraders.size} 个交易员\n`)

  const browser = await puppeteer.launch({
    headless: false,
    args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
  })

  try {
    const page = await browser.newPage()
    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36')
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => false })
    })

    let count = 0
    for (const [key, trader] of uniqueTraders) {
      if (count >= 20) break // 只抓取前20个
      
      let url
      if (trader.source === 'binance') {
        url = `https://www.binance.com/en/copy-trading/lead-details?portfolioId=${trader.source_trader_id}`
      } else if (trader.source === 'bitget') {
        url = `https://www.bitget.com/zh-CN/copy-trading/trader/${trader.source_trader_id}/futures`
      } else {
        continue
      }

      console.log(`\n[${count + 1}] ${trader.source}: ${trader.source_trader_id}`)
      console.log(`    URL: ${url}`)
      
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 })
        await sleep(8000)

        const details = await page.evaluate((source) => {
          const text = document.body.innerText || ''
          const result = {}

          if (source === 'binance') {
            // Binance 数据提取
            // ROI
            const roi7dMatch = text.match(/7[Dd]\s*ROI[:\s]*([+-]?\d+\.?\d*)%/i)
            const roi30dMatch = text.match(/30[Dd]\s*ROI[:\s]*([+-]?\d+\.?\d*)%/i)
            const roi90dMatch = text.match(/90[Dd]\s*ROI[:\s]*([+-]?\d+\.?\d*)%/i)
            if (roi7dMatch) result.roi_7d = parseFloat(roi7dMatch[1])
            if (roi30dMatch) result.roi_30d = parseFloat(roi30dMatch[1])
            if (roi90dMatch) result.roi = parseFloat(roi90dMatch[1])

            // PnL
            const pnlMatch = text.match(/PnL[:\s]*\$?([\d,]+\.?\d*)/i)
            if (pnlMatch) result.pnl = parseFloat(pnlMatch[1].replace(/,/g, ''))

            // 胜率
            const winRateMatch = text.match(/Win\s*Rate[:\s]*(\d+\.?\d*)%/i)
            if (winRateMatch) result.winRate = parseFloat(winRateMatch[1])

            // 最大回撤
            const mddMatch = text.match(/(?:MDD|Max\s*Drawdown)[:\s]*([+-]?\d+\.?\d*)%/i)
            if (mddMatch) result.maxDrawdown = parseFloat(mddMatch[1])

            // 总交易数
            const tradesMatch = text.match(/(?:Total\s*Trades|Trades)[:\s]*(\d+)/i)
            if (tradesMatch) result.totalTrades = parseInt(tradesMatch[1])

          } else if (source === 'bitget') {
            // Bitget 数据提取
            // 总收益
            const pnlMatch = text.match(/总收益[:\s]*\$?([\d,]+\.?\d*)/i) ||
                            text.match(/\$([\d,]+\.?\d*)\s*总收益/i)
            if (pnlMatch) result.pnl = parseFloat(pnlMatch[1].replace(/,/g, ''))

            // 最大回撤
            const mddMatch = text.match(/最大回撤[:\s]*(\d+\.?\d*)%/i)
            if (mddMatch) result.maxDrawdown = parseFloat(mddMatch[1])

            // 胜率
            const winRateMatch = text.match(/胜率[:\s]*(\d+\.?\d*)%/i)
            if (winRateMatch) result.winRate = parseFloat(winRateMatch[1])

            // 累计跟单人数
            const copiersMatch = text.match(/累计跟单人数[:\s]*([\d,]+)/i)
            if (copiersMatch) result.totalCopiers = parseInt(copiersMatch[1].replace(/,/g, ''))

            // 交易频率
            const freqMatch = text.match(/交易频率[:\s]*(\d+)/i)
            if (freqMatch) result.tradeFrequency = parseInt(freqMatch[1])

            // 平均持仓时长
            const avgHoldMatch = text.match(/平均持仓时长[:\s]*(\d+)[天dD]?(\d+)?[小时hH]?/i)
            if (avgHoldMatch) {
              result.avgHoldingHours = (parseInt(avgHoldMatch[1]) || 0) * 24 + (parseInt(avgHoldMatch[2]) || 0)
            }

            // 跟单者收益
            const copierPnlMatch = text.match(/跟单者收益[:\s]*\$?([+-]?[\d,]+\.?\d*)/i)
            if (copierPnlMatch) result.copierPnl = parseFloat(copierPnlMatch[1].replace(/,/g, ''))

            // 7D/30D/90D ROI
            const roi7dMatch = text.match(/7[天dD][:\s]*([+-]?\d+\.?\d*)%/i)
            const roi30dMatch = text.match(/30[天dD][:\s]*([+-]?\d+\.?\d*)%/i)
            const roi90dMatch = text.match(/90[天dD][:\s]*([+-]?\d+\.?\d*)%/i)
            if (roi7dMatch) result.roi_7d = parseFloat(roi7dMatch[1])
            if (roi30dMatch) result.roi_30d = parseFloat(roi30dMatch[1])
            if (roi90dMatch) result.roi = parseFloat(roi90dMatch[1])
          }

          // 提取持仓分布
          const positions = []
          const posRegex = /([A-Z]+USDT?)\s*(\d+\.?\d*)%/gi
          let m
          while ((m = posRegex.exec(text)) !== null) {
            positions.push({ symbol: m[1], pct: parseFloat(m[2]) })
          }
          if (positions.length > 0) result.positions = positions

          return result
        }, trader.source)

        console.log(`    数据: PnL=$${details.pnl || 'N/A'}, MDD=${details.maxDrawdown || 'N/A'}%, WR=${details.winRate || 'N/A'}%`)

        // 更新数据库
        if (Object.keys(details).length > 0) {
          await updateTraderData(trader, details)
        }

        count++

      } catch (error) {
        console.log(`    ❌ 错误: ${error.message}`)
      }

      await sleep(3000)
    }

    console.log(`\n✅ 完成！更新了 ${count} 个交易员`)

  } finally {
    await browser.close()
  }
}

async function updateTraderData(trader, details) {
  try {
    const updateData = {}
    
    if (details.pnl !== undefined) updateData.pnl = details.pnl
    if (details.roi_7d !== undefined) updateData.roi_7d = details.roi_7d
    if (details.roi_30d !== undefined) updateData.roi_30d = details.roi_30d
    if (details.roi !== undefined) updateData.roi = details.roi
    if (details.winRate !== undefined) updateData.win_rate = details.winRate
    if (details.maxDrawdown !== undefined) updateData.max_drawdown = details.maxDrawdown
    if (details.totalTrades !== undefined) updateData.trades_count = details.totalTrades
    if (details.totalCopiers !== undefined) updateData.total_copiers = details.totalCopiers
    if (details.avgHoldingHours !== undefined) updateData.holding_days = details.avgHoldingHours / 24
    if (details.copierPnl !== undefined) updateData.copier_pnl = details.copierPnl

    if (Object.keys(updateData).length > 0) {
      // 更新最新的快照记录
      const { error } = await supabase
        .from('trader_snapshots')
        .update(updateData)
        .eq('source', trader.source)
        .eq('source_trader_id', trader.source_trader_id)
        .order('captured_at', { ascending: false })
        .limit(1)

      if (!error) {
        console.log(`    ✅ 已更新快照`)
      }
    }

    // 保存持仓分布
    if (details.positions && details.positions.length > 0) {
      for (const pos of details.positions) {
        await supabase.from('trader_portfolio').upsert({
          source: trader.source,
          source_trader_id: trader.source_trader_id,
          symbol: pos.symbol,
          weight_pct: pos.pct,
          updated_at: new Date().toISOString(),
        }, { onConflict: 'source,source_trader_id,symbol' }).catch(() => {})
      }
      console.log(`    ✅ 保存 ${details.positions.length} 个持仓`)
    }

  } catch (error) {
    console.log(`    更新失败: ${error.message}`)
  }
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms))
}

main().catch(console.error)

