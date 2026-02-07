#!/usr/bin/env node
// Collect blockchain/crypto papers from arXiv
import { getClient, upsertItems, sleep } from './lib.mjs'

const QUERIES = [
  'blockchain', 'cryptocurrency', 'decentralized finance', 'defi',
  'smart contract', 'tokenomics', 'bitcoin', 'ethereum',
  'consensus mechanism', 'zero knowledge proof', 'NFT',
  'crypto trading', 'decentralized exchange', 'stablecoin',
  'layer 2 scaling', 'merkle tree', 'distributed ledger'
]
const MAX_PER_QUERY = 500
const PAGE_SIZE = 100

function parseArxivXML(xml) {
  const entries = []
  const entryRegex = /<entry>([\s\S]*?)<\/entry>/g
  let match
  while ((match = entryRegex.exec(xml)) !== null) {
    const e = match[1]
    const get = (tag) => {
      const m = e.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`))
      return m ? m[1].trim() : null
    }
    const getAll = (tag) => {
      const results = []
      const r = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'g')
      let m2
      while ((m2 = r.exec(e)) !== null) results.push(m2[1].trim())
      return results
    }
    const pdfLink = e.match(/href="([^"]*)"[^>]*title="pdf"/)?.[1]
    const id = get('id')
    const doi = e.match(/doi\.org\/([^<"]+)/)?.[1]

    entries.push({
      title: get('title')?.replace(/\s+/g, ' '),
      author: getAll('name').join(', '),
      description: get('summary')?.replace(/\s+/g, ' ')?.slice(0, 2000),
      category: 'paper',
      subcategory: 'blockchain',
      source_url: id,
      pdf_url: pdfLink || (id ? id.replace('/abs/', '/pdf/') : null),
      language: 'en',
      doi: doi || null,
      publish_date: get('published')?.slice(0, 10) || null,
      tags: ['arxiv'],
      is_free: true,
    })
  }
  return entries
}

async function main() {
  const client = getClient()
  await client.connect()
  console.log('Connected to DB')

  let totalItems = []
  for (const query of QUERIES) {
    console.log(`Searching arXiv for "${query}"...`)
    for (let start = 0; start < MAX_PER_QUERY; start += PAGE_SIZE) {
      const url = `https://export.arxiv.org/api/query?search_query=all:${encodeURIComponent(query)}&start=${start}&max_results=${PAGE_SIZE}&sortBy=relevance`
      try {
        const res = await fetch(url)
        const xml = await res.text()
        const entries = parseArxivXML(xml)
        if (entries.length === 0) break
        totalItems.push(...entries)
        console.log(`  Got ${entries.length} results (start=${start})`)
        await sleep(3000) // arXiv rate limit: be nice
      } catch (e) {
        console.error(`Error for "${query}" start=${start}:`, e.message)
        await sleep(5000)
      }
    }
  }

  // Deduplicate by source_url
  const seen = new Set()
  totalItems = totalItems.filter(item => {
    if (!item.source_url || seen.has(item.source_url)) return false
    seen.add(item.source_url)
    return true
  })

  console.log(`Collected ${totalItems.length} unique papers`)
  await upsertItems(client, totalItems, 'arxiv')
  await client.end()
  console.log('Done!')
}

main().catch(e => { console.error(e); process.exit(1) })
