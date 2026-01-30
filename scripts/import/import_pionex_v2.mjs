/**
 * Pionex Copy Trading - V2 using Playwright with Cloudflare bypass
 * Strategy: Navigate homepage first, wait for CF challenge, then SPA navigate to copy-trade
 * Then use page.evaluate() to call internal APIs with the browser's CF cookies
 */
import 'dotenv/config'
import { chromium } from 'playwright'
import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) { console.error('Missing env'); process.exit(1) }
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

const SOURCE = 'pionex'
const TARGET_COUNT = 500
const clip = (v, min, max) => Math.max(min, Math.min(max, v))
const safeLog1p = x => x <= -1 ? 0 : Math.log(1 + x)
function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

const ARENA_CONFIG = {
  MAX_RETURN_SCORE: 70,
  MAX_PNL_SCORE: 15,
  PARAMS: {
    '7D': { tanhCoeff: 0.08, roiExponent: 1.8, mddThreshold: 15, winRateCap: 62 },
    '30D': { tanhCoeff: 0.15, roiExponent: 1.6, mddThreshold: 30, winRateCap: 68 },
    '90D': { tanhCoeff: 0.18, roiExponent: 1.6, mddThreshold: 40, winRateCap: 70 },
  },
  PNL_PARAMS: {
    '7D': { base: 500, coeff: 0.40 },
    '30D': { base: 2000, coeff: 0.35 },
    '90D': { base: 5000, coeff: 0.30 },
  },
}

function calculateArenaScore(roi, pnl, maxDrawdown, winRate, period) {
  const params = ARENA_CONFIG.PARAMS[period] || ARENA_CONFIG.PARAMS['90D']
  const days = period === '7D' ? 7 : period === '30D' ? 30 : 90
  const wr = winRate !== null && winRate !== undefined ? (winRate <= 1 ? winRate * 100 : winRate) : null
  const intensity = (365 / days) * safeLog1p((roi || 0) / 100)
  const r0 = Math.tanh(params.tanhCoeff * intensity)
  const returnScore = r0 > 0 ? clip(ARENA_CONFIG.MAX_RETURN_SCORE * Math.pow(r0, params.roiExponent), 0, ARENA_CONFIG.MAX_RETURN_SCORE) : 0
  // PnL score (0-15)
  const pnlParams = ARENA_CONFIG.PNL_PARAMS[period] || ARENA_CONFIG.PNL_PARAMS['90D']
  let pnlScore = 0
  if (pnl !== null && pnl !== undefined && pnl > 0) {
    const logArg = 1 + pnl / pnlParams.base
    if (logArg > 0) {
      pnlScore = clip(ARENA_CONFIG.MAX_PNL_SCORE * Math.tanh(pnlParams.coeff * Math.log(logArg)), 0, ARENA_CONFIG.MAX_PNL_SCORE)
    }
  }
  const drawdownScore = maxDrawdown !== null ? clip(8 * clip(1 - Math.abs(maxDrawdown) / params.mddThreshold, 0, 1), 0, 8) : 4
  const stabilityScore = wr !== null ? clip(7 * clip((wr - 45) / (params.winRateCap - 45), 0, 1), 0, 7) : 3.5
  return Math.round((returnScore + pnlScore + drawdownScore + stabilityScore) * 100) / 100
}

async function main() {
  const arg = process.argv[2]?.toUpperCase()
  const periods = arg === 'ALL' ? ['7D', '30D', '90D'] : (arg && ['7D','30D','90D'].includes(arg)) ? [arg] : ['30D']
  console.log(`\n📊 Pionex V2 - 目标周期: ${periods.join(', ')}`)

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled',
           '--disable-web-security', '--disable-features=IsolateOrigins,site-per-process'],
  })

  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    viewport: { width: 1920, height: 1080 },
    locale: 'en-US',
    timezoneId: 'America/Los_Angeles',
    extraHTTPHeaders: { 'Accept-Language': 'en-US,en;q=0.9' },
  })

  // Override webdriver detection
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false })
    delete navigator.__proto__.webdriver
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] })
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] })
    window.chrome = { runtime: {} }
  })

  const page = await context.newPage()
  const allTraders = new Map()
  
  // Intercept ALL responses for trader data
  page.on('response', async (response) => {
    const url = response.url()
    if (!url.includes('pionex.com')) return
    const ct = response.headers()['content-type'] || ''
    if (!ct.includes('json')) return
    
    try {
      const text = await response.text().catch(() => '')
      if (!text || text.length < 50) return
      const json = JSON.parse(text)
      
      // Look for any array data that looks like traders
      const findArrays = (obj, path = '') => {
        if (!obj || typeof obj !== 'object') return []
        const results = []
        if (Array.isArray(obj) && obj.length > 0) {
          results.push({ data: obj, path })
        }
        for (const [k, v] of Object.entries(obj)) {
          if (Array.isArray(v) && v.length > 0) {
            results.push({ data: v, path: `${path}.${k}` })
          } else if (v && typeof v === 'object' && !Array.isArray(v)) {
            for (const [k2, v2] of Object.entries(v)) {
              if (Array.isArray(v2) && v2.length > 0) {
                results.push({ data: v2, path: `${path}.${k}.${k2}` })
              }
            }
          }
        }
        return results
      }
      
      for (const { data: list, path: dataPath } of findArrays(json)) {
        // Check if items look like traders (have ROI/PnL related fields)
        const sample = list[0]
        if (!sample || typeof sample !== 'object') continue
        const keys = Object.keys(sample).join(',').toLowerCase()
        if (!keys.match(/roi|pnl|profit|return|win|trade|copy|kol|follow/)) continue
        
        const endpoint = new URL(url).pathname
        console.log(`  📡 API拦截 [${endpoint}] path=${dataPath}: ${list.length}条`)
        console.log(`    字段: ${Object.keys(sample).slice(0, 15).join(', ')}`)
        
        for (const t of list) {
          const traderId = String(t.uid || t.user_id || t.kol_user_id || t.traderId || t.userId || t.id || '')
          if (!traderId || traderId === 'undefined') continue
          
          let roi = parseFloat(String(t.roi || t.roi_rate || t.roiRate || t.profit_rate || t.profitRate || t.returnRate || 0))
          if (Math.abs(roi) > 0 && Math.abs(roi) < 1) roi *= 100
          
          let pnl = parseFloat(String(t.pnl || t.total_pnl || t.totalPnl || t.profit || 0))
          let winRate = null
          if (t.win_rate != null) winRate = parseFloat(String(t.win_rate))
          else if (t.winRate != null) winRate = parseFloat(String(t.winRate))
          if (winRate != null && winRate > 0 && winRate <= 1) winRate *= 100
          
          let mdd = null
          if (t.max_drawdown != null) mdd = parseFloat(String(t.max_drawdown))
          else if (t.maxDrawdown != null) mdd = parseFloat(String(t.maxDrawdown))
          
          allTraders.set(traderId, {
            traderId,
            nickname: t.nickname || t.nick_name || t.traderName || t.name || t.display_name || `Trader_${traderId.slice(0, 8)}`,
            avatarUrl: t.avatar || t.avatar_url || t.headUrl || null,
            roi, pnl, winRate, maxDrawdown: mdd,
            followers: parseInt(String(t.followers || t.follower_num || t.copy_num || t.copyNum || 0)),
          })
        }
        console.log(`    累计: ${allTraders.size}个`)
      }
    } catch {}
  })

  try {
    // Strategy 1: Navigate to copy-trade page directly
    console.log('\n📌 Strategy 1: Direct navigation to copy-trade...')
    await page.goto('https://www.pionex.com/en/copy-trade', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {})
    
    // Wait for Cloudflare
    for (let i = 0; i < 10; i++) {
      const title = await page.title()
      if (!title.includes('moment') && !title.includes('Cloudflare')) break
      console.log(`  CF挑战中... (${i+1}/10)`)
      await sleep(3000)
    }
    await sleep(5000)
    
    const title = await page.title()
    console.log(`  页面标题: ${title}`)
    
    // Close popups
    await page.evaluate(() => {
      document.querySelectorAll('button, [role="button"]').forEach(btn => {
        const text = (btn.textContent || '').toLowerCase()
        if (['ok', 'got it', 'accept', 'close', 'confirm', 'i understand'].some(t => text.includes(t))) {
          try { btn.click() } catch {}
        }
      })
    }).catch(() => {})
    await sleep(2000)

    // Try to navigate to copy-trade within SPA
    const currentUrl = page.url()
    console.log(`  当前URL: ${currentUrl}`)
    
    if (!currentUrl.includes('copy-trade') || currentUrl.endsWith('/en')) {
      console.log('  SPA内导航到copy-trade...')
      // Click on "Copy" or "Copy Trade" link
      const copyLink = page.locator('a[href*="copy-trade"], a[href*="copy_trade"], a:has-text("Copy Trade"), a:has-text("Copy")')
      if (await copyLink.count() > 0) {
        await copyLink.first().click().catch(() => {})
        await sleep(5000)
        console.log(`  导航后URL: ${page.url()}`)
      }
    }
    
    console.log(`  拦截到: ${allTraders.size}个交易员`)

    // Strategy 2: Try fetching APIs from within the page context
    if (allTraders.size < 10) {
      console.log('\n📌 Strategy 2: 从页面内调用API...')
      const apiResults = await page.evaluate(async () => {
        const results = []
        const endpoints = [
          '/kol-apis/tapi/v1/home_page/recommend_kol',
          '/kol-apis/tapi/v1/kol/list?sort_field=roi&page_num=0&page_size=100&sort_type=desc',
          '/kol-apis/tapi/v1/future/copy_trading/kol_list?sort_field=roi&page_num=0&page_size=100&sort_type=desc&period=2',
          '/kol-apis/tapi/v1/copy_trading_rank_list?sort_field=roi&page_num=0&page_size=100',
          '/kol-apis/tapi/v1/future/kol_rank_list?sort_field=roi&page_num=0&page_size=100&period=2',
          '/kol-apis/tapi/v1/copy/trader_list?sort=roi&page=0&size=100',
        ]
        
        for (const ep of endpoints) {
          try {
            const resp = await fetch(ep, {
              headers: { 'Accept': 'application/json' },
              credentials: 'include'
            })
            if (resp.ok) {
              const json = await resp.json()
              results.push({ endpoint: ep, status: resp.status, data: json, size: JSON.stringify(json).length })
            } else {
              results.push({ endpoint: ep, status: resp.status })
            }
          } catch (e) {
            results.push({ endpoint: ep, error: e.message })
          }
        }
        return results
      }).catch(e => { console.log(`  API调用失败: ${e.message}`); return [] })
      
      for (const r of apiResults) {
        console.log(`  [${r.status || 'ERR'}] ${r.endpoint} ${r.size ? `(${r.size} bytes)` : (r.error || '')}`)
        if (r.data) {
          // Parse API response
          const findArrays = (obj) => {
            if (Array.isArray(obj)) return [obj]
            const arrs = []
            if (obj && typeof obj === 'object') {
              for (const v of Object.values(obj)) {
                if (Array.isArray(v) && v.length > 0) arrs.push(v)
                else if (v && typeof v === 'object') {
                  for (const v2 of Object.values(v)) {
                    if (Array.isArray(v2) && v2.length > 0) arrs.push(v2)
                  }
                }
              }
            }
            return arrs
          }
          
          for (const list of findArrays(r.data)) {
            if (!list[0] || typeof list[0] !== 'object') continue
            const keys = Object.keys(list[0]).join(',').toLowerCase()
            if (!keys.match(/roi|pnl|profit|return|win|trade|copy|kol|follow|nickname|avatar/)) continue
            console.log(`    ✅ 找到 ${list.length}条交易员数据!`)
            console.log(`    字段: ${Object.keys(list[0]).slice(0, 12).join(', ')}`)
            
            for (const t of list) {
              const traderId = String(t.uid || t.user_id || t.kol_user_id || t.traderId || t.userId || t.id || '')
              if (!traderId || traderId === 'undefined') continue
              let roi = parseFloat(String(t.roi || t.roi_rate || t.roiRate || t.profit_rate || 0))
              if (Math.abs(roi) > 0 && Math.abs(roi) < 1) roi *= 100
              allTraders.set(traderId, {
                traderId,
                nickname: t.nickname || t.nick_name || t.name || `Trader_${traderId.slice(0, 8)}`,
                avatarUrl: t.avatar || t.avatar_url || null,
                roi,
                pnl: parseFloat(String(t.pnl || t.total_pnl || 0)),
                winRate: t.win_rate != null ? parseFloat(String(t.win_rate)) * (parseFloat(String(t.win_rate)) <= 1 ? 100 : 1) : null,
                maxDrawdown: t.max_drawdown != null ? parseFloat(String(t.max_drawdown)) : null,
                followers: parseInt(String(t.followers || t.follower_num || 0)),
              })
            }
          }
        }
      }
      console.log(`  总计: ${allTraders.size}个交易员`)
    }

    // Strategy 3: DOM extraction
    if (allTraders.size < 10) {
      console.log('\n📌 Strategy 3: DOM提取...')
      // Wait for content
      await page.waitForTimeout(3000)
      
      // Scroll to load more
      for (let i = 0; i < 5; i++) {
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
        await sleep(2000)
      }
      
      const domData = await page.evaluate(() => {
        const results = []
        const seen = new Set()
        const allElements = document.querySelectorAll('[class*="trader"], [class*="card"], [class*="item"], [class*="list"], [class*="kol"], [class*="rank"]')
        
        allElements.forEach(el => {
          const text = el.innerText || ''
          if (!text.includes('%') || text.length < 20 || text.length > 3000) return
          
          const roiMatch = text.match(/([+-]?\d{1,5}(?:\.\d{1,2})?)\s*%/)
          if (!roiMatch) return
          
          const roi = parseFloat(roiMatch[1])
          if (roi === 0 || isNaN(roi) || Math.abs(roi) > 10000) return
          
          const lines = text.split('\n').map(l => l.trim()).filter(l => l && l.length > 1 && l.length < 30 && !l.includes('%') && !l.match(/^[\d,]+$/) && !l.includes('Copy') && !l.includes('Follow'))
          const nickname = lines[0] || ''
          if (!nickname) return
          
          const key = `${nickname}_${roi}`
          if (seen.has(key)) return
          seen.add(key)
          
          results.push({ traderId: `pionex_dom_${nickname.toLowerCase().replace(/[^a-z0-9]/g, '')}`, nickname, roi })
        })
        return results
      })
      
      for (const t of domData) {
        if (!allTraders.has(t.traderId)) allTraders.set(t.traderId, t)
      }
      console.log(`  DOM提取: ${domData.length}条, 总计: ${allTraders.size}个`)
    }

    // Screenshot for debugging
    await page.screenshot({ path: `/tmp/pionex_v2_${Date.now()}.png`, fullPage: false }).catch(() => {})
    
    // Save data
    const traders = Array.from(allTraders.values())
    console.log(`\n📊 总计获取: ${traders.length}个交易员`)
    
    if (traders.length > 0) {
      for (const period of periods) {
        traders.sort((a, b) => (b.roi || 0) - (a.roi || 0))
        const top = traders.slice(0, TARGET_COUNT)
        const capturedAt = new Date().toISOString()
        
        await supabase.from('trader_sources').upsert(
          top.map(t => ({
            source: SOURCE, source_type: 'leaderboard', source_trader_id: t.traderId,
            handle: t.nickname, avatar_url: t.avatarUrl || null,
            profile_url: `https://www.pionex.com/copy-trade/trader/${t.traderId}`,
            is_active: true,
          })),
          { onConflict: 'source,source_trader_id' }
        )
        
        const { error } = await supabase.from('trader_snapshots').upsert(
          top.map((t, idx) => ({
            source: SOURCE, source_trader_id: t.traderId, season_id: period,
            rank: idx + 1, roi: t.roi, pnl: t.pnl || null,
            win_rate: t.winRate, max_drawdown: t.maxDrawdown || null,
            followers: t.followers || null,
            arena_score: calculateArenaScore(t.roi, t.pnl, t.maxDrawdown, t.winRate, period),
            captured_at: capturedAt,
          })),
          { onConflict: 'source,source_trader_id,season_id' }
        )
        
        if (error) console.log(`  ⚠ ${period} upsert失败: ${error.message}`)
        else console.log(`  ✅ ${period}: ${top.length}条保存成功`)
      }
    } else {
      console.log('  ⚠ 无数据可保存')
    }
  } finally {
    await context.close()
    await browser.close()
  }
}

main().catch(e => { console.error('Fatal:', e); process.exit(1) })
