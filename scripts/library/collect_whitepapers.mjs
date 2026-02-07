#!/usr/bin/env node
// Collect crypto whitepapers from CoinGecko API
import { getClient, upsertItems, sleep } from './lib.mjs'

const BASE = 'https://api.coingecko.com/api/v3'
const BATCH_SIZE = 250 // coins per page for /coins/markets
const RATE_LIMIT_MS = 6000 // ~10 req/min for free tier

async function fetchJSON(url) {
  const res = await fetch(url)
  if (res.status === 429) {
    console.log('Rate limited, waiting 60s...')
    await sleep(60000)
    return fetchJSON(url)
  }
  if (!res.ok) throw new Error(`${res.status} ${url}`)
  return res.json()
}

async function main() {
  const client = getClient()
  await client.connect()
  console.log('Connected to DB')

  // Get top coins by market cap (up to 3000)
  const allCoins = []
  for (let page = 1; page <= 12; page++) { // 12 pages * 250 = 3000
    console.log(`Fetching coins page ${page}...`)
    try {
      const coins = await fetchJSON(`${BASE}/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=${BATCH_SIZE}&page=${page}&sparkline=false`)
      allCoins.push(...coins)
      await sleep(RATE_LIMIT_MS)
    } catch (e) {
      console.error(`Page ${page} error:`, e.message)
      await sleep(RATE_LIMIT_MS * 2)
    }
  }
  console.log(`Got ${allCoins.length} coins from markets`)

  // For each coin, fetch detail to get whitepaper link
  const items = []
  let processed = 0
  for (const coin of allCoins) {
    processed++
    if (processed % 50 === 0) console.log(`Processing ${processed}/${allCoins.length}...`)
    
    try {
      const detail = await fetchJSON(`${BASE}/coins/${coin.id}?localization=false&tickers=false&market_data=false&community_data=false&developer_data=false`)
      
      const wpUrl = detail.links?.whitepaper
      const homepage = detail.links?.homepage?.[0]
      const desc = detail.description?.en?.slice(0, 2000)
      const symbol = detail.symbol?.toUpperCase()

      items.push({
        title: `${detail.name} (${symbol}) Whitepaper`,
        title_en: `${detail.name} Whitepaper`,
        author: detail.name,
        description: desc || `Official whitepaper for ${detail.name}`,
        category: 'whitepaper',
        subcategory: detail.categories?.[0]?.toLowerCase() || 'blockchain',
        source_url: homepage || `https://www.coingecko.com/en/coins/${coin.id}`,
        pdf_url: wpUrl || null,
        cover_url: detail.image?.large || coin.image,
        language: 'en',
        tags: detail.categories || [],
        crypto_symbols: symbol ? [symbol] : [],
        publish_date: null,
        is_free: true,
      })

      await sleep(RATE_LIMIT_MS)
    } catch (e) {
      console.error(`Error fetching ${coin.id}:`, e.message)
      await sleep(RATE_LIMIT_MS)
    }
  }

  console.log(`Collected ${items.length} whitepaper entries`)
  await upsertItems(client, items, 'coingecko')
  await client.end()
  console.log('Done!')
}

main().catch(e => { console.error(e); process.exit(1) })
