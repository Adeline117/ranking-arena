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
const BASE_URL = 'https://www.bybit.com/copyTrade/'
const TARGET_COUNT = 500
const CONCURRENCY = 5

// ============================================
// Arena Score 计算逻辑
// ============================================

const ARENA_CONFIG = {
  PARAMS: {
    '7D': { tanhCoeff: 0.08, roiExponent: 1.8, mddThreshold: 15, winRateCap: 62 },
    '30D': { tanhCoeff: 0.15, roiExponent: 1.6, mddThreshold: 30, winRateCap: 68 },
    '90D': { tanhCoeff: 0.18, roiExponent: 1.6, mddThreshold: 40, winRateCap: 70 },
  },
  MAX_RETURN_SCORE: 85,
  MAX_DRAWDOWN_SCORE: 8,
  MAX_STABILITY_SCORE: 7,
}

const clip = (v, min, max) => Math.max(min, Math.min(max, v))
const safeLog1p = x => x <= -1 ? 0 : Math.log(1 + x)
const getPeriodDays = p => p === '7D' ? 7 : p === '30D' ? 30 : 90

function calculateArenaScore(roi, pnl, maxDrawdown, winRate, period) {
  const params = ARENA_CONFIG.PARAMS[period] || ARENA_CONFIG.PARAMS['90D']
  const days = getPeriodDays(period)
  
  const wr = winRate !== null && winRate !== undefined 
    ? (winRate <= 1 ? winRate * 100 : winRate) 
    : null
  
  const intensity = (365 / days) * safeLog1p(roi / 100)
  const r0 = Math.tanh(params.tanhCoeff * intensity)
  const returnScore = r0 > 0 ? clip(ARENA_CONFIG.MAX_RETURN_SCORE * Math.pow(r0, params.roiExponent), 0, 85) : 0
  
  const drawdownScore = maxDrawdown !== null && maxDrawdown !== undefined
    ? clip(ARENA_CONFIG.MAX_DRAWDOWN_SCORE * clip(1 - Math.abs(maxDrawdown) / params.mddThreshold, 0, 1), 0, 8)
    : 4
  
  const stabilityScore = wr !== null
    ? clip(ARENA_CONFIG.MAX_STABILITY_SCORE * clip((wr - 45) / (params.winRateCap - 45), 0, 1), 0, 7)
    : 3.5
  
  return Math.round((returnScore + drawdownScore + stabilityScore) * 100) / 100
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

async function fetchLeaderboardData(period) {
  console.log(`\n=== 抓取 Bybit ${period} 排行榜 ===`)
  console.log('时间:', new Date().toISOString())
  console.log(`目标: ${TARGET_COUNT} 个交易员`)

  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled', '--disable-dev-shm-usage'],
    timeout: 60000,
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

      // 调试：打印页面信息
      const debugInfo = await page.evaluate(() => {
        const buttons = document.querySelectorAll('button')
        const copyButtons = Array.from(buttons).filter(b => b.innerText?.includes('Copy'))
        const allText = document.body.innerText

        // 查找所有包含 % 的文本片段
        const percentMatches = allText.match(/\S{0,5}\d+\.\d+%/g) || []
        // 尝试更宽松的 ROI 匹配
        const roiMatches = allText.match(/\d{1,4}\.\d{1,2}\s*%/g) || []

        // 找到第一个 Copy 按钮附近的文本
        let nearCopyText = ''
        if (copyButtons.length > 0) {
          const card = copyButtons[0].closest('div')?.parentElement?.parentElement
          if (card) {
            nearCopyText = card.innerText?.slice(0, 200) || ''
          }
        }

        return {
          totalButtons: buttons.length,
          copyButtons: copyButtons.length,
          percentMatches: percentMatches.slice(0, 10),
          roiMatches: roiMatches.slice(0, 10),
          nearCopyText: nearCopyText.replace(/\n/g, ' | '),
        }
      })
      console.log(`  调试信息:`)
      console.log(`    - 总按钮数: ${debugInfo.totalButtons}`)
      console.log(`    - Copy按钮: ${debugInfo.copyButtons}`)
      console.log(`    - 百分比匹配: ${debugInfo.percentMatches.join(', ')}`)
      console.log(`    - ROI匹配: ${debugInfo.roiMatches.join(', ')}`)
      console.log(`    - 卡片文本: ${debugInfo.nearCopyText.slice(0, 150)}`)

      const domTraders = await page.evaluate(() => {
        const results = []
        const seen = new Set()

        // Bybit 使用卡片布局展示交易员
        // 方法1: 查找所有带 "Copy" 按钮的卡片
        const copyButtons = document.querySelectorAll('button')
        copyButtons.forEach(btn => {
          if (btn.innerText?.trim() !== 'Copy') return

          // 找到包含这个按钮的卡片容器
          const card = btn.closest('div[class*="card"], div[class*="Item"], div[class*="trader"]') || btn.parentElement?.parentElement?.parentElement

          if (!card) return

          // 清理文本 - 移除不可见字符
          const text = (card.innerText || '').replace(/[\u200B-\u200D\u200E\u200F\uFEFF]/g, '')

          // 提取 ROI - 格式如 "+40.04%" "+87.02%"，可能有特殊字符
          // 匹配: +40.04% 或 -10.5% (允许数字和%之间有任意字符)
          const roiMatch = text.match(/([+-])(\d{1,4}(?:\.\d{1,2})?)[\s\u200B-\u200F]*%/)
          if (!roiMatch) return

          const sign = roiMatch[1] === '-' ? -1 : 1
          const roi = parseFloat(roiMatch[2]) * sign

          // 提取名字 - 通常在卡片顶部，可能有特殊字符
          // 查找包含名字的元素（不是数字开头的文本）
          let nickname = ''
          const textElements = card.querySelectorAll('span, div, a')
          for (const el of textElements) {
            const t = (el.innerText || '').replace(/[\u200B-\u200D\u200E\u200F\uFEFF]/g, '').trim()
            // 名字通常是2-20字符，不以数字或+/-开头
            if (t.length >= 2 && t.length <= 25 && !t.match(/^[0-9+\-$%]/) && !t.includes('Copy') && !t.includes('MYT') && !t.includes('ROI') && !t.includes('Drawdown')) {
              nickname = t.split('\n')[0].trim()
              break
            }
          }

          if (!nickname) return

          // 生成一个基于名字的唯一 ID（因为卡片可能没有链接）
          const traderId = nickname.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase()

          if (seen.has(traderId)) return
          seen.add(traderId)

          // 提取头像
          const img = card.querySelector('img')
          let avatar = null
          if (img?.src && !img.src.includes('placeholder') && !img.src.includes('default')) {
            avatar = img.src
          }

          results.push({
            traderId,
            nickname,
            avatar,
            roi,
          })
        })

        // 方法2: 通过页面文本块提取
        if (results.length < 10) {
          // 清理整个页面文本
          const allText = (document.body.innerText || '').replace(/[\u200B-\u200D\u200E\u200F\uFEFF]/g, '')
          // 按 "Copy" 按钮分割，每个交易员卡片都有一个 Copy 按钮
          const blocks = allText.split(/\bCopy\b/)

          blocks.forEach((block, idx) => {
            if (idx === 0) return // 第一个块是页面头部

            // 提取 ROI - 处理特殊字符
            const roiMatch = block.match(/([+-])(\d{1,4}(?:\.\d{1,2})?)[\s]*%/)
            if (!roiMatch) return

            const sign = roiMatch[1] === '-' ? -1 : 1
            const roi = parseFloat(roiMatch[2]) * sign

            // 提取名字 - 在 ROI 之前的文本
            const beforeRoi = block.split(roiMatch[0])[0]
            const lines = beforeRoi.split('\n').filter(l => l.trim().length > 1)

            let nickname = ''
            for (const line of lines) {
              const t = line.trim()
              if (t.length >= 2 && t.length <= 25 && !t.match(/^[0-9+\-$%.]/) && !t.includes('MYT') && !t.includes('ROI') && !t.includes('Drawdown')) {
                nickname = t
                break
              }
            }

            if (!nickname) return

            const traderId = nickname.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase()

            if (seen.has(traderId)) return
            seen.add(traderId)

            results.push({
              traderId,
              nickname,
              avatar: null,
              roi,
            })
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
  
  // 批量 insert trader_snapshots (包含 arena_score)
  const snapshotsData = traders.map((t, idx) => {
    const normalizedWinRate = t.winRate !== null && t.winRate !== undefined
      ? (t.winRate <= 1 ? t.winRate * 100 : t.winRate)
      : null
    const arenaScore = calculateArenaScore(t.roi || 0, t.pnl, t.maxDrawdown, normalizedWinRate, period)
    
    return {
      source: SOURCE,
      source_trader_id: t.traderId,
      season_id: period,
      rank: idx + 1,
      roi: t.roi || 0,
      pnl: t.pnl || null,
      win_rate: normalizedWinRate,
      max_drawdown: t.maxDrawdown || null,
      followers: t.followers || null,
      arena_score: arenaScore,
      captured_at: capturedAt,
    }
  })
  
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
  const periods = getTargetPeriods()
  const totalStartTime = Date.now()
  
  console.log(`\n========================================`)
  console.log(`Bybit 数据抓取 (优化版)`)
  console.log(`目标周期: ${periods.join(', ')}`)
  console.log(`========================================`)

  const results = []

  for (const period of periods) {
    console.log(`\n${'='.repeat(50)}`)
    console.log(`📊 开始抓取 ${period} 排行榜...`)
    console.log(`${'='.repeat(50)}`)
    
    const traders = await fetchLeaderboardData(period)

    if (traders.length === 0) {
      console.log(`\n⚠ ${period} 未获取到数据，跳过`)
      continue
    }

    traders.sort((a, b) => (b.roi || 0) - (a.roi || 0))
    const top100 = traders.slice(0, TARGET_COUNT)

    console.log(`\n📋 ${period} TOP 10:`)
    top100.slice(0, 10).forEach((t, idx) => {
      console.log(`  ${idx + 1}. ${t.nickname || t.traderId}: ROI ${t.roi?.toFixed(2)}%`)
    })

    const saved = await saveTradersBatch(top100, period)
    results.push({ period, count: traders.length, saved, topRoi: top100[0]?.roi || 0 })
    
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
    console.log(`   ${r.period}: ${r.saved} 条, TOP ROI ${r.topRoi?.toFixed(2)}%`)
  }
  console.log(`   总耗时: ${totalTime}s`)
  console.log(`${'='.repeat(60)}`)
}

main()
