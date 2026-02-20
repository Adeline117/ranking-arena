#!/usr/bin/env node
/**
 * Debug: Check CTA trader ID computation vs DB IDs
 */
import { chromium } from 'playwright'
import { sleep } from './lib/shared.mjs'

const TARGET_IDS = new Set([
  'cta_abluk24', 'cta_dragonsmallsmallsmal', 'cta_fireblue', 'cta_galaxyquant',
  'cta_gateuser061f1d13', 'cta_gateuser0eec98f2', 'cta_gateuser19f45b51',
  'cta_gateuser3893dd1b', 'cta_gateuser6ed1d847', 'cta_gateuser947625fb',
  'cta_gateuser96a07d2e', 'cta_gateusera1af57c1', 'cta_gateuserbf05e1e0',
  'cta_gateuserbfda99d2', 'cta_gateuserc864817e', 'cta_gateuserca120d12',
  'cta_gateuserd2e4499f', 'cta_gateuserfab06533', 'cta_gunmanzzz',
  'cta_loaitrx', 'cta_mossclothessleepdeer', 'cta_rayder', 'cta_rosesneverpanic',
  'cta_sensei', 'cta_slowisfast', 'cta_studen', 'cta_zhaocaiqi'
])

async function main() {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] })
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
    viewport: { width: 1920, height: 1080 },
  })
  const page = await context.newPage()
  await page.goto('https://www.gate.com/copytrading', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {})
  await sleep(3000)

  // Fetch all CTA traders and show IDs computed 2 ways
  const result = await page.evaluate(async () => {
    const allNicknames = new Set()
    
    for (const sortField of ['NINETY_PROFIT_RATE_SORT', 'THIRTY_PROFIT_RATE_SORT', 'SEVEN_PROFIT_RATE_SORT', 'COPY_USER_COUNT_SORT']) {
      for (let pg = 1; pg <= 30; pg++) {
        try {
          const r = await fetch(`/apiw/v2/copy/leader/query_cta_trader?page_num=${pg}&page_size=100&sort_field=${sortField}`)
          const j = await r.json()
          const list = j?.data?.list || []
          if (list.length === 0) break
          for (const t of list) {
            allNicknames.add(JSON.stringify({
              nickname: t.nickname || '',
              nick_en: t.nick_en || '',
              // Computed IDs using different strategies:
              id_v1: 'cta_' + (t.nickname || '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 20),
              id_v2: 'cta_' + (t.nick_en || '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 20),
              id_v3: 'cta_' + (t.nickname || '').toLowerCase().replace(/\s+/g, '').replace(/[^a-z0-9]/g, '').slice(0, 20),
              // Also just raw stripped
              stripped_nick: (t.nickname || '').toLowerCase().replace(/[^a-z0-9]/g, ''),
              stripped_nicken: (t.nick_en || '').toLowerCase().replace(/[^a-z0-9]/g, ''),
            }))
          }
        } catch { break }
      }
    }
    return [...allNicknames].map(s => JSON.parse(s))
  })
  
  console.log(`Total unique CTA traders: ${result.length}`)
  
  // Find any that match target IDs
  const TARGET_IDS = new Set([
    'cta_abluk24', 'cta_dragonsmallsmallsmal', 'cta_fireblue', 'cta_galaxyquant',
    'cta_gateuser061f1d13', 'cta_gateuser0eec98f2', 'cta_gateuser19f45b51',
    'cta_gateuser3893dd1b', 'cta_gateuser6ed1d847', 'cta_gateuser947625fb',
    'cta_gateuser96a07d2e', 'cta_gateusera1af57c1', 'cta_gateuserbf05e1e0',
    'cta_gateuserbfda99d2', 'cta_gateuserc864817e', 'cta_gateuserca120d12',
    'cta_gateuserd2e4499f', 'cta_gateuserfab06533', 'cta_gunmanzzz',
    'cta_loaitrx', 'cta_mossclothessleepdeer', 'cta_rayder', 'cta_rosesneverpanic',
    'cta_sensei', 'cta_slowisfast', 'cta_studen', 'cta_zhaocaiqi'
  ])
  
  console.log('\n=== Matches found ===')
  for (const t of result) {
    const matched = [t.id_v1, t.id_v2, t.id_v3].find(id => TARGET_IDS.has(id))
    if (matched) {
      console.log(`MATCH: ${matched}`)
      console.log(`  nickname: "${t.nickname}", nick_en: "${t.nick_en}"`)
      console.log(`  v1: ${t.id_v1}, v2: ${t.id_v2}`)
    }
  }
  
  // Try fuzzy matching - show close matches
  console.log('\n=== Close matches (partial string overlap) ===')
  const targetNames = [...TARGET_IDS].map(id => id.replace('cta_', ''))
  for (const t of result) {
    const n = t.stripped_nick || ''
    const ne = t.stripped_nicken || ''
    for (const target of targetNames) {
      if (n.includes(target.slice(0, 8)) || ne.includes(target.slice(0, 8)) ||
          target.includes(n.slice(0, 8))) {
        console.log(`Close match: "${t.nickname}" → ${n} vs target: ${target}`)
        break
      }
    }
  }
  
  // Show sample computed IDs
  console.log('\n=== Sample IDs (first 30) ===')
  for (const t of result.slice(0, 30)) {
    console.log(`  nickname: "${t.nickname}" → id_v1: ${t.id_v1}`)
  }
  
  await browser.close()
}

main().catch(e => { console.error(e); process.exit(1) })
