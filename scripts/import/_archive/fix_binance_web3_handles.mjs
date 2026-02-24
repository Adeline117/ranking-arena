/**
 * Fix binance_web3 trader handles and avatars
 *
 * Problem: 3337 traders have handles like `0x0000005c` (truncated wallet addresses)
 * Solution: Re-fetch the leaderboard API to get `addressLabel` and `addressLogo`,
 *           then update handles and avatar_url in trader_sources
 *
 * Usage: node scripts/import/fix_binance_web3_handles.mjs
 */

import { getSupabaseClient, sleep } from './lib/shared.mjs'

const supabase = getSupabaseClient()
const SOURCE = 'binance_web3'

const PERIODS = ['7d', '30d', '90d']
const CHAINS = [
  { chainId: 56, name: 'BSC' },
  { chainId: 1, name: 'ETH' },
  { chainId: 8453, name: 'Base' },
]
const TAGS = ['ALL', 'KOL']
const PAGE_SIZE = 100

async function fetchPage(tag, period, chainId, pageNo) {
  const url = `https://web3.binance.com/bapi/defi/v1/public/wallet-direct/market/leaderboard/query?tag=${tag}&pageNo=${pageNo}&pageSize=${PAGE_SIZE}&sortBy=0&orderBy=0&period=${period}&chainId=${chainId}`
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      'Accept': 'application/json',
    },
  })
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`)
  const json = await res.json()
  return json?.data?.data || []
}

async function fetchAllFromAPI() {
  console.log('📡 Fetching all traders from Binance Web3 API...')
  const tradersMap = new Map() // address → { addressLabel, addressLogo }

  for (const tag of TAGS) {
    for (const period of PERIODS) {
      for (const { chainId, name } of CHAINS) {
        let pageNo = 1
        let chainTotal = 0
        while (true) {
          try {
            const items = await fetchPage(tag, period, chainId, pageNo)
            if (!items.length) break

            for (const t of items) {
              if (!t.address) continue
              const addr = t.address.toLowerCase()
              // Only overwrite if we get a better entry (has label/logo)
              const existing = tradersMap.get(addr)
              if (!existing || (!existing.addressLabel && t.addressLabel) || (!existing.addressLogo && t.addressLogo)) {
                tradersMap.set(addr, {
                  address: t.address,
                  addressLabel: t.addressLabel || existing?.addressLabel || null,
                  addressLogo: t.addressLogo || existing?.addressLogo || null,
                })
              }
            }

            chainTotal += items.length
            if (items.length < PAGE_SIZE) break
            pageNo++
            await sleep(200)
          } catch (e) {
            console.warn(`  ⚠️ Error fetching ${tag}/${period}/${name} page ${pageNo}: ${e.message}`)
            await sleep(1000)
            break
          }
        }
        if (chainTotal > 0) console.log(`  ${tag}/${period}/${name}: ${chainTotal} traders fetched`)
        await sleep(200)
      }
    }
  }

  console.log(`\n✅ Total unique addresses from API: ${tradersMap.size}`)
  const withLabel = [...tradersMap.values()].filter(t => t.addressLabel).length
  const withLogo = [...tradersMap.values()].filter(t => t.addressLogo).length
  console.log(`   With addressLabel: ${withLabel}`)
  console.log(`   With addressLogo: ${withLogo}`)

  return tradersMap
}

async function updateDB(apiData) {
  console.log('\n📊 Fetching all binance_web3 traders from DB...')

  // Get all binance_web3 traders (paginate past 1000 limit)
  let allTraders = []
  let from = 0
  const PAGE = 1000
  while (true) {
    const { data, error } = await supabase
      .from('trader_sources')
      .select('id, source_trader_id, handle, avatar_url')
      .eq('source', SOURCE)
      .range(from, from + PAGE - 1)
    if (error) { console.error('DB fetch error:', error.message); break }
    allTraders = allTraders.concat(data || [])
    if (!data || data.length < PAGE) break
    from += PAGE
  }

  console.log(`  Found ${allTraders.length} traders in DB`)

  let handleUpdated = 0
  let avatarFilled = 0
  let skippedNoLabel = 0
  let notInAPI = 0

  // Batch updates
  const BATCH = 50
  const updates = []

  for (const trader of allTraders) {
    const addr = trader.source_trader_id.toLowerCase()
    const api = apiData.get(addr)

    if (!api) {
      notInAPI++
      continue
    }

    const newHandle = api.addressLabel || null
    const newAvatar = api.addressLogo || null

    const update = {}
    let changed = false

    // Update handle if: current handle is 0x truncated AND we have a real label
    if (trader.handle && trader.handle.toLowerCase().startsWith('0x') && newHandle) {
      update.handle = newHandle
      changed = true
      handleUpdated++
    }

    // Fill avatar_url if: currently NULL and we have a logo
    if (!trader.avatar_url && newAvatar) {
      update.avatar_url = newAvatar
      changed = true
      avatarFilled++
    }

    if (!changed && !newHandle && trader.handle && trader.handle.toLowerCase().startsWith('0x')) {
      skippedNoLabel++
    }

    if (changed) {
      updates.push({ id: trader.id, ...update })
    }
  }

  console.log(`\n📋 Update plan:`)
  console.log(`  Handles to update (0x→nickname): ${handleUpdated}`)
  console.log(`  Avatars to fill (NULL→URL): ${avatarFilled}`)
  console.log(`  Traders with 0x handle but no API label: ${skippedNoLabel}`)
  console.log(`  Traders not found in API (stale?): ${notInAPI}`)
  console.log(`  Total DB updates: ${updates.length}`)

  if (updates.length === 0) {
    console.log('\n⚠️ Nothing to update.')
    return { handleUpdated: 0, avatarFilled: 0 }
  }

  // Execute updates in batches
  console.log('\n💾 Applying updates...')
  let successCount = 0
  let errorCount = 0

  for (let i = 0; i < updates.length; i += BATCH) {
    const batch = updates.slice(i, i + BATCH)
    const promises = batch.map(({ id, handle, avatar_url }) => {
      const upd = {}
      if (handle !== undefined) upd.handle = handle
      if (avatar_url !== undefined) upd.avatar_url = avatar_url
      return supabase.from('trader_sources').update(upd).eq('id', id)
        .then(({ error }) => {
          if (error) errorCount++
          else successCount++
        })
    })
    await Promise.all(promises)

    if ((i + BATCH) % 500 === 0 || i + BATCH >= updates.length) {
      console.log(`  Progress: ${Math.min(i + BATCH, updates.length)}/${updates.length} (ok: ${successCount}, err: ${errorCount})`)
    }
  }

  console.log(`\n✅ Done: ${successCount} records updated, ${errorCount} errors`)
  return { handleUpdated, avatarFilled, successCount, errorCount }
}

async function printSummary() {
  console.log('\n📊 Final DB state:')

  const { count: totalTraders } = await supabase
    .from('trader_sources').select('*', { count: 'exact', head: true }).eq('source', SOURCE)
  const { count: stillHex } = await supabase
    .from('trader_sources').select('*', { count: 'exact', head: true }).eq('source', SOURCE).ilike('handle', '0x%')
  const { count: nullAvatar } = await supabase
    .from('trader_sources').select('*', { count: 'exact', head: true }).eq('source', SOURCE).is('avatar_url', null)
  const { count: hasAvatar } = await supabase
    .from('trader_sources').select('*', { count: 'exact', head: true }).eq('source', SOURCE).not('avatar_url', 'is', null)

  console.log(`  Total binance_web3 traders: ${totalTraders}`)
  console.log(`  Still have 0x handles: ${stillHex}`)
  console.log(`  NULL avatar_url: ${nullAvatar}`)
  console.log(`  Has avatar_url: ${hasAvatar}`)

  // Sample updated traders
  const { data: samples } = await supabase
    .from('trader_sources')
    .select('source_trader_id, handle, avatar_url')
    .eq('source', SOURCE)
    .not('handle', 'ilike', '0x%')
    .not('avatar_url', 'is', null)
    .limit(5)
  
  if (samples && samples.length > 0) {
    console.log('\n  Sample traders with nicknames:')
    samples.forEach(t => {
      console.log(`    ${t.source_trader_id.slice(0,12)}... → "${t.handle}" | avatar: ${t.avatar_url ? '✓' : '✗'}`)
    })
  }

  // Sample of remaining 0x traders (to verify they truly have no label)
  const { data: hexSamples } = await supabase
    .from('trader_sources')
    .select('source_trader_id, handle, avatar_url')
    .eq('source', SOURCE)
    .ilike('handle', '0x%')
    .limit(3)
  
  if (hexSamples && hexSamples.length > 0) {
    console.log('\n  Sample remaining 0x traders (no Binance label set):')
    hexSamples.forEach(t => {
      console.log(`    ${t.source_trader_id.slice(0,12)}... → "${t.handle}"`)
    })
  }
}

async function main() {
  console.log('='.repeat(60))
  console.log('Binance Web3 Handle + Avatar Fix')
  console.log('='.repeat(60))

  // Step 1: Fetch all trader data from API
  const apiData = await fetchAllFromAPI()

  // Step 2: Update DB
  const result = await updateDB(apiData)

  // Step 3: Print final summary
  await printSummary()

  console.log('\n' + '='.repeat(60))
  console.log('SUMMARY')
  console.log('='.repeat(60))
  console.log(`  Handles updated (0x→nickname): ${result.handleUpdated}`)
  console.log(`  Avatars filled (NULL→URL): ${result.avatarFilled}`)
  console.log(`  Total DB writes: ${result.successCount}`)
  console.log('='.repeat(60))
}

main().catch(e => { console.error('Fatal error:', e); process.exit(1) })
