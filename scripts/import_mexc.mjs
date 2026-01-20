/**
 * MEXC Copy Trading 排行榜数据抓取 (修复版)
 * 
 * 优化：
 * 1. 拦截 API 响应获取数据
 * 2. 更准确的翻页逻辑
 * 3. 更好的数据提取
 * 
 * 用法: node scripts/import_mexc.mjs [7D|30D|90D]
 */

import 'dotenv/config'
import puppeteer from 'puppeteer-extra'
import StealthPlugin from 'puppeteer-extra-plugin-stealth'
import { createClient } from '@supabase/supabase-js'

puppeteer.use(StealthPlugin())

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Error: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set')
  process.exit(1)
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

const SOURCE = 'mexc'
const BASE_URL = 'https://www.mexc.com/futures/copyTrade/home'
const TARGET_COUNT = 100
const MAX_PAGES = 20

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function getTargetPeriod() {
  const arg = process.argv[2]?.toUpperCase()
  if (arg && ['7D', '30D', '90D'].includes(arg)) return arg
  return '90D'
}

async function fetchLeaderboardData(period) {
  console.log(`\n=== 抓取 MEXC ${period} 排行榜 ===`)
  console.log('时间:', new Date().toISOString())
  console.log(`目标: ${TARGET_COUNT} 个交易员`)

  const traders = new Map()

  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled'],
  })

  try {
    const page = await browser.newPage()
    await page.setViewport({ width: 1920, height: 1080 })
    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36')

    // 拦截 API 响应
    page.on('response', async response => {
      const url = response.url()
      // MEXC 跟单 API
      if (url.includes('copy') || url.includes('trader') || url.includes('rank') || url.includes('leader')) {
        try {
          const contentType = response.headers()['content-type'] || ''
          if (contentType.includes('json')) {
            const data = await response.json()
            
            // 尝试从各种数据结构中提取
            let list = data?.data?.list || data?.data?.items || data?.data?.traders || data?.list || []
            if (data?.data && Array.isArray(data.data)) list = data.data
            
            if (Array.isArray(list) && list.length > 0) {
              console.log(`  📡 API: ${url.split('?')[0].split('/').slice(-2).join('/')} - ${list.length} 条`)
              
              list.forEach(item => {
                const traderId = item.traderId || item.uid || item.id || item.userId || ''
                if (!traderId || traders.has(traderId)) return
                
                let roi = parseFloat(item.roi || item.totalRoi || item.pnlRate || 0)
                // 如果 ROI 是小数形式（如 0.5432），转换为百分比
                if (Math.abs(roi) < 10) roi = roi * 100
                
                traders.set(traderId, {
                  traderId: String(traderId),
                  nickname: item.nickName || item.nickname || item.name || item.displayName || `Trader_${traderId}`,
                  avatar: item.avatar || item.avatarUrl || null,
                  roi,
                  pnl: parseFloat(item.pnl || item.totalPnl || item.profit || 0),
                  winRate: parseFloat(item.winRate || 0) * (item.winRate > 1 ? 1 : 100),
                  maxDrawdown: parseFloat(item.mdd || item.maxDrawdown || 0),
                  followers: parseInt(item.followerCount || item.copierCount || item.followers || 0),
                })
              })
              
              console.log(`    累计: ${traders.size} 个`)
            }
          }
        } catch (e) {
          // 忽略
        }
      }
    })

    console.log('\n📱 访问页面...')
    try {
      await page.goto(BASE_URL, { waitUntil: 'networkidle2', timeout: 60000 })
    } catch (e) {
      console.log('  ⚠ 加载超时，继续...')
    }
    await sleep(8000)

    // 关闭弹窗
    console.log('🔄 关闭弹窗...')
    await page.evaluate(() => {
      const closeTexts = ['关闭', 'OK', 'Got it', '确定', 'Close', 'I understand', '知道了']
      document.querySelectorAll('button, [class*="close"], [class*="modal"] *').forEach(el => {
        const text = (el.textContent || '').trim()
        const className = typeof el.className === 'string' ? el.className : ''
        if (closeTexts.some(t => text.includes(t)) || className.includes('close')) {
          try { el.click() } catch {}
        }
      })
    })
    await sleep(2000)

    // 点击 "全部交易员" 或 "All Traders"
    console.log('🔄 点击全部交易员...')
    const allTradersClicked = await page.evaluate(() => {
      const targets = ['All Traders', '全部交易员', 'All', '全部', 'Top Traders']
      const elements = document.querySelectorAll('button, [role="tab"], [class*="tab"], span, div')
      for (const el of elements) {
        const text = (el.textContent || '').trim()
        if (targets.includes(text)) {
          el.click()
          return text
        }
      }
      return null
    })
    if (allTradersClicked) {
      console.log(`  ✓ 点击: ${allTradersClicked}`)
      await sleep(3000)
    }

    // 点击 ROI 排序
    console.log('🔄 点击 ROI 排序...')
    await page.evaluate(() => {
      const elements = document.querySelectorAll('th, [class*="header"] *, [class*="sort"] *, span, div')
      for (const el of elements) {
        const text = (el.textContent || '').trim()
        if (text === 'ROI' || text === 'ROI%' || text === '收益率') {
          el.click()
          return true
        }
      }
      return false
    })
    await sleep(3000)

    // 从 DOM 提取数据的函数
    const extractFromDOM = async () => {
      return await page.evaluate(() => {
        const results = []
        
        // 方法1: 查找交易员卡片
        const cards = document.querySelectorAll('[class*="trader"], [class*="card"], [class*="item"], [class*="row"]')
        cards.forEach(card => {
          const text = card.innerText || ''
          
          // 提取用户名
          const nameEl = card.querySelector('[class*="name"], [class*="nick"], [class*="title"]')
          const nickname = nameEl?.innerText?.trim() || ''
          
          // 提取 ROI (找最大的百分比数值)
          const roiMatches = text.match(/([+-]?\d{1,6}(?:,?\d{3})*(?:\.\d+)?)\s*%/g) || []
          let maxRoi = 0
          roiMatches.forEach(m => {
            const val = parseFloat(m.replace(/[,%]/g, ''))
            if (Math.abs(val) > Math.abs(maxRoi) && Math.abs(val) < 100000) {
              maxRoi = val
            }
          })
          
          if (nickname && nickname.length >= 2 && nickname.length <= 30 && maxRoi !== 0) {
            // 过滤掉明显不是用户名的文本
            if (!nickname.match(/^[+-]?\d/) && 
                !nickname.includes('%') && 
                !nickname.includes('ROI') && 
                !nickname.includes('USDT') &&
                !nickname.includes('Days')) {
              results.push({ nickname, roi: maxRoi })
            }
          }
        })
        
        // 方法2: 从纯文本提取
        if (results.length < 10) {
          const bodyText = document.body.innerText
          const lines = bodyText.split('\n').map(l => l.trim()).filter(l => l)
          
          for (let i = 0; i < lines.length; i++) {
            const line = lines[i]
            // 检查是否是用户名格式
            if (line.length >= 2 && line.length <= 25 &&
                !line.match(/^[+-]?\d/) && 
                !line.includes('%') &&
                !line.includes('ROI') && 
                !line.includes('USDT') &&
                !line.includes('Days') &&
                !line.includes('MDD') &&
                !line.includes('Followers')) {
              
              // 在后面几行找 ROI
              for (let j = 1; j <= 5; j++) {
                const nextLine = lines[i + j] || ''
                const roiMatch = nextLine.match(/^([+-]?\d{1,6}(?:,?\d{3})*(?:\.\d+)?)\s*%$/)
                if (roiMatch) {
                  const roi = parseFloat(roiMatch[1].replace(/,/g, ''))
                  if (Math.abs(roi) < 100000 && !results.find(r => r.nickname === line)) {
                    results.push({ nickname: line, roi })
                  }
                  break
                }
              }
            }
          }
        }
        
        return results
      })
    }

    // 如果 API 拦截不够，从 DOM 提取并翻页
    console.log('\n📄 分页获取数据...')
    let noNewDataCount = 0
    
    for (let pageNum = 1; pageNum <= MAX_PAGES && traders.size < TARGET_COUNT; pageNum++) {
      const lastCount = traders.size
      
      // 从 DOM 提取
      const domTraders = await extractFromDOM()
      domTraders.forEach(t => {
        const id = t.nickname // 使用昵称作为临时 ID
        if (!traders.has(id) && t.roi !== 0) {
          traders.set(id, {
            traderId: id,
            nickname: t.nickname,
            avatar: null,
            roi: t.roi,
            pnl: null,
            winRate: null,
            maxDrawdown: null,
            followers: null,
          })
        }
      })
      
      console.log(`  第 ${pageNum} 页: DOM ${domTraders.length} 个，累计 ${traders.size} 个`)
      
      if (traders.size >= TARGET_COUNT) {
        console.log(`  ✓ 已达到目标`)
        break
      }
      
      if (traders.size === lastCount) {
        noNewDataCount++
        if (noNewDataCount >= 3) {
          console.log('  连续3次无新数据，尝试其他方法...')
        }
        if (noNewDataCount >= 5) {
          console.log('  停止翻页')
          break
        }
      } else {
        noNewDataCount = 0
      }
      
      // 翻页 - 多种方式尝试
      let clicked = false
      
      // 方式1: 点击下一页按钮
      clicked = await page.evaluate(() => {
        const nextBtns = document.querySelectorAll(
          '[class*="next"]:not([disabled]), ' +
          '[aria-label*="next"]:not([disabled]), ' +
          'button[class*="page"]:not([disabled])'
        )
        for (const btn of nextBtns) {
          if (btn.offsetParent) {
            btn.click()
            return true
          }
        }
        return false
      })
      
      // 方式2: 点击页码
      if (!clicked) {
        clicked = await page.evaluate((targetPage) => {
          const pagers = document.querySelectorAll('li[class*="page"] button, [class*="pagination"] button, [class*="pager"] *')
          for (const p of pagers) {
            if (p.textContent?.trim() === String(targetPage) && p.offsetParent && !p.disabled) {
              p.click()
              return true
            }
          }
          return false
        }, pageNum + 1)
      }
      
      // 方式3: 滚动加载
      if (!clicked) {
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
      }
      
      await sleep(3000)
    }

    console.log(`\n📊 共获取 ${traders.size} 个交易员`)
    
    await page.screenshot({ path: `/tmp/mexc_${period}_${Date.now()}.png`, fullPage: true })

  } finally {
    await browser.close()
  }

  return Array.from(traders.values())
}

async function saveTraders(traders, period) {
  console.log(`\n💾 批量保存 ${traders.length} 个交易员...`)
  
  const capturedAt = new Date().toISOString()

  const sourcesData = traders.map(t => ({
    source: SOURCE,
    source_type: 'leaderboard',
    source_trader_id: t.traderId,
    handle: t.nickname,
    is_active: true,
  }))

  const snapshotsData = traders.map((t, idx) => ({
    source: SOURCE,
    source_trader_id: t.traderId,
    season_id: period,
    rank: idx + 1,
    roi: t.roi,
    pnl: t.pnl,
    win_rate: t.winRate,
    max_drawdown: t.maxDrawdown,
    followers: t.followers || 0,
    captured_at: capturedAt,
  }))

  await supabase.from('trader_sources').upsert(sourcesData, { onConflict: 'source,source_trader_id' })

  const { error } = await supabase.from('trader_snapshots').insert(snapshotsData)
  
  if (error) {
    console.log(`  ⚠ 批量保存失败: ${error.message}`)
    let saved = 0
    for (const s of snapshotsData) {
      const { error: e } = await supabase.from('trader_snapshots').insert(s)
      if (!e) saved++
    }
    console.log(`  逐条保存: ${saved}/${snapshotsData.length}`)
    return { saved, errors: snapshotsData.length - saved }
  }

  console.log(`  ✓ 保存成功: ${snapshotsData.length}`)
  return { saved: snapshotsData.length, errors: 0 }
}

async function main() {
  const period = getTargetPeriod()
  console.log(`\n========================================`)
  console.log(`MEXC 数据抓取 (修复版) - ${period}`)
  console.log(`========================================`)

  const traders = await fetchLeaderboardData(period)

  if (traders.length === 0) {
    console.log('\n⚠ 未获取到数据')
    return
  }

  // 按 ROI 排序
  traders.sort((a, b) => (b.roi || 0) - (a.roi || 0))
  traders.forEach((t, idx) => t.rank = idx + 1)

  const top100 = traders.slice(0, TARGET_COUNT)

  console.log(`\n📋 TOP 10:`)
  top100.slice(0, 10).forEach((t, idx) => {
    console.log(`  ${idx + 1}. ${t.nickname}: ROI ${t.roi?.toFixed(2)}%`)
  })

  const result = await saveTraders(top100, period)

  console.log(`\n========================================`)
  console.log(`✅ 完成！`)
  console.log(`   获取: ${traders.length}`)
  console.log(`   保存: ${result.saved}`)
  console.log(`========================================`)
}

main()
