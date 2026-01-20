/**
 * Bybit Copy Trading 排行榜数据抓取 (优化版)
 * 
 * 优化点：
 * 1. 更好的 ROI 匹配模式
 * 2. 并行获取详情
 * 3. 批量保存
 * 
 * 用法: node scripts/import_bybit.mjs [7D|30D|90D]
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

const SOURCE = 'bybit'
const BASE_URL = 'https://www.bybit.com/copyTrade/tradeCenter/leaderBoard'
const TARGET_COUNT = 100
const CONCURRENCY = 5

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function getTargetPeriod() {
  const arg = process.argv[2]?.toUpperCase()
  if (arg && ['7D', '30D', '90D'].includes(arg)) return arg
  return '90D'
}

async function fetchLeaderboardData(period) {
  console.log(`\n=== 抓取 Bybit ${period} 排行榜 ===`)
  console.log('时间:', new Date().toISOString())
  console.log(`目标: ${TARGET_COUNT} 个交易员`)

  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled'],
  })

  const allTraders = new Map()

  try {
    const page = await browser.newPage()
    await page.setViewport({ width: 1920, height: 1080 })
    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36')

    // 监听 API 响应
    page.on('response', async (response) => {
      const url = response.url()
      if (url.includes('leaderBoard') || url.includes('leader') || url.includes('rank')) {
        try {
          const json = await response.json()
          if (json.result?.list || json.data?.list || Array.isArray(json.result)) {
            const list = json.result?.list || json.data?.list || json.result || []
            console.log(`  📡 拦截到 API 数据: ${list.length} 条`)
            
            list.forEach((item, idx) => {
              const traderId = item.leaderId || item.traderUid || item.uid || ''
              if (!traderId || allTraders.has(traderId)) return
              
              allTraders.set(traderId, {
                traderId: String(traderId),
                nickname: item.nickName || item.leaderName || null,
                avatar: item.avatar || item.avatarUrl || null,
                roi: parseFloat(item.roi || item.roiRate || 0) * (item.roi > 10 ? 1 : 100),
                pnl: parseFloat(item.pnl || item.totalPnl || 0),
                winRate: parseFloat(item.winRate || 0),
                maxDrawdown: parseFloat(item.mdd || item.maxDrawdown || 0),
                followers: parseInt(item.followerCount || item.copierNum || 0),
              })
            })
          }
        } catch {}
      }
    })

    console.log('\n📱 访问页面...')
    try {
      await page.goto(BASE_URL, { waitUntil: 'networkidle2', timeout: 45000 })
    } catch (e) {
      console.log('  ⚠ 加载超时，继续...')
    }
    await sleep(5000)

    // 关闭各种弹窗
    console.log('🔄 关闭弹窗...')
    await page.evaluate(() => {
      // 关闭地区弹窗
      document.querySelectorAll('button, div, span').forEach(el => {
        const text = (el.textContent || '').toLowerCase()
        if (text.includes("don't live") || text.includes('confirm') || 
            text.includes('accept') || text.includes('got it') ||
            text.includes('close') || text.includes('ok')) {
          try { el.click() } catch {}
        }
      })
      // 关闭模态框
      document.querySelectorAll('[class*="modal"] [class*="close"], [class*="dialog"] [class*="close"]').forEach(el => {
        try { el.click() } catch {}
      })
    })
    await sleep(2000)

    // 切换时间周期
    console.log(`🔄 切换到 ${period}...`)
    const periodMap = { '7D': '7', '30D': '30', '90D': '90' }
    await page.evaluate((days) => {
      const buttons = document.querySelectorAll('button, div, span, [role="tab"]')
      for (const btn of buttons) {
        const text = (btn.textContent || '').trim()
        if (text === `${days}D` || text === `${days} Days` || text.includes(`${days}天`)) {
          btn.click()
          return true
        }
      }
      return false
    }, periodMap[period])
    await sleep(3000)

    // 点击 ROI 排序
    console.log('🔄 点击 ROI 排序...')
    await page.evaluate(() => {
      const elements = document.querySelectorAll('*')
      for (const el of elements) {
        const text = (el.textContent || '').trim()
        if (text === 'ROI' || text === 'Top ROI' || text.includes('收益率')) {
          el.click()
          return true
        }
      }
      return false
    })
    await sleep(3000)

    console.log(`  API 拦截到: ${allTraders.size} 个`)

    // 如果 API 拦截数据不够，从页面提取
    if (allTraders.size < TARGET_COUNT) {
      console.log('\n📄 滚动加载更多数据...')
      
      for (let scroll = 1; scroll <= 50; scroll++) {
        await page.evaluate(() => window.scrollBy(0, 800))
        await sleep(800)
        
        // 每10次滚动检查一次
        if (scroll % 10 === 0) {
          console.log(`  滚动 ${scroll}，当前: ${allTraders.size} 个`)
          if (allTraders.size >= TARGET_COUNT) break
        }
      }
    }

    // 如果仍然不够，从 DOM 提取
    if (allTraders.size < TARGET_COUNT) {
      console.log('\n📄 从页面 DOM 提取数据...')
      const domTraders = await page.evaluate(() => {
        const results = []
        
        // 方法1: 从卡片提取完整数据
        const cards = document.querySelectorAll('[class*="trader"], [class*="leader"], [class*="card"], [class*="item"]')
        cards.forEach(card => {
          const text = card.innerText || ''
          
          // 提取头像
          const img = card.querySelector('img[src*="avatar"], img[src*="user"], img[class*="avatar"]')
          let avatar = null
          if (img?.src && !img.src.includes('placeholder') && !img.src.includes('default')) {
            avatar = img.src
          }
          
          // 提取链接和 ID
          const link = card.querySelector('a[href*="leader"], a[href*="trader"]')
          const href = link?.href || ''
          const idMatch = href.match(/\/(\d+)(?:$|\?)/) || href.match(/leaderId=(\d+)/)
          
          // 提取名字
          const nameEl = card.querySelector('[class*="name"], [class*="nick"]')
          const nickname = nameEl?.innerText?.trim()?.split('\n')[0] || ''
          
          // 提取 ROI
          const roiMatch = text.match(/([+-]?[\d,]+\.?\d*)\s*%/)
          const roi = roiMatch ? parseFloat(roiMatch[1].replace(/,/g, '')) : 0
          
          if (idMatch && nickname && roi > 0) {
            results.push({
              traderId: idMatch[1],
              nickname,
              avatar,
              roi,
            })
          }
        })
        
        // 方法2: 从链接获取基础信息
        if (results.length < 10) {
          const links = document.querySelectorAll('a[href*="leader"], a[href*="trader"]')
          links.forEach(link => {
            const href = link.href
            const idMatch = href.match(/\/(\d+)(?:$|\?)/) || href.match(/leaderId=(\d+)/)
            if (idMatch) {
              const text = link.textContent?.trim() || ''
              // 尝试获取附近的头像
              const parent = link.closest('[class*="card"], [class*="item"], div')
              const img = parent?.querySelector('img')
              let avatar = null
              if (img?.src && img.src.includes('avatar')) {
                avatar = img.src
              }
              
              if (text && text.length >= 2 && text.length <= 30) {
                results.push({
                  traderId: idMatch[1],
                  nickname: text.split('\n')[0].trim(),
                  avatar,
                })
              }
            }
          })
        }
        
        return results
      })
      
      console.log(`  DOM 提取: ${domTraders.length} 条原始数据`)
      
      // 合并 DOM 数据
      domTraders.forEach(t => {
        if (t.traderId && !allTraders.has(t.traderId)) {
          allTraders.set(t.traderId, {
            traderId: t.traderId,
            nickname: t.nickname,
            avatar: t.avatar || null,
            roi: t.roi || 0,
            pnl: 0,
            winRate: 0,
            maxDrawdown: 0,
            followers: 0,
          })
        }
      })
    }

    console.log(`\n📊 共获取 ${allTraders.size} 个交易员数据`)
    
    await page.screenshot({ path: `/tmp/bybit_${period}_${Date.now()}.png`, fullPage: true })

  } finally {
    await browser.close()
  }

  return Array.from(allTraders.values())
}

async function saveTradersBatch(traders, period) {
  console.log(`\n💾 批量保存 ${traders.length} 个交易员...`)
  
  const capturedAt = new Date().toISOString()
  
  // 批量 upsert trader_sources
  const sourcesData = traders.map(t => ({
    source: SOURCE,
    source_type: 'leaderboard',
    source_trader_id: t.traderId,
    handle: t.nickname,
    profile_url: t.avatar,
    is_active: true,
  }))
  
  await supabase.from('trader_sources').upsert(sourcesData, { onConflict: 'source,source_trader_id' })
  
  // 批量 insert trader_snapshots
  const snapshotsData = traders.map((t, idx) => ({
    source: SOURCE,
    source_trader_id: t.traderId,
    season_id: period,
    rank: idx + 1,
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
    // 逐条重试
    let saved = 0
    for (const s of snapshotsData) {
      const { error: e } = await supabase.from('trader_snapshots').insert(s)
      if (!e) saved++
    }
    console.log(`  逐条保存: ${saved}/${snapshotsData.length}`)
    return saved
  }
  
  console.log(`  ✓ 保存成功: ${snapshotsData.length} 条`)
  return snapshotsData.length
}

async function main() {
  const period = getTargetPeriod()
  const startTime = Date.now()
  
  console.log(`\n========================================`)
  console.log(`Bybit 数据抓取 (优化版) - ${period}`)
  console.log(`========================================`)

  const traders = await fetchLeaderboardData(period)

  if (traders.length === 0) {
    console.log('\n⚠ 未获取到数据，请检查截图')
    return
  }

  // 排序
  traders.sort((a, b) => (b.roi || 0) - (a.roi || 0))
  const top100 = traders.slice(0, TARGET_COUNT)

  console.log(`\n📋 TOP 10:`)
  top100.slice(0, 10).forEach((t, idx) => {
    console.log(`  ${idx + 1}. ${t.nickname || t.traderId}: ROI ${t.roi?.toFixed(2)}%`)
  })

  const saved = await saveTradersBatch(top100, period)
  
  const totalTime = ((Date.now() - startTime) / 1000).toFixed(1)

  console.log(`\n========================================`)
  console.log(`✅ 完成！`)
  console.log(`   来源: ${SOURCE}`)
  console.log(`   周期: ${period}`)
  console.log(`   获取: ${traders.length}`)
  console.log(`   保存: ${saved}`)
  console.log(`   耗时: ${totalTime}s`)
  console.log(`========================================`)
}

main()
