#!/usr/bin/env node
/**
 * fix-avatars-binance.mjs
 * Fetch and store real avatar URLs for binance_futures traders.
 * 
 * Uses curl + mihomo proxy (port 7890) to bypass US geo-restriction.
 * API: GET /bapi/futures/v1/friendly/future/copy-trade/lead-portfolio/detail?portfolioId=...
 *   Returns: { data: { avatarUrl, nickName, ... } }
 * 
 * HARD RULES:
 *   - Only update WHERE avatar_url IS NULL in trader_sources
 *   - Never overwrite existing avatars
 *   - Only real CDN URLs, no fabricated avatars
 */
import { exec } from 'child_process'
import { promisify } from 'util'
import { createClient } from '@supabase/supabase-js'
import { config } from 'dotenv'
config({ path: new URL('../.env.local', import.meta.url).pathname })

const execAsync = promisify(exec)
const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const sb = createClient(SUPABASE_URL, SUPABASE_KEY)

const sleep = ms => new Promise(r => setTimeout(r, ms))
const PROXY = 'http://127.0.0.1:7890'
const CONCURRENCY = 5

function isRealAvatar(url) {
  if (!url || typeof url !== 'string' || url.length < 10) return false
  if (!url.startsWith('http')) return false
  const lower = url.toLowerCase()
  // Binance uses their own default-avatar.png for traders without custom pics — that's OK
  // Only filter out truly fabricated/generated ones
  const fakes = ['boringavatars', 'dicebear', 'identicon']
  return !fakes.some(f => lower.includes(f))
}

async function fetchBinanceAvatar(portfolioId) {
  try {
    const { stdout } = await execAsync(
      `curl -s --max-time 10 -x ${PROXY} --compressed 'https://www.binance.com/bapi/futures/v1/friendly/future/copy-trade/lead-portfolio/detail?portfolioId=${portfolioId}' -H 'User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' -H 'Origin: https://www.binance.com' -H 'Referer: https://www.binance.com/en/copy-trading'`,
      { timeout: 15000 }
    )
    const json = JSON.parse(stdout)
    if (!json?.success) return null
    const url = json?.data?.avatarUrl || json?.data?.userPhotoUrl || json?.data?.headImage
    if (isRealAvatar(url)) return url
  } catch {}
  return null
}

async function main() {
  console.log('🖼️  Binance Futures Avatar Fix\n')

  // Test proxy first
  try {
    const { stdout } = await execAsync(`curl -s --max-time 5 -x ${PROXY} 'https://ipinfo.io/ip'`, { timeout: 8000 })
    console.log(`✓ Proxy working, IP: ${stdout.trim()}`)
  } catch {
    console.error('❌ Proxy not working! Check mihomo proxy on port 7890.')
    process.exit(1)
  }

  // Fetch traders with null avatar
  let allRows = []
  let start = 0
  while (true) {
    const { data, error } = await sb
      .from('trader_sources')
      .select('id, source_trader_id, handle')
      .eq('source', 'binance_futures')
      .is('avatar_url', null)
      .range(start, start + 499)
    if (error) throw new Error('DB error: ' + error.message)
    if (!data || data.length === 0) break
    allRows = allRows.concat(data)
    if (data.length < 500) break
    start += 500
  }

  console.log(`📊 Before: ${allRows.length} traders need avatars\n`)
  if (allRows.length === 0) { console.log('✅ Nothing to do!'); return }

  let updated = 0, failed = 0

  // Process in batches with CONCURRENCY
  for (let i = 0; i < allRows.length; i += CONCURRENCY) {
    const batch = allRows.slice(i, i + CONCURRENCY)
    
    const results = await Promise.all(batch.map(async row => {
      const avatar = await fetchBinanceAvatar(row.source_trader_id)
      return { row, avatar }
    }))

    for (const { row, avatar } of results) {
      if (!avatar) { failed++; continue }

      const { error } = await sb
        .from('trader_sources')
        .update({ avatar_url: avatar })
        .eq('id', row.id)
        .is('avatar_url', null) // double safety - never overwrite

      if (error) {
        console.warn(`  ❌ id=${row.id}: ${error.message}`)
        failed++
      } else {
        updated++
      }
    }

    const done = Math.min(i + CONCURRENCY, allRows.length)
    if (done % 100 === 0 || done === allRows.length) {
      console.log(`  ${done}/${allRows.length} | ✅ ${updated} | ❌ ${failed}`)
    }
    await sleep(300)
  }

  const { count: nullCount } = await sb
    .from('trader_sources')
    .select('*', { count: 'exact', head: true })
    .eq('source', 'binance_futures')
    .is('avatar_url', null)

  console.log(`\n✅ Updated: ${updated} | Failed/no-avatar: ${failed}`)
  console.log(`📊 After: binance_futures null_avatar=${nullCount}`)
}

main().catch(e => { console.error(e); process.exit(1) })
