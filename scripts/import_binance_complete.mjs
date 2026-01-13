/**
 * Binance 完整数据抓取
 * 7D/30D/90D 排行榜 + 每个交易员主页详细数据
 */

import 'dotenv/config'
import puppeteer from 'puppeteer'
import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

// Binance 排行榜
const RANKINGS = [
  { period: '90', label: '90D' },
  { period: '30', label: '30D' },
  { period: '7', label: '7D' },
]

const BASE_URL = 'https://www.binance.com/en/copy-trading'

async function main() {
  console.log('=== Binance 完整数据抓取 ===\n')
  console.log('开始时间:', new Date().toISOString())

  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  })

  try {
    const page = await browser.newPage()
    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36')
    await page.setViewport({ width: 1920, height: 1080 })

    // 存储所有交易员数据
    const allTraders = new Map()

    // 访问主页面
    console.log('访问 Binance Copy Trading...')
    await page.goto(BASE_URL, { waitUntil: 'networkidle2', timeout: 60000 })
    await sleep(3000)

    // 抓取每个时间段
    for (const ranking of RANKINGS) {
      console.log(`\n📊 抓取 ${ranking.label} 排行榜...`)
      
      // 点击时间选择器
      try {
        await page.evaluate((label) => {
          const buttons = Array.from(document.querySelectorAll('button, [role="tab"], [class*="tab"]'))
          const btn = buttons.find(b => b.innerText.includes(label) || b.innerText.includes(label.replace('D', '')))
          if (btn) btn.click()
        }, ranking.label)
        await sleep(2000)
      } catch (e) {
        console.log(`  切换时间段失败，继续...`)
      }

      // 滚动加载更多
      for (let i = 0; i < 10; i++) {
        await page.evaluate(() => window.scrollBy(0, 500))
        await sleep(300)
      }

      // 提取数据
      const traders = await page.evaluate(() => {
        const results = []
        
        // 查找交易员卡片
        const cards = document.querySelectorAll('[class*="trader"], [class*="lead"], [class*="copy"]')
        
        cards.forEach((card, idx) => {
          const text = card.innerText || ''
          
          // 提取 ROI
          const roiMatch = text.match(/ROI[:\s]*([+-]?\d+\.?\d*)%/i) || text.match(/([+-]?\d+\.?\d*)%/)
          const roi = roiMatch ? parseFloat(roiMatch[1]) : null
          
          // 提取链接和 ID
          const link = card.querySelector('a[href*="lead-details"]')
          let traderId = null
          let profileUrl = null
          if (link) {
            const href = link.getAttribute('href')
            profileUrl = href.startsWith('http') ? href : `https://www.binance.com${href}`
            const idMatch = href.match(/portfolioId=(\d+)/)
            traderId = idMatch ? idMatch[1] : null
          }
          
          // 提取昵称
          const nameEl = card.querySelector('[class*="name"]')
          const nickname = nameEl?.innerText?.trim()?.split('\n')[0] || null
          
          // 提取头像
          const avatarEl = card.querySelector('img')
          const avatar = avatarEl?.src || null
          
          // 提取 PnL
          const pnlMatch = text.match(/PnL[:\s]*\$?([+-]?\d+(?:,?\d+)*\.?\d*)/i)
          const pnl = pnlMatch ? parseFloat(pnlMatch[1].replace(/,/g, '')) : null
          
          // 提取胜率
          const winRateMatch = text.match(/(?:Win Rate|胜率)[:\s]*(\d+\.?\d*)%/i)
          const winRate = winRateMatch ? parseFloat(winRateMatch[1]) : null
          
          // 提取粉丝数
          const followersMatch = text.match(/(\d+(?:,\d+)*)\s*(?:Copiers|Followers)/i)
          const followers = followersMatch ? parseInt(followersMatch[1].replace(/,/g, '')) : null
          
          // 提取最大回撤
          const mddMatch = text.match(/(?:MDD|Max Drawdown|Drawdown)[:\s]*([+-]?\d+\.?\d*)%/i)
          const maxDrawdown = mddMatch ? parseFloat(mddMatch[1]) : null

          if (traderId && roi !== null) {
            results.push({
              rank: idx + 1,
              traderId,
              nickname,
              avatar,
              profileUrl,
              roi,
              pnl,
              winRate,
              followers,
              maxDrawdown,
            })
          }
        })
        
        return results
      })

      console.log(`  获取到 ${traders.length} 个交易员`)

      // 合并数据
      for (const trader of traders) {
        const key = trader.traderId
        const existing = allTraders.get(key) || {
          source: 'binance',
          traderId: trader.traderId,
          nickname: trader.nickname,
          avatar: trader.avatar,
          profileUrl: trader.profileUrl,
        }
        
        if (ranking.period === '7') {
          existing.roi_7d = trader.roi
          existing.pnl_7d = trader.pnl
          existing.winRate_7d = trader.winRate
        } else if (ranking.period === '30') {
          existing.roi_30d = trader.roi
          existing.pnl_30d = trader.pnl
          existing.winRate_30d = trader.winRate
        } else {
          existing.roi = trader.roi
          existing.pnl = trader.pnl
          existing.winRate = trader.winRate
          existing.rank = trader.rank
          existing.followers = trader.followers
          existing.maxDrawdown = trader.maxDrawdown
        }
        
        allTraders.set(key, existing)
      }

      await sleep(2000)
    }

    console.log(`\n📥 保存 ${allTraders.size} 个交易员数据...`)
    
    const capturedAt = new Date().toISOString()
    
    for (const [key, trader] of allTraders) {
      await saveTrader(trader, capturedAt)
    }

    // 抓取 TOP 50 交易员详细数据
    console.log('\n📋 抓取交易员详细数据...')
    const topTraders = Array.from(allTraders.values())
      .filter(t => t.profileUrl && t.rank && t.rank <= 50)
      .slice(0, 50)

    for (const trader of topTraders) {
      await scrapeTraderDetails(page, trader, capturedAt)
      await sleep(1500)
    }

    console.log('\n✅ 完成!')
    console.log('结束时间:', new Date().toISOString())

  } finally {
    await browser.close()
  }
}

async function scrapeTraderDetails(page, trader, capturedAt) {
  if (!trader.profileUrl) return

  console.log(`  抓取 ${trader.nickname || trader.traderId}...`)

  try {
    await page.goto(trader.profileUrl, { waitUntil: 'networkidle2', timeout: 30000 })
    await sleep(2000)

    const details = await page.evaluate(() => {
      const result = {
        positions: [],
        stats: {},
      }

      const text = document.body.innerText || ''

      // 提取所有时间段的 ROI
      const roi7dMatch = text.match(/7[Dd]\s*ROI[:\s]*([+-]?\d+\.?\d*)%/)
      const roi30dMatch = text.match(/30[Dd]\s*ROI[:\s]*([+-]?\d+\.?\d*)%/)
      const roi90dMatch = text.match(/90[Dd]\s*ROI[:\s]*([+-]?\d+\.?\d*)%/)
      
      if (roi7dMatch) result.stats.roi_7d = parseFloat(roi7dMatch[1])
      if (roi30dMatch) result.stats.roi_30d = parseFloat(roi30dMatch[1])
      if (roi90dMatch) result.stats.roi = parseFloat(roi90dMatch[1])

      // 提取 PnL
      const pnlMatch = text.match(/(?:Total\s*)?PnL[:\s]*\$?([+-]?\d+(?:,?\d+)*\.?\d*)/i)
      if (pnlMatch) result.stats.pnl = parseFloat(pnlMatch[1].replace(/,/g, ''))

      // 提取胜率
      const winRateMatch = text.match(/(?:Win Rate|胜率)[:\s]*(\d+\.?\d*)%/i)
      if (winRateMatch) result.stats.winRate = parseFloat(winRateMatch[1])

      // 提取最大回撤
      const mddMatch = text.match(/(?:MDD|Max Drawdown)[:\s]*([+-]?\d+\.?\d*)%/i)
      if (mddMatch) result.stats.maxDrawdown = parseFloat(mddMatch[1])

      // 提取总交易次数
      const tradesMatch = text.match(/(?:Total Trades|总交易)[:\s]*(\d+)/i)
      if (tradesMatch) result.stats.totalTrades = parseInt(tradesMatch[1])

      // 提取平均盈亏
      const avgPnlMatch = text.match(/(?:Avg\.?\s*P\/L|平均盈亏)[:\s]*\$?([+-]?\d+\.?\d*)/i)
      if (avgPnlMatch) result.stats.avgPnl = parseFloat(avgPnlMatch[1])

      // 提取持仓
      const positionRows = document.querySelectorAll('[class*="position"] tr, [class*="portfolio"] tr')
      positionRows.forEach(row => {
        const rowText = row.innerText || ''
        const symbolMatch = rowText.match(/([A-Z]+USDT?)/i)
        const pctMatch = rowText.match(/(\d+\.?\d*)%/)
        const pnlMatch = rowText.match(/([+-]?\d+\.?\d*)%/)
        
        if (symbolMatch) {
          result.positions.push({
            symbol: symbolMatch[1].toUpperCase(),
            weightPct: pctMatch ? parseFloat(pctMatch[1]) : 0,
            direction: rowText.toLowerCase().includes('short') ? 'short' : 'long',
            pnlPct: pnlMatch ? parseFloat(pnlMatch[1]) : 0,
          })
        }
      })

      return result
    })

    // 更新快照数据
    const updateData = {}
    if (details.stats.roi_7d != null) updateData.roi_7d = details.stats.roi_7d
    if (details.stats.roi_30d != null) updateData.roi_30d = details.stats.roi_30d
    if (details.stats.roi != null) updateData.roi = details.stats.roi
    if (details.stats.pnl != null) updateData.pnl = details.stats.pnl
    if (details.stats.winRate != null) updateData.win_rate = details.stats.winRate
    if (details.stats.maxDrawdown != null) updateData.max_drawdown = details.stats.maxDrawdown

    if (Object.keys(updateData).length > 0) {
      await supabase
        .from('trader_snapshots')
        .update(updateData)
        .eq('source', 'binance')
        .eq('source_trader_id', trader.traderId)
        .eq('captured_at', capturedAt)
      
      console.log(`    更新: ROI 7D=${updateData.roi_7d || '-'}, 30D=${updateData.roi_30d || '-'}, 90D=${updateData.roi || '-'}`)
    }

    // 保存持仓数据
    if (details.positions.length > 0) {
      for (const pos of details.positions) {
        await supabase.from('trader_portfolio').upsert({
          source: 'binance',
          source_trader_id: trader.traderId,
          symbol: pos.symbol,
          weight_pct: pos.weightPct,
          direction: pos.direction,
          pnl_pct: pos.pnlPct,
          updated_at: new Date().toISOString(),
        }, { onConflict: 'source,source_trader_id,symbol' }).catch(() => {})
      }
      console.log(`    保存 ${details.positions.length} 个持仓`)
    }

  } catch (error) {
    console.log(`    ❌ 失败: ${error.message}`)
  }
}

async function saveTrader(trader, capturedAt) {
  try {
    // 保存 trader_sources
    await supabase.from('trader_sources').upsert({
      source: trader.source,
      source_type: 'leaderboard',
      source_trader_id: trader.traderId,
      handle: trader.nickname || null,
      profile_url: trader.avatar || null,
      is_active: true,
    }, { onConflict: 'source,source_trader_id' })

    // 保存 trader_snapshots
    await supabase.from('trader_snapshots').upsert({
      source: trader.source,
      source_trader_id: trader.traderId,
      rank: trader.rank || null,
      roi: trader.roi || 0,
      roi_7d: trader.roi_7d || null,
      roi_30d: trader.roi_30d || null,
      pnl: trader.pnl || null,
      win_rate: trader.winRate || null,
      max_drawdown: trader.maxDrawdown || null,
      followers: trader.followers || 0,
      captured_at: capturedAt,
    }, { onConflict: 'source,source_trader_id,captured_at' })

  } catch (error) {
    // 静默处理
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

main().catch(console.error)

