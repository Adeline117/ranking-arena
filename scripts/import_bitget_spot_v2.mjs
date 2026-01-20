/**
 * Bitget Spot Copy Trading 完整数据抓取 v2 (优化版)
 * 
 * 优化点：
 * 1. 并行获取详情
 * 2. 批量保存
 * 3. 更好的分页处理
 * 
 * 用法: node scripts/import_bitget_spot_v2.mjs [7D|30D|90D]
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

const SOURCE = 'bitget_spot'
const TARGET_COUNT = 100
const CONCURRENCY = 5

// Spot URL - rule=2 是按 ROI 排序
const PERIOD_CONFIG = {
  '7D': { url: 'https://www.bitget.com/copy-trading/spot/all?rule=2&sort=1' },
  '30D': { url: 'https://www.bitget.com/copy-trading/spot/all?rule=2&sort=2' },
  '90D': { url: 'https://www.bitget.com/copy-trading/spot/all?rule=2&sort=0' },
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function getTargetPeriods() {
  const arg = process.argv[2]?.toUpperCase()
  if (arg === 'ALL') return ['7D', '30D', '90D']
  if (arg && ['7D', '30D', '90D'].includes(arg)) return [arg]
  return ['7D', '30D', '90D'] // 默认抓取所有时间段
}

async function fetchLeaderboard(browser, period) {
  const config = PERIOD_CONFIG[period]
  console.log(`\n📋 抓取排行榜: ${config.url}`)
  
  const page = await browser.newPage()
  await page.setViewport({ width: 1920, height: 1080 })
  await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36')
  
  const traders = new Map()
  
  // 监听 API 响应
  page.on('response', async (response) => {
    const url = response.url()
    if (url.includes('trader') && (url.includes('list') || url.includes('rank'))) {
      try {
        const json = await response.json()
        const list = json.data?.list || json.data?.traderList || json.data || []
        if (Array.isArray(list) && list.length > 0) {
          console.log(`  📡 拦截到 API 数据: ${list.length} 条`)
          
          list.forEach(item => {
            const traderId = item.traderId || item.traderUid || item.uid || ''
            if (!traderId || traders.has(traderId)) return
            
            traders.set(traderId, {
              traderId: String(traderId),
              nickname: item.nickName || item.traderName || null,
              avatar: item.headUrl || item.avatar || null,
              roi: parseFloat(item.roi || item.yieldRate || 0) * (Math.abs(item.roi || 0) > 10 ? 1 : 100),
              pnl: parseFloat(item.totalProfit || item.profit || 0),
              winRate: parseFloat(item.winRate || 0),
              maxDrawdown: parseFloat(item.maxDrawdown || item.mdd || 0),
              followers: parseInt(item.followerCount || item.copyTraderCount || 0),
            })
          })
        }
      } catch {}
    }
  })
  
  try {
    await page.goto(config.url, { waitUntil: 'networkidle2', timeout: 45000 })
    await sleep(5000)
    
    // 关闭弹窗
    await page.evaluate(() => {
      document.querySelectorAll('button').forEach(btn => {
        const text = btn.textContent || ''
        if (text.includes('OK') || text.includes('Got') || text.includes('Accept') || text.includes('Confirm')) {
          try { btn.click() } catch {}
        }
      })
    }).catch(() => {})
    await sleep(2000)
    
    console.log(`  API 拦截到: ${traders.size} 个`)
    
    // 获取交易员链接作为备份
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
    
    // 合并链接数据
    for (const link of links) {
      if (!traders.has(link.traderId)) {
        const text = link.text || ''
        const nickMatch = text.match(/^([^@]+)@/)
        const roiMatch = text.match(/([+-]?[\d,]+\.?\d*)%/)
        
        traders.set(link.traderId, {
          traderId: link.traderId,
          nickname: nickMatch ? nickMatch[1].trim() : link.traderId.slice(0, 8),
          roi: roiMatch ? parseFloat(roiMatch[1].replace(/,/g, '')) : 0,
        })
      }
    }
    
    console.log(`  合并后: ${traders.size} 个`)
    
    // 分页获取更多
    if (traders.size < TARGET_COUNT) {
      console.log('\n📄 分页获取更多...')
      
      for (let pageNum = 2; pageNum <= 10; pageNum++) {
        if (traders.size >= TARGET_COUNT) break
        
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
        await sleep(1000)
        
        // 尝试多种分页选择器
        const clicked = await page.evaluate((pageNum) => {
          // 方法1: 标准分页
          const items = document.querySelectorAll('.bit-pagination-item a, .bit-pagination-item, [class*="pagination"] button, [class*="pagination"] a')
          for (const item of items) {
            if (item.textContent?.trim() === String(pageNum)) {
              item.click()
              return true
            }
          }
          
          // 方法2: 下一页按钮
          const nextBtns = document.querySelectorAll('[class*="next"], [aria-label*="next"], button:has(svg)')
          for (const btn of nextBtns) {
            if (btn.offsetParent !== null) {
              btn.click()
              return true
            }
          }
          
          return false
        }, pageNum)
        
        if (!clicked) {
          console.log(`  无法翻到第 ${pageNum} 页`)
          break
        }
        
        await sleep(3000)
        
        // 重新获取链接
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
        
        let newCount = 0
        for (const link of moreLinks) {
          if (!traders.has(link.traderId)) {
            const text = link.text || ''
            const nickMatch = text.match(/^([^@]+)@/)
            const roiMatch = text.match(/([+-]?[\d,]+\.?\d*)%/)
            traders.set(link.traderId, {
              traderId: link.traderId,
              nickname: nickMatch ? nickMatch[1].trim() : link.traderId.slice(0, 8),
              roi: roiMatch ? parseFloat(roiMatch[1].replace(/,/g, '')) : 0,
            })
            newCount++
          }
        }
        
        console.log(`  第${pageNum}页: 新增 ${newCount}, 累计 ${traders.size}`)
        
        if (newCount === 0) {
          console.log('  无新数据，停止翻页')
          break
        }
      }
    }
    
    await page.screenshot({ path: `/tmp/bitget_spot_${period}_${Date.now()}.png`, fullPage: true })
    
  } finally {
    await page.close()
  }
  
  return Array.from(traders.values()).slice(0, TARGET_COUNT)
}

async function fetchTraderDetails(browser, traderId, period) {
  const page = await browser.newPage()
  await page.setViewport({ width: 1920, height: 1080 })
  await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36')
  
  let details = {}
  
  try {
    const url = `https://www.bitget.com/copy-trading/trader/${traderId}/spot`
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {})
    
    // 等待数据加载
    await Promise.race([
      page.waitForSelector('[class*="roi"], [class*="ROI"]', { timeout: 5000 }),
      sleep(3000)
    ]).catch(() => {})
    
    // 从页面提取数据（包含头像）
    const pageData = await page.evaluate(() => {
      const text = document.body.innerText
      const result = {}
      
      // 获取头像
      const avatarImg = document.querySelector('img[src*="avatar"], img[src*="head"], img[class*="avatar"], [class*="avatar"] img')
      if (avatarImg?.src && (avatarImg.src.includes('qrc.bgstatic') || avatarImg.src.includes('img.bgstatic'))) {
        result.avatar = avatarImg.src
      }
      
      const roiMatch = text.match(/ROI[\s\n:]*([+-]?[\d,]+\.?\d*)%/i)
      if (roiMatch) result.roi = parseFloat(roiMatch[1].replace(/,/g, ''))
      
      const pnlMatch = text.match(/(?:Total P&?L|总收益|Profit)[\s\n:]*\$?([\d,]+\.?\d*)/i)
      if (pnlMatch) result.pnl = parseFloat(pnlMatch[1].replace(/,/g, ''))
      
      const winMatch = text.match(/(?:Win rate|胜率)[\s\n:]*(\d+\.?\d*)%/i)
      if (winMatch) result.winRate = parseFloat(winMatch[1])
      
      const mddMatch = text.match(/(?:MDD|Max(?:imum)? Drawdown|最大回撤)[\s\n:]*(\d+\.?\d*)%/i)
      if (mddMatch) result.maxDrawdown = parseFloat(mddMatch[1])
      
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

async function fetchAllDetailsParallel(browser, traders, period) {
  const limit = pLimit(CONCURRENCY)
  const startTime = Date.now()
  
  console.log(`\n🚀 并行获取详情 (并发: ${CONCURRENCY})...`)
  
  let completed = 0
  const total = traders.length
  
  const results = await Promise.all(
    traders.map((trader, index) =>
      limit(async () => {
        const details = await fetchTraderDetails(browser, trader.traderId, period)
        completed++
        
        if (completed % 10 === 0 || completed === total) {
          const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
          console.log(`  进度: ${completed}/${total} | 耗时: ${elapsed}s`)
        }
        
        return {
          ...trader,
          ...details,
          rank: index + 1,
        }
      })
    )
  )
  
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
  console.log(`  ✓ 详情获取完成，耗时: ${elapsed}s`)
  
  return results
}

async function saveTradersBatch(traders, period) {
  console.log(`\n💾 批量保存 ${traders.length} 条数据...`)
  
  const capturedAt = new Date().toISOString()
  
  // 批量 upsert trader_sources
  const sourcesData = traders.map(t => ({
    source: SOURCE,
    source_type: 'leaderboard',
    source_trader_id: t.traderId,
    handle: t.nickname,
    profile_url: t.avatar || null,
    is_active: true,
  }))
  
  await supabase.from('trader_sources').upsert(sourcesData, { onConflict: 'source,source_trader_id' })
  
  // 批量 insert trader_snapshots
  const snapshotsData = traders.map(t => ({
    source: SOURCE,
    source_trader_id: t.traderId,
    season_id: period,
    rank: t.rank,
    roi: t.roi || 0,
    pnl: t.pnl || null,
    win_rate: t.winRate || null,
    max_drawdown: t.maxDrawdown || null,
    followers: t.followers || null,
    captured_at: capturedAt,
  }))
  
  const { error } = await supabase.from('trader_snapshots').insert(snapshotsData)
  
  if (error) {
    console.log(`  ⚠ 批量保存失败: ${error.message}`)
    let saved = 0
    for (const s of snapshotsData) {
      const { error: e } = await supabase.from('trader_snapshots').insert(s)
      if (!e) saved++
    }
    return saved
  }
  
  console.log(`  ✓ 保存成功: ${snapshotsData.length} 条`)
  return snapshotsData.length
}

async function main() {
  const periods = getTargetPeriods()
  const totalStartTime = Date.now()
  
  console.log(`\n========================================`)
  console.log(`Bitget Spot 数据抓取 v2 (优化版)`)
  console.log(`目标周期: ${periods.join(', ')}`)
  console.log(`========================================`)
  console.log('时间:', new Date().toISOString())
  
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled'],
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
      
      // 2. 排序
      traders.sort((a, b) => (b.roi || 0) - (a.roi || 0))
      
      console.log(`\n📋 ${period} TOP 5:`)
      traders.slice(0, 5).forEach((t, i) => {
        console.log(`  ${i + 1}. ${t.nickname} (${t.traderId.slice(0, 8)}...): ROI ${t.roi?.toFixed(2) || 0}%`)
      })
      
      // 3. 并行获取详情
      const enrichedTraders = await fetchAllDetailsParallel(browser, traders, period)
      
      // 4. 保存
      const saved = await saveTradersBatch(enrichedTraders, period)
      results.push({ period, count: traders.length, saved, topRoi: traders[0]?.roi || 0 })
      
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
