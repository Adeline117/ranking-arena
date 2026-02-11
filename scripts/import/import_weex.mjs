/**
 * Weex Copy Trading 排行榜数据抓取
 *
 * Weex uses signed API requests (x-sig, sidecar). Strategy:
 * 1. Load page with Puppeteer stealth
 * 2. Intercept topTraderListView for initial 26 traders
 * 3. Hook the page's own axios/HTTP client via evaluateOnNewDocument
 *    to capture the request-building function
 * 4. Use the captured function to make paginated calls
 *
 * 用法: node scripts/import/import_weex.mjs [7D|30D|90D|ALL]
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
const SOURCE = 'weex'

function parseTrader(item) {
  const traderId = String(item.traderUserId || item.traderId || item.uid || item.id || '')
  if (!traderId || traderId === 'undefined') return null

  let roi = 0
  if (item.totalReturnRate != null) roi = parseFloat(String(item.totalReturnRate))
  if (roi === 0 && Array.isArray(item.ndaysReturnRates)) {
    const r = item.ndaysReturnRates.find(x => x.ndays === 21) ||
              item.ndaysReturnRates.find(x => x.ndays === 7) ||
              item.ndaysReturnRates[item.ndaysReturnRates.length - 1]
    if (r?.rate != null) roi = parseFloat(r.rate)
  }
  if (Math.abs(roi) > 0 && Math.abs(roi) < 1) roi *= 100

  return {
    traderId,
    nickname: item.traderNickName || item.nickName || item.nickname || item.name || `Trader_${traderId.slice(0, 8)}`,
    avatar: item.headPic || item.avatar || item.headUrl || null,
    roi,
    pnl: parseFloat(String(item.threeWeeksPNL || item.profit || item.totalProfit || 0)),
    winRate: 0,
    maxDrawdown: 0,
    followers: parseInt(String(item.followCount || item.followerCount || item.copierCount || 0)),
  }
}

async function main() {
  const periods = getTargetPeriods(['7D', '30D', '90D'])

  console.log(`\n${'='.repeat(50)}`)
  console.log(`Weex Copy Trading 数据抓取`)
  console.log(`${'='.repeat(50)}`)
  console.log('时间:', new Date().toISOString())

  const browser = await puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox', '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--proxy-server=http://127.0.0.1:7890',
    ],
  })

  const traders = new Map()

  try {
    const page = await browser.newPage()
    await page.setViewport({ width: 1920, height: 1080 })
    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36')

    // Inject XHR hook before page loads to capture the HTTP client
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => false })
      
      // We'll store the original XMLHttpRequest.send to be able to make authenticated requests
      // The page's HTTP client adds signed headers via interceptors
      window.__weex_pending_requests = []
      window.__weex_completed = []
      
      const origXHROpen = XMLHttpRequest.prototype.open
      const origXHRSend = XMLHttpRequest.prototype.send
      const origXHRSetHeader = XMLHttpRequest.prototype.setRequestHeader
      
      XMLHttpRequest.prototype.open = function(method, url, ...args) {
        this.__url = url
        this.__method = method
        this.__headers = {}
        return origXHROpen.call(this, method, url, ...args)
      }
      
      XMLHttpRequest.prototype.setRequestHeader = function(name, value) {
        if (this.__headers) this.__headers[name] = value
        return origXHRSetHeader.call(this, name, value)
      }
      
      XMLHttpRequest.prototype.send = function(body) {
        // Capture the full request config including signed headers
        if (this.__url && this.__url.includes('traderListView') && !this.__url.includes('top')) {
          const capturedConfig = {
            url: this.__url,
            method: this.__method,
            headers: {...this.__headers},
            body: body,
          }
          window.__weex_last_traderListView_config = capturedConfig
        }
        
        // Intercept response
        this.addEventListener('load', () => {
          if (this.__url && (this.__url.includes('topTraderListView') || this.__url.includes('traderListView'))) {
            try {
              const j = JSON.parse(this.responseText)
              if (j.code === 'SUCCESS') {
                if (Array.isArray(j.data)) {
                  for (const s of j.data) {
                    if (s.list) window.__weex_completed.push(...s.list)
                  }
                } else if (j.data?.rows) {
                  window.__weex_completed.push(...j.data.rows)
                }
              }
            } catch {}
          }
        })
        
        return origXHRSend.call(this, body)
      }
    })

    // Intercept responses at puppeteer level too (more reliable)
    page.on('response', async (response) => {
      const url = response.url()
      if (!url.includes('topTraderListView') && !url.includes('traderListView')) return
      try {
        const text = await response.text().catch(() => '')
        if (!text) return
        const json = JSON.parse(text)
        if (json.code !== 'SUCCESS') return

        if (Array.isArray(json.data)) {
          for (const section of json.data) {
            for (const item of (section.list || [])) {
              const t = parseTrader(item)
              if (t && !traders.has(t.traderId)) traders.set(t.traderId, t)
            }
          }
        } else if (json.data?.rows) {
          for (const item of json.data.rows) {
            const t = parseTrader(item)
            if (t && !traders.has(t.traderId)) traders.set(t.traderId, t)
          }
        }
      } catch {}
    })

    // Load page
    console.log('\n📋 加载页面...')
    await page.goto('https://www.weex.com/zh-CN/copy-trading', {
      waitUntil: 'networkidle2',
      timeout: 60000,
    }).catch(() => console.log('  ⚠ 超时'))
    await sleep(5000)

    console.log(`  标题: ${await page.title()}, 已收集: ${traders.size}`)

    // Close popups
    await page.evaluate(() => {
      document.querySelectorAll('button, [role="button"]').forEach(btn => {
        const text = (btn.textContent || '').toLowerCase()
        if (['ok', 'got it', 'accept', 'close', 'confirm', '知道了', '确定'].some(t => text.includes(t))) {
          try { btn.click() } catch {}
        }
      })
    }).catch(() => {})

    // Check if we captured the traderListView config
    const hasConfig = await page.evaluate(() => !!window.__weex_last_traderListView_config)
    console.log(`  traderListView 配置: ${hasConfig ? '✓' : '✗'}`)

    if (hasConfig) {
      // Now paginate using the captured config as template
      // We can't directly reuse the signed headers, but we can make the page's own HTTP client
      // send new requests by triggering the app's state
      console.log('\n📊 使用页面 HTTP 客户端分页...')
      
      // The trick: use the captured request URL and create new XHR with same auth mechanism
      // The page's axios interceptor will add the auth headers automatically!
      for (let sortRule of [9, 5, 6, 7, 8, 2, 1, 3, 4, 0]) {
        let pageNo = 1
        let hasMore = true
        
        while (hasMore && pageNo <= 50) {
          const result = await page.evaluate(async ({ sortRule, pageNo }) => {
            return new Promise((resolve) => {
              const config = window.__weex_last_traderListView_config
              if (!config) { resolve({ error: 'no config' }); return }
              
              const xhr = new XMLHttpRequest()
              xhr.open('POST', config.url, true)
              
              // Set the same headers that the page's interceptor would set
              // The interceptor fires on XMLHttpRequest.setRequestHeader
              for (const [k, v] of Object.entries(config.headers)) {
                try { xhr.setRequestHeader(k, v) } catch {}
              }
              xhr.setRequestHeader('Content-Type', 'application/json')
              
              xhr.onload = () => {
                try {
                  const j = JSON.parse(xhr.responseText)
                  resolve(j)
                } catch(e) { resolve({ error: 'parse: ' + e.message }) }
              }
              xhr.onerror = () => resolve({ error: 'network' })
              xhr.timeout = 10000
              xhr.ontimeout = () => resolve({ error: 'timeout' })
              
              xhr.send(JSON.stringify({
                languageType: 1,
                sortRule,
                simulation: 0,
                pageNo,
                pageSize: 50,
                nickName: ''
              }))
            })
          }, { sortRule, pageNo })

          if (result?.error) {
            if (pageNo === 1) console.log(`  ⚠ sort ${sortRule}: ${result.error}`)
            break
          }

          if (result?.code !== 'SUCCESS') {
            if (pageNo === 1) console.log(`  ⚠ sort ${sortRule}: code=${result?.code}`)
            break
          }

          const rows = result?.data?.rows || []
          if (rows.length === 0) break

          let added = 0
          for (const item of rows) {
            const t = parseTrader(item)
            if (t && !traders.has(t.traderId)) { traders.set(t.traderId, t); added++ }
          }

          hasMore = result.data?.nextFlag === true
          process.stdout.write(`\r  sort=${sortRule} p${pageNo}: +${added} → ${traders.size} (total=${result.data?.totals || '?'})`)

          if (added === 0 && pageNo > 2) break
          pageNo++
          await new Promise(r => setTimeout(r, 300 + Math.random() * 200))
        }
        console.log()
      }
    }

    console.log(`\n📊 总计: ${traders.size} 个唯一交易员`)
    await page.close()

    const allTraders = Array.from(traders.values())
    allTraders.sort((a, b) => (b.roi || 0) - (a.roi || 0))

    if (allTraders.length === 0) {
      console.log('\n⚠ 未获取到数据')
      process.exit(1)
    }

    const results = []
    for (const period of periods) {
      console.log(`\n💾 保存 ${allTraders.length} 条 ${period} 数据...`)
      const capturedAt = new Date().toISOString()

      await supabase.from('trader_sources').upsert(
        allTraders.map(t => ({
          source: SOURCE, source_type: 'leaderboard',
          source_trader_id: t.traderId, handle: t.nickname,
          avatar_url: t.avatar || null, is_active: true,
        })), { onConflict: 'source,source_trader_id' }
      )

      const snapshotsData = allTraders.map((t, idx) => {
        const arenaScore = calculateArenaScore(t.roi, t.pnl, t.maxDrawdown, t.winRate, period).totalScore
        if (idx < 3) console.log(`  ${idx + 1}. ${t.nickname.slice(0, 15)}: ROI ${t.roi.toFixed(2)}% → Score ${arenaScore}`)
        return {
          source: SOURCE, source_trader_id: t.traderId, season_id: period,
          rank: idx + 1, roi: t.roi, pnl: t.pnl || null,
          win_rate: t.winRate || null, max_drawdown: t.maxDrawdown || null,
          followers: t.followers || null, arena_score: arenaScore, captured_at: capturedAt,
        }
      })

      const { error } = await supabase.from('trader_snapshots').upsert(snapshotsData, {
        onConflict: 'source,source_trader_id,season_id'
      })

      if (error) {
        console.log(`  ⚠ 批量失败: ${error.message}`)
        let saved = 0
        for (const s of snapshotsData) {
          const { error: e } = await supabase.from('trader_snapshots').upsert(s, { onConflict: 'source,source_trader_id,season_id' })
          if (!e) saved++
        }
        results.push({ period, saved })
      } else {
        console.log(`  ✓ ${snapshotsData.length} 条`)
        results.push({ period, saved: snapshotsData.length })
      }
    }

    console.log(`\n${'='.repeat(50)}`)
    console.log(`✅ Weex 完成！`)
    for (const r of results) console.log(`  ${r.period}: ${r.saved} 条`)
    console.log(`${'='.repeat(50)}`)

  } finally {
    await browser.close()
  }
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1) })
