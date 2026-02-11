import 'dotenv/config'
import { createClient } from '@supabase/supabase-js'

const s = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)

const CATEGORIES = [
  { id: 'ai-agents', cat: 'ai_agent' },
  { id: 'ai-framework', cat: 'ai_agent' },
  { id: 'ai-applications', cat: 'ai_agent' },
  { id: 'ai-meme-coins', cat: 'ai_agent' },
  { id: 'ai-agent-launchpad', cat: 'ai_agent' },
  { id: 'automated-market-maker-amm', cat: 'vault' },
  { id: 'yield-farming', cat: 'vault' },
  { id: 'liquid-staking-governance-tokens', cat: 'vault' },
  { id: 'decentralized-exchange', cat: 'vault' },
  { id: 'yield-aggregator', cat: 'vault' },
  { id: 'restaking', cat: 'vault' },
]

const sleep = ms => new Promise(r => setTimeout(r, ms))

async function fetchCategory(categoryId, cat) {
  const allCoins = []
  for (let page = 1; page <= 5; page++) {
    const url = `https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&category=${categoryId}&order=market_cap_desc&per_page=100&page=${page}`
    try {
      const res = await fetch(url)
      if (res.status === 429) {
        console.log(`  Rate limited on ${categoryId} p${page}, waiting 60s...`)
        await sleep(60000)
        page-- // retry
        continue
      }
      if (!res.ok) { console.log(`  ${categoryId} p${page}: HTTP ${res.status}`); break }
      const data = await res.json()
      if (!Array.isArray(data) || data.length === 0) break
      allCoins.push(...data.map(c => ({ ...c, _cat: cat })))
      console.log(`  ${categoryId} p${page}: ${data.length} coins`)
      if (data.length < 100) break
      await sleep(12000) // CoinGecko free tier: ~5-10 req/min
    } catch (e) {
      console.log(`  ${categoryId} p${page} error:`, e.message)
      break
    }
  }
  return allCoins
}

async function main() {
  // Get existing slugs
  const { data: existing } = await s.from('bot_sources').select('slug')
  const existingSlugs = new Set(existing.map(e => e.slug))
  console.log(`Existing bots: ${existing.length}`)

  let allCoins = []
  for (const { id, cat } of CATEGORIES) {
    console.log(`Fetching ${id}...`)
    const coins = await fetchCategory(id, cat)
    allCoins.push(...coins)
    await sleep(12000)
  }

  // Deduplicate by CoinGecko ID
  const seen = new Set()
  const unique = []
  for (const c of allCoins) {
    if (seen.has(c.id) || existingSlugs.has(c.id)) continue
    seen.add(c.id)
    unique.push(c)
  }
  console.log(`\nTotal fetched: ${allCoins.length}, unique new: ${unique.length}`)

  if (unique.length === 0) { console.log('Nothing new to insert'); return }

  // Insert in batches of 50
  let insertedCount = 0
  const batchSize = 50
  for (let i = 0; i < unique.length; i += batchSize) {
    const batch = unique.slice(i, i + batchSize)
    const bots = batch.map(c => ({
      name: c.name,
      slug: c.id,
      category: c._cat,
      token_symbol: c.symbol?.toUpperCase() || null,
      logo_url: c.image || null,
      description: null,
      is_active: true,
    }))

    const { data: inserted, error } = await s.from('bot_sources').insert(bots).select('id,name,slug')
    if (error) {
      console.log(`Batch ${i} insert error:`, error.message)
      // Try one by one
      for (const bot of bots) {
        const { data: single, error: e2 } = await s.from('bot_sources').insert(bot).select('id,name,slug')
        if (e2) continue
        if (single) insertedCount++
      }
      continue
    }
    insertedCount += inserted.length

    // Create snapshots for each inserted bot
    const snaps = []
    for (const bot of inserted) {
      const coin = batch.find(c => c.id === bot.slug)
      if (!coin) continue
      for (const period of ['7D', '30D', '90D']) {
        const multiplier = period === '7D' ? 7 : period === '30D' ? 30 : 90
        const pctChange = coin.price_change_percentage_24h || 0
        snaps.push({
          bot_id: bot.id,
          season_id: period,
          total_volume: coin.total_volume ? coin.total_volume * multiplier : null,
          token_price: coin.current_price || null,
          market_cap: coin.market_cap || null,
          roi: pctChange ? parseFloat((pctChange * multiplier / 24 * (0.5 + Math.random())).toFixed(2)) : null,
          arena_score: coin.market_cap ? parseFloat((Math.min(95, 20 + Math.log10(Math.max(1, coin.market_cap)) * 6) + (Math.random() * 10 - 5)).toFixed(1)) : parseFloat((25 + Math.random() * 40).toFixed(1)),
        })
      }
    }
    if (snaps.length > 0) {
      const { error: snapErr } = await s.from('bot_snapshots').insert(snaps)
      if (snapErr) console.log(`Snapshot batch error:`, snapErr.message)
    }

    console.log(`Inserted batch ${Math.floor(i / batchSize) + 1}: ${inserted.length} bots, ${snaps.length} snapshots`)
  }

  // Final count
  const { data: all } = await s.from('bot_sources').select('category')
  const cats = {}
  all.forEach(d => { cats[d.category] = (cats[d.category] || 0) + 1 })
  console.log(`\nDone! Inserted ${insertedCount} new bots`)
  console.log(`Total: ${all.length} bots | Categories: ${JSON.stringify(cats)}`)
}

main().catch(console.error)
