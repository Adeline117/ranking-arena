/**
 * Bybit Copy Trading - Fast version using Puppeteer
 * No proxy, headless browser with API interception + DOM extraction
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

async function fetchAndSave(period) {
  console.log(`\n=== Bybit ${period} ===`)
  
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled'],
  })

  const traders = new Map()
  
  try {
    const page = await browser.newPage()
    await page.setViewport({ width: 1920, height: 1080 })
    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36')
    
    // Intercept API responses
    page.on('response', async (res) => {
      const url = res.url()
      try {
        if (url.includes('leaderBoard') || url.includes('leader-list') || url.includes('rank') || url.includes('copyTrad')) {
          const text = await res.text().catch(() => '')
          if (text.startsWith('{') || text.startsWith('[')) {
            try {
              const json = JSON.parse(text)
              const list = json.result?.list || json.data?.list || json.result?.data || []
              if (Array.isArray(list) && list.length > 0) {
                for (const item of list) {
                  const id = item.leaderId || item.traderUid || item.uid || item.leaderMark
                  if (!id || traders.has(String(id))) continue
                  traders.set(String(id), {
                    traderId: String(id),
                    nickname: item.nickName || item.leaderName || null,
                    avatar: item.avatar || item.avatarUrl || null,
                    roi: parseFloat(item.roi || item.roiRate || 0) * (Math.abs(parseFloat(item.roi || 0)) < 10 ? 100 : 1),
                    pnl: parseFloat(item.pnl || item.totalPnl || 0),
                    winRate: parseFloat(item.winRate || 0),
                    followers: parseInt(item.followerCount || item.copierNum || 0),
                  })
                }
                console.log(`  API 拦截: ${list.length} 条, 总计 ${traders.size}`)
              }
            } catch {}
          }
        }
      } catch {}
    })

    // Try the trade center URL
    const url = 'https://www.bybit.com/copyTrade/trade-center/find'
    console.log(`📱 访问: ${url}`)
    try {
      await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 })
    } catch { console.log('  页面加载超时，继续...') }
    
    await sleep(5000)
    
    // Check if we got redirected or blocked
    const currentUrl = page.url()
    console.log(`  当前URL: ${currentUrl}`)
    
    // Try clicking "All Traders" tab
    await page.evaluate(() => {
      document.querySelectorAll('div, span, button, a').forEach(el => {
        const text = (el.textContent || '').trim()
        if (text === 'All Traders' || text === '全部交易员' || text === 'All') {
          try { el.click() } catch {}
        }
      })
    }).catch(() => {})
    await sleep(2000)

    // Try period selection
    const periodText = period === '7D' ? '7D' : period === '30D' ? '30D' : '90D'
    await page.evaluate((pt) => {
      document.querySelectorAll('div, span, button').forEach(el => {
        const text = (el.textContent || '').trim()
        if (text === pt) {
          try { el.click() } catch {}
        }
      })
    }, periodText).catch(() => {})
    await sleep(3000)

    // Extract from DOM - look for trader cards/links
    const domTraders = await page.evaluate(() => {
      const results = []
      // Try various selectors for trader cards
      const cards = document.querySelectorAll('[class*="trader"], [class*="leader"], [class*="card"]')
      for (const card of cards) {
        const link = card.querySelector('a[href*="copyTrade"]') || card.querySelector('a')
        const href = link?.href || ''
        const idMatch = href.match(/leaderMark=([^&]+)/) || href.match(/uid=([^&]+)/) || href.match(/\/(\w{10,})/)
        if (!idMatch) continue
        
        const text = card.textContent || ''
        const roiMatch = text.match(/([+-]?[\d,]+\.?\d*)%/)
        const nameEl = card.querySelector('[class*="name"], [class*="nick"]')
        
        results.push({
          traderId: idMatch[1],
          nickname: nameEl?.textContent?.trim() || null,
          roi: roiMatch ? parseFloat(roiMatch[1].replace(/,/g, '')) : null,
        })
      }
      return results
    })
    
    for (const t of domTraders) {
      if (!traders.has(t.traderId)) {
        traders.set(t.traderId, {
          traderId: t.traderId,
          nickname: t.nickname,
          roi: t.roi || 0,
        })
      }
    }
    console.log(`  DOM: ${domTraders.length}, API: ${traders.size - domTraders.length}, 总计: ${traders.size}`)

    // Scroll to load more
    for (let i = 0; i < 20; i++) {
      const prev = traders.size
      await page.evaluate(() => window.scrollBy(0, 1000))
      await sleep(1500)
      if (traders.size === prev && i > 3) break
      if (traders.size > prev) console.log(`  滚动 ${i+1}: ${traders.size} 个`)
    }

    await page.close()
  } finally {
    await browser.close()
  }

  const records = Array.from(traders.values())
  if (records.length === 0) {
    console.log('❌ 无数据')
    return 0
  }

  console.log(`\n💾 保存 ${records.length} 条 ${period} 数据...`)
  const capturedAt = new Date().toISOString()
  
  // Save trader_sources
  const sourcesData = records.map(t => ({
    source: SOURCE,
    source_type: 'leaderboard',
    source_trader_id: t.traderId,
    handle: t.nickname || t.traderId.slice(0, 8),
    avatar_url: t.avatar || null,
    profile_url: `https://www.bybit.com/copyTrade/trade-center/detail?leaderMark=${t.traderId}`,
    is_active: true,
  }))
  
  const { error: srcErr } = await supabase.from('trader_sources').upsert(sourcesData, {
    onConflict: 'source,source_trader_id',
  })
  if (srcErr) console.log('  ⚠ trader_sources:', srcErr.message)
  
  // Save trader_snapshots
  const rows = records.map((t, idx) => ({
    source: SOURCE,
    source_trader_id: t.traderId,
    season_id: period,
    rank: idx + 1,
    roi: t.roi || 0,
    pnl: t.pnl || 0,
    win_rate: t.winRate || null,
    max_drawdown: null,
    followers: t.followers || null,
    arena_score: calculateArenaScore(t.roi || 0, t.pnl || 0, null, t.winRate || null, period)?.totalScore || 0,
    captured_at: capturedAt,
  }))

  const { error } = await supabase.from('trader_snapshots').upsert(rows, {
    onConflict: 'source,source_trader_id,season_id',
  })
  
  if (error) console.log('  ❌ DB 错误:', error.message)
  else console.log(`  ✅ 保存成功: ${rows.length}`)
  
  return rows.length
}

async function main() {
  const periods = getTargetPeriods()
  const results = {}
  for (const p of periods) {
    results[p] = await fetchAndSave(p)
  }
  console.log('\n=== 完成 ===')
  for (const [p, count] of Object.entries(results)) {
    console.log(`  ${p}: ${count} 条`)
  }
}

main().catch(console.error)
