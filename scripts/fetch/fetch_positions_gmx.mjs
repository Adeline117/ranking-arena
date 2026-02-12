#!/usr/bin/env node
/**
 * GMX Position Fetcher - Bulk fetch all open positions from GMX v2 subgraph
 * Cross-references with our trader list, writes to trader_position_history
 * 
 * Usage: node scripts/fetch/fetch_positions_gmx.mjs
 */

import { config } from 'dotenv'
config({ path: '.env.local' })

import { createClient } from '@supabase/supabase-js'

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

const SUBSQUID_URL = 'https://gmx.squids.live/gmx-synthetics-arbitrum:prod/api/graphql'

// Well-known Arbitrum token address → symbol
const TOKEN_MAP = {
  '0x82af49447d8a07e3bd95bd0d56f35241523fbab1': 'ETH',
  '0x47904963fc8b2340414262125af798b9655e58cd': 'BTC',
  '0xfc5a1a6eb076a2c7ad06ed22c90d7e710e35ad0a': 'GMX',
  '0xfa7f8980b0f1e64a2062791cc3b0871572f1f7f0': 'LINK',
  '0x912ce59144191c1204e64559fe8253a0e49e6548': 'ARB',
  '0xb06aa7e4af937c130dade66f6ed7642716fe07a': 'PENDLE',
  '0x9c74772b713a1b032aeb173e28683d937e51921c': 'PEPE',
  '0xdb58eb7f408eba2176ecb44a4696292605cceb39': 'DOGE',
  '0xa9004a5421372e1d83fb1f85b0fc986c912f91f3': 'SOL',
  '0x13674172e6e44d31d4be489d5184f3457c40153a': 'XRP',
  '0xe6172eecbb07f197f52bb73d74daa0e19c31c4db': 'AAVE',
  '0x53186c8419beb83fe4da74f7875041a1287337ed': 'ATOM',
  '0xc5ff0eb026db972f95df3dff04e697d8b660092a': 'AVAX',
  '0x1fd10e767187a92f0ab2abdeef4505e319ca06b2': 'NEAR',
  '0xdaf0a71608938f762e37ec5f72f670cc44703454': 'UNI',
  '0xeb2a83b973f4dbb9511d92dd40d2ba4c683f0971': 'LTC',
  '0x37a645648df29205c6261289983fb04ecd70b4b3': 'OP',
  '0xc5dbd52ae5a927cf585b884011d0c7631c9974c6': 'WLD',
  '0xfed500df379427fbc48bdaf3b511b519c7eccd26': 'ORDI',
  '0x3e57d02f9d196873e55727382974b02edebe6bfd': 'STX',
  '0x4c1dac9b6eaf122fe3de824c1c2220413f3ac197': 'EIGEN',
  '0xb46a094bc4b0adbd801e14b9db95e05e28962764': 'SUI',
  '0x955cd91eeae618f5a7b49e1e3c7482833b10dab4': 'TIA',
  '0x96ee343e36e8642627faea235d57a9fec8a6e34f': 'SEI',
  '0x938aef36caafbcb37815251b602168087ec14648': 'JTO',
  '0x580b373ac16803bb0133356f470f3c7eef54151b': 'POL',
  '0xaf770f03518686a365300ab35ad860e99967b2f0': 'RENDER',
  '0xb79eb5ba64a167676694bb41bc1640f95d309a2f': 'TON',
  '0x2f2a2543b76a4166549f7aab2e75bef0aefc5b0f': 'BTC',
}

let marketSymbolMap = {}

async function loadMarketMap() {
  const res = await fetch(SUBSQUID_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: '{ marketInfos(limit: 200) { id indexTokenAddress } }' })
  })
  const data = await res.json()
  for (const m of data?.data?.marketInfos || []) {
    const sym = TOKEN_MAP[m.indexTokenAddress?.toLowerCase()]
    if (sym) marketSymbolMap[m.id.toLowerCase()] = sym
  }
  console.log(`  Loaded ${Object.keys(marketSymbolMap).length} market→symbol mappings`)
}

function parseGmxUsd(raw) {
  if (!raw) return 0
  return Number(BigInt(raw) / BigInt(10 ** 22)) / 1e8
}

async function fetchAllOpenPositions() {
  let all = []
  let lastId = ''
  for (let i = 0; i < 20; i++) {
    const where = lastId
      ? `isSnapshot_eq: false, sizeInUsd_gt: "0", id_gt: "${lastId}"`
      : `isSnapshot_eq: false, sizeInUsd_gt: "0"`
    const query = `{ positions(where: {${where}}, limit: 1000, orderBy: id_ASC) { id account market sizeInUsd isLong entryPrice unrealizedPnl leverage } }`
    const res = await fetch(SUBSQUID_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query }),
      signal: AbortSignal.timeout(30000),
    })
    const data = await res.json()
    const positions = data?.data?.positions || []
    all.push(...positions)
    if (positions.length < 1000) break
    lastId = positions[positions.length - 1].id
    await sleep(200)
  }
  return all
}

async function getOurTraders() {
  const ids = new Set()
  let offset = 0
  while (true) {
    const { data } = await sb.from('trader_sources')
      .select('source_trader_id')
      .eq('source', 'gmx').eq('is_active', true)
      .range(offset, offset + 999)
    if (!data?.length) break
    data.forEach(t => ids.add(t.source_trader_id.toLowerCase()))
    offset += 1000
    if (data.length < 1000) break
  }
  return ids
}

async function main() {
  console.log(`\n🔷 GMX Position Fetcher (Bulk)`)

  await loadMarketMap()

  console.log(`  Fetching our GMX traders...`)
  const ourTraders = await getOurTraders()
  console.log(`  Our GMX traders: ${ourTraders.size}`)

  console.log(`  Fetching all open positions from subgraph...`)
  const allPositions = await fetchAllOpenPositions()
  console.log(`  Total open positions: ${allPositions.length}`)

  // Match and group by account
  const byAccount = new Map()
  for (const p of allPositions) {
    const acct = p.account.toLowerCase()
    if (!ourTraders.has(acct)) continue
    if (!byAccount.has(acct)) byAccount.set(acct, [])
    
    const symbol = marketSymbolMap[p.market?.toLowerCase()] || 'UNKNOWN'
    if (symbol === 'UNKNOWN') continue

    byAccount.get(acct).push({
      symbol,
      direction: p.isLong ? 'long' : 'short',
      entry_price: parseGmxUsd(p.entryPrice),
      max_position_size: parseGmxUsd(p.sizeInUsd),
      pnl_usd: parseGmxUsd(p.unrealizedPnl),
      margin_mode: 'isolated',
      status: 'open',
    })
  }

  console.log(`  Matched: ${byAccount.size} traders with positions\n`)

  // Delete old GMX positions (last 24h) and insert new
  const now = new Date().toISOString()
  const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
  
  let totalPos = 0, errors = 0
  let i = 0
  for (const [account, positions] of byAccount) {
    try {
      const records = positions.map(p => ({
        source: 'gmx', source_trader_id: account,
        symbol: p.symbol, direction: p.direction,
        position_type: 'perpetual', margin_mode: 'isolated',
        entry_price: p.entry_price || null,
        max_position_size: p.max_position_size || null,
        pnl_usd: p.pnl_usd || null,
        status: 'open', captured_at: now,
      }))

      await sb.from('trader_position_history').delete()
        .eq('source', 'gmx').eq('source_trader_id', account).gt('captured_at', oneDayAgo)

      const { error } = await sb.from('trader_position_history').insert(records)
      if (error) { errors++; console.error(`  ⚠ ${account.slice(0, 12)}: ${error.message}`) }
      else { totalPos += records.length }
    } catch (e) {
      errors++
    }
    i++
    if (i % 20 === 0) console.log(`  [${i}/${byAccount.size}] saved ${totalPos} positions`)
  }

  console.log(`\n✅ GMX Done: ${byAccount.size} traders, ${totalPos} positions saved, ${errors} errors`)
}

main().catch(console.error)
