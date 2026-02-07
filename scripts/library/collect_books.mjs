#!/usr/bin/env node
// Collect crypto/finance books from Google Books API
import { getClient, upsertItems, sleep } from './lib.mjs'

const QUERIES = [
  'cryptocurrency trading', 'bitcoin', 'ethereum blockchain',
  'technical analysis trading', 'quantitative trading',
  'DeFi decentralized finance', 'blockchain technology',
  'crypto investing', 'smart contracts solidity',
  'financial markets trading', 'algorithmic trading',
  'web3 development', 'NFT digital assets',
  'tokenomics crypto economics', 'derivatives futures trading',
  'risk management trading', 'market microstructure',
  'machine learning finance', 'options trading strategies',
  'forex currency trading', 'value investing',
  'portfolio management', 'behavioral finance',
  'fintech innovation', 'central bank digital currency',
]
const MAX_PER_QUERY = 40 // Google Books max startIndex ~40

async function searchBooks(query, startIndex = 0) {
  const url = `https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(query)}&startIndex=${startIndex}&maxResults=40&printType=books&langRestrict=en`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${res.status}`)
  const data = await res.json()
  return data.items || []
}

async function main() {
  const client = getClient()
  await client.connect()
  console.log('Connected to DB')

  let allItems = []
  for (const query of QUERIES) {
    console.log(`Searching Google Books: "${query}"`)
    try {
      const books = await searchBooks(query, 0)
      for (const book of books) {
        const info = book.volumeInfo || {}
        const isbn = info.industryIdentifiers?.find(i => i.type === 'ISBN_13')?.identifier
          || info.industryIdentifiers?.find(i => i.type === 'ISBN_10')?.identifier
        
        allItems.push({
          title: info.title + (info.subtitle ? `: ${info.subtitle}` : ''),
          title_en: info.title,
          author: info.authors?.join(', ') || null,
          description: info.description?.slice(0, 2000) || null,
          category: 'book',
          subcategory: info.categories?.[0]?.toLowerCase() || 'trading',
          source_url: info.infoLink || info.canonicalVolumeLink,
          cover_url: info.imageLinks?.thumbnail?.replace('http:', 'https:') || null,
          language: info.language || 'en',
          tags: info.categories || [],
          isbn: isbn || null,
          publish_date: info.publishedDate?.slice(0, 10) || null,
          is_free: false,
          buy_url: info.infoLink || null,
        })
      }
      console.log(`  Got ${books.length} books`)
      await sleep(3000)
    } catch (e) {
      console.error(`Error for "${query}":`, e.message)
      await sleep(10000)
    }
  }

  // Deduplicate by ISBN or title
  const seen = new Set()
  allItems = allItems.filter(item => {
    const key = item.isbn || item.title.toLowerCase()
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })

  console.log(`Collected ${allItems.length} unique books`)
  await upsertItems(client, allItems, 'google_books')
  await client.end()
  console.log('Done!')
}

main().catch(e => { console.error(e); process.exit(1) })
