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
const TARGET_COUNT = 500
const MAX_PAGES = 20

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
                
                // 从 API 响应提取真实用户名
                let realNickname = item.nickName || item.nickname || item.name || item.displayName || item.traderName
                
                // 过滤无效用户名
                // - 脱敏格式: 87*****5, abc***def
                // - 占位符: Mexctrader-XXX, Trader_XXX
                const isValidNickname = realNickname && 
                  realNickname.length >= 2 &&
                  !realNickname.includes('*****') &&  // 脱敏
                  !realNickname.startsWith('Trader_') &&
                  !realNickname.startsWith('Mexctrader-')
                
                // 提取头像 - 排除 banner 广告
                let avatarUrl = item.avatar || item.avatarUrl || item.headImg || item.photoUrl || item.userPhoto || item.img || null
                if (avatarUrl && (
                  avatarUrl.includes('/banner/') ||  // 广告 banner
                  avatarUrl.includes('placeholder') ||
                  avatarUrl.includes('default')
                )) {
                  avatarUrl = null
                }
                
                // 只保存有真实用户名的交易员
                if (isValidNickname) {
                  traders.set(traderId, {
                    traderId: String(traderId),
                    nickname: realNickname,
                    avatar: avatarUrl,
                    roi,
                    pnl: parseFloat(item.pnl || item.totalPnl || item.profit || 0),
                    winRate: parseFloat(item.winRate || 0) * (item.winRate > 1 ? 1 : 100),
                    maxDrawdown: parseFloat(item.mdd || item.maxDrawdown || 0),
                    followers: parseInt(item.followerCount || item.copierCount || item.followers || 0),
                  })
                }
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

    // 从 DOM 提取数据的函数（包含头像）
    const extractFromDOM = async () => {
      return await page.evaluate(() => {
        const results = []
        const seen = new Set()
        
        // MEXC 交易员卡片选择器 - 根据截图分析
        const cardSelectors = [
          '[class*="traderCard"]',
          '[class*="TraderCard"]', 
          '[class*="trader-card"]',
          '[class*="copy-trader"]',
          '[class*="leader-item"]',
          '[class*="rank-item"]',
          'div[class*="Card_card"]'
        ]
        
        let cards = []
        for (const sel of cardSelectors) {
          const found = document.querySelectorAll(sel)
          if (found.length > 0) {
            cards = [...cards, ...found]
          }
        }
        
        // 如果找不到特定卡片，用更通用的方法
        if (cards.length < 5) {
          // 查找包含 ROI 和用户信息的容器
          cards = [...document.querySelectorAll('div')].filter(div => {
            const text = div.innerText || ''
            const hasRoi = text.includes('%') && text.match(/\d{2,}\.?\d*\s*%/)
            const hasName = text.length > 20 && text.length < 500
            const isCard = div.offsetWidth > 150 && div.offsetWidth < 400 && div.offsetHeight > 100
            return hasRoi && hasName && isCard
          })
        }
        
        console.log('找到卡片数:', cards.length)
        
        cards.forEach(card => {
          try {
            const text = card.innerText || ''
            
            // 提取头像 - 查找第一个有效的图片
            let avatar = null
            const imgs = card.querySelectorAll('img')
            for (const img of imgs) {
              const src = img.src || ''
              // 排除无效图片
              if (!src || 
                  src.includes('data:') ||
                  src.includes('placeholder') ||
                  src.includes('default') ||
                  src.includes('banner') ||
                  src.includes('icon') ||
                  src.includes('logo') ||
                  src.includes('t.co') ||  // Twitter 追踪
                  src.includes('google') ||
                  src.includes('facebook') ||
                  src.length < 20) {
                continue
              }
              // 检查图片尺寸 - 头像通常是小的正方形
              if (img.width > 20 && img.width < 100 && img.height > 20 && img.height < 100) {
                avatar = src
                break
              }
              // 如果没有尺寸信息，检查 URL 模式
              if (src.includes('avatar') || src.includes('user') || src.includes('head') || src.includes('photo')) {
                avatar = src
                break
              }
            }
            
            // 提取用户名 - 优先查找特定类名
            let nickname = ''
            const nameSelectors = [
              '[class*="nickName"]',
              '[class*="nick-name"]',
              '[class*="userName"]',
              '[class*="user-name"]',
              '[class*="traderName"]',
              '[class*="trader-name"]',
              '[class*="name"]',
              'h3', 'h4', 'h5'
            ]
            for (const sel of nameSelectors) {
              const el = card.querySelector(sel)
              if (el) {
                const txt = el.innerText?.trim()
                if (txt && txt.length >= 2 && txt.length <= 30 && 
                    !txt.includes('%') && !txt.includes('ROI') && 
                    !txt.includes('USDT') && !txt.includes('Days') &&
                    !txt.match(/^[+-]?\d/)) {
                  nickname = txt
                  break
                }
              }
            }
            
            // 备用：从卡片文本的第一行提取
            if (!nickname) {
              const lines = text.split('\n').map(l => l.trim()).filter(l => l)
              for (const line of lines) {
                // 严格过滤：必须像用户名
                if (line.length >= 2 && line.length <= 25 &&
                    !line.startsWith('$') &&  // 排除金额
                    !line.includes('%') && 
                    !line.includes('ROI') &&
                    !line.includes('USDT') && 
                    !line.includes('USD') &&
                    !line.includes('Days') &&
                    !line.includes('MDD') && 
                    !line.includes('Followers') &&
                    !line.includes('Copy') &&
                    !line.includes('Trade') &&
                    !line.match(/^[+-]?\d/) &&  // 不以数字开头
                    !line.match(/^\d{1,3}(,\d{3})*(\.\d+)?$/)) { // 不是格式化数字
                  nickname = line
                  break
                }
              }
            }
            
            // 提取 ROI - 优先找标记为 ROI 的数值
            let maxRoi = 0
            
            // 方法1: 找 "ROI" 标签旁边的数值
            const roiLabelMatch = text.match(/ROI[:\s]*([+-]?\d{1,6}(?:,?\d{3})*(?:\.\d+)?)\s*%/i)
            if (roiLabelMatch) {
              maxRoi = parseFloat(roiLabelMatch[1].replace(/,/g, ''))
            }
            
            // 方法2: 如果没找到，取第一个合理的百分比（通常是 ROI）
            if (maxRoi === 0) {
              const roiMatches = text.match(/([+-]?\d{1,6}(?:,?\d{3})*(?:\.\d+)?)\s*%/g) || []
              for (const m of roiMatches) {
                const val = parseFloat(m.replace(/[,%]/g, ''))
                // 合理的 ROI 范围：-100% 到 50000%
                if (val > -100 && val < 50000) {
                  maxRoi = val
                  break // 取第一个合理的值
                }
              }
            }
            
            // 调试：打印前几个抓取的 ROI
            if (results.length < 5 && maxRoi > 0) {
              console.log('  ROI抓取:', nickname, '->', maxRoi + '%')
            }
            
            // 验证用户名 - 排除金额、数字等
            const isValidName = nickname && 
              nickname.length >= 2 && 
              nickname.length <= 25 &&
              !nickname.startsWith('$') &&  // 排除金额
              !nickname.match(/^[\d,.$+-]+$/) &&  // 排除纯数字/金额
              !nickname.includes('USDT') &&
              !nickname.includes('USD') &&
              !nickname.includes('%') &&
              !nickname.includes('ROI') &&
              !nickname.includes('MDD') &&
              !nickname.includes('Days') &&
              !nickname.includes('Followers') &&
              !nickname.match(/^\d{1,3}(,\d{3})*(\.\d+)?$/) // 排除格式化数字
            
            // 验证并添加
            if (isValidName && maxRoi > 0 && !seen.has(nickname)) {
              seen.add(nickname)
              // 调试：打印有头像的记录
              if (avatar && results.length < 3) {
                console.log('DOM头像:', nickname, '->', avatar.substring(0, 60))
              }
              results.push({ 
                nickname, 
                roi: maxRoi, 
                avatar: avatar || null 
              })
            }
          } catch (e) {
            // 忽略单个卡片的错误
          }
        })
        
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
        // 验证昵称是有效的真实名字，不是占位符
        if (!t.nickname || 
            t.nickname.startsWith('Mexctrader-') || 
            t.nickname.startsWith('Trader_') ||
            t.nickname.match(/^[A-Za-z]+-[A-Za-z0-9]{6}$/)) { // 排除像 "Mexctrader-3R65aJ" 这样的格式
          return
        }
        
        const id = t.nickname // 使用昵称作为 ID
        if (!traders.has(id) && t.roi > 0) {
          traders.set(id, {
            traderId: id,
            nickname: t.nickname,
            avatar: t.avatar || null,
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

  const sourcesData = traders.map(t => {
    // 验证头像 URL - 排除 banner 和无效链接
    let avatarUrl = t.avatar
    if (avatarUrl && (
      avatarUrl.includes('/banner/') ||
      avatarUrl.includes('placeholder') ||
      avatarUrl.includes('default') ||
      avatarUrl.includes('t.co') ||  // Twitter 追踪
      avatarUrl.includes('google') ||
      avatarUrl.includes('facebook')
    )) {
      avatarUrl = null
    }
    
    return {
      source: SOURCE,
      source_type: 'leaderboard',
      source_trader_id: t.traderId,
      handle: t.nickname,
      avatar_url: avatarUrl,
      is_active: true,
    }
  })

  const snapshotsData = traders.map((t, idx) => {
    const normalizedWr = t.winRate !== null ? (t.winRate <= 1 ? t.winRate * 100 : t.winRate) : null
    return {
      source: SOURCE,
      source_trader_id: t.traderId,
      season_id: period,
      rank: idx + 1,
      roi: t.roi,
      pnl: t.pnl,
      win_rate: normalizedWr,
      max_drawdown: t.maxDrawdown,
      followers: t.followers || 0,
      arena_score: calculateArenaScore(t.roi, t.pnl, t.maxDrawdown, normalizedWr, period),
      captured_at: capturedAt,
    }
  })

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
  const periods = getTargetPeriods()
  const totalStartTime = Date.now()
  
  console.log(`\n========================================`)
  console.log(`MEXC 数据抓取 (修复版)`)
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
    traders.forEach((t, idx) => t.rank = idx + 1)

    const top100 = traders.slice(0, TARGET_COUNT)

    console.log(`\n📋 ${period} TOP 10:`)
    top100.slice(0, 10).forEach((t, idx) => {
      console.log(`  ${idx + 1}. ${t.nickname}: ROI ${t.roi?.toFixed(2)}%`)
    })

    const result = await saveTraders(top100, period)
    results.push({ period, count: traders.length, saved: result.saved, topRoi: top100[0]?.roi || 0 })
    
    console.log(`\n✅ ${period} 完成！`)
    
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
