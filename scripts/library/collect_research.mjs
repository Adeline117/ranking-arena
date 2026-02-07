#!/usr/bin/env node
// Collect research reports from Binance Research, Messari, etc.
import { getClient, upsertItems, sleep } from './lib.mjs'

async function collectBinanceResearch() {
  const items = []
  // Binance Research has a public API-like endpoint
  try {
    const res = await fetch('https://www.binance.com/bapi/composite/v1/public/cms/article/list/query?type=1&catalogId=48&pageNo=1&pageSize=50')
    const data = await res.json()
    if (data?.data?.articles) {
      for (const article of data.data.articles) {
        items.push({
          title: article.title,
          title_en: article.title,
          description: article.brief || null,
          category: 'research',
          subcategory: 'exchange_research',
          source_url: `https://www.binance.com/en/research/analysis/${article.code}`,
          cover_url: article.coverUrl || null,
          language: 'en',
          tags: ['binance', 'research'],
          publish_date: article.releaseDate ? new Date(article.releaseDate).toISOString().slice(0, 10) : null,
          is_free: true,
        })
      }
    }
  } catch (e) {
    console.error('Binance Research error:', e.message)
  }
  return items
}

async function collectMessari() {
  const items = []
  try {
    // Messari free research articles
    const res = await fetch('https://data.messari.io/api/v1/news?fields=title,url,author,published_at,tags&page=1&limit=50')
    const data = await res.json()
    if (data?.data) {
      for (const article of data.data) {
        items.push({
          title: article.title,
          title_en: article.title,
          author: article.author?.name || null,
          description: null,
          category: 'research',
          subcategory: 'market_research',
          source_url: article.url,
          language: 'en',
          tags: ['messari', ...(article.tags?.map(t => t.name) || [])],
          publish_date: article.published_at?.slice(0, 10) || null,
          is_free: true,
        })
      }
    }
  } catch (e) {
    console.error('Messari error:', e.message)
  }
  return items
}

// Add some well-known research reports manually
function getKnownReports() {
  return [
    { title: 'Bitcoin: A Peer-to-Peer Electronic Cash System', author: 'Satoshi Nakamoto', category: 'whitepaper', subcategory: 'blockchain', source_url: 'https://bitcoin.org/bitcoin.pdf', pdf_url: 'https://bitcoin.org/bitcoin.pdf', publish_date: '2008-10-31', tags: ['bitcoin', 'original'], crypto_symbols: ['BTC'], is_free: true },
    { title: 'Ethereum Whitepaper', author: 'Vitalik Buterin', category: 'whitepaper', subcategory: 'blockchain', source_url: 'https://ethereum.org/en/whitepaper/', publish_date: '2013-12-01', tags: ['ethereum', 'smart-contracts'], crypto_symbols: ['ETH'], is_free: true },
    { title: 'Uniswap v3 Core', author: 'Hayden Adams et al.', category: 'whitepaper', subcategory: 'defi', source_url: 'https://uniswap.org/whitepaper-v3.pdf', pdf_url: 'https://uniswap.org/whitepaper-v3.pdf', tags: ['defi', 'amm'], crypto_symbols: ['UNI'], is_free: true },
    { title: 'MakerDAO Whitepaper', author: 'MakerDAO', category: 'whitepaper', subcategory: 'defi', source_url: 'https://makerdao.com/whitepaper/', tags: ['defi', 'stablecoin'], crypto_symbols: ['MKR', 'DAI'], is_free: true },
    { title: 'Aave Protocol Whitepaper', author: 'Aave', category: 'whitepaper', subcategory: 'defi', source_url: 'https://github.com/aave/aave-protocol/blob/master/docs/Aave_Protocol_Whitepaper_v1_0.pdf', tags: ['defi', 'lending'], crypto_symbols: ['AAVE'], is_free: true },
  ]
}

async function main() {
  const client = getClient()
  await client.connect()
  console.log('Connected to DB')

  const binance = await collectBinanceResearch()
  console.log(`Binance Research: ${binance.length} articles`)
  await upsertItems(client, binance, 'binance_research')

  const messari = await collectMessari()
  console.log(`Messari: ${messari.length} articles`)
  await upsertItems(client, messari, 'messari')

  const known = getKnownReports()
  console.log(`Known reports: ${known.length}`)
  await upsertItems(client, known, 'manual')

  await client.end()
  console.log('Done!')
}

main().catch(e => { console.error(e); process.exit(1) })
