#!/usr/bin/env node
/**
 * Generate blockie avatar URLs for wallet-address traders that don't have avatar_url set.
 */
import 'dotenv/config'
import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
)

const walletSources = ['gains', 'gmx', 'hyperliquid', 'okx_web3', 'binance_web3']
let totalFixed = 0

for (const source of walletSources) {
  const { data } = await supabase
    .from('trader_sources')
    .select('id, source_trader_id')
    .eq('source', source)
    .is('avatar_url', null)

  if (!data || data.length === 0) continue

  let fixed = 0
  for (const t of data) {
    const id = t.source_trader_id
    // Wallet addresses start with 0x or are long base58 strings
    if (id.startsWith('0x') || id.length > 30) {
      const blockieUrl = `/api/avatar/blockie?address=${encodeURIComponent(id)}`
      const { error } = await supabase
        .from('trader_sources')
        .update({ avatar_url: blockieUrl })
        .eq('id', t.id)
      if (!error) fixed++
    }
  }

  if (fixed > 0) {
    console.log(`${source}: generated ${fixed} blockie URLs`)
    totalFixed += fixed
  }
}

console.log(`\nTotal fixed: ${totalFixed}`)
