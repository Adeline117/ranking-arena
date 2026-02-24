/**
 * Bitget Futures Copy Trading 完整数据抓取 v2 (优化版)
 *
 * 优化点：
 * 1. 并行获取交易员详情（3-5倍提速）
 * 2. 批量数据库写入
 * 3. 智能等待替代固定 sleep
 *
 * 用法: node scripts/import/import_bitget_futures_v2.mjs [7D|30D|90D] [--concurrency=5]
 */

import puppeteer from 'puppeteer-extra'
import StealthPlugin from 'puppeteer-extra-plugin-stealth'
import pLimit from 'p-limit'

// 使用共享工具库（消除重复代码）
import {
  getSupabaseClient,
  calculateArenaScore,
  sleep,
  randomDelay,
  getTargetPeriods,
  getConcurrency,
} from '../lib/shared.mjs'

puppeteer.use(StealthPlugin())

const supabase = getSupabaseClient()

const SOURCE = 'bitget_futures'
const TARGET_COUNT = 500

// URL 参数: rule=2 (ROI排序)
// sort: 1=7D, 2=30D, 0=all/90D
const PERIOD_CONFIG = {
  '7D': { url: 'https://www.bitget.com/copy-trading/futures/all?rule=2&sort=0', periodParam: '7D' },
  '30D': { url: 'https://www.bitget.com/copy-trading/futures/all?rule=2&sort=0', periodParam: '30D' },
  '90D': { url: 'https://www.bitget.com/copy-trading/futures/all?rule=2&sort=0', periodParam: '90D' },
}

async function fetchLeaderboard(browser, period) {
  const config = PERIOD_CONFIG[period]
  console.log(`\n📋 抓取排行榜: ${config.url}`)
  
  const page = await browser.newPage()
  await page.setViewport({ width: 1920, height: 1080 })
  await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36')
  
  const traders = []
  
  try {
    try {
      await page.goto(config.url, { waitUntil: 'networkidle2', timeout: 90000 })
    } catch (e) {
      console.log('  ⚠ 页面加载超时，继续尝试...')
    }
    
    // 智能等待：等待交易员卡片出现
    await page.waitForSelector('a[href*="/trader/"]', { timeout: 10000 }).catch(() => {})
    await sleep(2000)
    
    // 关闭弹窗
    await page.evaluate(() => {
      document.querySelectorAll('button').forEach(btn => {
        const text = btn.textContent || ''
        if (text.includes('OK') || text.includes('Got') || text.includes('Accept')) {
          try { btn.click() } catch {}
        }
      })
    }).catch(() => {})
    await sleep(1000)
    
    // 获取交易员链接
    const links = await page.evaluate(() => {
      const anchors = document.querySelectorAll('a[href*="/trader/"]')
      return Array.from(anchors).map(a => {
        const href = a.href
        const match = href.match(/\/trader\/([a-f0-9]+)\//)
        if (match) {
          return {
            traderId: match[1],
            text: a.textContent?.slice(0, 100),
          }
        }
        return null
      }).filter(Boolean)
    })
    
    // 去重
    const seen = new Set()
    for (const link of links) {
      if (!seen.has(link.traderId)) {
        seen.add(link.traderId)
        
        // 从文本中提取昵称和ROI
        const text = link.text || ''
        const nickMatch = text.match(/^([^@]+)@/)
        const roiMatch = text.match(/([+-]?[\d,]+\.?\d*)%/)
        
        traders.push({
          traderId: link.traderId,
          nickname: nickMatch ? nickMatch[1].trim() : link.traderId,
          roi: roiMatch ? parseFloat(roiMatch[1].replace(/,/g, '')) : 0,
        })
      }
    }
    
    console.log(`  获取到 ${traders.length} 个交易员`)
    
    // 尝试分页获取更多
    if (traders.length < TARGET_COUNT) {
      for (let pageNum = 2; pageNum <= 5; pageNum++) {
        if (traders.length >= TARGET_COUNT) break
        
        await page.evaluate(() => window.scrollTo(0, 3500))
        await sleep(800)
        
        const clicked = await page.evaluate((pageNum) => {
          const items = document.querySelectorAll('.bit-pagination-item a, .bit-pagination-item')
          for (const item of items) {
            if (item.textContent?.trim() === String(pageNum)) {
              item.click()
              return true
            }
          }
          return false
        }, pageNum)
        
        if (!clicked) break
        
        // 等待新数据加载
        await sleep(2500)
        
        const moreLinks = await page.evaluate(() => {
          const anchors = document.querySelectorAll('a[href*="/trader/"]')
          return Array.from(anchors).map(a => {
            const href = a.href
            const match = href.match(/\/trader\/([a-f0-9]+)\//)
            if (match) {
              return {
                traderId: match[1],
                text: a.textContent?.slice(0, 100),
              }
            }
            return null
          }).filter(Boolean)
        })
        
        for (const link of moreLinks) {
          if (!seen.has(link.traderId)) {
            seen.add(link.traderId)
            const text = link.text || ''
            const nickMatch = text.match(/^([^@]+)@/)
            const roiMatch = text.match(/([+-]?[\d,]+\.?\d*)%/)
            traders.push({
              traderId: link.traderId,
              nickname: nickMatch ? nickMatch[1].trim() : link.traderId,
              roi: roiMatch ? parseFloat(roiMatch[1].replace(/,/g, '')) : 0,
            })
          }
        }
        console.log(`  第${pageNum}页后: ${traders.length} 个`)
      }
    }
  } finally {
    await page.close()
  }
  
  return traders.slice(0, TARGET_COUNT)
}

/**
 * 获取单个交易员详情（接受 browser 作为参数，内部创建 page）
 */
async function fetchTraderDetails(browser, traderId, period) {
  const page = await browser.newPage()
  await page.setViewport({ width: 1920, height: 1080 })
  await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36')
  
  let details = {}
  
  // 监听 API 响应
  page.on('response', async (res) => {
    const url = res.url()
    try {
      if (url.includes('trader') && url.includes('api')) {
        const text = await res.text().catch(() => '')
        if (text.includes('winRate') || text.includes('maxDrawdown') || text.includes('totalProfit')) {
          try {
            const json = JSON.parse(text)
            if (json.data) {
              Object.assign(details, json.data)
            }
          } catch {}
        }
      }
    } catch {}
  })
  
  try {
    const url = `https://www.bitget.com/copy-trading/trader/${traderId}/futures`
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 25000 }).catch(() => {})
    
    // 智能等待：等待数据出现或超时
    await Promise.race([
      page.waitForSelector('[class*="roi"], [class*="ROI"]', { timeout: 8000 }),
      sleep(3000)
    ]).catch(() => {})
    
    // 点击不同周期的标签来获取数据
    const periodMap = { '7D': '7', '30D': '30', '90D': '90' }
    await page.evaluate((days) => {
      const buttons = document.querySelectorAll('button, [role="tab"], div[class*="tab"]')
      for (const btn of buttons) {
        const text = btn.textContent || ''
        if (text.includes(days + 'D') || text.includes(days + ' day') || text.includes(days + '天')) {
          btn.click()
          return
        }
      }
    }, periodMap[period])
    
    await sleep(1500)
    
    // 从页面提取数据
    const pageData = await page.evaluate(() => {
      const text = document.body.innerText
      const result = {}
      
      // ROI
      const roiMatch = text.match(/ROI[\s\n:]*([+-]?[\d,]+\.?\d*)%/i)
      if (roiMatch) result.roi = parseFloat(roiMatch[1].replace(/,/g, ''))
      
      // Total P&L / 总收益
      const pnlMatch = text.match(/(?:Total P&?L|总收益|Profit)[\s\n:]*\$?([\d,]+\.?\d*)/i)
      if (pnlMatch) result.pnl = parseFloat(pnlMatch[1].replace(/,/g, ''))
      
      // Win Rate / 胜率
      const winMatch = text.match(/(?:Win rate|胜率)[\s\n:]*(\d+\.?\d*)%/i)
      if (winMatch) result.winRate = parseFloat(winMatch[1])
      
      // MDD / 最大回撤
      const mddMatch = text.match(/(?:MDD|Max(?:imum)? Drawdown|最大回撤)[\s\n:]*(\d+\.?\d*)%/i)
      if (mddMatch) result.maxDrawdown = parseFloat(mddMatch[1])
      
      // Followers / 跟随者
      const followMatch = text.match(/(?:Followers?|跟随者|Copiers?)[\s\n:]*(\d+)/i)
      if (followMatch) result.followers = parseInt(followMatch[1])
      
      return result
    })
    
    Object.assign(details, pageData)
    
  } catch (e) {
    // 忽略错误
  } finally {
    await page.close()
  }
  
  return details
}

/**
 * 并行获取所有交易员详情
 */
async function fetchAllDetailsParallel(browser, traders, period, concurrency) {
  const limit = pLimit(concurrency)
  const startTime = Date.now()
  
  console.log(`\n🚀 并行获取详情 (并发数: ${concurrency})...`)
  
  let completed = 0
  const total = traders.length
  
  const tasks = traders.map((trader, index) => 
    limit(async () => {
      try {
        // 随机延迟，避免同时发起请求
        await randomDelay(100, 500)
        
        const details = await fetchTraderDetails(browser, trader.traderId, period)
        completed++
        
        // 每完成10个打印进度
        if (completed % 10 === 0 || completed === total) {
          const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
          const eta = ((Date.now() - startTime) / completed * (total - completed) / 1000).toFixed(1)
          console.log(`  进度: ${completed}/${total} | 已用: ${elapsed}s | 预计剩余: ${eta}s`)
        }
        
        return {
          trader,
          details,
          rank: index + 1,
          success: true,
        }
      } catch (e) {
        completed++
        return {
          trader,
          details: {},
          rank: index + 1,
          success: false,
          error: e.message,
        }
      }
    })
  )
  
  const results = await Promise.all(tasks)
  
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
  console.log(`  ✓ 详情获取完成，耗时: ${elapsed}s`)
  
  return results
}

/**
 * 批量保存交易员数据
 */
async function saveTradersBatch(results, period, capturedAt) {
  console.log(`\n💾 批量保存数据...`)
  
  // 1. 批量 upsert trader_sources
  const sourcesData = results.map(r => ({
    source: SOURCE,
    source_type: 'leaderboard',
    source_trader_id: r.trader.traderId,
    handle: r.trader.nickname,
    avatar_url: null,
    profile_url: `https://www.bitget.com/copy-trading/trader/${r.trader.traderId}/futures`,
    is_active: true,
  }))
  
  const { error: sourcesError } = await supabase
    .from('trader_sources')
    .upsert(sourcesData, { onConflict: 'source,source_trader_id' })
  
  if (sourcesError) {
    console.log(`  ⚠ trader_sources 保存警告: ${sourcesError.message}`)
  }
  
  // 2. 批量 insert trader_snapshots (包含 arena_score)
  const snapshotsData = results.map(r => {
    const roi = r.details.roi || r.trader.roi || 0
    const pnl = r.details.pnl || r.details.totalProfit || null
    const maxDrawdown = r.details.maxDrawdown || null
    const winRate = r.details.winRate !== null && r.details.winRate !== undefined
      ? (r.details.winRate <= 1 ? r.details.winRate * 100 : r.details.winRate)
      : null
    
    const { totalScore: arenaScore } = calculateArenaScore(roi, pnl, maxDrawdown, winRate, period)
    
    return {
      source: SOURCE,
      source_trader_id: r.trader.traderId,
      season_id: period,
      rank: r.rank,
      roi,
      pnl,
      win_rate: winRate,
      max_drawdown: maxDrawdown,
      followers: r.details.followers || r.details.currentCopiers || null,
      arena_score: arenaScore,
      captured_at: capturedAt,
    }
  })
  
  const { error: snapshotsError } = await supabase
    .from('trader_snapshots')
    .insert(snapshotsData)
  
  if (snapshotsError) {
    console.log(`  ⚠ trader_snapshots 保存警告: ${snapshotsError.message}`)
    // 如果批量失败，尝试逐条插入
    console.log(`  尝试逐条保存...`)
    let saved = 0
    for (const snapshot of snapshotsData) {
      const { error } = await supabase.from('trader_snapshots').upsert(snapshot)
      if (!error) saved++
    }
    console.log(`  逐条保存: ${saved}/${snapshotsData.length}`)
    return saved
  }
  
  console.log(`  ✓ 批量保存成功: ${snapshotsData.length} 条`)
  return snapshotsData.length
}

async function main() {
  const periods = getTargetPeriods()
  const concurrency = getConcurrency()
  const totalStartTime = Date.now()
  
  console.log(`\n========================================`)
  console.log(`Bitget Futures 数据抓取 v2 (优化版)`)
  console.log(`========================================`)
  console.log(`时间: ${new Date().toISOString()}`)
  console.log(`目标周期: ${periods.join(', ')}`)
  console.log(`并发: ${concurrency}`)
  console.log(`目标: ${TARGET_COUNT} 个交易员/周期`)
  
  const browser = await puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox', 
      '--disable-setuid-sandbox', 
      '--disable-blink-features=AutomationControlled',
      '--disable-dev-shm-usage',
    ],
  })

  const results = []
  
  try {
    for (const period of periods) {
      console.log(`\n${'='.repeat(50)}`)
      console.log(`📊 开始抓取 ${period} 排行榜...`)
      console.log(`${'='.repeat(50)}`)
      
      // 1. 获取排行榜
      const traders = await fetchLeaderboard(browser, period)
      
      if (traders.length === 0) {
        console.log(`\n⚠ ${period} 未获取到交易员列表，跳过`)
        continue
      }
      
      console.log(`\n📋 ${period} TOP 5:`)
      traders.slice(0, 5).forEach((t, i) => {
        console.log(`  ${i + 1}. ${t.nickname} (${t.traderId.slice(0, 8)}...): ROI ${t.roi}%`)
      })
      
      // 2. 并行获取所有交易员的详情
      const capturedAt = new Date().toISOString()
      const detailResults = await fetchAllDetailsParallel(browser, traders, period, concurrency)
      
      // 3. 打印部分详情
      console.log(`\n📊 详情数据示例:`)
      detailResults.slice(0, 3).forEach((r, i) => {
        const d = r.details
        console.log(`  ${i + 1}. ${r.trader.nickname}: ROI:${(d.roi || r.trader.roi || 0).toFixed(1)}% PnL:$${(d.pnl || 0).toFixed(0)} WR:${(d.winRate || 0)}%`)
      })
      
      // 4. 批量保存
      const saved = await saveTradersBatch(detailResults, period, capturedAt)
      const successCount = detailResults.filter(r => r.success).length
      results.push({ period, count: successCount, saved, topRoi: traders[0]?.roi || 0 })
      
      console.log(`\n✅ ${period} 完成！保存了 ${saved} 条数据`)
      
      if (periods.indexOf(period) < periods.length - 1) {
        console.log(`\n⏳ 等待 5 秒后抓取下一个时间段...`)
        await sleep(5000)
      }
    }
    
    const totalTime = ((Date.now() - totalStartTime) / 1000).toFixed(1)
    
    console.log(`\n${'='.repeat(60)}`)
    console.log(`✅ 全部完成！`)
    console.log(`${'='.repeat(60)}`)
    console.log(`📊 抓取结果:`)
    for (const r of results) {
      console.log(`   ${r.period}: ${r.saved} 条, TOP ROI ${r.topRoi?.toFixed?.(2) || r.topRoi}%`)
    }
    console.log(`   总耗时: ${totalTime}s`)
    console.log(`${'='.repeat(60)}`)
    
  } finally {
    await browser.close()
  }
}

main().catch(console.error)
