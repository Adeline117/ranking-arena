#!/usr/bin/env node
/**
 * Enrich leaderboard_ranks for MEXC
 * Uses Puppeteer with stealth to intercept MEXC copy trading API
 * Matches by nickname (source_trader_id)
 * Fields: win_rate, max_drawdown, trades_count
 */
import puppeteer from 'puppeteer-extra'
import StealthPlugin from 'puppeteer-extra-plugin-stealth'
import { getSupabaseClient, sleep } from './lib/shared.mjs'

puppeteer.use(StealthPlugin())
const supabase = getSupabaseClient()
const SOURCE = 'mexc'
const BASE_URL = 'https://www.mexc.com/futures/copyTrade/home'

async function main() {
  console.log(`\n${'='.repeat(60)}`)
  console.log(`MEXC — Enrich leaderboard_ranks`)
  console.log(`${'='.repeat(60)}`)

  // Get all rows needing enrichment
  let allRows = []
  let offset = 0
  while (true) {
    const { data, error } = await supabase
      .from('leaderboard_ranks')
      .select('id, source_trader_id, season_id, win_rate, max_drawdown, trades_count')
      .eq('source', SOURCE)
      .or('win_rate.is.null,max_drawdown.is.null,trades_count.is.null')
      .range(offset, offset + 999)
    if (error) { console.error('DB error:', error.message); break }
    if (!data?.length) break
    allRows.push(...data)
    if (data.length < 1000) break
    offset += 1000
  }

  console.log(`Need enrichment: ${allRows.length} rows`)
  if (!allRows.length) return

  // Build lookup: nickname_lower -> [rows]
  const lookup = new Map()
  for (const r of allRows) {
    const nick = r.source_trader_id.toLowerCase()
    if (!lookup.has(nick)) lookup.set(nick, [])
    lookup.get(nick).push(r)
  }

  const apiTraders = new Map() // nickname_lower -> data

  function processTraderList(list) {
    for (const item of list) {
      const nickname = (item.nickname || item.nickName || item.name || '').toLowerCase()
      if (!nickname) continue

      const entry = {
        winRate: item.winRate != null ? parseFloat(item.winRate) : null,
        mdd: item.maxDrawdown7 != null ? Math.abs(parseFloat(item.maxDrawdown7)) :
             item.maxDrawdown != null ? Math.abs(parseFloat(item.maxDrawdown)) : null,
        openTimes: item.openTimes != null ? parseInt(item.openTimes) : null,
        totalWinRate: item.totalWinRate != null ? parseFloat(item.totalWinRate) : null,
      }

      // Convert decimals to percentages
      if (entry.winRate != null && Math.abs(entry.winRate) <= 1) entry.winRate *= 100
      if (entry.mdd != null && Math.abs(entry.mdd) <= 1) entry.mdd *= 100
      if (entry.totalWinRate != null && Math.abs(entry.totalWinRate) <= 1) entry.totalWinRate *= 100

      apiTraders.set(nickname, entry)
    }
  }

  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled'],
  })

  try {
    const page = await browser.newPage()
    await page.setViewport({ width: 1920, height: 1080 })
    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36')

    // Intercept API responses
    page.on('response', async response => {
      const url = response.url()
      try {
        const ct = response.headers()['content-type'] || ''
        if (!ct.includes('json')) return

        if (url.includes('v1/traders/v2') || url.includes('traders/top') ||
            url.includes('recommend/traders') || url.includes('traders/ai')) {
          const data = await response.json()

          if (data?.data?.content && Array.isArray(data.data.content)) {
            processTraderList(data.data.content)
          }
          if (data?.data) {
            for (const key of Object.keys(data.data)) {
              const arr = data.data[key]
              if (Array.isArray(arr) && arr.length > 0 && arr[0]?.uid) {
                processTraderList(arr)
              }
            }
          }
          if (Array.isArray(data?.data) && data.data.length > 0 && data.data[0]?.uid) {
            processTraderList(data.data)
          }
        }
      } catch {}
    })

    console.log('Loading MEXC copy trading page...')
    try {
      await page.goto(BASE_URL, { waitUntil: 'networkidle2', timeout: 60000 })
    } catch {
      console.log('  Load timeout, continuing...')
    }
    await sleep(8000)

    // Close popups
    await page.evaluate(() => {
      document.querySelectorAll('button, [class*="close"], [class*="modal"] *').forEach(el => {
        const text = (el.textContent || '').trim()
        const cn = typeof el.className === 'string' ? el.className : ''
        if (['关闭', 'OK', 'Got it', '确定', 'Close', 'I understand', '知道了'].some(t => text.includes(t)) || cn.includes('close')) {
          try { el.click() } catch {}
        }
      })
    })
    await sleep(2000)

    // Click "All Traders" tab
    console.log('Clicking All Traders tab...')
    await page.evaluate(() => {
      for (const el of document.querySelectorAll('button, [role="tab"], [class*="tab"], span, div, a')) {
        const text = (el.textContent || '').trim()
        if (['All Traders', '全部交易员', 'Top Traders'].includes(text)) {
          el.click(); return true
        }
      }
      return false
    })
    await sleep(3000)

    console.log(`  After initial load: ${apiTraders.size} traders`)

    // Paginate
    let noNewCount = 0
    for (let pageNum = 2; pageNum <= 60; pageNum++) {
      const before = apiTraders.size

      const clicked = await page.evaluate(() => {
        const btns = document.querySelectorAll('button, li, a, [class*="next"]')
        for (const el of btns) {
          const text = (el.textContent || '').trim()
          const cn = typeof el.className === 'string' ? el.className : ''
          const ariaLabel = el.getAttribute('aria-label') || ''
          if ((text === '›' || text === '>' || text === '»' || text === 'Next' ||
               cn.includes('next') || ariaLabel.includes('next') || ariaLabel.includes('Next')) &&
              !el.disabled && !cn.includes('disabled')) {
            el.click()
            return true
          }
        }

        const items = document.querySelectorAll('[class*="pagination"] li, [class*="pager"] li')
        if (items.length > 0) {
          const arr = [...items]
          const activeIdx = arr.findIndex(x => {
            const cn2 = typeof x.className === 'string' ? x.className : ''
            return cn2.includes('active') || cn2.includes('current') || cn2.includes('-selected')
          })
          if (activeIdx >= 0 && activeIdx + 1 < arr.length - 1) {
            arr[activeIdx + 1].click()
            return true
          }
        }
        return false
      })

      if (!clicked) {
        await page.evaluate(() => window.scrollBy(0, 5000))
        await sleep(3000)
      } else {
        await sleep(4000)
      }

      const gained = apiTraders.size - before
      if (gained > 0) {
        noNewCount = 0
        if (pageNum % 5 === 0) console.log(`  Page ${pageNum}: total ${apiTraders.size} traders`)
      } else {
        noNewCount++
        if (noNewCount >= 3) break
      }
    }

    console.log(`Total collected: ${apiTraders.size} traders`)
  } catch (e) {
    console.error('Browser error:', e.message)
  } finally {
    await browser.close()
  }

  // Match and update
  let updated = 0
  for (const [nickname, data] of apiTraders) {
    const rows = lookup.get(nickname)
    if (!rows) continue

    for (const row of rows) {
      const updates = {}
      const wr = data.winRate ?? data.totalWinRate
      if (row.win_rate == null && wr != null && !isNaN(wr)) updates.win_rate = parseFloat(wr.toFixed(2))
      if (row.max_drawdown == null && data.mdd != null && !isNaN(data.mdd)) updates.max_drawdown = parseFloat(data.mdd.toFixed(2))
      if (row.trades_count == null && data.openTimes != null) updates.trades_count = data.openTimes

      if (Object.keys(updates).length === 0) continue
      const { error } = await supabase.from('leaderboard_ranks').update(updates).eq('id', row.id)
      if (!error) updated++
    }
  }

  console.log(`\n✅ MEXC: ${updated} updated`)

  // Verify
  const { count: total } = await supabase.from('leaderboard_ranks').select('*', { count: 'exact', head: true }).eq('source', SOURCE)
  const { count: wrNull } = await supabase.from('leaderboard_ranks').select('*', { count: 'exact', head: true }).eq('source', SOURCE).is('win_rate', null)
  const { count: mddNull } = await supabase.from('leaderboard_ranks').select('*', { count: 'exact', head: true }).eq('source', SOURCE).is('max_drawdown', null)
  const { count: tcNull } = await supabase.from('leaderboard_ranks').select('*', { count: 'exact', head: true }).eq('source', SOURCE).is('trades_count', null)
  console.log(`After: total=${total} wr_null=${wrNull} mdd_null=${mddNull} tc_null=${tcNull}`)
}

main().catch(e => { console.error('Fatal:', e); process.exit(1) })
