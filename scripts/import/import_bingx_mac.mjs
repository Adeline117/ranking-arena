/**
 * BingX Copy Trading - Mac Mini版 (Playwright + Proxy + __NUXT__ extraction)
 * 通过代理绕过CF，从Nuxt SSR state提取trader数据
 */
import { chromium } from 'playwright'
import {
  getSupabaseClient,
  calculateArenaScore,
  sleep,
  getTargetPeriods,
} from '../lib/shared.mjs'

const supabase = getSupabaseClient()
const SOURCE = 'bingx'
const PROXY = 'http://127.0.0.1:7890'

async function scrapeTraders(period) {
  console.log(`\n=== BingX ${period} ===`)
  
  const browser = await chromium.launch({
    headless: false,
    proxy: { server: PROXY }
  })
  
  const page = await browser.newPage()
  
  try {
    // Capture API responses with full trader data
    const apiTraders = []
    page.on('response', async (resp) => {
      try {
        const ct = resp.headers()['content-type'] || ''
        if (!ct.includes('json')) return
        const body = await resp.json()
        const results = body?.data?.result || body?.data?.list || []
        if (!Array.isArray(results)) return
        for (const item of results) {
          const t = item.trader || item
          const stats = item.traderStatistics || item.statistics || item
          if (t.uid) {
            apiTraders.push({
              uid: String(t.uid),
              name: t.nickName || t.realNickName || '',
              avatar: t.avatar || null,
              roi: parseFloat(stats.roi || stats.roiRate || stats.weeklyRoi || 0) * 100,
              pnl: parseFloat(stats.totalPnl || stats.pnl || stats.profitRealizedPnlU || 0),
              winRate: parseFloat(stats.winRate || stats.profitRate || 0) * 100,
              tradeCount: parseInt(stats.tradeCount || stats.totalCount || stats.profitCount || 0),
            })
          }
        }
      } catch(e) {}
    })
    
    await page.goto('https://bingx.com/en/CopyTrading', { timeout: 45000, waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(12000)
    
    // Click Futures tab
    await page.click('text=Futures').catch(() => {})
    await page.waitForTimeout(5000)
    
    // Scroll to load everything
    for (let i = 0; i < 20; i++) {
      await page.evaluate(() => window.scrollBy(0, 600))
      await page.waitForTimeout(1200)
    }
    await page.waitForTimeout(3000)
    
    // Extract from __NUXT__ state - get user info (uid, name, avatar)
    const nuxtTraders = await page.evaluate(() => {
      const nuxt = window.__NUXT__
      if (!nuxt) return []
      const results = []
      const seen = new Set()
      
      function find(obj, d) {
        if (d > 15 || !obj || typeof obj !== 'object') return
        if (obj.uid && obj.nickName && !seen.has(String(obj.uid))) {
          seen.add(String(obj.uid))
          results.push({
            uid: String(obj.uid),
            name: obj.nickName || obj.realNickName || '',
            avatar: obj.avatar || null,
            shortUid: obj.shortUid
          })
        }
        if (Array.isArray(obj)) {
          for (const item of obj) find(item, d+1)
        } else {
          for (const k of Object.keys(obj)) find(obj[k], d+1)
        }
      }
      find(nuxt, 0)
      return results
    })
    
    // Also extract ROI data from DOM text
    const domTraders = await page.evaluate(() => {
      const results = []
      // BingX shows trader cards with name and ROI percentage
      const body = document.body.innerText
      // Pattern: name followed by ROI like "+123.45%" 
      const sections = body.split(/(?=\+\d+\.\d+%|-\d+\.\d+%)/)
      return results
    })
    
    console.log(`  API拦截: ${apiTraders.length} 个trader`)
    console.log(`  NUXT提取: ${nuxtTraders.length} 个trader`)
    
    // Merge: API data has stats, NUXT has identity
    const merged = new Map()
    
    for (const t of nuxtTraders) {
      merged.set(t.uid, { ...t, roi: 0, pnl: 0, winRate: 0, tradeCount: 0 })
    }
    
    for (const t of apiTraders) {
      if (merged.has(t.uid)) {
        Object.assign(merged.get(t.uid), t)
      } else {
        merged.set(t.uid, t)
      }
    }
    
    const traders = [...merged.values()].filter(t => t.name)
    console.log(`  合并去重: ${traders.length} 个trader`)
    
    if (traders.length === 0) {
      await browser.close()
      return 0
    }
    
    // Save to DB
    let saved = 0
    for (let idx = 0; idx < traders.length; idx++) {
      const trader = traders[idx]
      await supabase.from('trader_sources').upsert({
        source: SOURCE,
        source_trader_id: trader.uid,
        handle: trader.name,
        avatar_url: trader.avatar,
        profile_url: `https://bingx.com/en/CopyTrading/trader-detail/${trader.shortUid || trader.uid}`,
        last_refreshed_at: new Date().toISOString()
      }, { onConflict: 'source,source_trader_id' })
      
      const scoreResult = calculateArenaScore({
        roi: trader.roi || 0,
        pnl: trader.pnl || 0,
        winRate: trader.winRate || 0,
        tradeCount: trader.tradeCount || 0
      })
      const score = typeof scoreResult === 'object' ? scoreResult.totalScore || 0 : scoreResult || 0
      
      const { error } = await supabase.from('leaderboard_ranks').upsert({
        source: SOURCE,
        source_trader_id: trader.uid,
        season_id: period,
        rank: idx + 1,
        roi: trader.roi || 0,
        pnl: trader.pnl || 0,
        win_rate: trader.winRate || 0,
        trades_count: trader.tradeCount || 0,
        arena_score: score,
        handle: trader.name,
        avatar_url: trader.avatar,
        followers: 0,
        computed_at: new Date().toISOString()
      }, { onConflict: 'source,source_trader_id,season_id' })
      
      if (error) { if (saved === 0) console.log('  DB error:', error.message) }
      else saved++
    }
    
    console.log(`  保存 ${saved}/${traders.length} 个trader`)
    await browser.close()
    return saved
    
  } catch (e) {
    console.error(`  Error: ${e.message}`)
    await browser.close().catch(() => {})
    return 0
  }
}

const periods = getTargetPeriods(['7D', '30D', '90D'])
let total = 0
for (const p of periods) {
  total += await scrapeTraders(p)
  await sleep(2000)
}
console.log(`\n✅ BingX完成，共保存 ${total} 条记录`)
