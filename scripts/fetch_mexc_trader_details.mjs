/**
 * MEXC 交易员详情抓取
 * 
 * 获取每个交易员的详细数据
 * 
 * 用法: node scripts/fetch_mexc_trader_details.mjs [--limit=N]
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

const SOURCE = 'mexc'
const DEFAULT_LIMIT = 50
const CONCURRENCY = 3

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function parseLimit() {
  const arg = process.argv.find(a => a.startsWith('--limit='))
  return arg ? parseInt(arg.split('=')[1]) : DEFAULT_LIMIT
}

/**
 * 获取所有 MEXC 交易员
 */
async function getMexcTraders(limit) {
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

    // 监听 API 响应
    page.on('response', async response => {
      const url = response.url()
      
      // 交易员详情 API
      if (url.includes('trader/detail') || url.includes('leader/info')) {
        try {
          const data = JSON.parse(await response.text())
          if (data.data) {
            const d = data.data
            details.stats.roi = parseFloat(d.roi || d.totalRoi || 0)
            details.stats.pnl = parseFloat(d.totalPnl || d.pnl || 0)
            details.stats.winRate = parseFloat(d.winRate || 0)
            details.stats.maxDrawdown = parseFloat(d.maxDrawdown || d.mdd || 0)
            details.stats.followers = parseInt(d.followerCount || d.copierCount || 0)
            details.stats.totalTrades = parseInt(d.totalTrades || 0)
            details.stats.sharpeRatio = parseFloat(d.sharpeRatio || 0)
          }
        } catch {}
      }

      // 持仓历史 API
      if (url.includes('position') || url.includes('history') || url.includes('order')) {
        try {
          const data = JSON.parse(await response.text())
          const list = data.data?.list || data.data?.items || data.data || []
          if (Array.isArray(list)) {
            list.slice(0, 20).forEach(p => {
              if (p.symbol) {
                details.positions.push({
                  symbol: p.symbol || '',
                  direction: (p.side || p.direction || '').toLowerCase().includes('short') ? 'short' : 'long',
                  pnlPct: parseFloat(p.roi || p.pnlRate || 0),
                  pnlUsd: parseFloat(p.pnl || p.profit || 0),
                  openTime: p.openTime,
                  closeTime: p.closeTime,
                })
              }
            })
          }
        } catch {}
      }
    })

    // 访问交易员详情页
    // MEXC 详情页 URL 格式 - 使用 handle 作为 ID
    const url = `https://www.mexc.com/futures/copyTrade/home/${encodeURIComponent(traderId)}`
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
        if (text.includes('关闭') || text.includes('ok') || text.includes('got it') || text.includes('确定')) {
          try { el.click() } catch {}
        }
      })
    })
    await sleep(1000)

    // 如果 API 没有获取到数据，从 DOM 提取
    if (Object.keys(details.stats).length === 0) {
      const pageData = await page.evaluate(() => {
        const text = document.body.innerText
        const result = {}

        // ROI
        const roiMatch = text.match(/(?:ROI|收益率)[:\s]*([+-]?\d+(?:,\d+)*\.?\d*)%/i)
        if (roiMatch) result.roi = parseFloat(roiMatch[1].replace(/,/g, ''))

        // PnL
        const pnlMatch = text.match(/(?:PNL|收益|Profit)[:\s]*\$?([+-]?[\d,]+\.?\d*)/i)
        if (pnlMatch) result.pnl = parseFloat(pnlMatch[1].replace(/,/g, ''))

        // 胜率
        const winRateMatch = text.match(/(?:Win Rate|胜率)[:\s]*(\d+\.?\d*)%/i)
        if (winRateMatch) result.winRate = parseFloat(winRateMatch[1])

        // 最大回撤
        const mddMatch = text.match(/(?:Max Drawdown|MDD|最大回撤)[:\s]*([+-]?\d+\.?\d*)%/i)
        if (mddMatch) result.maxDrawdown = parseFloat(mddMatch[1])

        // 跟随者
        const followersMatch = text.match(/(?:Followers|Copiers|跟随者|粉丝)[:\s]*([\d,]+)/i)
        if (followersMatch) result.followers = parseInt(followersMatch[1].replace(/,/g, ''))

        // 交易次数
        const tradesMatch = text.match(/(?:Total Trades|交易次数|Trades)[:\s]*(\d+)/i)
        if (tradesMatch) result.totalTrades = parseInt(tradesMatch[1])

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
        const assetRegex = /([A-Z]+(?:USDT)?)\s+(\d+\.?\d*)%/g
        let match
        while ((match = assetRegex.exec(text)) !== null) {
          const symbol = match[1]
          const pct = parseFloat(match[2])
          if (pct > 0 && pct <= 100) {
            assetBreakdown.push({ symbol, percentage: pct })
          }
        }
        result.assetBreakdown = assetBreakdown.slice(0, 10)

        return result
      })

      Object.assign(details.stats, pageData)
      details.assetBreakdown = pageData.assetBreakdown || []
    }

    // 尝试点击历史 Tab
    try {
      await page.evaluate(() => {
        const tabs = document.querySelectorAll('button, [role="tab"], [class*="tab"]')
        for (const tab of tabs) {
          const text = (tab.textContent || '').toLowerCase()
          if (text.includes('history') || text.includes('历史') || text.includes('position') || text.includes('订单')) {
            tab.click()
            return true
          }
        }
        return false
      })
      await sleep(3000)
    } catch {}

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
    const periods = ['7D', '30D', '90D']
    for (const period of periods) {
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
        copiers_pnl: 0,
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
        pnl_usd: pos.pnlUsd,
        open_time: pos.openTime || capturedAt,
        close_time: pos.closeTime,
        status: 'closed',
        captured_at: capturedAt,
      }, { onConflict: 'source,source_trader_id,symbol,open_time' }).catch(() => {})
    }
  }
}

async function main() {
  const limit = parseLimit()
  console.log(`\n========================================`)
  console.log(`MEXC 交易员详情抓取`)
  console.log(`========================================`)
  console.log(`时间: ${new Date().toISOString()}`)
  console.log(`限制: ${limit} 个交易员`)
  console.log(`并发: ${CONCURRENCY}`)

  // 获取交易员列表
  const traders = await getMexcTraders(limit)
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
