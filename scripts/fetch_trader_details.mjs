/**
 * 抓取交易员详细数据
 * 从 Binance/Bitget 交易员主页获取:
 * - 7D/30D/90D ROI
 * - Portfolio breakdown (持仓分布)
 * - Position history (历史订单)
 */

import 'dotenv/config'
import puppeteer from 'puppeteer'
import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

// Binance 交易员详情 API
const BINANCE_DETAIL_API = 'https://www.binance.com/bapi/futures/v1/friendly/future/copy-trade/lead-portfolio/detail'
const BINANCE_POSITION_API = 'https://www.binance.com/bapi/futures/v1/friendly/future/copy-trade/lead-portfolio/positions'

async function main() {
  console.log('=== 抓取交易员详细数据 ===\n')

  // 获取需要更新的交易员
  const { data: traders } = await supabase
    .from('trader_sources')
    .select('source, source_trader_id, handle')
    .in('source', ['binance', 'bitget'])
    .limit(100)

  if (!traders || traders.length === 0) {
    console.log('没有交易员数据')
    return
  }

  console.log(`找到 ${traders.length} 个交易员\n`)

  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  })

  try {
    const page = await browser.newPage()
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36')

    // 访问币安页面获取 cookies
    await page.goto('https://www.binance.com/en/copy-trading', { waitUntil: 'networkidle2', timeout: 60000 })
    await new Promise(r => setTimeout(r, 3000))

    for (const trader of traders) {
      if (trader.source === 'binance') {
        await fetchBinanceTraderDetails(page, trader)
      }
      // 延迟避免请求过快
      await new Promise(r => setTimeout(r, 1000))
    }
  } finally {
    await browser.close()
  }

  console.log('\n✅ 完成!')
}

async function fetchBinanceTraderDetails(page, trader) {
  const { source_trader_id, handle } = trader
  console.log(`\n处理: ${handle || source_trader_id}`)

  try {
    // 获取详细数据
    const detailData = await page.evaluate(async (url, portfolioId) => {
      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ portfolioId }),
        })
        return await response.json()
      } catch (e) {
        return { error: e.message }
      }
    }, BINANCE_DETAIL_API, source_trader_id)

    if (detailData.code === '000000' && detailData.data) {
      const d = detailData.data
      
      // 提取多时间段 ROI
      const roi7d = d.roi7d ?? d.roi_7d
      const roi30d = d.roi30d ?? d.roi_30d
      const roi90d = d.roi90d ?? d.roi_90d ?? d.roi
      
      console.log(`  ROI: 7D=${roi7d}%, 30D=${roi30d}%, 90D=${roi90d}%`)
      
      // 更新到数据库
      const updateData = {
        roi_7d: roi7d != null ? Number(roi7d) : null,
        roi_30d: roi30d != null ? Number(roi30d) : null,
      }
      
      // 更新最新的快照记录
      const { error } = await supabase
        .from('trader_snapshots')
        .update(updateData)
        .eq('source', 'binance')
        .eq('source_trader_id', source_trader_id)
        .order('captured_at', { ascending: false })
        .limit(1)
      
      if (error) {
        console.log(`  ❌ 更新失败: ${error.message}`)
      } else {
        console.log(`  ✅ ROI 数据已更新`)
      }

      // 提取 Portfolio breakdown
      if (d.positions || d.portfolio || d.assets) {
        const positions = d.positions || d.portfolio || d.assets || []
        console.log(`  Portfolio: ${positions.length} 个持仓`)
        
        // 保存 portfolio 数据
        for (const pos of positions) {
          await supabase.from('trader_portfolio').upsert({
            source: 'binance',
            source_trader_id,
            symbol: pos.symbol || pos.asset,
            weight_pct: pos.weightPct || pos.percentage || 0,
            direction: pos.direction || pos.side || 'long',
            entry_price: pos.entryPrice || pos.avgPrice || 0,
            pnl_pct: pos.pnlPct || pos.unrealizedPnl || 0,
            updated_at: new Date().toISOString(),
          }, { onConflict: 'source,source_trader_id,symbol' })
        }
      }
    }

    // 获取持仓历史
    const positionData = await page.evaluate(async (url, portfolioId) => {
      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ portfolioId, pageNumber: 1, pageSize: 20 }),
        })
        return await response.json()
      } catch (e) {
        return { error: e.message }
      }
    }, BINANCE_POSITION_API, source_trader_id)

    if (positionData.code === '000000' && positionData.data?.list) {
      const positions = positionData.data.list
      console.log(`  历史订单: ${positions.length} 条`)
      
      // 保存历史订单
      for (const pos of positions) {
        await supabase.from('trader_position_history').upsert({
          source: 'binance',
          source_trader_id,
          symbol: pos.symbol,
          direction: pos.side || pos.direction,
          entry_price: pos.entryPrice,
          exit_price: pos.exitPrice || pos.closePrice,
          pnl_pct: pos.pnlPct || pos.profit,
          open_time: pos.openTime ? new Date(pos.openTime).toISOString() : null,
          close_time: pos.closeTime ? new Date(pos.closeTime).toISOString() : null,
        }, { onConflict: 'source,source_trader_id,symbol,open_time' })
      }
    }

  } catch (error) {
    console.log(`  ❌ 错误: ${error.message}`)
  }
}

main().catch(console.error)

