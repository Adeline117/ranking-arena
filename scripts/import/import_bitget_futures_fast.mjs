/**
 * Bitget Futures - Fast version (list only, no detail pages)
 * Saves traders from the leaderboard list without visiting individual detail pages
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
const SOURCE = 'bitget_futures'

async function fetchAndSave(period) {
  console.log(`\n=== Bitget Futures ${period} ===`)
  
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
        if (url.includes('/api/') && (url.includes('trader') || url.includes('copy'))) {
          const text = await res.text().catch(() => '')
          if (text.startsWith('{') || text.startsWith('[')) {
            try {
              const json = JSON.parse(text)
              const list = json.data?.list || json.data?.traders || json.data || []
              if (Array.isArray(list) && list.length > 0 && list[0].traderUid) {
                for (const item of list) {
                  const id = item.traderUid || item.traderId
                  if (!id || traders.has(id)) continue
                  traders.set(id, {
                    traderId: String(id),
                    nickname: item.nickName || item.traderName || null,
                    avatar: item.headUrl || item.avatar || null,
                    roi: parseFloat(item.roi || item.roiRate || 0),
                    pnl: parseFloat(item.profit || item.totalProfit || item.pnl || 0),
                    winRate: parseFloat(item.winRate || 0),
                    followers: parseInt(item.followerCount || item.copyCount || 0),
                  })
                }
                console.log(`  API 拦截: ${list.length} 条, 总计 ${traders.size}`)
              }
            } catch {}
          }
        }
      } catch {}
    })

    const url = 'https://www.bitget.com/copy-trading/futures/all?rule=2&sort=0'
    console.log(`📱 访问: ${url}`)
    try {
      await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 })
    } catch { console.log('  页面加载超时，继续...') }
    
    await sleep(3000)
    
    // Close popups
    await page.evaluate(() => {
      document.querySelectorAll('button').forEach(btn => {
        const text = btn.textContent || ''
        if (text.includes('OK') || text.includes('Got') || text.includes('Accept')) {
          try { btn.click() } catch {}
        }
      })
    }).catch(() => {})

    // Extract from DOM
    const domTraders = await page.evaluate(() => {
      const links = document.querySelectorAll('a[href*="/trader/"]')
      return Array.from(links).map(a => {
        const match = a.href.match(/\/trader\/([a-f0-9]+)\//)
        if (!match) return null
        const text = a.textContent || ''
        const roiMatch = text.match(/([+-]?[\d,]+\.?\d*)%/)
        return {
          traderId: match[1],
          text: text.slice(0, 200),
          roi: roiMatch ? parseFloat(roiMatch[1].replace(/,/g, '')) : null,
        }
      }).filter(Boolean)
    })
    
    for (const t of domTraders) {
      if (!traders.has(t.traderId)) {
        traders.set(t.traderId, {
          traderId: t.traderId,
          nickname: null,
          roi: t.roi || 0,
        })
      }
    }
    console.log(`  DOM: ${domTraders.length}, 总计: ${traders.size}`)

    // Paginate
    for (let p = 2; p <= 10; p++) {
      if (traders.size >= 500) break
      const prev = traders.size
      
      await page.evaluate(() => window.scrollTo(0, 3500))
      await sleep(500)
      
      const clicked = await page.evaluate((pn) => {
        const items = document.querySelectorAll('.bit-pagination-item a, .bit-pagination-item, [class*="pagination"] li a, [class*="pagination"] li')
        for (const item of items) {
          if (item.textContent?.trim() === String(pn)) { item.click(); return true }
        }
        return false
      }, p)
      
      if (!clicked) { console.log(`  分页结束 (第${p}页)`); break }
      await sleep(3000)
      
      const more = await page.evaluate(() => {
        const links = document.querySelectorAll('a[href*="/trader/"]')
        return Array.from(links).map(a => {
          const match = a.href.match(/\/trader\/([a-f0-9]+)\//)
          if (!match) return null
          const text = a.textContent || ''
          const roiMatch = text.match(/([+-]?[\d,]+\.?\d*)%/)
          return { traderId: match[1], roi: roiMatch ? parseFloat(roiMatch[1].replace(/,/g, '')) : null }
        }).filter(Boolean)
      })
      
      for (const t of more) {
        if (!traders.has(t.traderId)) {
          traders.set(t.traderId, { traderId: t.traderId, roi: t.roi || 0 })
        }
      }
      console.log(`  第${p}页: ${traders.size - prev} 新, 总计 ${traders.size}`)
    }

    await page.close()
  } finally {
    await browser.close()
  }

  // Save to DB
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
    profile_url: `https://www.bitget.com/copy-trading/trader/${t.traderId}/futures`,
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
