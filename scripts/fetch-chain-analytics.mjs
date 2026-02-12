#!/usr/bin/env node
/**
 * fetch-chain-analytics.mjs
 * 从 DefiLlama 抓取多链TVL和协议数据，存入 chain_analytics 表
 * 
 * 用法: node scripts/fetch-chain-analytics.mjs
 * 环境变量: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */

import { createClient } from '@supabase/supabase-js'

// ============================================
// Config
// ============================================
const CHAINS = [
  { name: 'Ethereum', slug: 'Ethereum' },
  { name: 'Solana', slug: 'Solana' },
  { name: 'Base', slug: 'Base' },
  { name: 'Arbitrum', slug: 'Arbitrum' },
  { name: 'Polygon', slug: 'Polygon' },
  { name: 'BSC', slug: 'BSC' },
  { name: 'Avalanche', slug: 'Avalanche' },
  { name: 'Optimism', slug: 'OP Mainnet' },
]

const DEFILLAMA_BASE = 'https://api.llama.fi'

// ============================================
// Helpers
// ============================================
async function fetchJSON(url) {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${url} returned ${res.status}`)
  return res.json()
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

// ============================================
// Data Fetching
// ============================================
async function fetchChainTVLs() {
  const chains = await fetchJSON(`${DEFILLAMA_BASE}/v2/chains`)
  const map = {}
  for (const c of chains) {
    map[c.name] = c.tvl
  }
  return map
}

async function fetchTopProtocolsForChain(chainSlug, limit = 10) {
  const protocols = await fetchJSON(`${DEFILLAMA_BASE}/v2/protocols`)
  return protocols
    .filter(p => p.chains?.includes(chainSlug))
    .sort((a, b) => (b.tvl || 0) - (a.tvl || 0))
    .slice(0, limit)
    .map(p => ({
      name: p.name,
      symbol: p.symbol,
      category: p.category,
      tvl: p.tvl,
      chain_tvl: p.chainTvls?.[chainSlug] || null,
    }))
}

// ============================================
// Main
// ============================================
async function main() {
  const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY

  // Allow dry-run without Supabase
  const dryRun = !supabaseUrl || !supabaseKey
  if (dryRun) {
    console.log('⚠️  No Supabase credentials — running in dry-run mode (stdout only)')
  }

  const supabase = dryRun ? null : createClient(supabaseUrl, supabaseKey, {
    auth: { persistSession: false }
  })

  console.log('📡 Fetching chain TVLs from DefiLlama...')
  const tvlMap = await fetchChainTVLs()

  console.log('📡 Fetching protocol data...')
  // Cache protocols list (single request)
  const allProtocols = await fetchJSON(`${DEFILLAMA_BASE}/v2/protocols`)

  const now = new Date().toISOString()
  const rows = []

  for (const chain of CHAINS) {
    const tvl = tvlMap[chain.slug] || tvlMap[chain.name] || 0

    const chainProtocols = allProtocols
      .filter(p => p.chainTvls && chain.slug in p.chainTvls)

    const topProtocols = chainProtocols
      .sort((a, b) => (b.chainTvls?.[chain.slug] || 0) - (a.chainTvls?.[chain.slug] || 0))
      .slice(0, 10)
      .map(p => ({
        name: p.name,
        symbol: p.symbol,
        category: p.category,
        total_tvl: p.tvl,
        chain_tvl: p.chainTvls?.[chain.slug] || null,
      }))

    const row = {
      chain_name: chain.name,
      chain_slug: chain.slug,
      tvl,
      top_protocols: topProtocols,
      protocol_count: chainProtocols.length,
      captured_at: now,
    }

    rows.push(row)
    console.log(`  ✅ ${chain.name}: TVL $${(tvl / 1e9).toFixed(2)}B | ${row.protocol_count} protocols`)
  }

  if (supabase) {
    const { error } = await supabase.from('chain_analytics').upsert(rows, {
      onConflict: 'chain_slug,captured_at',
    })
    if (error) {
      console.error('❌ Supabase insert error:', error.message)
      process.exit(1)
    }
    console.log(`\n✅ Inserted ${rows.length} rows into chain_analytics`)
  } else {
    console.log('\n📊 Results (dry-run):')
    console.table(rows.map(r => ({
      chain: r.chain_name,
      tvl: `$${(r.tvl / 1e9).toFixed(2)}B`,
      protocols: r.protocol_count,
      top: r.top_protocols[0]?.name || '-',
    })))
  }
}

main().catch(err => {
  console.error('❌ Fatal:', err.message)
  process.exit(1)
})
