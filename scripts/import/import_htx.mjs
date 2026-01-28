/**
 * HTX Futures Copy Trading 排行榜数据抓取
 *
 * 使用 Puppeteer 拦截 API 响应获取交易员数据
 * 特点：
 * 1. 浏览器自动化 + API 拦截
 * 2. 支持 7D/30D/90D 时间段
 * 3. 并发获取详情
 *
 * 用法: node scripts/import/import_htx.mjs [7D|30D|90D|ALL]
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

const SOURCE = 'htx_futures'
const BASE_URL = 'https://futures.htx.com/en-us/copytrading/futures'
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
  return ['7D', '30D', '90D']
}

/**
 * 标准化 ROI 值
 */
function normalizeRoi(val) {
  if (val === null || val === undefined) return null
  const num = parseFloat(val)
  if (isNaN(num)) return null
  // HTX 返回百分比形式 (如 50.5 表示 50.5%)
  return num
}

/**
 * 从页面抓取排行榜数据
 */
async function fetchLeaderboardData(period) {
  console.log(`\n=== 抓取 HTX Futures ${period} 排行榜 ===`)
  console.log('时间:', new Date().toISOString())
  console.log(`目标: ${TARGET_COUNT} 个交易员`)

  const browser = await puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-web-security',
      '--lang=en-US,en',
    ],
    timeout: 60000,
  })

  const allTraders = new Map()
  let apiDataReceived = false

  try {
    const page = await browser.newPage()
    await page.setViewport({ width: 1920, height: 1080 })
    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36')

    // 设置额外的请求头
    await page.setExtraHTTPHeaders({
      'Accept-Language': 'en-US,en;q=0.9',
    })

    // 监听 API 响应
    page.on('response', async (response) => {
      const url = response.url()

      // 只监听 copy trading rank API
      if (url.includes('/futures/copytrading/rank')) {
        try {
          const json = await response.json()
          console.log(`  📡 拦截到排行榜 API: ${url.substring(0, 100)}...`)
          console.log(`  📝 响应结构: code=${json.code}, status=${json.status}, keys=${Object.keys(json).join(',')}`)

          // HTX rank API 返回格式: { code: 200, data: { totalNum: N, itemList: [...] } }
          const list = json.data?.itemList || json.data?.list || []
          const totalNum = json.data?.totalNum || 0
          console.log(`  📝 总数: ${totalNum}, 当前获取: ${list.length} 条`)

          if (Array.isArray(list) && list.length > 0) {
            console.log(`  ✓ 获取到 ${list.length} 条交易员数据`)

            // 调试：输出第一条数据的结构和 profitList 长度
            if (list[0]) {
              console.log(`  📝 数据示例: ${list[0].nickName}, profitList长度: ${list[0].profitList?.length || 0}`)
            }

            apiDataReceived = true

            list.forEach((item) => {
              // HTX 数据结构: uid, userSign, nickName, imgUrl, copyUserNum, copyProfit, winRate, profitRate
              const traderId = String(item.uid || item.userId || '')

              if (!traderId || allTraders.has(traderId)) return

              // HTX 的 profitRate 是字符串格式 (如 "0.5123" = 51.23%)
              const parseRoi = (val) => {
                if (val === null || val === undefined) return null
                const num = parseFloat(val)
                if (isNaN(num)) return null
                // profitRate 是小数格式 (0.5 = 50%)
                return num * 100
              }

              // 解析 winRate (字符串格式如 "1.0000" = 100%)
              const parseWinRate = (val) => {
                if (val === null || val === undefined) return 0
                const num = parseFloat(val)
                if (isNaN(num)) return 0
                return num * 100
              }

              // profitList 是每日累计收益率数组 (最新的在最后)
              // 计算不同时间段的 ROI
              const profitList = item.profitList || []
              let roi90d = null
              let roi30d = null
              let roi7d = null

              if (profitList.length > 0) {
                // profitList 包含最近 30 天的每日累计收益率
                // 第一个值 = 30 天前的累计, 最后一个值 = 今天的累计
                const last = parseFloat(profitList[profitList.length - 1])
                const first = parseFloat(profitList[0] || 0)

                // 90D: 使用当前累计值 (这是历史总累计，不仅仅是 90 天)
                roi90d = last * 100

                // 30D: 最近 30 天的增量 = 今天累计 - 30天前累计
                roi30d = (last - first) * 100

                // 7D: 最近 7 天的增量
                if (profitList.length >= 7) {
                  const val7dAgo = parseFloat(profitList[profitList.length - 8] || first)
                  roi7d = (last - val7dAgo) * 100
                } else {
                  roi7d = (last - first) * 100
                }
              }

              // 使用 userSign 作为主键 (URL 需要 userSign)
              const sourceId = item.userSign || traderId

              allTraders.set(sourceId, {
                traderId: sourceId,  // 使用 userSign 作为 traderId
                uid: traderId,       // 保存原始 uid
                nickname: item.nickName || `HTX_${traderId}`,
                avatar: item.imgUrl || null,
                roi_90d: roi90d,
                roi_30d: roi30d,
                roi_7d: roi7d,
                pnl: parseFloat(item.copyProfit || 0) || 0,
                winRate: parseWinRate(item.winRate),
                maxDrawdown: 0,  // HTX 列表 API 不包含回撤数据
                followers: parseInt(item.copyUserNum || 0) || 0,
                fullUserNum: parseInt(item.fullUserNum || 1000),
                trades: 0,
                profitList: profitList,
              })
            })

            console.log(`  ✓ 当前共收集 ${allTraders.size} 个交易员`)
          }
        } catch (err) {
          console.log(`  ⚠ 解析 API 失败: ${err.message}`)
        }
      }
    })

    console.log('\n📱 访问 HTX Copy Trading 页面...')
    try {
      await page.goto(BASE_URL, { waitUntil: 'networkidle2', timeout: 60000 })
    } catch (e) {
      console.log('  ⚠ 页面加载超时，继续尝试...')
    }
    await sleep(5000)

    // 尝试关闭弹窗
    console.log('🔄 关闭可能的弹窗...')
    await page.evaluate(() => {
      document.querySelectorAll('button, div, span, a').forEach(el => {
        const text = (el.textContent || '').toLowerCase()
        if (text.includes('close') || text.includes('confirm') || text.includes('agree') ||
            text.includes('accept') || text.includes('got it') || text.includes('ok') ||
            text.includes('dismiss') || text === 'x' || text === '×') {
          try { el.click() } catch {}
        }
      })
      // 点击遮罩层
      document.querySelectorAll('.modal-overlay, .overlay, .mask, [class*="modal"]').forEach(el => {
        try { el.click() } catch {}
      })
    })
    await sleep(2000)

    // 尝试点击 PNL(%) 或 ROI 排序选项
    console.log('🔄 尝试选择 PNL(%) 排序...')
    await page.evaluate(() => {
      const sortOptions = ['pnl(%)', 'pnl', 'roi', 'yield', 'profit', 'return']
      document.querySelectorAll('button, div, span, li, a, [role="tab"], [role="option"]').forEach(el => {
        const text = (el.textContent || '').toLowerCase().trim()
        for (const opt of sortOptions) {
          if (text.includes(opt)) {
            try {
              el.click()
              console.log('Clicked:', text)
            } catch {}
            break
          }
        }
      })
    })
    await sleep(3000)

    // 尝试选择时间周期
    const periodText = period === '7D' ? '7' : period === '30D' ? '30' : '90'
    console.log(`🔄 尝试选择 ${period} 周期...`)
    await page.evaluate((days) => {
      document.querySelectorAll('button, div, span, li, a, [role="tab"], [role="option"]').forEach(el => {
        const text = (el.textContent || '').toLowerCase().trim()
        if (text.includes(days + 'd') || text.includes(days + ' day') ||
            text === days || text.includes(`${days}天`)) {
          try {
            el.click()
            console.log('Clicked period:', text)
          } catch {}
        }
      })
    }, periodText)
    await sleep(3000)

    // 滚动页面以加载更多数据
    console.log('📜 滚动页面加载更多数据...')
    for (let i = 0; i < 3; i++) {
      await page.evaluate(() => window.scrollBy(0, 800))
      await sleep(1500)
    }

    // 直接调用 API 获取更多数据
    // rankType: 0=综合, 1=收益率排序(ROI), 2=收益排序(PNL), 3=跟单人数, 4=AUM, 5=胜率
    // 用户要求按 PNL(%) 排序，即 ROI，对应 rankType=1
    console.log('\n📡 直接调用 API 获取更多数据...')
    const API_URL = 'https://futures.htx.com/-/x/hbg/v1/futures/copytrading/rank'

    // 按 ROI (rankType=1) 获取最多 100 个交易员
    for (let pageNo = 1; pageNo <= 2; pageNo++) {
      try {
        const params = `?rankType=1&pageNo=${pageNo}&pageSize=50`
        const response = await page.evaluate(async (url) => {
          const res = await fetch(url, {
            method: 'GET',
            headers: {
              'Accept': 'application/json',
            },
          })
          return res.json()
        }, API_URL + params)

        if (response.code === 200 && response.data?.itemList) {
          const list = response.data.itemList
          console.log(`  📋 API 获取到 ${list.length} 条数据 (page ${pageNo})`)

          // 添加交易员数据
          for (const item of list) {
            const uid = String(item.uid || '')
            const sourceId = item.userSign || uid
            if (!sourceId || allTraders.has(sourceId)) continue

            // 从 profitList 计算各时间段 ROI
            const profitList = item.profitList || []
            let roi90d = null
            let roi30d = null
            let roi7d = null

            if (profitList.length > 0) {
              // profitList 包含最近 30 天的每日累计收益率
              const last = parseFloat(profitList[profitList.length - 1])
              const first = parseFloat(profitList[0] || 0)

              // 90D: 当前累计值 (历史总累计)
              roi90d = last * 100

              // 30D: 最近 30 天增量
              roi30d = (last - first) * 100

              // 7D: 最近 7 天增量
              if (profitList.length >= 7) {
                const val7dAgo = parseFloat(profitList[profitList.length - 8] || first)
                roi7d = (last - val7dAgo) * 100
              } else {
                roi7d = (last - first) * 100
              }
            }

            const winRate = parseFloat(item.winRate || 0) * 100

            allTraders.set(sourceId, {
              traderId: sourceId,
              uid: uid,
              nickname: item.nickName || `HTX_${uid}`,
              avatar: item.imgUrl || null,
              roi_90d: roi90d,
              roi_30d: roi30d,
              roi_7d: roi7d,
              pnl: parseFloat(item.copyProfit || 0) || 0,
              winRate: winRate,
              maxDrawdown: 0,
              followers: parseInt(item.copyUserNum || 0) || 0,
              fullUserNum: parseInt(item.fullUserNum || 1000),
              trades: 0,
              profitList: profitList,
            })
          }

          console.log(`  ✓ 当前共收集 ${allTraders.size} 个交易员`)

          if (allTraders.size >= TARGET_COUNT) break
        }
      } catch (err) {
        console.log(`  ⚠ API 调用失败: ${err.message}`)
      }
      await sleep(1000)
    }

    // 如果 API 拦截没有数据，尝试从 DOM 解析
    if (allTraders.size === 0) {
      console.log('\n📊 API 拦截未获取数据，尝试从页面 DOM 解析...')

      const domTraders = await page.evaluate(() => {
        const traders = []

        // 查找所有链接到交易员详情的元素
        const detailLinks = document.querySelectorAll('a[href*="/copytrading/futures/detail/"]')

        detailLinks.forEach((link, idx) => {
          try {
            const href = link.getAttribute('href') || ''
            const idMatch = href.match(/\/detail\/(\d+)/)
            if (!idMatch) return

            const traderId = idMatch[1]

            // 向上查找包含该链接的卡片容器
            let card = link.closest('[class*="card"], [class*="item"], [class*="trader"]')
            if (!card) card = link.parentElement?.parentElement

            if (!card) return

            // 查找名称 - 通常在链接内或附近
            let name = link.textContent?.trim()
            if (!name || name.length < 2) {
              const nameEl = card.querySelector('[class*="name"], [class*="nick"]')
              name = nameEl?.textContent?.trim()
            }

            // 查找 ROI 数值 - 寻找百分比格式
            const allText = card.textContent || ''
            const roiMatches = allText.match(/[-+]?\d+\.?\d*\s*%/g)
            let roi = null
            if (roiMatches && roiMatches.length > 0) {
              // 取第一个百分比数值
              roi = parseFloat(roiMatches[0].replace('%', ''))
            }

            if (name && name.length > 1 && !name.includes('HTX') && !name.includes('About')) {
              traders.push({
                traderId,
                nickname: name,
                roi: roi,
              })
            }
          } catch {}
        })

        return traders
      })

      console.log(`  从 DOM 解析到 ${domTraders.length} 个交易员`)

      domTraders.forEach(t => {
        if (!allTraders.has(t.traderId)) {
          allTraders.set(t.traderId, {
            ...t,
            roi_90d: t.roi,
            roi_30d: null,
            roi_7d: null,
            pnl: 0,
            winRate: 0,
            maxDrawdown: 0,
            followers: 0,
            trades: 0,
          })
        }
      })
    }

    // 获取页面截图用于调试
    if (allTraders.size === 0) {
      console.log('\n📸 保存页面截图用于调试...')
      await page.screenshot({ path: '/tmp/htx_debug.png', fullPage: true })
      console.log('  截图已保存到 /tmp/htx_debug.png')

      // 输出页面 HTML 用于调试
      const html = await page.content()
      console.log('\n📄 页面内容预览 (前 2000 字符):')
      console.log(html.substring(0, 2000))
    }

  } catch (error) {
    console.error('抓取出错:', error.message)
  } finally {
    await browser.close()
  }

  console.log(`\n✓ 共获取 ${allTraders.size} 个交易员`)
  return Array.from(allTraders.values())
}

/**
 * 批量保存交易员数据
 */
async function saveTradersBatch(traders, period) {
  console.log(`\n💾 保存 ${traders.length} 个交易员 (${period})...`)

  if (traders.length === 0) {
    console.log('  ⚠ 没有数据可保存')
    return 0
  }

  const capturedAt = new Date().toISOString()

  // 根据时间段选择对应的 ROI
  const getRoiForPeriod = (t) => {
    switch (period) {
      case '7D': return t.roi_7d ?? t.roi_90d ?? 0
      case '30D': return t.roi_30d ?? t.roi_90d ?? 0
      case '90D': return t.roi_90d ?? 0
      default: return t.roi_90d ?? 0
    }
  }

  // 按对应时间段 ROI 排序
  traders.sort((a, b) => getRoiForPeriod(b) - getRoiForPeriod(a))
  const top100 = traders.slice(0, TARGET_COUNT)

  // 批量 upsert trader_sources
  // traderId 已经是 userSign，可直接用于 URL
  const sourcesData = top100.map(t => ({
    source: SOURCE,
    source_type: 'leaderboard',
    source_trader_id: t.traderId,  // userSign
    handle: t.nickname,
    profile_url: `https://futures.htx.com/en-us/copytrading/futures/detail/${t.traderId}`,
    is_active: true,
  }))

  const { error: sourceError } = await supabase
    .from('trader_sources')
    .upsert(sourcesData, { onConflict: 'source,source_trader_id' })

  if (sourceError) {
    console.log(`  ⚠ trader_sources 保存失败: ${sourceError.message}`)
  }

  // 批量 insert trader_snapshots
  const snapshotsData = top100.map((t, idx) => {
    const roi = getRoiForPeriod(t)
    const normalizedWinRate = t.winRate !== null && t.winRate !== undefined
      ? (t.winRate <= 1 ? t.winRate * 100 : t.winRate)
      : null
    const arenaScore = calculateArenaScore(roi, t.pnl, t.maxDrawdown, normalizedWinRate, period)

    return {
      source: SOURCE,
      source_trader_id: t.traderId,
      season_id: period,
      rank: idx + 1,
      roi: roi,
      pnl: t.pnl || null,
      win_rate: normalizedWinRate,
      max_drawdown: t.maxDrawdown || null,
      followers: t.followers || null,
      arena_score: arenaScore,
      captured_at: capturedAt,
    }
  })

  const { error: snapshotError } = await supabase.from('trader_snapshots').insert(snapshotsData)

  if (snapshotError) {
    console.log(`  ⚠ 批量保存失败: ${snapshotError.message}`)
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
  console.log(`HTX Futures 数据抓取 (Puppeteer 版本)`)
  console.log(`目标周期: ${periods.join(', ')}`)
  console.log(`========================================`)

  const results = []

  for (const period of periods) {
    console.log(`\n${'='.repeat(50)}`)
    console.log(`📊 开始抓取 ${period} 排行榜...`)
    console.log(`${'='.repeat(50)}`)

    const traders = await fetchLeaderboardData(period)

    if (traders.length === 0) {
      console.log(`\n⚠ ${period} 未获取到数据`)
      console.log('  可能原因:')
      console.log('  1. HTX 网站可能需要 VPN 访问')
      console.log('  2. 网站结构可能已更改')
      console.log('  3. 可能存在反爬机制')
      results.push({ period, count: 0, saved: 0, topRoi: 0 })
      continue
    }

    // 根据对应时间段 ROI 排序
    const getRoiForPeriod = (t) => {
      switch (period) {
        case '7D': return t.roi_7d ?? t.roi_90d ?? 0
        case '30D': return t.roi_30d ?? t.roi_90d ?? 0
        default: return t.roi_90d ?? 0
      }
    }

    traders.sort((a, b) => getRoiForPeriod(b) - getRoiForPeriod(a))

    console.log(`\n📋 ${period} TOP 10:`)
    traders.slice(0, 10).forEach((t, idx) => {
      const roi = getRoiForPeriod(t)
      console.log(`  ${idx + 1}. ${t.nickname}: ROI ${roi?.toFixed(2)}%`)
    })

    const saved = await saveTradersBatch(traders, period)
    results.push({ period, count: traders.length, saved, topRoi: getRoiForPeriod(traders[0]) || 0 })

    console.log(`\n✅ ${period} 完成！保存了 ${saved} 条数据`)

    if (periods.indexOf(period) < periods.length - 1) {
      console.log(`\n⏳ 等待 3 秒后抓取下一个时间段...`)
      await sleep(3000)
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
