#!/usr/bin/env node
/**
 * enrich-htx-avatars.mjs
 * 从 HTX API 补充缺失的头像
 */
import 'dotenv/config'
import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

const DRY_RUN = process.argv.includes('--dry-run')
const API_URL = 'https://futures.htx.com/-/x/hbg/v1/futures/copytrading/rank'
const PAGE_SIZE = 50

const sleep = ms => new Promise(r => setTimeout(r, ms))

async function fetchHtxAvatars() {
  console.log('\n🔄 Fetching HTX avatars from API...')

  const avatarMap = new Map() // trader ID → imgUrl
  const maxPages = 20 // Fetch ~1000 traders

  for (let pageNo = 1; pageNo <= maxPages; pageNo++) {
    try {
      const url = `${API_URL}?rankType=1&pageNo=${pageNo}&pageSize=${PAGE_SIZE}`
      const response = await fetch(url, {
        headers: {
          'Accept': 'application/json',
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        }
      })

      const data = await response.json()

      if (data.code !== 200 || !data.data?.itemList) {
        console.log(`  ⚠ API error: ${data.code}`)
        break
      }

      const list = data.data.itemList

      for (const item of list) {
        const avatar = item.imgUrl || null
        if (!avatar) continue

        // Store both userSign (Base64) and uid (number) as keys
        const userSign = item.userSign
        const uid = String(item.uid || '')

        if (userSign) avatarMap.set(userSign, avatar)
        if (uid) avatarMap.set(uid, avatar)
      }

      console.log(`  📋 Page ${pageNo}: ${list.length} items, ${avatarMap.size} total IDs`)

      if (list.length < PAGE_SIZE) break

      await sleep(500) // Rate limiting

    } catch (error) {
      console.error(`  ✗ Error fetching page ${pageNo}:`, error.message)
      break
    }
  }

  console.log(`\n✅ Total IDs with avatars: ${avatarMap.size}`)
  return avatarMap
}

async function updateDatabase(avatarMap) {
  console.log('\n🔄 Updating database...')

  // Get traders without avatars
  const { data: traders, error } = await supabase
    .from('trader_sources')
    .select('id, source_trader_id')
    .eq('source', 'htx_futures')
    .is('avatar_url', null)

  if (error) {
    console.error('Error fetching traders:', error)
    return
  }

  console.log(`  Found ${traders.length} HTX traders without avatars`)

  let updated = 0
  let notFound = 0

  for (const trader of traders) {
    const avatarUrl = avatarMap.get(trader.source_trader_id)

    if (avatarUrl) {
      if (!DRY_RUN) {
        const { error: updateError } = await supabase
          .from('trader_sources')
          .update({ avatar_url: avatarUrl })
          .eq('id', trader.id)

        if (!updateError) {
          updated++
        } else {
          console.error(`  ✗ Error updating ${trader.source_trader_id}:`, updateError)
        }
      } else {
        updated++
      }
    } else {
      notFound++
    }
  }

  console.log(`\n✅ Results ${DRY_RUN ? '(DRY RUN)' : ''}:`)
  console.log(`  Updated: ${updated}`)
  console.log(`  Not found in API: ${notFound}`)
}

async function main() {
  console.log(`\n🖼️ HTX Avatar Enrichment ${DRY_RUN ? '(DRY RUN)' : ''}`)

  const avatarMap = await fetchHtxAvatars()
  await updateDatabase(avatarMap)

  // Final stats
  const { count: remaining } = await supabase
    .from('trader_sources')
    .select('id', { count: 'exact', head: true })
    .eq('source', 'htx_futures')
    .is('avatar_url', null)

  console.log(`\n📊 Remaining HTX traders without avatars: ${remaining}`)
}

main().catch(console.error)
