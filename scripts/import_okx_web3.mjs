/**
 * OKX Web3 排行榜数据抓取 (修复版)
 * 
 * 优化：
 * 1. 拦截 API 响应获取数据
 * 2. 更完善的无限滚动加载
 * 3. 支持正负收益率
 * 
 * 用法: node scripts/import_okx_web3.mjs [7D|30D|90D]
 */

import 'dotenv/config'
import { chromium } from 'playwright'
import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Error: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set')
  process.exit(1)
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

const SOURCE = 'okx_web3'
const BASE_URL = 'https://web3.okx.com/copy-trade/leaderboard/solana'
const TARGET_COUNT = 100

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function getTargetPeriod() {
  const arg = process.argv[2]?.toUpperCase()
  if (arg && ['7D', '30D', '90D'].includes(arg)) return arg
  return '7D'
}

async function fetchLeaderboardData(period) {
  console.log(`\n=== 抓取 OKX Web3 ${period} 排行榜 ===`)
  console.log('时间:', new Date().toISOString())
  console.log(`目标: ${TARGET_COUNT} 个交易员`)

  const traders = new Map()

  const browser = await chromium.launch({
    headless: true,
    args: ['--disable-blink-features=AutomationControlled', '--no-sandbox'],
  })

  try {
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      viewport: { width: 1920, height: 1080 },
      locale: 'en-US',
    })

    await context.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined })
    })

    const page = await context.newPage()

    // 拦截 API 响应
    page.on('response', async (response) => {
      const url = response.url()
      // OKX Web3 API 通常包含这些关键词
      if (url.includes('leaderboard') || url.includes('rank') || url.includes('trader') || url.includes('copy-trade')) {
        try {
          const contentType = response.headers()['content-type'] || ''
          if (contentType.includes('json')) {
            const data = await response.json()
            
            // 尝试从各种可能的数据结构中提取
            let list = data?.data?.list || data?.data?.traders || data?.list || data?.traders || []
            if (data?.data && Array.isArray(data.data)) list = data.data
            
            if (Array.isArray(list) && list.length > 0) {
              console.log(`  📡 API 拦截: ${url.split('?')[0].split('/').slice(-2).join('/')} - ${list.length} 条`)
              
              list.forEach(item => {
                const traderId = item.address || item.traderId || item.uid || item.id || ''
                if (!traderId || traders.has(traderId)) return
                
                // 解析 ROI - 可能是小数或百分比
                let roi = parseFloat(item.roi || item.pnlRate || item.profitRate || 0)
                if (Math.abs(roi) < 10) roi = roi * 100 // 如果是小数形式，转为百分比
                
                // 解析 PnL
                let pnl = parseFloat(item.pnl || item.profit || item.totalPnl || 0)
                
                traders.set(traderId, {
                  traderId,
                  nickname: item.nickname || item.name || item.displayName || traderId.slice(0, 8) + '...',
                  avatar: item.avatar || item.avatarUrl || null,
                  roi,
                  pnl,
                  winRate: parseFloat(item.winRate || 0) * (item.winRate > 1 ? 1 : 100),
                  maxDrawdown: parseFloat(item.mdd || item.maxDrawdown || 0),
                  followers: parseInt(item.followers || item.copierCount || 0),
                })
              })
              
              console.log(`    累计: ${traders.size} 个`)
            }
          }
        } catch (e) {
          // 忽略解析错误
        }
      }
    })

    console.log('\n📱 访问页面...')
    try {
      await page.goto(BASE_URL, { waitUntil: 'networkidle', timeout: 60000 })
    } catch (e) {
      console.log('  ⚠ 加载超时，继续...')
    }
    await sleep(5000)

    // 关闭弹窗
    const closeButtons = ['I understand', 'Accept All Cookies', 'Got it', 'OK', 'Close']
    for (const text of closeButtons) {
      try {
        await page.click(`text=${text}`, { timeout: 1000 })
        console.log(`  关闭弹窗: ${text}`)
      } catch {}
    }
    await sleep(2000)

    // 如果 API 拦截数据不够，从 DOM 提取
    if (traders.size < TARGET_COUNT) {
      console.log('\n📊 从 DOM 提取数据...')
      
      const extractFromDOM = async () => {
        return await page.evaluate(() => {
          const results = []
          const seen = new Set()
          
          // 方法1: 查找所有可能的交易员卡片/行
          const cards = document.querySelectorAll('[class*="trader"], [class*="card"], [class*="item"], [class*="row"], [class*="user"], [class*="leader"]')
          cards.forEach(card => {
            const text = card.innerText || ''
            const lines = text.split('\n').map(l => l.trim()).filter(l => l)
            
            // 找地址 (xxxx...xxxx 格式)
            let address = null
            for (const line of lines) {
              const addrMatch = line.match(/([A-Za-z0-9]{4,8}\.\.\.[A-Za-z0-9]{4})/)
              if (addrMatch) {
                address = addrMatch[1]
                break
              }
            }
            
            // 找 ROI (任意 xxx.xx% 格式)
            let roi = null
            const roiMatches = text.match(/([+-]?[\d,]+\.?\d*)\s*%/g) || []
            for (const m of roiMatches) {
              const val = parseFloat(m.replace(/[,%]/g, ''))
              if (!isNaN(val) && Math.abs(val) > 0.01 && Math.abs(val) < 100000) {
                roi = val
                break
              }
            }
            
            // 找 PnL ($xxx 或 xxx USDT)
            let pnl = 0
            const pnlMatch = text.match(/\$\s*([\d,]+\.?\d*)([KM])?/) || text.match(/([\d,]+\.?\d*)\s*USDT/)
            if (pnlMatch) {
              pnl = parseFloat(pnlMatch[1].replace(/,/g, ''))
              if (pnlMatch[2] === 'K') pnl *= 1000
              if (pnlMatch[2] === 'M') pnl *= 1000000
            }
            
            if (address && roi !== null && !seen.has(address)) {
              seen.add(address)
              results.push({ address, nickname: address, roi, pnl })
            }
          })
          
          // 方法2: 从整个页面文本中提取
          if (results.length < 20) {
            const bodyText = document.body.innerText
            const lines = bodyText.split('\n').map(l => l.trim()).filter(l => l)
            
            for (let i = 0; i < lines.length; i++) {
              const line = lines[i]
              
              // 检查是否是地址格式
              const addrMatch = line.match(/^([A-Za-z0-9]{4,8}\.\.\.[A-Za-z0-9]{4})$/)
              if (addrMatch && !seen.has(addrMatch[1])) {
                // 在周围行查找 ROI
                const context = lines.slice(Math.max(0, i-3), i+6).join(' ')
                const roiMatch = context.match(/([+-]?[\d,]+\.?\d*)\s*%/)
                
                if (roiMatch) {
                  const roi = parseFloat(roiMatch[1].replace(/,/g, ''))
                  if (!isNaN(roi) && Math.abs(roi) > 0.01 && Math.abs(roi) < 100000) {
                    seen.add(addrMatch[1])
                    results.push({
                      address: addrMatch[1],
                      nickname: addrMatch[1],
                      roi,
                      pnl: 0,
                    })
                  }
                }
              }
            }
          }
          
          // 方法3: 查找所有包含 % 的元素并回溯找地址
          if (results.length < 20) {
            const allElements = document.querySelectorAll('*')
            allElements.forEach(el => {
              const text = el.textContent || ''
              if (text.match(/^[+-]?[\d.]+%$/) && !text.includes('\n')) {
                const roi = parseFloat(text.replace(/[%,]/g, ''))
                if (isNaN(roi) || Math.abs(roi) < 0.01 || Math.abs(roi) > 100000) return
                
                // 向上查找地址
                let parent = el.parentElement
                for (let j = 0; j < 10 && parent; j++) {
                  const parentText = parent.innerText || ''
                  const addrMatch = parentText.match(/([A-Za-z0-9]{4,8}\.\.\.[A-Za-z0-9]{4})/)
                  if (addrMatch && !seen.has(addrMatch[1])) {
                    seen.add(addrMatch[1])
                    results.push({
                      address: addrMatch[1],
                      nickname: addrMatch[1],
                      roi,
                      pnl: 0,
                    })
                    break
                  }
                  parent = parent.parentElement
                }
              }
            })
          }
          
          return results
        })
      }
      
      // 先提取初始数据
      const initialTraders = await extractFromDOM()
      initialTraders.forEach(item => {
        if (!traders.has(item.address)) {
          traders.set(item.address, {
            traderId: item.address,
            nickname: item.nickname,
            avatar: null,
            roi: item.roi,
            pnl: item.pnl,
            winRate: null,
            maxDrawdown: null,
            followers: null,
          })
        }
      })
      console.log(`  初始提取: ${traders.size} 个`)
      
      // 滚动加载更多
      let noNewDataCount = 0
      const maxScrollAttempts = 50
      
      for (let scroll = 1; scroll <= maxScrollAttempts && traders.size < TARGET_COUNT; scroll++) {
        const lastCount = traders.size
        
        // 多种滚动方式
        await page.evaluate(() => {
          // 滚动到底部
          window.scrollTo(0, document.body.scrollHeight)
        })
        await sleep(1500)
        
        // 尝试点击加载更多按钮
        const loadMoreClicked = await page.evaluate(() => {
          const buttons = document.querySelectorAll('button, [class*="more"], [class*="load"]')
          for (const btn of buttons) {
            const text = (btn.textContent || '').toLowerCase()
            if (text.includes('load more') || text.includes('加载更多') || text.includes('show more') || text.includes('view more')) {
              btn.click()
              return true
            }
          }
          return false
        })
        
        if (loadMoreClicked) {
          await sleep(2000)
        }
        
        // 尝试点击分页
        await page.evaluate((page) => {
          const pagers = document.querySelectorAll('[class*="page"], [class*="pagination"] *')
          for (const p of pagers) {
            if (p.textContent?.trim() === String(page)) {
              p.click()
              return true
            }
          }
          // 下一页按钮
          const nexts = document.querySelectorAll('[class*="next"]')
          for (const n of nexts) {
            if (n.offsetParent) {
              n.click()
              return true
            }
          }
          return false
        }, scroll + 1)
        await sleep(1500)
        
        // 提取数据
        const domTraders = await extractFromDOM()
        domTraders.forEach(item => {
          if (!traders.has(item.address)) {
            traders.set(item.address, {
              traderId: item.address,
              nickname: item.nickname,
              avatar: null,
              roi: item.roi,
              pnl: item.pnl,
              winRate: null,
              maxDrawdown: null,
              followers: null,
            })
          }
        })
        
        if (traders.size === lastCount) {
          noNewDataCount++
          if (noNewDataCount >= 8) {
            console.log(`  滚动 ${scroll}: 连续 ${noNewDataCount} 次无新数据，停止`)
            break
          }
        } else {
          noNewDataCount = 0
          if (scroll % 5 === 0 || traders.size >= TARGET_COUNT) {
            console.log(`  滚动 ${scroll}: 当前 ${traders.size} 个`)
          }
        }
      }
    }

    console.log(`\n📊 共获取 ${traders.size} 个交易员`)
    
    await page.screenshot({ path: `/tmp/okx_web3_${period}_${Date.now()}.png`, fullPage: true })

  } finally {
    await browser.close()
  }

  return Array.from(traders.values())
}

async function saveTraders(traders, period) {
  console.log(`\n💾 批量保存 ${traders.length} 个交易员...`)
  
  const capturedAt = new Date().toISOString()

  // 批量 upsert
  const sourcesData = traders.map(t => ({
    source: SOURCE,
    source_type: 'leaderboard',
    source_trader_id: t.traderId,
    handle: t.nickname,
    profile_url: t.avatar,
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

  const { error: sourceError } = await supabase
    .from('trader_sources')
    .upsert(sourcesData, { onConflict: 'source,source_trader_id' })

  if (sourceError) {
    console.log(`  ⚠ Sources 保存失败: ${sourceError.message}`)
  }

  const { error: snapshotError } = await supabase
    .from('trader_snapshots')
    .insert(snapshotsData)

  if (snapshotError) {
    console.log(`  ⚠ Snapshots 保存失败: ${snapshotError.message}`)
    // 逐条重试
    let saved = 0
    for (const s of snapshotsData) {
      const { error } = await supabase.from('trader_snapshots').insert(s)
      if (!error) saved++
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
  console.log(`OKX Web3 排行榜数据抓取 (修复版)`)
  console.log(`目标周期: ${period}`)
  console.log(`========================================`)

  const traders = await fetchLeaderboardData(period)

  if (traders.length === 0) {
    console.log('\n⚠ 未获取到数据')
    process.exit(1)
  }

  // 按 ROI 排序
  traders.sort((a, b) => (b.roi || 0) - (a.roi || 0))
  traders.forEach((t, idx) => t.rank = idx + 1)

  const topTraders = traders.slice(0, TARGET_COUNT)

  console.log(`\n📋 TOP 10:`)
  topTraders.slice(0, 10).forEach((t, idx) => {
    console.log(`  ${idx + 1}. ${t.nickname}: ROI ${t.roi?.toFixed(2)}%`)
  })

  const result = await saveTraders(topTraders, period)

  console.log(`\n========================================`)
  console.log(`✅ 完成！`)
  console.log(`   获取: ${traders.length}`)
  console.log(`   保存: ${result.saved}`)
  console.log(`========================================`)
}

main()
