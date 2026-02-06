#!/usr/bin/env node
/**
 * fix-htx-avatars.mjs
 * 1. Remove fake HTX "traders" (navigation elements from DOM scraping)
 * 2. Decode Base64 IDs and match against API uids
 * 3. Update avatars for matched traders
 */
import 'dotenv/config'
import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
)
const sleep = ms => new Promise(r => setTimeout(r, ms))

// These handles are navigation elements, not real traders
const FAKE_HANDLES = [
  'About HTX', 'Products', 'Buy Crypto', 'Buy BTC', 'Services',
  'One-Click Purchase', 'Trade', 'Derivatives', 'Finance', 'More',
  'NFT', 'Copy Trading', 'Spot', 'Futures',
]

function tryDecodeBase64(str) {
  try {
    const decoded = Buffer.from(str, 'base64').toString('utf-8')
    // If it decodes to a number, return it
    if (/^\d+$/.test(decoded)) return decoded
  } catch {}
  return null
}

async function main() {
  console.log('=== HTX Avatar Fix ===\n')

  // Step 1: Remove fake traders (navigation elements)
  console.log('Step 1: Removing fake HTX traders...')
  for (const handle of FAKE_HANDLES) {
    const { data: fakes } = await supabase
      .from('trader_sources')
      .select('id, source_trader_id, handle')
      .eq('source', 'htx_futures')
      .eq('handle', handle)

    if (fakes?.length) {
      for (const f of fakes) {
        // Only delete if ID looks fake (htx_dom_*, 360000*)
        if (f.source_trader_id.startsWith('htx_dom_') || f.source_trader_id.startsWith('360000')) {
          await supabase.from('trader_sources').delete().eq('id', f.id)
          console.log(`  Removed: ${f.source_trader_id} (${f.handle})`)
        }
      }
    }
  }

  // Step 2: Fetch ALL traders from HTX rank API
  console.log('\nStep 2: Fetching HTX rank API...')
  const avatarByUid = new Map()     // uid (string) → imgUrl
  const avatarBySign = new Map()    // userSign (base64) → imgUrl
  const avatarByName = new Map()    // nickName → imgUrl

  for (const rankType of [1, 2, 3, 4, 5]) {
    for (let page = 1; page <= 20; page++) {
      const resp = await fetch(
        `https://futures.htx.com/-/x/hbg/v1/futures/copytrading/rank?rankType=${rankType}&pageNo=${page}&pageSize=50`,
        { headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' } },
      )
      const data = await resp.json().catch(() => null)
      if (data?.code !== 200 || !data?.data?.itemList?.length) break

      for (const item of data.data.itemList) {
        const avatar = item.imgUrl
        if (!avatar || avatar.includes('default')) continue

        if (item.uid) avatarByUid.set(String(item.uid), avatar)
        if (item.userSign) avatarBySign.set(item.userSign, avatar)
        if (item.nickName) avatarByName.set(item.nickName, avatar)
      }

      if (data.data.itemList.length < 50) break
      await sleep(300)
    }
  }

  console.log(`  UIDs: ${avatarByUid.size}, Signs: ${avatarBySign.size}, Names: ${avatarByName.size}`)

  // Step 3: Match and update
  console.log('\nStep 3: Matching and updating...')
  const { data: traders } = await supabase
    .from('trader_sources')
    .select('id, source_trader_id, handle')
    .eq('source', 'htx_futures')
    .is('avatar_url', null)

  console.log(`  ${traders?.length || 0} traders need avatars`)

  let updated = 0
  const unmatched = []

  for (const t of (traders || [])) {
    let avatar = null

    // 1. Direct match on source_trader_id as uid
    avatar = avatarByUid.get(t.source_trader_id)

    // 2. Direct match on source_trader_id as userSign
    if (!avatar) avatar = avatarBySign.get(t.source_trader_id)

    // 3. Decode base64 ID to uid and match
    if (!avatar) {
      const decodedUid = tryDecodeBase64(t.source_trader_id)
      if (decodedUid) avatar = avatarByUid.get(decodedUid)
    }

    // 4. Match by handle/nickname
    if (!avatar && t.handle) {
      avatar = avatarByName.get(t.handle)
    }

    // 5. Strip email/phone masking and try handle prefix
    if (!avatar && t.handle) {
      // Try first 3 chars of handle against nicknames
      const prefix = t.handle.substring(0, 3)
      for (const [name, url] of avatarByName) {
        if (name.startsWith(prefix) && name.length === t.handle.length) {
          avatar = url
          break
        }
      }
    }

    if (avatar) {
      const { error } = await supabase
        .from('trader_sources')
        .update({ avatar_url: avatar })
        .eq('id', t.id)
      if (!error) {
        updated++
        console.log(`  [${updated}] ${t.handle} (${t.source_trader_id}) -> avatar found`)
      }
    } else {
      unmatched.push(t)
    }
  }

  console.log(`\nResult: ${updated}/${traders?.length || 0} updated`)
  if (unmatched.length > 0) {
    console.log(`\nUnmatched (${unmatched.length}):`)
    for (const t of unmatched) {
      const decoded = tryDecodeBase64(t.source_trader_id)
      console.log(`  ${t.source_trader_id}${decoded ? ' (uid: ' + decoded + ')' : ''} | ${t.handle}`)
    }
  }
}

main().catch(console.error)
