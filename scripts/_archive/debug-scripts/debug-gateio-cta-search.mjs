#!/usr/bin/env node
/**
 * Debug: Search for specific CTA traders
 */
import { chromium } from 'playwright'
import { sleep } from './lib/shared.mjs'

async function main() {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] })
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
    viewport: { width: 1920, height: 1080 },
  })
  const page = await context.newPage()
  await page.goto('https://www.gate.com/copytrading', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {})
  await sleep(3000)

  async function apiFetch(url) {
    return page.evaluate(async (u) => {
      try {
        const r = await fetch(u, { credentials: 'include' })
        return await r.json()
      } catch (e) { return { error: String(e) } }
    }, url)
  }

  // Check total count of CTA traders
  const ctaFirst = await apiFetch('https://www.gate.com/apiw/v2/copy/leader/query_cta_trader?page_num=1&page_size=20&sort_field=NINETY_PROFIT_RATE_SORT')
  console.log('CTA total count info:', JSON.stringify({
    code: ctaFirst?.code,
    dataKeys: Object.keys(ctaFirst?.data || {}),
    total: ctaFirst?.data?.total_count || ctaFirst?.data?.total || 'N/A',
    listLen: ctaFirst?.data?.list?.length
  }))

  // Try searching by name
  const searches = ['galaxyquant', 'GalaxyQuant', 'fireblue', 'sensei', 'gunmanzzz', 'loaitrx', 'rayder', 'studen']
  for (const name of searches) {
    const r = await apiFetch(`https://www.gate.com/apiw/v2/copy/leader/query_cta_trader?page_num=1&page_size=20&sort_field=NINETY_PROFIT_RATE_SORT&trader_name=${encodeURIComponent(name)}`)
    const count = r?.data?.list?.length || 0
    console.log(`Search "${name}": ${count} results`)
    if (count > 0) console.log('  First:', JSON.stringify(r?.data?.list?.[0]).slice(0, 200))
    await sleep(200)
  }

  // Try going to page 31+ to see if there are more CTA traders
  console.log('\n=== Checking pages 31-40 ===')
  for (let pg = 31; pg <= 40; pg++) {
    const r = await apiFetch(`https://www.gate.com/apiw/v2/copy/leader/query_cta_trader?page_num=${pg}&page_size=20&sort_field=NINETY_PROFIT_RATE_SORT`)
    const list = r?.data?.list || []
    if (list.length === 0) { console.log(`Page ${pg}: empty (stopped)`); break }
    console.log(`Page ${pg}: ${list.length} traders`)
    if (list.length > 0) {
      const nicks = list.map(t => t.nickname || '').slice(0, 3).join(', ')
      console.log(`  First 3: ${nicks}`)
    }
    await sleep(300)
  }

  // Try different base URL (without leading https)
  console.log('\n=== Trying relative URL with /apiw/v2/copy/leader/query_cta_trader ===')
  const relResult = await page.evaluate(async () => {
    const r = await fetch('/apiw/v2/copy/leader/query_cta_trader?page_num=1&page_size=20&sort_field=COPY_USER_COUNT_SORT&trader_name=galaxyquant')
    const j = await r.json()
    return { code: j?.code, listLen: j?.data?.list?.length, total: j?.data?.total_count }
  })
  console.log('Relative URL result:', JSON.stringify(relResult))
  
  // Try without page_size limit, see if there's a way to get all traders
  const maxPageResult = await page.evaluate(async () => {
    // Try page_size=1000
    const r = await fetch('/apiw/v2/copy/leader/query_cta_trader?page_num=1&page_size=1000&sort_field=NINETY_PROFIT_RATE_SORT')
    const j = await r.json()
    return { listLen: j?.data?.list?.length, total: j?.data?.total_count, totalPages: j?.data?.total_page }
  })
  console.log('With page_size=1000:', JSON.stringify(maxPageResult))

  // Try all 4 sort fields but with different page ranges
  console.log('\n=== Extended pagination with ALL sort fields ===')
  const uniqueNicks = new Set()
  for (const sortField of ['NINETY_PROFIT_RATE_SORT', 'THIRTY_PROFIT_RATE_SORT', 'SEVEN_PROFIT_RATE_SORT', 'COPY_USER_COUNT_SORT', 'TOTAL_PROFIT_RATE_SORT']) {
    let prevSize = 0
    for (let pg = 1; pg <= 50; pg++) {
      const r = await apiFetch(`https://www.gate.com/apiw/v2/copy/leader/query_cta_trader?page_num=${pg}&page_size=20&sort_field=${sortField}`)
      const list = r?.data?.list || []
      if (list.length === 0) break
      for (const t of list) uniqueNicks.add(t.nickname)
      await sleep(200)
    }
    console.log(`${sortField}: total unique so far: ${uniqueNicks.size}`)
  }
  
  console.log(`\nTotal unique CTA nicknames: ${uniqueNicks.size}`)
  
  // Check if our target nicknames are in there
  const targets = ['GalaxyQuant', 'galaxyquant', 'FireBlue', 'fireblue', 'Sensei', 'Gunmanzzz', 'loaitrx', 'Rayder', 'Studen']
  for (const t of targets) {
    const found = [...uniqueNicks].find(n => n.toLowerCase() === t.toLowerCase())
    if (found) console.log(`FOUND: "${t}" → "${found}"`)
    else {
      // Partial match
      const partial = [...uniqueNicks].find(n => n.toLowerCase().includes(t.toLowerCase().slice(0, 5)))
      if (partial) console.log(`PARTIAL: "${t}" ≈ "${partial}"`)
      else console.log(`NOT FOUND: "${t}"`)
    }
  }

  await browser.close()
}

main().catch(e => { console.error(e); process.exit(1) })
