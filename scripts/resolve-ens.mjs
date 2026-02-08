/**
 * ENS Batch Resolver
 * 
 * Finds all trader_sources with 0x address handles and resolves ENS names
 * via Ethereum mainnet reverse resolution.
 * 
 * Usage: node scripts/resolve-ens.mjs
 */

import 'dotenv/config'
import { createClient } from '@supabase/supabase-js'
import { createPublicClient, http } from 'viem'
import { mainnet } from 'viem/chains'

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY')
  process.exit(1)
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

// Use public Ethereum RPC (or set ETH_RPC_URL env var)
const ETH_RPC = process.env.ETH_RPC_URL || 'https://eth.llamarpc.com'

const client = createPublicClient({
  chain: mainnet,
  transport: http(ETH_RPC),
})

const sleep = ms => new Promise(r => setTimeout(r, ms))

async function main() {
  console.log('🔍 Fetching trader_sources with 0x handles...')

  // Find all records where handle looks like an Ethereum address
  const { data: traders, error } = await supabase
    .from('trader_sources')
    .select('id, source_trader_id, handle, source')
    .like('handle', '0x%')
    .limit(2000)

  if (error) {
    console.error('DB error:', error.message)
    process.exit(1)
  }

  // Filter to valid 42-char Ethereum addresses
  const ethTraders = traders.filter(t =>
    t.handle && /^0x[a-fA-F0-9]{40}$/.test(t.handle)
  )

  console.log(`Found ${ethTraders.length} traders with 0x addresses`)

  if (ethTraders.length === 0) {
    console.log('Nothing to resolve.')
    return
  }

  let resolved = 0
  let failed = 0
  const BATCH_SIZE = 10

  for (let i = 0; i < ethTraders.length; i += BATCH_SIZE) {
    const batch = ethTraders.slice(i, i + BATCH_SIZE)

    const results = await Promise.allSettled(
      batch.map(async (trader) => {
        try {
          const ensName = await client.getEnsName({
            address: trader.handle,
          })
          return { trader, ensName }
        } catch (err) {
          return { trader, ensName: null, error: err.message }
        }
      })
    )

    for (const result of results) {
      if (result.status === 'rejected') {
        failed++
        continue
      }

      const { trader, ensName } = result.value
      if (ensName) {
        console.log(`  ✅ ${trader.handle.slice(0, 10)}... → ${ensName}`)
        const { error: updateErr } = await supabase
          .from('trader_sources')
          .update({ handle: ensName })
          .eq('id', trader.id)

        if (updateErr) {
          console.error(`  ❌ Update failed for ${trader.id}:`, updateErr.message)
          failed++
        } else {
          resolved++
        }
      }
    }

    if (i + BATCH_SIZE < ethTraders.length) {
      await sleep(500) // Rate limit RPC calls
    }
  }

  console.log(`\n📊 Done: ${resolved} resolved, ${failed} failed, ${ethTraders.length - resolved - failed} no ENS`)
}

main().catch(console.error)
