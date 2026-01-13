/**
 * Bitget 交易员数据导入
 * 包含：合约交易榜单、现货交易榜单
 * 获取：7D/30D/90D ROI、Portfolio、历史订单
 */

import 'dotenv/config'
import puppeteer from 'puppeteer'
import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

// Bitget API
const BITGET_FUTURES_API = 'https://www.bitget.com/v1/trigger/trace/public/traderRankList'
const BITGET_SPOT_API = 'https://www.bitget.com/v1/trigger/trace/public/spotTraderRankList'

async function main() {
  console.log('=== Bitget 交易员数据导入 ===\n')

  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  })

  try {
    const page = await browser.newPage()
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36')

    // 访问 Bitget 页面
    await page.goto('https://www.bitget.com/copy-trading', { waitUntil: 'networkidle2', timeout: 60000 })
    await new Promise(r => setTimeout(r, 3000))

    // 抓取合约交易榜单
    console.log('抓取合约交易榜单...')
    await fetchBitgetRanking(page, 'futures', '7D')
    await fetchBitgetRanking(page, 'futures', '30D')
    await fetchBitgetRanking(page, 'futures', '90D')

    // 抓取现货交易榜单
    console.log('\n抓取现货交易榜单...')
    await fetchBitgetRanking(page, 'spot', '7D')
    await fetchBitgetRanking(page, 'spot', '30D')
    await fetchBitgetRanking(page, 'spot', '90D')

  } finally {
    await browser.close()
  }

  console.log('\n✅ 完成!')
}

async function fetchBitgetRanking(page, type, timeRange) {
  const apiUrl = type === 'futures' ? BITGET_FUTURES_API : BITGET_SPOT_API
  const sourceType = type === 'futures' ? 'bitget' : 'bitget_spot'

  console.log(`  获取 ${type} ${timeRange} 排行榜...`)

  try {
    const data = await page.evaluate(async (url, range) => {
      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            pageNo: 1,
            pageSize: 100,
            sortType: 'ROI',
            timeRange: range,
          }),
        })
        return await response.json()
      } catch (e) {
        return { error: e.message }
      }
    }, apiUrl, timeRange)

    if (data.code === '00000' && data.data?.list) {
      const traders = data.data.list
      console.log(`    获取到 ${traders.length} 个交易员`)

      const capturedAt = new Date().toISOString()

      // 保存 trader_sources
      const sourcesData = traders.map(t => ({
        source: sourceType,
        source_type: 'leaderboard',
        source_trader_id: String(t.traderId || t.uid),
        handle: t.nickName || t.nickname || null,
        profile_url: t.avatar || t.headPic || null,
        is_active: true,
        market_type: type,
      }))

      await supabase.from('trader_sources').upsert(sourcesData, {
        onConflict: 'source,source_trader_id',
      })

      // 保存 trader_snapshots
      const snapshotsData = traders.map((t, idx) => ({
        source: sourceType,
        source_trader_id: String(t.traderId || t.uid),
        rank: idx + 1,
        roi: Number(t.roi) || 0,
        pnl: t.pnl != null ? Number(t.pnl) : null,
        win_rate: t.winRate != null ? Number(t.winRate) : null,
        max_drawdown: t.maxDrawdown != null ? Number(t.maxDrawdown) : null,
        followers: 0,
        season_id: timeRange,
        captured_at: capturedAt,
      }))

      const { error } = await supabase.from('trader_snapshots').upsert(snapshotsData, {
        onConflict: 'source,source_trader_id,captured_at',
      })

      if (error) {
        console.log(`    ❌ 保存失败: ${error.message}`)
      } else {
        console.log(`    ✅ 保存成功`)
      }
    }
  } catch (error) {
    console.log(`    ❌ 错误: ${error.message}`)
  }
}

main().catch(console.error)

