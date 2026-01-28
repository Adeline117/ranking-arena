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
const TARGET_COUNT = 500
const CONCURRENCY = 5

// Arena Score 计算逻辑
const ARENA_CONFIG = {
  PARAMS: {
    '7D': { tanhCoeff: 0.08, roiExponent: 1.8, mddThreshold: 15, winRateCap: 62 },
    '30D': { tanhCoeff: 0.15, roiExponent: 1.6, mddThreshold: 30, winRateCap: 68 },
    '90D': { tanhCoeff: 0.18, roiExponent: 1.6, mddThreshold: 40, winRateCap: 70 },
  },
  MAX_RETURN_SCORE: 85, MAX_DRAWDOWN_SCORE: 8, MAX_STABILITY_SCORE: 7,
}
const clip = (v, min, max) => Math.max(min, Math.min(max, v))
const safeLog1p = x => x <= -1 ? 0 : Math.log(1 + x)
const getPeriodDays = p => p === '7D' ? 7 : p === '30D' ? 30 : 90

function calculateArenaScore(roi, pnl, maxDrawdown, winRate, period) {
  const params = ARENA_CONFIG.PARAMS[period] || ARENA_CONFIG.PARAMS['90D']
  const days = getPeriodDays(period)
  const wr = winRate !== null && winRate !== undefined ? (winRate <= 1 ? winRate * 100 : winRate) : null
  const intensity = (365 / days) * safeLog1p(roi / 100)
  const r0 = Math.tanh(params.tanhCoeff * intensity)
  const returnScore = r0 > 0 ? clip(ARENA_CONFIG.MAX_RETURN_SCORE * Math.pow(r0, params.roiExponent), 0, 85) : 0
  const drawdownScore = maxDrawdown !== null ? clip(ARENA_CONFIG.MAX_DRAWDOWN_SCORE * clip(1 - Math.abs(maxDrawdown) / params.mddThreshold, 0, 1), 0, 8) : 4
  const stabilityScore = wr !== null ? clip(ARENA_CONFIG.MAX_STABILITY_SCORE * clip((wr - 45) / (params.winRateCap - 45), 0, 1), 0, 7) : 3.5
  return Math.round((returnScore + drawdownScore + stabilityScore) * 100) / 100
}

// Spot URL - 使用用户提供的 URL
const PERIOD_CONFIG = {
  '7D': { url: 'https://www.bitget.com/asia/copy-trading/spot?rule=2&sort=0' },
  '30D': { url: 'https://www.bitget.com/asia/copy-trading/spot?rule=2&sort=0' },
  '90D': { url: 'https://www.bitget.com/asia/copy-trading/spot?rule=2&sort=0' },
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
    // 设置更真实的浏览器环境
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => false })
      Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] })
      Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en', 'zh-CN'] })
    })

    await page.goto(config.url, { waitUntil: 'networkidle0', timeout: 90000 })
    await sleep(3000)

    // 检查是否遇到 Cloudflare 挑战
    const isCloudflare = await page.evaluate(() => {
      const text = document.body?.innerText || ''
      return text.includes('Verify you are human') || text.includes('Cloudflare')
    })

    if (isCloudflare) {
      console.log('  ⚠ 检测到 Cloudflare 挑战，等待 15 秒...')
      // 尝试点击 Cloudflare checkbox
      await page.evaluate(() => {
        const checkbox = document.querySelector('input[type="checkbox"], [class*="checkbox"]')
        if (checkbox) checkbox.click()
      }).catch(() => {})
      await sleep(15000)

      // 重新检查
      const stillBlocked = await page.evaluate(() => {
        const text = document.body?.innerText || ''
        return text.includes('Verify you are human') || text.includes('Cloudflare')
      })
      if (stillBlocked) {
        console.log('  ⚠ 仍然被 Cloudflare 阻止，尝试刷新...')
        await page.reload({ waitUntil: 'networkidle0', timeout: 60000 })
        await sleep(5000)
      }
    }

    await sleep(3000)

    // 关闭所有弹窗（包括 Region Restricted 弹窗）
    await page.evaluate(() => {
      // 关闭各类弹窗按钮
      document.querySelectorAll('button, [role="button"]').forEach(btn => {
        const text = (btn.textContent || '').toLowerCase()
        if (text.includes('ok') || text.includes('got') || text.includes('accept') ||
            text.includes('confirm') || text.includes('close') || text.includes('dismiss') ||
            text.includes('continue') || text.includes('i understand') || text.includes('stay')) {
          try { btn.click() } catch {}
        }
      })
      // 关闭模态框的 X 按钮
      document.querySelectorAll('[class*="close"], [class*="dismiss"], [aria-label*="close"]').forEach(el => {
        try { el.click() } catch {}
      })
    }).catch(() => {})
    await sleep(2000)
    
    console.log(`  API 拦截到: ${traders.size} 个`)
    
    // 从页面提取交易员数据 - 使用多种方法
    const cardData = await page.evaluate(() => {
      const results = []
      const seen = new Set()
      let debugInfo = []

      // 方法1: 查找包含 ROI 百分比的卡片元素
      // Bitget Spot 的卡片通常有特定的 class
      const allElements = document.querySelectorAll('*')
      let cardCandidates = []

      // 找到所有可能的卡片（包含百分比且大小合适）
      allElements.forEach(el => {
        const text = el.innerText || ''
        // 卡片特征: 包含 +/-百分比，有合适的文本长度
        if (text.match(/[+-]\d{1,3}\.\d{1,2}%/) && text.length > 50 && text.length < 800) {
          // 检查是否包含 "is copying"，如果包含则跳过
          if (text.includes('is copying')) return
          // 检查是否有子元素也匹配（避免重复）
          let isParent = false
          cardCandidates.forEach(c => {
            if (el.contains(c.el) && el !== c.el) isParent = true
          })
          if (!isParent) {
            cardCandidates.push({ el, text })
          }
        }
      })

      // 去重: 保留最小的包含元素
      const finalCards = []
      cardCandidates.forEach(c => {
        let hasChild = false
        cardCandidates.forEach(c2 => {
          if (c.el !== c2.el && c.el.contains(c2.el)) hasChild = true
        })
        if (!hasChild) finalCards.push(c)
      })

      debugInfo.push({ type: 'stats', cardCandidates: cardCandidates.length, finalCards: finalCards.length })

      finalCards.slice(0, 100).forEach((card, idx) => {
        const cardText = card.text

        // 提取 trader ID - 尝试多种方法
        let traderId = ''

        // 方法1: 从卡片内的链接获取
        const link = card.el.querySelector('a[href*="/trader/"], a[href*="/spot/trader/"]')
        if (link) {
          const match = link.href.match(/\/trader\/([a-f0-9]+)/)
          if (match) traderId = match[1]
        }

        // 方法2: 检查卡片元素本身是否有链接
        if (!traderId && card.el.tagName === 'A') {
          const match = card.el.href?.match(/\/trader\/([a-f0-9]+)/)
          if (match) traderId = match[1]
        }

        // 方法3: 查找任何包含 trader id 的链接（包括父元素）
        if (!traderId) {
          let parent = card.el
          for (let i = 0; i < 5 && parent; i++) {
            if (parent.tagName === 'A' && parent.href) {
              const match = parent.href.match(/\/trader\/([a-f0-9]+)/)
              if (match) {
                traderId = match[1]
                break
              }
            }
            // 检查子元素
            const anyLink = parent.querySelector('a[href*="trader"]')
            if (anyLink) {
              const match = anyLink.href.match(/\/trader\/([a-f0-9]+)/)
              if (match) {
                traderId = match[1]
                break
              }
            }
            parent = parent.parentElement
          }
        }

        // 方法4: 从 data 属性获取
        if (!traderId) {
          const dataEls = card.el.querySelectorAll('[data-trader-id], [data-uid], [data-id]')
          dataEls.forEach(el => {
            if (!traderId) {
              traderId = el.dataset.traderId || el.dataset.uid || el.dataset.id || ''
            }
          })
        }

        // 方法5: 提取 username 作为临时 ID（如 @BGUSER-QP8YFFZE）
        if (!traderId) {
          const usernameMatch = cardText.match(/@(BGUSER-[A-Z0-9]+|[a-zA-Z0-9_-]+)/i)
          if (usernameMatch) {
            // 用 username 的 hash 作为临时 traderId
            const username = usernameMatch[1]
            traderId = 'spot_' + username.toLowerCase().replace(/[^a-z0-9]/g, '')
          }
        }

        // 如果还是没有，跳过这个卡片
        if (!traderId || seen.has(traderId)) {
          if (idx < 5) {
            debugInfo.push({
              idx,
              noTraderId: true,
              cardTextSample: cardText.slice(0, 150).replace(/\n/g, ' | ')
            })
          }
          return
        }
        seen.add(traderId)

        // 提取 ROI
        let roi = 0
        const roiMatch = cardText.match(/([+-])(\d{1,3}(?:\.\d{1,2})?)\s*%/)
        if (roiMatch) {
          const sign = roiMatch[1] === '-' ? -1 : 1
          roi = parseFloat(roiMatch[2]) * sign
        }

        // 提取昵称 - 第一行通常是名字
        const lines = cardText.split('\n').filter(l => l.trim() && l.length > 1 && l.length < 50)
        let nickname = lines[0]?.trim() || traderId.slice(0, 8)
        nickname = nickname.replace(/[+-]\d.*%.*/, '').trim()

        if (idx < 5) {
          debugInfo.push({
            idx,
            traderId: traderId.slice(0, 8),
            roi,
            nickname: nickname.slice(0, 20),
            cardTextSample: cardText.slice(0, 100).replace(/\n/g, ' | ')
          })
        }

        results.push({
          traderId,
          nickname: nickname || traderId.slice(0, 8),
          roi,
        })
      })

      return { results, debugInfo }
    })

    // 打印调试信息
    if (cardData.debugInfo && cardData.debugInfo.length > 0) {
      console.log('  调试信息:')
      cardData.debugInfo.forEach((d) => {
        if (d.type === 'stats') {
          console.log(`    卡片候选: ${d.cardCandidates}, 最终卡片: ${d.finalCards}`)
        } else if (d.noTraderId) {
          console.log(`    ${d.idx}. 无trader ID: ${d.cardTextSample?.slice(0, 80)}`)
        } else {
          console.log(`    ${d.idx}. ${d.traderId}: ROI=${d.roi}% name=${d.nickname}`)
          console.log(`       ${d.cardTextSample?.slice(0, 80)}`)
        }
      })
    }

    // 合并卡片数据
    for (const card of cardData.results) {
      if (!traders.has(card.traderId)) {
        traders.set(card.traderId, {
          traderId: card.traderId,
          nickname: card.nickname,
          roi: card.roi,
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
        
        // 重新获取卡片数据（使用卡片提取 ROI）
        const moreCards = await page.evaluate(() => {
          const results = []
          const seen = new Set()

          // 过滤掉侧边栏的 "is copying" 区域
          const allAnchors = document.querySelectorAll('a[href*="/trader/"]')
          const anchors = Array.from(allAnchors).filter(a => {
            const parentText = a.parentElement?.parentElement?.innerText || ''
            if (parentText.includes('is copying') && parentText.length < 200) return false
            return true
          })

          anchors.forEach(anchor => {
            const href = anchor.href
            const match = href.match(/\/trader\/([a-f0-9]+)/)
            if (!match) return

            const traderId = match[1]
            if (seen.has(traderId)) return
            seen.add(traderId)

            // 找到卡片容器
            let card = null
            let parent = anchor
            for (let i = 0; i < 10 && parent; i++) {
              const text = parent.innerText || ''
              if (text.includes('%') && !text.includes('is copying')) {
                if (text.length < 1000 && text.length > 10) {
                  card = parent
                  break
                }
              }
              parent = parent.parentElement
            }

            if (!card) return

            const cardText = card.innerText || ''

            // 提取 ROI
            let roi = 0
            const roiMatch = cardText.match(/([+-])(\d{1,4}(?:\.\d{1,2})?)\s*%/) ||
                             cardText.match(/(\d{1,4}(?:\.\d{1,2})?)\s*%/)
            if (roiMatch) {
              if (roiMatch.length === 3) {
                const sign = roiMatch[1] === '-' ? -1 : 1
                roi = parseFloat(roiMatch[2]) * sign
              } else {
                roi = parseFloat(roiMatch[1])
              }
            }

            // 提取昵称
            const nameEl = card.querySelector('[class*="name"], [class*="nick"]')
            let nickname = nameEl?.innerText?.trim()?.split('\n')[0] || ''
            if (!nickname) {
              const lines = cardText.split('\n').filter(l => l.trim())
              nickname = lines[0]?.trim() || traderId.slice(0, 8)
            }
            nickname = nickname.replace(/@.*/, '').replace(/is copying.*/, '').trim()
            if (nickname.length > 30) nickname = nickname.slice(0, 30)

            results.push({ traderId, nickname: nickname || traderId.slice(0, 8), roi })
          })

          return results
        })

        let newCount = 0
        for (const card of moreCards) {
          if (!traders.has(card.traderId)) {
            traders.set(card.traderId, {
              traderId: card.traderId,
              nickname: card.nickname,
              roi: card.roi,
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

  // 如果是合成的 trader ID（以 spot_ 开头），跳过详情获取
  if (traderId.startsWith('spot_')) {
    await page.close()
    return details
  }

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
  
  // 批量 insert trader_snapshots (包含 arena_score)
  const snapshotsData = traders.map(t => {
    const normalizedWr = t.winRate !== null ? (t.winRate <= 1 ? t.winRate * 100 : t.winRate) : null
    return {
      source: SOURCE,
      source_trader_id: t.traderId,
      season_id: period,
      rank: t.rank,
      roi: t.roi || 0,
      pnl: t.pnl || null,
      win_rate: normalizedWr,
      max_drawdown: t.maxDrawdown || null,
      followers: t.followers || null,
      arena_score: calculateArenaScore(t.roi || 0, t.pnl, t.maxDrawdown, normalizedWr, period),
      captured_at: capturedAt,
    }
  })
  
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
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--disable-web-security',
      '--disable-features=IsolateOrigins,site-per-process',
      '--window-size=1920,1080',
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
