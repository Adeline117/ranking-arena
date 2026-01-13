/**
 * Bitget 完整数据抓取
 * 合约 + 现货，7D/30D/90D 排行榜
 * 每个交易员主页详细数据
 */

import 'dotenv/config'
import puppeteer from 'puppeteer'
import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

// Bitget 排行榜 URL
const RANKINGS = [
  { type: 'futures', period: '90', url: 'https://www.bitget.com/zh-CN/copy-trading/leaderboard-ranking/futures-roi/1?dateType=90' },
  { type: 'futures', period: '30', url: 'https://www.bitget.com/zh-CN/copy-trading/leaderboard-ranking/futures-roi/1?dateType=30' },
  { type: 'futures', period: '7', url: 'https://www.bitget.com/zh-CN/copy-trading/leaderboard-ranking/futures-roi/1?dateType=7' },
  { type: 'spot', period: '90', url: 'https://www.bitget.com/zh-CN/copy-trading/leaderboard-ranking/spot-roi/1?dateType=90' },
  { type: 'spot', period: '30', url: 'https://www.bitget.com/zh-CN/copy-trading/leaderboard-ranking/spot-roi/1?dateType=30' },
  { type: 'spot', period: '7', url: 'https://www.bitget.com/zh-CN/copy-trading/leaderboard-ranking/spot-roi/1?dateType=7' },
]

async function main() {
  console.log('=== Bitget 完整数据抓取 ===\n')
  console.log('开始时间:', new Date().toISOString())

  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  })

  try {
    const page = await browser.newPage()
    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36')
    await page.setViewport({ width: 1920, height: 1080 })

    // 存储所有交易员数据（用于合并多时间段数据）
    const allTraders = new Map()

    // 抓取每个排行榜
    for (const ranking of RANKINGS) {
      console.log(`\n📊 抓取 ${ranking.type} ${ranking.period}D 排行榜...`)
      const traders = await scrapeRanking(page, ranking)
      
      // 合并数据
      for (const trader of traders) {
        const key = `${ranking.type}_${trader.traderId}`
        const existing = allTraders.get(key) || {
          source: ranking.type === 'futures' ? 'bitget' : 'bitget_spot',
          traderId: trader.traderId,
          nickname: trader.nickname,
          avatar: trader.avatar,
          profileUrl: trader.profileUrl,
        }
        
        // 添加对应时间段的数据
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
          existing.totalTrades = trader.totalTrades
          existing.maxDrawdown = trader.maxDrawdown
        }
        
        allTraders.set(key, existing)
      }
      
      // 避免请求过快
      await sleep(2000)
    }

    console.log(`\n📥 保存 ${allTraders.size} 个交易员数据...`)
    
    // 保存到数据库
    const capturedAt = new Date().toISOString()
    
    for (const [key, trader] of allTraders) {
      await saveTrader(trader, capturedAt)
    }

    // 抓取排名前 50 的交易员详细数据
    console.log('\n📋 抓取交易员详细数据...')
    const topTraders = Array.from(allTraders.values())
      .filter(t => t.profileUrl && t.rank && t.rank <= 50)
      .slice(0, 50)

    for (const trader of topTraders) {
      await scrapeTraderDetails(page, trader)
      await sleep(1500)
    }

    console.log('\n✅ 完成!')
    console.log('结束时间:', new Date().toISOString())

  } finally {
    await browser.close()
  }
}

async function scrapeRanking(page, ranking) {
  const traders = []
  
  try {
    await page.goto(ranking.url, { waitUntil: 'networkidle2', timeout: 60000 })
    await sleep(3000)

    // 等待排行榜加载
    await page.waitForSelector('[class*="leaderboard"], [class*="ranking"], table, [class*="trader"]', { timeout: 15000 }).catch(() => {})

    // 滚动加载更多
    for (let i = 0; i < 5; i++) {
      await page.evaluate(() => window.scrollBy(0, 800))
      await sleep(500)
    }

    // 提取数据
    const data = await page.evaluate(() => {
      const results = []
      const bodyText = document.body.innerText || ''
      
      // 方法1: 从页面文本解析 - Bitget 格式如:
      // "老枪\n@BGUSER-9WQM8XWL\n收益率:\n+12,821.83%\n$25,399.3总收益\n253\n/\n500\n跟单者"
      // 或表格格式: "4\tEncryption\n@Encryption-\t+9,280.79%\t$18,585.98\t79/500"
      
      // 查找所有带链接的交易员元素
      const links = document.querySelectorAll('a[href*="/copy-trading/trader/"]')
      
      links.forEach((link, idx) => {
        const href = link.getAttribute('href')
        const idMatch = href.match(/trader\/([^/?]+)/)
        if (!idMatch) return
        
        const traderId = idMatch[1]
        const profileUrl = href.startsWith('http') ? href : `https://www.bitget.com${href}`
        
        // 获取包含此链接的父容器的文本
        let container = link.parentElement
        for (let i = 0; i < 5 && container; i++) {
          if (container.innerText && container.innerText.length > 50) break
          container = container.parentElement
        }
        
        const text = container?.innerText || link.innerText || ''
        
        // 提取 ROI - 格式: +12,821.83% 或 收益率: +12,821.83%
        const roiMatch = text.match(/([+-]?\d{1,3}(?:,\d{3})*\.?\d*)%/)
        const roi = roiMatch ? parseFloat(roiMatch[1].replace(/,/g, '')) : null
        
        // 提取 PNL - 格式: $25,399.3总收益 或 $18,585.98
        const pnlMatch = text.match(/\$([0-9,]+\.?\d*)(?:\s*(?:总收益|USDT))?/i)
        const pnl = pnlMatch ? parseFloat(pnlMatch[1].replace(/,/g, '')) : null
        
        // 提取昵称 - 链接文本或 @ 前的文字
        let nickname = null
        const nicknameMatch = text.match(/^([^\n@]+)/) || text.match(/([^\n]+)\n@/)
        if (nicknameMatch) {
          nickname = nicknameMatch[1].trim()
        }
        
        // 提取头像
        const avatarEl = container?.querySelector('img') || link.querySelector('img')
        const avatar = avatarEl?.src || null
        
        // 提取跟单者数
        const followersMatch = text.match(/(\d+)\s*\/\s*(\d+)\s*(?:跟单者)?/)
        const followers = followersMatch ? parseInt(followersMatch[1]) : null
        
        if (traderId && roi !== null && !results.find(r => r.traderId === traderId)) {
          results.push({
            rank: results.length + 1,
            traderId,
            nickname,
            avatar,
            profileUrl,
            roi,
            pnl,
            followers,
            winRate: null,
            maxDrawdown: null,
          })
        }
      })
      
      // 方法2: 如果没找到，尝试解析页面 JSON 数据
      if (results.length === 0) {
        const scripts = document.querySelectorAll('script')
        scripts.forEach(script => {
          const text = script.textContent || ''
          if (text.includes('traderList') || text.includes('rankList')) {
            try {
              const match = text.match(/\{.*traderList.*\}|\{.*rankList.*\}/s)
              if (match) {
                const json = JSON.parse(match[0])
                const list = json.traderList || json.rankList || json.data?.list || []
                list.forEach((item, idx) => {
                  results.push({
                    rank: idx + 1,
                    traderId: String(item.traderId || item.uid || item.id),
                    nickname: item.nickName || item.nickname,
                    avatar: item.avatar || item.headPic,
                    profileUrl: `https://www.bitget.com/copy-trading/trader/${item.traderId || item.uid}`,
                    roi: parseFloat(item.roi) || 0,
                    followers: parseInt(item.followers) || 0,
                    winRate: parseFloat(item.winRate) || null,
                    pnl: parseFloat(item.pnl) || null,
                    totalTrades: parseInt(item.totalTrades || item.tradeCount) || null,
                    maxDrawdown: parseFloat(item.maxDrawdown || item.mdd) || null,
                  })
                })
              }
            } catch (e) {}
          }
        })
      }
      
      return results
    })

    console.log(`  获取到 ${data.length} 个交易员`)
    return data

  } catch (error) {
    console.log(`  ❌ 抓取失败: ${error.message}`)
    return []
  }
}

async function scrapeTraderDetails(page, trader) {
  if (!trader.profileUrl) return

  console.log(`  抓取 ${trader.nickname || trader.traderId} 详细数据...`)

  try {
    await page.goto(trader.profileUrl, { waitUntil: 'networkidle2', timeout: 30000 })
    await sleep(2000)

    const details = await page.evaluate(() => {
      const result = {
        positions: [],
        positionHistory: [],
        stats: {},
      }

      // 提取当前持仓
      const positionRows = document.querySelectorAll('[class*="position"] tr, [class*="holding"] [class*="item"]')
      positionRows.forEach(row => {
        const text = row.innerText || ''
        const symbolMatch = text.match(/([A-Z]+USDT?)/i)
        const pnlMatch = text.match(/([+-]?\d+\.?\d*)%/)
        
        if (symbolMatch) {
          result.positions.push({
            symbol: symbolMatch[1].toUpperCase(),
            direction: text.toLowerCase().includes('short') ? 'short' : 'long',
            pnlPct: pnlMatch ? parseFloat(pnlMatch[1]) : 0,
          })
        }
      })

      // 提取统计数据
      const statsText = document.body.innerText || ''
      
      // 提取 PNL（多种格式：累计盈亏、Total PnL、盈亏等）
      const pnlPatterns = [
        /(?:累计盈亏|Total PnL|总盈亏|盈亏)[:\s]*\$?([+-]?\d+(?:,?\d+)*\.?\d*)\s*(?:USDT)?/i,
        /(?:Profit|收益)[:\s]*\$?([+-]?\d+(?:,?\d+)*\.?\d*)\s*(?:USDT)?/i,
        /PnL[:\s]*\$?([+-]?\d+(?:,?\d+)*\.?\d*)\s*(?:USDT)?/i,
      ]
      for (const pattern of pnlPatterns) {
        const match = statsText.match(pattern)
        if (match) {
          result.stats.pnl = parseFloat(match[1].replace(/,/g, ''))
          break
        }
      }
      
      // 总交易次数
      const tradesMatch = statsText.match(/(?:总交易|Total Trades)[:\s]*(\d+)/i)
      if (tradesMatch) result.stats.totalTrades = parseInt(tradesMatch[1])
      
      // 平均盈亏
      const avgPnlMatch = statsText.match(/(?:平均盈亏|Avg P\/L)[:\s]*([+-]?\d+\.?\d*)/i)
      if (avgPnlMatch) result.stats.avgPnl = parseFloat(avgPnlMatch[1])
      
      // 最大回撤
      const mddMatch = statsText.match(/(?:最大回撤|Max Drawdown)[:\s]*([+-]?\d+\.?\d*)%/i)
      if (mddMatch) result.stats.maxDrawdown = parseFloat(mddMatch[1])
      
      // 持仓时间
      const holdingTimeMatch = statsText.match(/(?:平均持仓|Avg Holding)[:\s]*(\d+\.?\d*)\s*(天|d|h|小时)/i)
      if (holdingTimeMatch) {
        const value = parseFloat(holdingTimeMatch[1])
        const unit = holdingTimeMatch[2].toLowerCase()
        result.stats.avgHoldingHours = unit.includes('天') || unit === 'd' ? value * 24 : value
      }

      return result
    })

    // 保存持仓数据
    if (details.positions.length > 0) {
      for (const pos of details.positions) {
        await supabase.from('trader_portfolio').upsert({
          source: trader.source,
          source_trader_id: trader.traderId,
          symbol: pos.symbol,
          direction: pos.direction,
          pnl_pct: pos.pnlPct,
          updated_at: new Date().toISOString(),
        }, { onConflict: 'source,source_trader_id,symbol' }).catch(() => {})
      }
      console.log(`    保存 ${details.positions.length} 个持仓`)
    }

    // 更新统计数据到快照
    if (Object.keys(details.stats).length > 0) {
      const updateData = {}
      if (details.stats.pnl != null) updateData.pnl = details.stats.pnl
      if (details.stats.maxDrawdown) updateData.max_drawdown = details.stats.maxDrawdown
      if (details.stats.totalTrades) updateData.trades_count = details.stats.totalTrades
      
      if (Object.keys(updateData).length > 0) {
        // 更新最新的快照记录
        const { error } = await supabase
          .from('trader_snapshots')
          .update(updateData)
          .eq('source', trader.source)
          .eq('source_trader_id', trader.traderId)
          .order('captured_at', { ascending: false })
          .limit(1)
        
        if (!error && updateData.pnl != null) {
          console.log(`    ✓ PNL: $${updateData.pnl.toFixed(2)}`)
        }
      }
    }

  } catch (error) {
    console.log(`    ❌ 详情抓取失败: ${error.message}`)
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
    const snapshotData = {
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
    }

    await supabase.from('trader_snapshots').upsert(snapshotData, {
      onConflict: 'source,source_trader_id,captured_at',
    })

  } catch (error) {
    console.log(`  保存失败 ${trader.traderId}: ${error.message}`)
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

main().catch(console.error)


