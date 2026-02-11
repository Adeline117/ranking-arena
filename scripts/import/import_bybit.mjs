/**
 * Bybit Copy Trading 排行榜数据抓取 (API版)
 * 
 * 策略: 先用Puppeteer访问页面获取session/cookies，
 * 然后通过page.evaluate调用内部API获取分页数据
 * 
 * API: /x-api/fapi/beehive/public/v1/common/dynamic-leader-list
 * 
 * 用法: node scripts/import/import_bybit.mjs [7D|30D|90D]
 */

import puppeteer from 'puppeteer-extra'
import StealthPlugin from 'puppeteer-extra-plugin-stealth'
import {
  getSupabaseClient,
  calculateArenaScore,
  sleep,
  getTargetPeriods,
} from '../lib/shared.mjs'

puppeteer.use(StealthPlugin())

const supabase = getSupabaseClient()

const SOURCE = 'bybit'
const TARGET_COUNT = 500

const DURATION_MAP = {
  '7D': 'DATA_DURATION_SEVEN_DAY',
  '30D': 'DATA_DURATION_THIRTY_DAY',
  '90D': 'DATA_DURATION_NINETY_DAY',
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

    // 1. 先访问页面获取session/cookies
    console.log('📱 访问页面获取session...')
    try {
      await page.goto('https://www.bybit.com/copyTrade/trade-center/find', { waitUntil: 'networkidle2', timeout: 45000 })
    } catch (e) {
      console.log('  ⚠ 加载超时，继续...')
    }
    await sleep(3000)

    // 关闭弹窗
    await page.evaluate(() => {
      document.querySelectorAll('button, div, span').forEach(el => {
        const text = (el.textContent || '').toLowerCase()
        if (text.includes("don't live") || text.includes('confirm') || 
            text.includes('accept') || text.includes('got it') ||
            text.includes('close') || text.includes('ok')) {
          try { el.click() } catch {}
        }
      })
    }).catch(() => {})
    await sleep(1000)

    // 2. 通过page.evaluate调用内部API获取分页数据
    const duration = DURATION_MAP[period]
    console.log(`📡 通过API获取数据 (${duration})...`)

    const PAGE_SIZE = 50
    const MAX_PAGES = 20

    for (let pageNo = 1; pageNo <= MAX_PAGES; pageNo++) {
      try {
        const result = await page.evaluate(async (params) => {
          const url = `/x-api/fapi/beehive/public/v1/common/dynamic-leader-list?pageNo=${params.pageNo}&pageSize=${params.pageSize}&dataDuration=${params.duration}&userTag=&leaderTag=&code=&leaderLevel=`
          const resp = await fetch(url)
          const json = await resp.json()
          if (json.retCode !== 0) return { error: json.retMsg, retCode: json.retCode }
          return {
            totalCount: json.result?.totalCount,
            totalPages: json.result?.totalPageCount,
            traders: json.result?.leaderDetails || [],
          }
        }, { pageNo, pageSize: PAGE_SIZE, duration })

        if (result.error) {
          console.log(`  ⚠ API错误: ${result.error}`)
          break
        }

        if (pageNo === 1) {
          console.log(`  总数: ${result.totalCount}, 总页数: ${result.totalPages}`)
        }

        for (const item of result.traders) {
          const traderId = String(item.leaderMark || item.leaderId || '')
          if (!traderId || allTraders.has(traderId)) continue

          // Parse ROI from leaderDetails - check various metric fields
          let roi = 0
          let pnl = 0
          let winRate = 0
          let maxDrawdown = 0
          let followers = 0

          // leaderDetails has metricDetails array with different metrics
          if (item.metricDetails) {
            for (const m of item.metricDetails) {
              const val = parseFloat(m.value || 0)
              const key = (m.metricKey || m.key || '').toLowerCase()
              if (key.includes('roi') || key.includes('roe') || key.includes('yield')) roi = val
              else if (key.includes('pnl') || key.includes('profit')) pnl = val
              else if (key.includes('win')) winRate = val
              else if (key.includes('draw') || key.includes('mdd')) maxDrawdown = val
              else if (key.includes('follower') || key.includes('copier')) followers = parseInt(val)
            }
          }

          // Fallback: direct fields
          if (roi === 0) roi = parseFloat(item.roi || item.roiRate || item.roe || 0)
          if (pnl === 0) pnl = parseFloat(item.pnl || item.totalPnl || 0)
          if (winRate === 0) winRate = parseFloat(item.winRate || 0)
          if (maxDrawdown === 0) maxDrawdown = parseFloat(item.mdd || item.maxDrawdown || 0)
          if (followers === 0) followers = parseInt(item.followerCount || item.copierNum || 0)

          // ROI normalization: if < 10, it's probably decimal form
          if (Math.abs(roi) > 0 && Math.abs(roi) < 10) roi *= 100

          allTraders.set(traderId, {
            traderId,
            nickname: item.nickName || item.leaderName || null,
            avatar: item.avatar || item.avatarUrl || null,
            roi,
            pnl,
            winRate,
            maxDrawdown,
            followers,
          })
        }

        console.log(`  第${pageNo}页: +${result.traders.length}, 总计: ${allTraders.size}`)

        if (allTraders.size >= TARGET_COUNT) {
          console.log(`  ✓ 已达目标数量 ${TARGET_COUNT}`)
          break
        }

        if (pageNo >= (result.totalPages || 1)) {
          console.log(`  ✓ 已到最后一页`)
          break
        }

        if (result.traders.length === 0) break

        await sleep(500) // 防止过快请求
      } catch (e) {
        console.log(`  ⚠ 第${pageNo}页请求失败: ${e.message}`)
        // If page got detached, try reopening
        if (e.message.includes('detached') || e.message.includes('closed') || e.message.includes('Target')) {
          console.log('  页面已断开，停止分页')
          break
        }
        await sleep(2000)
      }
    }

    // 3. 如果API分页没拿到足够数据，尝试不同排序方式
    if (allTraders.size < 100) {
      console.log(`\n  ⚠ API只获取了 ${allTraders.size} 个，尝试其他排序...`)
      
      for (const sortField of ['LEADER_SORT_ROI', 'LEADER_SORT_PNL', 'LEADER_SORT_FOLLOWER_COUNT']) {
        if (allTraders.size >= TARGET_COUNT) break
        try {
          const result = await page.evaluate(async (params) => {
            const url = `/x-api/fapi/beehive/public/v1/common/dynamic-leader-list?pageNo=1&pageSize=50&dataDuration=${params.duration}&sortField=${params.sort}`
            const resp = await fetch(url)
            const json = await resp.json()
            return {
              traders: json.result?.leaderDetails || [],
              totalCount: json.result?.totalCount,
            }
          }, { duration, sort: sortField })
          
          let newCount = 0
          for (const item of result.traders) {
            const traderId = String(item.leaderMark || item.leaderId || '')
            if (!traderId || allTraders.has(traderId)) continue
            let roi = parseFloat(item.roi || item.roiRate || 0)
            if (Math.abs(roi) > 0 && Math.abs(roi) < 10) roi *= 100
            allTraders.set(traderId, {
              traderId,
              nickname: item.nickName || item.leaderName || null,
              avatar: item.avatar || null,
              roi, pnl: parseFloat(item.pnl || 0),
              winRate: parseFloat(item.winRate || 0),
              maxDrawdown: parseFloat(item.mdd || 0),
              followers: parseInt(item.followerCount || 0),
            })
            newCount++
          }
          console.log(`  排序 ${sortField}: +${newCount} (总: ${result.totalCount})`)
          await sleep(500)
        } catch (e) {
          console.log(`  排序 ${sortField} 失败: ${e.message}`)
        }
      }
    }

    console.log(`\n📊 共获取 ${allTraders.size} 个交易员数据`)
  } finally {
    await browser.close()
  }

  return Array.from(allTraders.values())
}

async function saveTradersBatch(traders, period) {
  console.log(`\n💾 批量保存 ${traders.length} 个交易员...`)
  
  const capturedAt = new Date().toISOString()
  
  const sourcesData = traders.map(t => ({
    source: SOURCE,
    source_type: 'leaderboard',
    source_trader_id: t.traderId,
    handle: t.nickname,
    avatar_url: t.avatar || null,
    is_active: true,
  }))
  
  await supabase.from('trader_sources').upsert(sourcesData, { onConflict: 'source,source_trader_id' })
  
  const snapshotsData = traders.map((t, idx) => {
    const normalizedWinRate = t.winRate !== null && t.winRate !== undefined
      ? (t.winRate <= 1 ? t.winRate * 100 : t.winRate)
      : null
    const { totalScore: arenaScore } = calculateArenaScore(t.roi || 0, t.pnl, t.maxDrawdown, normalizedWinRate, period)
    
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
  
  const { error } = await supabase.from('trader_snapshots').upsert(snapshotsData, { onConflict: 'source,source_trader_id,season_id' })
  
  if (error) {
    console.log(`  ⚠ 批量保存失败: ${error.message}`)
    let saved = 0
    for (const s of snapshotsData) {
      const { error: e } = await supabase.from('trader_snapshots').upsert(s, { onConflict: 'source,source_trader_id,season_id' })
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
  console.log(`Bybit 数据抓取 (API分页版)`)
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
    const top = traders.slice(0, TARGET_COUNT)

    console.log(`\n📋 ${period} TOP 10:`)
    top.slice(0, 10).forEach((t, idx) => {
      console.log(`  ${idx + 1}. ${t.nickname || t.traderId}: ROI ${t.roi?.toFixed(2)}%`)
    })

    const saved = await saveTradersBatch(top, period)
    results.push({ period, count: traders.length, saved, topRoi: top[0]?.roi || 0 })
    
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
