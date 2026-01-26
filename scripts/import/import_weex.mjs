/**
 * Weex Copy Trading 排行榜数据抓取
 *
 * URL: https://www.weex.com/zh-CN/copy-trading
 *
 * Weex 数据周期映射：
 * - 3周 (21天) → 映射为 30D
 * - 全时间 → 映射为 90D
 * - 无 7D 数据
 *
 * 用法: node scripts/import/import_weex.mjs [30D|90D|ALL]
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

const SOURCE = 'weex'
const BASE_URL = 'https://www.weex.com/zh-CN/copy-trading'
const TARGET_COUNT = 50  // 目标抓取 50 个交易员
const MIN_COUNT = 30     // Weex 主页只显示约 30 个交易员（3 分类 x 9 个/分类 + 部分重叠）
const CONCURRENCY = 5

// Weex 周期映射配置
// Weex 只有 3周 和 全时间 两种周期
const PERIOD_CONFIG = {
  '30D': {
    weexPeriod: '3week',   // Weex 3周数据
    actualDays: 21,        // 实际 21 天
    sortParam: 'week_roi', // 排序参数
  },
  '90D': {
    weexPeriod: 'all',     // Weex 全时间数据
    actualDays: 90,        // 用 90D 参数计算
    sortParam: 'total_roi',
  },
}

// Arena Score 计算逻辑
const ARENA_CONFIG = {
  PARAMS: {
    '30D': { tanhCoeff: 0.15, roiExponent: 1.6, mddThreshold: 30, winRateCap: 68 },
    '90D': { tanhCoeff: 0.18, roiExponent: 1.6, mddThreshold: 40, winRateCap: 70 },
  },
  MAX_RETURN_SCORE: 85, MAX_DRAWDOWN_SCORE: 8, MAX_STABILITY_SCORE: 7,
}

const clip = (v, min, max) => Math.max(min, Math.min(max, v))
const safeLog1p = x => x <= -1 ? 0 : Math.log(1 + x)

function calculateArenaScore(roi, pnl, maxDrawdown, winRate, period, actualDays) {
  const params = ARENA_CONFIG.PARAMS[period] || ARENA_CONFIG.PARAMS['90D']
  const days = actualDays || (period === '30D' ? 30 : 90)
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
  if (arg === 'ALL') return ['30D', '90D']
  if (arg && ['30D', '90D'].includes(arg)) return [arg]
  return ['30D', '90D'] // Weex 只支持 30D 和 90D
}

async function fetchLeaderboard(browser, period) {
  const config = PERIOD_CONFIG[period]
  console.log(`\n📋 抓取排行榜 (${period} ← Weex ${config.weexPeriod})...`)
  console.log(`  URL: ${BASE_URL}`)

  const page = await browser.newPage()
  await page.setViewport({ width: 1920, height: 1080 })
  await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36')

  // 设置更真实的浏览器环境
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false })
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] })
    Object.defineProperty(navigator, 'languages', { get: () => ['zh-CN', 'zh', 'en-US', 'en'] })
  })

  const traders = new Map()

  // 监听 API 响应
  page.on('response', async (response) => {
    const url = response.url()
    // 只匹配交易员相关的 API 端点
    if (url.includes('trader') || url.includes('copy') || url.includes('expert') || url.includes('Trader')) {
      try {
        const contentType = response.headers()['content-type'] || ''
        if (!contentType.includes('json')) return

        const json = await response.json()
        const endpoint = url.split('?')[0].split('/').slice(-2).join('/')

        // 处理 topTraderListView 的嵌套结构
        // 结构: { data: [{ tab, desc, sortRule, list: [...traders] }] }
        if (url.includes('topTraderList') || url.includes('TopTrader')) {
          const sections = json.data || json || []
          if (Array.isArray(sections)) {
            sections.forEach(section => {
              const traderList = section.list || section.traders || []
              if (Array.isArray(traderList) && traderList.length > 0) {
                console.log(`  📡 API 拦截 (${section.tab || section.desc || endpoint}): ${traderList.length} 条`)

                // 打印第一条数据结构
                if (traderList[0]) {
                  const sample = traderList[0]
                  const keys = Object.keys(sample).join(', ')
                  console.log(`    字段: ${keys}`)
                  // 打印 profile 内容
                  if (sample.profile && typeof sample.profile === 'object') {
                    const profileKeys = Object.keys(sample.profile).join(', ')
                    console.log(`    profile: ${profileKeys}`)
                  } else {
                    console.log(`    profile类型: ${typeof sample.profile}, 值: ${JSON.stringify(sample.profile)?.slice(0,100)}`)
                  }
                  // 打印 ROI 相关字段
                  console.log(`    ROI字段: totalReturnRate=${sample.totalReturnRate}, threeWeeksPNL=${sample.threeWeeksPNL}`)
                  if (sample.ndaysReturnRates) {
                    console.log(`    ndaysReturnRates: ${JSON.stringify(sample.ndaysReturnRates).slice(0, 200)}`)
                  }
                }

                traderList.forEach((item, idx) => {
                  // Weex 实际字段名
                  const traderId = String(item.traderUserId || item.traderId || item.uid || item.id || '')
                  if (!traderId || traderId === 'undefined') return

                  // 如果已存在，检查是否需要更新 ROI
                  const existing = traders.get(traderId)

                  // 提取 ROI - 从 totalReturnRate 获取
                  let roi = 0

                  // 方法1: totalReturnRate (总收益率，已是百分比形式如 113.24 表示 113.24%)
                  if (item.totalReturnRate !== undefined && item.totalReturnRate !== null) {
                    roi = parseFloat(String(item.totalReturnRate))
                  }

                  // 调试第一条
                  if (idx === 0) {
                    console.log(`    调试: traderId=${traderId}, totalReturnRate=${item.totalReturnRate}, roi=${roi}`)
                  }

                  // 方法2: 从 ndaysReturnRates 数组获取 3周收益
                  if (roi === 0 && item.ndaysReturnRates && Array.isArray(item.ndaysReturnRates)) {
                    // 找到 21 天或最接近的数据
                    const rateObj = item.ndaysReturnRates.find(r => r.ndays === 21 || r.ndays === 'n21') ||
                                    item.ndaysReturnRates.find(r => r.ndays === 30 || r.ndays === 'n30') ||
                                    item.ndaysReturnRates[item.ndaysReturnRates.length - 1]
                    if (rateObj && rateObj.rate !== undefined) {
                      roi = parseFloat(rateObj.rate)
                    }
                  }

                  // 方法3: 从 itemVoList 获取
                  if (roi === 0 && item.itemVoList && Array.isArray(item.itemVoList)) {
                    const roiItem = item.itemVoList.find(v => v.itemType === 'roi' || v.key === 'roi' || v.label?.includes('收益'))
                    if (roiItem && roiItem.value !== undefined) {
                      roi = parseFloat(roiItem.value)
                    }
                  }

                  // totalReturnRate 已经是百分比形式，不需要转换
                  // 只有当值很小（<1）时可能需要转换
                  if (Math.abs(roi) > 0 && Math.abs(roi) < 1) roi *= 100

                  const nickname = item.traderNickName || item.nickName || item.nickname || item.name || ''
                  const avatar = item.headPic || item.avatar || item.headUrl || null

                  // PnL - threeWeeksPNL 是 3 周收益金额
                  const pnl = parseFloat(String(item.threeWeeksPNL || item.profit || item.totalProfit || 0))
                  const followers = parseInt(String(item.followCount || item.followerCount || item.copierCount || 0))

                  // 如果已存在且新 ROI 更高，或者不存在，则添加/更新
                  if (!existing || roi > (existing.roi || 0)) {
                    traders.set(traderId, {
                      traderId,
                      nickname: nickname || String(traderId).slice(0, 10),
                      avatar,
                      roi,
                      pnl,
                      winRate: 0,
                      maxDrawdown: 0,
                      followers,
                    })
                  }
                })
              }
            })
            console.log(`    累计: ${traders.size} 个`)
          }
          return
        }

        // 标准列表结构
        let list = []
        if (json.data?.list && Array.isArray(json.data.list)) {
          list = json.data.list
        } else if (json.data?.traders && Array.isArray(json.data.traders)) {
          list = json.data.traders
        } else if (Array.isArray(json.data)) {
          list = json.data
        }

        // 过滤掉明显不是交易员数据的列表
        if (list.length > 0 && list[0]) {
          const sample = list[0]
          // 如果包含 areaCode 或 chineseName 这种字段，跳过
          if (sample.areaCode || sample.chineseName || sample.koreaName) {
            return
          }
          // 必须有 traderId 或 ROI 相关字段才处理
          if (!sample.traderId && !sample.uid && !sample.threeWeekRoi && !sample.roi) {
            return
          }
        }

        if (list.length > 0) {
          console.log(`  📡 API 拦截 (${endpoint}): ${list.length} 条`)

          let added = 0
          list.forEach(item => {
            // Weex 实际字段名
            const traderId = String(item.traderUserId || item.traderId || item.uid || item.id || '')
            if (!traderId || traderId === 'undefined' || traders.has(traderId)) return

            const profile = item.profile || {}
            let roi = parseFloat(
              item.threeWeekRoi || item.nWeekRoi || item.weekRoi ||
              profile.threeWeekRoi || profile.nWeekRoi ||
              item.totalRoi || item.roi || 0
            )
            if (Math.abs(roi) > 0 && Math.abs(roi) < 10) roi *= 100

            const nickname = item.traderNickName || item.nickName || item.nickname || item.name || ''

            traders.set(traderId, {
              traderId,
              nickname: nickname || traderId.slice(0, 10),
              avatar: item.headPic || item.avatar || item.headUrl || null,
              roi,
              pnl: parseFloat(item.profit || profile.profit || item.totalProfit || 0),
              winRate: parseFloat(item.winRate || profile.winRate || 0),
              maxDrawdown: parseFloat(item.maxDrawdown || profile.maxDrawdown || 0),
              followers: parseInt(item.followCount || item.followerCount || item.copierCount || 0),
            })
            added++
          })

          if (added > 0) {
            console.log(`    ✓ 新增 ${added} 个, 累计 ${traders.size} 个`)
          }
        }
      } catch (e) {
        // 忽略非 JSON 响应
      }
    }
  })

  try {
    // 先尝试访问可能的排行榜全列表页面
    const listUrls = [
      'https://www.weex.com/zh-CN/copy-trading/list',
      'https://www.weex.com/zh-CN/copy-trading/ranking',
      'https://www.weex.com/zh-CN/copy-trading/all',
    ]

    let foundListPage = false
    for (const url of listUrls) {
      if (foundListPage) break
      try {
        console.log(`  尝试: ${url.replace('https://www.weex.com', '')}`)
        await page.goto(url, { waitUntil: 'networkidle0', timeout: 20000 })
        await sleep(3000)
        if (traders.size > 30) {
          foundListPage = true
          console.log(`  ✓ 找到列表页面，已获取 ${traders.size} 个`)
        }
      } catch {}
    }

    // 如果没有找到列表页面，访问主页
    if (!foundListPage) {
      await page.goto(BASE_URL, { waitUntil: 'networkidle0', timeout: 90000 })
      await sleep(5000)
    }

    // 关闭弹窗
    await page.evaluate(() => {
      document.querySelectorAll('button, [role="button"]').forEach(btn => {
        const text = (btn.textContent || '').toLowerCase()
        if (text.includes('ok') || text.includes('got') || text.includes('accept') ||
            text.includes('confirm') || text.includes('close') || text.includes('知道了') ||
            text.includes('确定') || text.includes('关闭')) {
          try { btn.click() } catch {}
        }
      })
    }).catch(() => {})
    await sleep(2000)

    console.log(`  API 拦截到: ${traders.size} 个`)

    // 点击 "全部交易专家" 标签来查看所有交易员
    console.log('  尝试切换到全部交易专家视图...')
    const clickedTab = await page.evaluate(() => {
      const tabs = document.querySelectorAll('button, [role="tab"], [class*="tab"], span, div, a')
      let clicked = false
      tabs.forEach(tab => {
        const text = tab.textContent || ''
        if ((text.includes('全部交易专家') || (text.includes('全部') && text.length < 20)) && !clicked) {
          try {
            tab.click()
            clicked = true
          } catch {}
        }
      })
      return clicked
    }).catch(() => false)

    if (clickedTab) {
      console.log('  ✓ 找到"全部交易专家"标签，等待加载...')
      await sleep(5000)
    }

    // 点击不同的排序标签来获取更多交易员
    console.log('  尝试切换不同排序方式...')
    const sortTabs = await page.evaluate(() => {
      const tabs = new Set()
      // 查找 tab 容器（通常包含多个排序选项）
      const tabContainers = document.querySelectorAll('[role="tablist"], [class*="tab-container"], [class*="tabs"]')

      // 也查找独立的 tab 元素
      document.querySelectorAll('[role="tab"], [class*="tab-item"], [class*="sort-item"]').forEach(el => {
        const text = (el.innerText || el.textContent || '').trim()
        // 只匹配较短的文本（避免匹配整个卡片）
        if (text.length < 15 && text.length > 1 &&
            text.match(/(收益|胜率|跟单|ROI|带单|跟随|排序|最新|热门)/)) {
          tabs.add(text)
        }
      })

      // 查找区域标题（如 "跟随者收益排行"、"带单收益排行" 等）
      document.querySelectorAll('h2, h3, h4, [class*="title"], [class*="heading"]').forEach(el => {
        const text = (el.innerText || el.textContent || '').trim()
        if (text.length < 30 && text.includes('排行')) {
          tabs.add(text)
        }
      })

      return Array.from(tabs)
    })

    if (sortTabs.length > 0 && sortTabs.length < 10) {
      console.log(`  找到 ${sortTabs.length} 个排序标签: ${sortTabs.join(', ')}`)

      for (const tabText of sortTabs) {
        if (traders.size >= TARGET_COUNT) break

        const clicked = await page.evaluate((targetText) => {
          const elements = document.querySelectorAll('[role="tab"], [class*="tab"], button, span, div')
          for (const el of elements) {
            const text = (el.innerText || el.textContent || '').trim()
            if (text === targetText && el.offsetWidth > 0 && el.offsetHeight > 0) {
              try {
                el.click()
                return true
              } catch {}
            }
          }
          return false
        }, tabText)

        if (clicked) {
          console.log(`    切换到: ${tabText}`)
          await sleep(3000) // 等待新数据加载
        }
      }
    } else if (sortTabs.length > 0) {
      console.log(`  找到 ${sortTabs.length} 个候选标签（过多，跳过）`)
    }

    // 尝试点击各个分类的 ">" 或 "全部" 链接进入分类详情页
    console.log('  查找分类详情入口...')

    // 打印页面 debug 信息
    const pageDebug = await page.evaluate(() => {
      const allLinks = []
      document.querySelectorAll('a[href]').forEach(el => {
        const href = el.getAttribute('href') || ''
        const text = (el.innerText || '').trim().slice(0, 50)
        if (href && !href.startsWith('#') && !href.startsWith('javascript')) {
          allLinks.push({ href, text })
        }
      })
      // 找包含 copy/trader/ranking 的链接
      const relevantLinks = allLinks.filter(l =>
        l.href.includes('copy') || l.href.includes('trader') || l.href.includes('ranking')
      )
      return { total: allLinks.length, relevant: relevantLinks.slice(0, 10) }
    })

    console.log(`  页面链接: 共 ${pageDebug.total} 个, 相关 ${pageDebug.relevant.length} 个`)
    if (pageDebug.relevant.length > 0) {
      pageDebug.relevant.slice(0, 5).forEach(l => console.log(`    - ${l.text || '(无文字)'}: ${l.href}`))
    }

    // 查找并点击各个区块的 "全部" 或 ">" 按钮
    console.log('  尝试点击区块导航...')
    const sectionNavClicked = await page.evaluate(() => {
      const results = []
      // 查找区块标题元素 (如 "跟随者收益排行", "带单收益排行" 等)
      const sectionHeaders = document.querySelectorAll('h2, h3, h4, [class*="section-title"], [class*="block-title"], [class*="title"]')

      sectionHeaders.forEach(header => {
        const headerText = header.innerText || ''
        if (!headerText.includes('排行') && !headerText.includes('榜')) return

        // 查找同级或相邻的 ">" 或 "全部" 元素
        const parent = header.parentElement
        if (!parent) return

        // 在父元素中查找 ">" 或 "全部" 链接
        parent.querySelectorAll('a, span, div, svg').forEach(el => {
          const text = (el.innerText || el.textContent || '').trim()
          const tagName = el.tagName.toLowerCase()

          if (text === '>' || text === '全部' || text === '全部 >' ||
              text.includes('查看') || text.includes('更多') ||
              (tagName === 'svg' && el.closest('[class*="arrow"]'))) {
            try {
              el.click()
              results.push(`${headerText.slice(0, 15)} - ${text || 'SVG'}`)
            } catch {}
          }
        })
      })

      // 也尝试查找独立的 "全部 >" 按钮
      document.querySelectorAll('a, span, div').forEach(el => {
        const text = (el.innerText || el.textContent || '').trim()
        if ((text === '全部 >' || text === '全部>' || text.match(/^全部\s*[>›→]$/)) &&
            el.offsetWidth > 0 && el.offsetHeight > 0) {
          try {
            el.click()
            results.push(text)
          } catch {}
        }
      })

      return results
    }).catch(() => [])

    if (sectionNavClicked.length > 0) {
      console.log(`  ✓ 点击了 ${sectionNavClicked.length} 个区块导航: ${sectionNavClicked.slice(0, 3).join(', ')}`)
      await sleep(3000)
    }

    // 展开各分类的轮播/滚动
    console.log('  展开各分类...')
    await page.evaluate(() => {
      // 查找标题旁边的展开按钮
      const expandButtons = document.querySelectorAll('[class*="more"], [class*="expand"], [class*="next"], [class*="arrow-right"]')
      expandButtons.forEach(btn => {
        try { btn.click() } catch {}
      })
    }).catch(() => {})
    await sleep(2000)

    // 从页面提取数据
    const pageData = await page.evaluate(() => {
      const results = []
      const seen = new Set()
      const debugInfo = []

      // 方法1: 查找所有带有"跟单"按钮的卡片
      const copyButtons = document.querySelectorAll('button, [role="button"]')
      copyButtons.forEach(btn => {
        const btnText = btn.textContent || ''
        if (!btnText.includes('跟单') && !btnText.includes('Copy')) return

        // 向上查找卡片容器
        let card = btn.parentElement
        for (let i = 0; i < 10 && card; i++) {
          const text = card.innerText || ''
          // 卡片应该包含百分比和"跟单"按钮
          if (text.includes('%') && text.length > 50 && text.length < 2000) {
            break
          }
          card = card.parentElement
        }

        if (!card) return

        const cardText = card.innerText || ''

        // 提取 ROI - 查找带 + 的百分比
        let roi = 0
        const roiMatch = cardText.match(/\+(\d{1,5}(?:\.\d{1,2})?)\s*%/)
        if (roiMatch) {
          roi = parseFloat(roiMatch[1])
        } else {
          // 尝试匹配其他格式
          const altMatch = cardText.match(/([+-]?)(\d{1,5}(?:\.\d{1,2})?)\s*%/)
          if (altMatch) {
            const sign = altMatch[1] === '-' ? -1 : 1
            roi = parseFloat(altMatch[2]) * sign
          }
        }

        // 提取昵称 - 通常在卡片顶部
        const lines = cardText.split('\n').filter(l => {
          const t = l.trim()
          return t && t.length > 1 && t.length < 40 &&
                 !t.includes('%') && !t.includes('跟单') &&
                 !t.includes('收益') && !t.includes('胜率') &&
                 !t.includes('$') && !t.match(/^\d+$/) &&
                 !t.match(/^No\.?\s*\d+$/i) &&  // 过滤 "No 1", "No.2" 等排名标识
                 !t.match(/^#\d+$/i) &&         // 过滤 "#1", "#2" 等
                 !t.match(/^TOP\s*\d+$/i) &&    // 过滤 "TOP 1", "TOP2" 等
                 !t.match(/^Lv\.?\s*\d+$/i)     // 过滤 "Lv 1", "Lv.5" 等级别标识
        })
        let nickname = lines[0]?.trim() || ''

        // 生成 trader ID - 优先使用昵称
        let traderId = ''

        // 只使用昵称生成 ID（避免 URL 路径被误用为 trader ID）
        if (nickname && nickname.length > 1) {
          traderId = 'weex_' + nickname.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]/g, '').slice(0, 20)
        }

        // 只在没有昵称时尝试从链接获取（但要过滤掉常见的 URL 路径）
        if (!traderId) {
          const link = card.querySelector('a[href]')
          if (link) {
            const match = link.href.match(/\/trader\/([a-zA-Z0-9_-]{8,})(?:[/?]|$)/)
            if (match) traderId = match[1]
          }
        }

        // 跳过无效的 trader ID（URL 路径、页面链接等）
        const invalidIds = ['copy-trading', 'elite-trader', 'trader-tiers', 'ranking', 'leaderboard', 'list', 'all']
        if (!traderId || seen.has(traderId) || roi === 0 || invalidIds.includes(traderId.toLowerCase())) return
        seen.add(traderId)

        if (results.length < 5) {
          debugInfo.push({ nickname: nickname.slice(0, 15), roi, traderId: traderId.slice(0, 12) })
        }

        results.push({
          traderId,
          nickname: nickname || traderId.slice(0, 10),
          roi,
        })
      })

      // 方法2: 如果方法1结果不够，直接查找包含大百分比的元素
      if (results.length < 10) {
        document.querySelectorAll('*').forEach(el => {
          const text = el.innerText || ''
          // 查找显示 ROI 的元素（通常是较大的百分比数字）
          const match = text.match(/^\s*\+(\d{2,5}(?:\.\d{1,2})?)\s*%\s*$/)
          if (!match) return

          const roi = parseFloat(match[1])
          if (roi < 1) return // 忽略太小的值

          // 向上查找卡片
          let card = el.parentElement
          for (let i = 0; i < 8 && card; i++) {
            const cardText = card.innerText || ''
            if (cardText.length > 80 && cardText.length < 1500 && cardText.includes('跟单')) {
              break
            }
            card = card.parentElement
          }

          if (!card) return

          const cardText = card.innerText || ''
          const lines = cardText.split('\n').filter(l => {
            const t = l.trim()
            return t && t.length > 1 && t.length < 40 &&
                   !t.includes('%') && !t.includes('跟单') &&
                   !t.includes('收益') && !t.match(/^\d/)
          })
          const nickname = lines[0]?.trim() || ''
          const traderId = nickname ? 'weex_' + nickname.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]/g, '').slice(0, 20) : ''

          if (!traderId || seen.has(traderId)) return
          seen.add(traderId)

          results.push({ traderId, nickname: nickname || `Trader_${roi}`, roi })
        })
      }

      return { results, debugInfo }
    })

    // 打印调试信息
    if (pageData.debugInfo && pageData.debugInfo.length > 0) {
      console.log('  调试 - 提取的交易员:')
      pageData.debugInfo.forEach((d, i) => {
        console.log(`    ${i + 1}. ${d.nickname}: ROI ${d.roi}%`)
      })
    }

    // 合并数据 - 避免重复（检查昵称相似度）
    const existingNicknames = new Set(Array.from(traders.values()).map(t => t.nickname?.toLowerCase()))

    for (const item of pageData.results) {
      // 跳过已存在的 traderId
      if (traders.has(item.traderId)) continue

      // 跳过昵称重复的（避免 DOM 提取和 API 提取重复）
      const normalizedNickname = item.nickname?.toLowerCase()
      if (normalizedNickname && existingNicknames.has(normalizedNickname)) continue

      // 确保 ROI 是数字
      const roiValue = typeof item.roi === 'number' ? item.roi : parseFloat(String(item.roi)) || 0
      if (roiValue === 0) continue

      // 添加新交易员
      traders.set(item.traderId, {
        traderId: item.traderId,
        nickname: item.nickname,
        roi: roiValue,
      })
      existingNicknames.add(normalizedNickname)
    }

    console.log(`  合并后: ${traders.size} 个`)

    // 分页/滚动加载更多
    if (traders.size < MIN_COUNT) {
      console.log(`\n📄 滚动加载更多 (目标: ${MIN_COUNT} 个, 当前: ${traders.size} 个)...`)

      let noNewDataCount = 0
      for (let scroll = 0; scroll < 10; scroll++) {
        if (traders.size >= TARGET_COUNT) break
        // 如果连续 3 次没有新数据且已达到最小要求，停止
        if (noNewDataCount >= 3 && traders.size >= MIN_COUNT) {
          console.log(`  已达到最小目标 ${MIN_COUNT}，停止滚动`)
          break
        }

        const prevSize = traders.size

        // 安全滚动 - 处理 document.body 为 null 的情况
        await page.evaluate(() => {
          const scrollTarget = document.body || document.documentElement || document.querySelector('main') || document.querySelector('#__next')
          if (scrollTarget) {
            window.scrollTo(0, scrollTarget.scrollHeight || 10000)
          } else {
            window.scrollBy(0, 1000)
          }
        }).catch(() => {})
        await sleep(1500)

        // 尝试点击"加载更多"按钮
        await page.evaluate(() => {
          const loadMoreBtns = document.querySelectorAll('button, [role="button"]')
          loadMoreBtns.forEach(btn => {
            const text = (btn.textContent || '').toLowerCase()
            if (text.includes('加载更多') || text.includes('load more') || text.includes('查看更多') || text.includes('more')) {
              try { btn.click() } catch {}
            }
          })
        }).catch(() => {})
        await sleep(1500)

        // 重新获取数据
        const moreData = await page.evaluate(() => {
          const results = []
          const seen = new Set()

          // 查找交易员卡片 - 使用跟单按钮定位
          document.querySelectorAll('button, [role="button"]').forEach(btn => {
            const btnText = btn.textContent || ''
            if (!btnText.includes('跟单') && !btnText.includes('Copy')) return

            let card = btn.parentElement
            for (let i = 0; i < 10 && card; i++) {
              const text = card.innerText || ''
              if (text.includes('%') && text.length > 50 && text.length < 2000) break
              card = card.parentElement
            }
            if (!card) return

            const cardText = card?.innerText || ''
            const roiMatch = cardText.match(/([+-]?)(\d{1,4}(?:\.\d{1,2})?)\s*%/)
            let roi = 0
            if (roiMatch) {
              const sign = roiMatch[1] === '-' ? -1 : 1
              roi = parseFloat(roiMatch[2]) * sign
            }
            if (roi === 0) return

            const lines = cardText.split('\n').filter(l => {
              const t = l.trim()
              return t && t.length > 1 && t.length < 40 &&
                     !t.includes('%') && !t.includes('跟单') &&
                     !t.includes('收益') && !t.includes('胜率') &&
                     !t.match(/^No\.?\s*\d+$/i) &&
                     !t.match(/^#\d+$/i) &&
                     !t.match(/^TOP\s*\d+$/i) &&
                     !t.match(/^Lv\.?\s*\d+$/i)
            })
            const nickname = lines[0]?.trim() || ''
            if (!nickname || nickname.match(/^No\.?\s*\d+$/i)) return

            const traderId = 'weex_' + nickname.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]/g, '').slice(0, 20)
            if (seen.has(traderId)) return
            seen.add(traderId)

            results.push({ traderId, nickname, roi })
          })

          return results
        })

        const existingNicknames2 = new Set(Array.from(traders.values()).map(t => t.nickname?.toLowerCase()))
        for (const item of moreData) {
          if (traders.has(item.traderId)) continue
          const normalizedNickname = item.nickname?.toLowerCase()
          if (normalizedNickname && existingNicknames2.has(normalizedNickname)) continue
          traders.set(item.traderId, {
            traderId: item.traderId,
            nickname: item.nickname,
            roi: item.roi,
          })
          existingNicknames2.add(normalizedNickname)
        }

        console.log(`  滚动 ${scroll + 1}: ${traders.size} 个`)

        // 追踪连续无新数据次数
        if (traders.size === prevSize) {
          noNewDataCount++
        } else {
          noNewDataCount = 0
        }
      }
    }

    // 如果还不够，尝试横向滚动各个卡片区域
    if (traders.size < MIN_COUNT) {
      console.log(`\n📄 尝试横向滚动获取更多 (当前: ${traders.size})...`)

      await page.evaluate(() => {
        // 查找可横向滚动的容器
        const scrollContainers = document.querySelectorAll('[class*="scroll"], [class*="slider"], [class*="carousel"], [style*="overflow"]')
        scrollContainers.forEach(container => {
          // 横向滚动
          for (let i = 0; i < 5; i++) {
            container.scrollLeft += 300
          }
        })
      })
      await sleep(2000)

      // 再次提取
      const moreData2 = await page.evaluate(() => {
        const results = []
        const seen = new Set()

        document.querySelectorAll('button, [role="button"]').forEach(btn => {
          const btnText = btn.textContent || ''
          if (!btnText.includes('跟单') && !btnText.includes('Copy')) return

          let card = btn.parentElement
          for (let i = 0; i < 10 && card; i++) {
            const text = card.innerText || ''
            if (text.includes('%') && text.length > 50 && text.length < 2000) break
            card = card.parentElement
          }
          if (!card) return

          const cardText = card.innerText || ''
          let roi = 0
          const roiMatch = cardText.match(/\+(\d{1,5}(?:\.\d{1,2})?)\s*%/)
          if (roiMatch) roi = parseFloat(roiMatch[1])
          if (roi === 0) return

          const lines = cardText.split('\n').filter(l => {
            const t = l.trim()
            return t && t.length > 1 && t.length < 40 &&
                   !t.includes('%') && !t.includes('跟单') &&
                   !t.includes('收益') && !t.includes('胜率') &&
                   !t.match(/^No\.?\s*\d+$/i) &&
                   !t.match(/^#\d+$/i) &&
                   !t.match(/^TOP\s*\d+$/i) &&
                   !t.match(/^Lv\.?\s*\d+$/i)
          })
          const nickname = lines[0]?.trim() || ''
          if (!nickname || nickname.match(/^No\.?\s*\d+$/i)) return

          const traderId = 'weex_' + nickname.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]/g, '').slice(0, 20)
          if (!traderId || seen.has(traderId)) return
          seen.add(traderId)
          results.push({ traderId, nickname, roi })
        })
        return results
      })

      const existingNicknames3 = new Set(Array.from(traders.values()).map(t => t.nickname?.toLowerCase()))
      for (const item of moreData2) {
        if (traders.has(item.traderId)) continue
        const normalizedNickname = item.nickname?.toLowerCase()
        if (normalizedNickname && existingNicknames3.has(normalizedNickname)) continue
        traders.set(item.traderId, item)
        existingNicknames3.add(normalizedNickname)
      }
      console.log(`  横向滚动后: ${traders.size} 个`)
    }

    // 如果还不够，尝试访问分类详情页面获取更多数据
    if (traders.size < MIN_COUNT) {
      console.log(`\n📄 尝试访问分类详情页面 (当前: ${traders.size})...`)

      // 查找并点击分类详情链接
      const categoryUrls = await page.evaluate(() => {
        const urls = []
        document.querySelectorAll('a[href]').forEach(a => {
          const href = a.getAttribute('href') || ''
          const text = a.innerText || ''
          // 查找跟单相关的分类链接
          if ((href.includes('copy') || href.includes('trader') || href.includes('ranking')) &&
              !urls.includes(href) && href !== window.location.pathname) {
            urls.push({ href, text: text.slice(0, 30) })
          }
        })
        return urls.slice(0, 5)
      })

      if (categoryUrls.length > 0) {
        console.log(`  找到 ${categoryUrls.length} 个分类页面`)

        for (const { href, text } of categoryUrls) {
          if (traders.size >= TARGET_COUNT) break

          try {
            const fullUrl = href.startsWith('http') ? href : `https://www.weex.com${href}`
            console.log(`  访问: ${text || href.slice(-30)}...`)

            await page.goto(fullUrl, { waitUntil: 'networkidle0', timeout: 30000 })
            await sleep(3000)

            // 滚动加载更多
            for (let i = 0; i < 5; i++) {
              await page.evaluate(() => {
                const scrollTarget = document.body || document.documentElement
                if (scrollTarget) window.scrollTo(0, scrollTarget.scrollHeight || 10000)
              }).catch(() => {})
              await sleep(1500)
            }

            console.log(`  当前累计: ${traders.size} 个`)
          } catch (e) {
            console.log(`  访问失败: ${e.message}`)
          }
        }
      }
    }

    // 尝试访问不同的排行榜 URL
    if (traders.size < MIN_COUNT) {
      console.log(`\n📄 尝试访问其他排行榜页面...`)

      const rankingUrls = [
        // 可能的排行榜页面
        'https://www.weex.com/zh-CN/copy-trading/ranking',
        'https://www.weex.com/zh-CN/copy-trading/leaderboard',
        'https://www.weex.com/zh-CN/copy-trading/traders',
        'https://www.weex.com/zh-CN/copy-trading/list',
        'https://www.weex.com/zh-CN/copy-trading?tab=all',
        'https://www.weex.com/zh-CN/copy-trading?tab=ranking',
        // 不同排序方式
        'https://www.weex.com/zh-CN/copy-trading?sort=roi',
        'https://www.weex.com/zh-CN/copy-trading?sort=profit',
        'https://www.weex.com/zh-CN/copy-trading?sort=followers',
      ]

      for (const url of rankingUrls) {
        if (traders.size >= TARGET_COUNT) break

        try {
          console.log(`  访问: ${url.replace('https://www.weex.com', '')}...`)
          await page.goto(url, { waitUntil: 'networkidle0', timeout: 30000 })
          await sleep(3000)

          // 滚动加载
          for (let i = 0; i < 5; i++) {
            await page.evaluate(() => {
              const scrollTarget = document.body || document.documentElement
              if (scrollTarget) window.scrollTo(0, scrollTarget.scrollHeight || 10000)
            }).catch(() => {})
            await sleep(1500)
            if (traders.size >= TARGET_COUNT) break
          }

          if (traders.size > 27) {
            console.log(`  ✓ 累计: ${traders.size} 个`)
            break
          }
        } catch (e) {
          // 页面可能不存在
        }
      }
    }

    // 如果还不够，尝试直接调用 API
    if (traders.size < MIN_COUNT) {
      console.log(`\n📄 尝试直接调用 API...`)

      // 尝试从页面调用 API
      const apiResult = await page.evaluate(async () => {
        const results = []
        // 尝试不同的 API 端点
        const endpoints = [
          '/api/copyTrade/topTraderListView',
          '/api/copyTrade/traderList',
          '/api/copy/traders',
        ]

        for (const endpoint of endpoints) {
          try {
            const resp = await fetch(`https://www.weex.com${endpoint}`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ pageSize: 100, pageNum: 1 }),
            })
            const json = await resp.json()
            if (json.data) {
              results.push({ endpoint, data: json.data })
            }
          } catch {}
        }
        return results
      }).catch(() => [])

      if (apiResult.length > 0) {
        console.log(`  API 调用成功: ${apiResult.length} 个端点`)
        for (const r of apiResult) {
          console.log(`    ${r.endpoint}: ${JSON.stringify(r.data).slice(0, 100)}...`)
        }
      }
    }

    await page.screenshot({ path: `/tmp/weex_${period}_${Date.now()}.png`, fullPage: true })

  } finally {
    await page.close()
  }

  return Array.from(traders.values()).slice(0, TARGET_COUNT)
}

async function saveTradersBatch(traders, period) {
  const config = PERIOD_CONFIG[period]
  console.log(`\n💾 批量保存 ${traders.length} 条数据...`)
  console.log(`  周期映射: Weex ${config.weexPeriod} → Arena ${period}`)

  const capturedAt = new Date().toISOString()

  // 按 ROI 排序
  traders.sort((a, b) => (b.roi || 0) - (a.roi || 0))

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
  const snapshotsData = traders.map((t, idx) => {
    const normalizedWr = t.winRate !== null && t.winRate !== undefined
      ? (t.winRate <= 1 ? t.winRate * 100 : t.winRate)
      : null
    const roiValue = typeof t.roi === 'number' ? t.roi : parseFloat(String(t.roi)) || 0
    const arenaScore = calculateArenaScore(roiValue, t.pnl, t.maxDrawdown, normalizedWr, period, config.actualDays)

    // Debug first few
    if (idx < 5) {
      console.log(`    ${idx + 1}. ${t.nickname.slice(0, 10)}: ROI ${roiValue}% → Score ${arenaScore}`)
    }

    return {
      source: SOURCE,
      source_trader_id: t.traderId,
      season_id: period,  // 存储为 Arena 标准周期 (Weex 3周→30D, 全时间→90D)
      rank: idx + 1,
      roi: roiValue,
      pnl: t.pnl || null,
      win_rate: normalizedWr,
      max_drawdown: t.maxDrawdown || null,
      followers: t.followers || null,
      arena_score: arenaScore,
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

  console.log(`\n${'='.repeat(50)}`)
  console.log(`Weex Copy Trading 数据抓取`)
  console.log(`${'='.repeat(50)}`)
  console.log('时间:', new Date().toISOString())
  console.log(`目标周期: ${periods.join(', ')}`)
  console.log('')
  console.log('⚠️  Weex 数据周期映射说明:')
  console.log('   30D ← Weex 3周 (21天)')
  console.log('   90D ← Weex 全时间')
  console.log('   7D  ← 不支持 (Weex 无此数据)')
  console.log(`${'='.repeat(50)}`)

  const browser = await puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--disable-web-security',
      '--window-size=1920,1080',
    ],
  })

  const results = []

  try {
    for (const period of periods) {
      console.log(`\n${'='.repeat(50)}`)
      console.log(`📊 开始抓取 ${period} 排行榜 (Weex ${PERIOD_CONFIG[period].weexPeriod})...`)
      console.log(`${'='.repeat(50)}`)

      // 获取排行榜
      const traders = await fetchLeaderboard(browser, period)

      if (traders.length === 0) {
        console.log(`\n⚠ ${period} 未获取到交易员列表，跳过`)
        continue
      }

      // 排序并显示 TOP 5
      traders.sort((a, b) => (b.roi || 0) - (a.roi || 0))

      console.log(`\n📋 ${period} TOP 5:`)
      traders.slice(0, 5).forEach((t, i) => {
        console.log(`  ${i + 1}. ${t.nickname} (${t.traderId.slice(0, 10)}...): ROI ${t.roi?.toFixed(2) || 0}%`)
      })

      // 保存
      const saved = await saveTradersBatch(traders, period)
      results.push({
        period,
        weexPeriod: PERIOD_CONFIG[period].weexPeriod,
        count: traders.length,
        saved,
        topRoi: traders[0]?.roi || 0
      })

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
      console.log(`   ${r.period} (← ${r.weexPeriod}): ${r.saved} 条, TOP ROI ${r.topRoi?.toFixed?.(2) || r.topRoi}%`)
    }
    console.log(`   总耗时: ${totalTime}s`)
    console.log(`${'='.repeat(60)}`)

  } finally {
    await browser.close()
  }
}

main().catch(console.error)
