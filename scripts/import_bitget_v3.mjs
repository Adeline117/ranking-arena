/**
 * Bitget 完整数据抓取 v3
 * 正确提取 traderId 和 profile URL
 */

import 'dotenv/config'
import puppeteer from 'puppeteer'
import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

const URLS = [
  { type: 'futures', period: '90', url: 'https://www.bitget.com/zh-CN/copy-trading/leaderboard-ranking/futures-roi/1?dateType=90' },
  { type: 'futures', period: '30', url: 'https://www.bitget.com/zh-CN/copy-trading/leaderboard-ranking/futures-roi/1?dateType=30' },
  { type: 'futures', period: '7', url: 'https://www.bitget.com/zh-CN/copy-trading/leaderboard-ranking/futures-roi/1?dateType=7' },
]

async function main() {
  console.log('=== Bitget 数据抓取 v3 ===\n')

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

    const allTraders = new Map()

    for (const config of URLS) {
      console.log(`\n📊 抓取 ${config.type} ${config.period}D...`)
      
      await page.goto(config.url, { waitUntil: 'domcontentloaded', timeout: 60000 })
      await sleep(10000)
      
      // 滚动加载更多
      for (let i = 0; i < 10; i++) {
        await page.evaluate(() => window.scrollBy(0, 500))
        await sleep(500)
      }

      // 提取所有链接中的 trader ID
      const traders = await page.evaluate(() => {
        const results = []
        
        // 查找所有包含 trader ID 的链接
        const links = document.querySelectorAll('a[href*="copy-trading/trader"]')
        const seenIds = new Set()
        
        links.forEach(link => {
          const href = link.getAttribute('href') || ''
          // 匹配 /trader/xxxxx 格式
          const match = href.match(/\/trader\/([a-zA-Z0-9]+)/)
          if (!match) return
          
          const traderId = match[1]
          if (seenIds.has(traderId)) return
          seenIds.add(traderId)
          
          // 找到包含此链接的卡片
          const card = link.closest('[class*="item"], [class*="card"], [class*="row"], tr') || link.parentElement?.parentElement
          if (!card) return
          
          const text = card.innerText || ''
          
          // 提取 ROI
          const roiMatch = text.match(/([+-]?\d+(?:,?\d+)*\.?\d*)%/)
          const roi = roiMatch ? parseFloat(roiMatch[1].replace(/,/g, '')) : null
          
          // 提取昵称
          const nameEl = card.querySelector('[class*="name"], [class*="nick"]')
          const nickname = nameEl?.innerText?.trim()?.split('\n')[0] || null
          
          // 提取头像
          const avatarEl = card.querySelector('img')
          const avatar = avatarEl?.src || null
          
          // 提取 PnL
          const pnlMatch = text.match(/\$\s*([\d,]+\.?\d*)/)
          const pnl = pnlMatch ? parseFloat(pnlMatch[1].replace(/,/g, '')) : null
          
          // 提取胜率
          const winRateMatch = text.match(/(\d+\.?\d*)\s*%\s*胜率/i) || text.match(/胜率\s*(\d+\.?\d*)\s*%/i)
          const winRate = winRateMatch ? parseFloat(winRateMatch[1]) : null
          
          // 提取最大回撤
          const mddMatch = text.match(/(\d+\.?\d*)\s*%\s*(?:最大)?回撤/i)
          const maxDrawdown = mddMatch ? parseFloat(mddMatch[1]) : null

          results.push({
            traderId,
            profileUrl: `https://www.bitget.com/zh-CN/copy-trading/trader/${traderId}/futures`,
            nickname,
            avatar,
            roi,
            pnl,
            winRate,
            maxDrawdown,
          })
        })
        
        return results
      })

      console.log(`  获取到 ${traders.length} 个交易员`)
      
      // 打印前3个
      traders.slice(0, 3).forEach(t => {
        console.log(`    - ${t.nickname || t.traderId}: ROI=${t.roi}%, PnL=$${t.pnl || 'N/A'}`)
      })

      // 合并数据
      const sourceType = config.type === 'futures' ? 'bitget' : 'bitget_spot'
      for (const trader of traders) {
        const key = `${sourceType}_${trader.traderId}`
        const existing = allTraders.get(key) || {
          source: sourceType,
          traderId: trader.traderId,
          nickname: trader.nickname,
          avatar: trader.avatar,
          profileUrl: trader.profileUrl,
        }
        
        if (config.period === '7') {
          existing.roi_7d = trader.roi
        } else if (config.period === '30') {
          existing.roi_30d = trader.roi
        } else {
          existing.roi = trader.roi
          existing.pnl = trader.pnl
          existing.winRate = trader.winRate
          existing.maxDrawdown = trader.maxDrawdown
        }
        
        allTraders.set(key, existing)
      }
      
      await sleep(3000)
    }

    // 保存数据
    console.log(`\n📥 保存 ${allTraders.size} 个交易员...`)
    const capturedAt = new Date().toISOString()
    
    let saved = 0
    for (const [key, trader] of allTraders) {
      if (await saveTrader(trader, capturedAt)) {
        saved++
      }
    }
    
    console.log(`✅ 成功保存 ${saved} 个`)

    // 抓取 TOP 10 交易员详情
    console.log('\n📋 抓取交易员详情...')
    const topTraders = Array.from(allTraders.values())
      .filter(t => t.roi && t.profileUrl)
      .sort((a, b) => (b.roi || 0) - (a.roi || 0))
      .slice(0, 10)

    for (const trader of topTraders) {
      await scrapeTraderDetails(page, trader, capturedAt)
      await sleep(3000)
    }

    console.log('\n✅ 完成!')

  } finally {
    await browser.close()
  }
}

async function scrapeTraderDetails(page, trader, capturedAt) {
  console.log(`\n  抓取详情: ${trader.nickname || trader.traderId}`)
  
  try {
    await page.goto(trader.profileUrl, { waitUntil: 'domcontentloaded', timeout: 30000 })
    await sleep(5000)

    const details = await page.evaluate(() => {
      const text = document.body.innerText || ''
      const result = {}

      // 总收益
      const pnlPatterns = [
        /总收益[:\s]*\$?([\d,]+\.?\d*)/i,
        /累计收益[:\s]*\$?([\d,]+\.?\d*)/i,
        /\$([\d,]+\.?\d*)\s*总收益/i,
      ]
      for (const pattern of pnlPatterns) {
        const match = text.match(pattern)
        if (match) {
          result.pnl = parseFloat(match[1].replace(/,/g, ''))
          break
        }
      }

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
      const avgHoldMatch = text.match(/平均持仓时长[:\s]*(\d+)天?(\d+)?小时?/i)
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

      // 品种偏好
      const positions = []
      const posRegex = /([A-Z]+USDT?)\s*(\d+\.?\d*)%/gi
      let m
      while ((m = posRegex.exec(text)) !== null) {
        positions.push({ symbol: m[1], pct: parseFloat(m[2]) })
      }
      if (positions.length > 0) result.positions = positions

      return result
    })

    console.log(`    详情: PnL=$${details.pnl || 'N/A'}, MDD=${details.maxDrawdown || 'N/A'}%, WR=${details.winRate || 'N/A'}%`)

    // 更新数据库
    if (Object.keys(details).length > 0) {
      const updateData = {}
      if (details.pnl) updateData.pnl = details.pnl
      if (details.maxDrawdown) updateData.max_drawdown = details.maxDrawdown
      if (details.winRate) updateData.win_rate = details.winRate
      if (details.roi_7d) updateData.roi_7d = details.roi_7d
      if (details.roi_30d) updateData.roi_30d = details.roi_30d
      if (details.totalCopiers) updateData.total_copiers = details.totalCopiers
      if (details.avgHoldingHours) updateData.holding_days = details.avgHoldingHours / 24

      if (Object.keys(updateData).length > 0) {
        await supabase
          .from('trader_snapshots')
          .update(updateData)
          .eq('source', trader.source)
          .eq('source_trader_id', trader.traderId)
          .eq('captured_at', capturedAt)
        console.log(`    ✅ 已更新`)
      }

      // 保存持仓
      if (details.positions) {
        for (const pos of details.positions) {
          await supabase.from('trader_portfolio').upsert({
            source: trader.source,
            source_trader_id: trader.traderId,
            symbol: pos.symbol,
            weight_pct: pos.pct,
            updated_at: new Date().toISOString(),
          }, { onConflict: 'source,source_trader_id,symbol' }).catch(() => {})
        }
      }
    }

    // 抓取历史订单
    await scrapeHistory(page, trader)

  } catch (e) {
    console.log(`    ❌ 错误: ${e.message}`)
  }
}

async function scrapeHistory(page, trader) {
  try {
    // 点击历史订单标签
    await page.evaluate(() => {
      const tabs = Array.from(document.querySelectorAll('[class*="tab"], button, [role="tab"]'))
      for (const tab of tabs) {
        if (tab.innerText?.includes('历史') || tab.innerText?.includes('订单')) {
          tab.click()
          return true
        }
      }
      return false
    })
    await sleep(2000)

    const history = await page.evaluate(() => {
      const results = []
      const items = document.querySelectorAll('[class*="history"] tr, [class*="order"] [class*="item"], [class*="position"] tr')
      
      items.forEach(item => {
        const text = item.innerText || ''
        const symbolMatch = text.match(/([A-Z]+USDT?)/i)
        const pnlMatch = text.match(/([+-]?\d+\.?\d*)%/)
        
        if (symbolMatch) {
          results.push({
            symbol: symbolMatch[1].toUpperCase(),
            pnlPct: pnlMatch ? parseFloat(pnlMatch[1]) : 0,
            direction: text.includes('空') || text.toLowerCase().includes('short') ? 'short' : 'long',
          })
        }
      })
      
      return results.slice(0, 20)
    })

    if (history.length > 0) {
      console.log(`    历史订单: ${history.length} 条`)
      for (const h of history) {
        await supabase.from('trader_position_history').insert({
          source: trader.source,
          source_trader_id: trader.traderId,
          symbol: h.symbol,
          direction: h.direction,
          pnl_pct: h.pnlPct,
          created_at: new Date().toISOString(),
        }).catch(() => {})
      }
    }
  } catch (e) {}
}

async function saveTrader(trader, capturedAt) {
  try {
    // 保存 trader_sources - 使用正确的 profile URL
    await supabase.from('trader_sources').upsert({
      source: trader.source,
      source_type: 'leaderboard',
      source_trader_id: trader.traderId,
      handle: trader.nickname || null,
      profile_url: trader.profileUrl, // 使用正确的 profile URL
      is_active: true,
    }, { onConflict: 'source,source_trader_id' })

    // 保存 trader_snapshots
    await supabase.from('trader_snapshots').upsert({
      source: trader.source,
      source_trader_id: trader.traderId,
      roi: trader.roi || 0,
      roi_7d: trader.roi_7d || null,
      roi_30d: trader.roi_30d || null,
      pnl: trader.pnl || null,
      win_rate: trader.winRate || null,
      max_drawdown: trader.maxDrawdown || null,
      followers: 0,
      season_id: '90D',
      captured_at: capturedAt,
    }, { onConflict: 'source,source_trader_id,captured_at' })

    return true
  } catch (e) {
    return false
  }
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms))
}

main().catch(console.error)

