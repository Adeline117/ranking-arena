#!/usr/bin/env node
/**
 * Download crypto whitepapers and upload to Supabase Storage.
 * Updates pdf_url to point to Supabase Storage public URL.
 */
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const SUPABASE_URL = 'https://iknktzifjdyujdccyhsv.supabase.co'
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const DB_URL = 'postgresql://postgres.iknktzifjdyujdccyhsv:j0qvCCZDzOHDfBka@aws-0-us-west-2.pooler.supabase.com:6543/postgres'
const BUCKET = 'library'
const STORAGE_BASE = `${SUPABASE_URL}/storage/v1/object/public/${BUCKET}`

// Known working PDF URLs for top crypto whitepapers
const WHITEPAPER_PDFS = [
  { symbol: 'BTC', url: 'https://bitcoin.org/bitcoin.pdf', filename: 'bitcoin-whitepaper.pdf' },
  { symbol: 'ETH', url: 'https://ethereum.org/content/whitepaper/whitepaper-pdf/Ethereum_Whitepaper_-_Buterin_2014.pdf', filename: 'ethereum-whitepaper.pdf' },
  { symbol: 'SOL', url: 'https://solana.com/solana-whitepaper.pdf', filename: 'solana-whitepaper.pdf' },
  { symbol: 'DOT', url: 'https://polkadot.network/PolkaDotPaper.pdf', filename: 'polkadot-whitepaper.pdf' },
  { symbol: 'AVAX', url: 'https://assets.website-files.com/5d80307810123f5ffbb34d6e/6008d7bbf8b10d1eb01e7e16_Avalanche%20Platform%20Whitepaper.pdf', filename: 'avalanche-whitepaper.pdf' },
  { symbol: 'UNI', url: 'https://uniswap.org/whitepaper-v3.pdf', filename: 'uniswap-v3-whitepaper.pdf' },
  { symbol: 'NEAR', url: 'https://pages.near.org/papers/the-official-near-white-paper/', filename: 'near-whitepaper.pdf', skip: true },
  { symbol: 'FIL', url: 'https://filecoin.io/filecoin.pdf', filename: 'filecoin-whitepaper.pdf' },
  { symbol: 'ALGO', url: 'https://arxiv.org/pdf/1607.01341.pdf', filename: 'algorand-whitepaper.pdf' },
  { symbol: 'XRP', url: 'https://ripple.com/files/ripple_consensus_whitepaper.pdf', filename: 'ripple-whitepaper.pdf' },
  { symbol: 'ADA', url: 'https://docs.cardano.org/about-cardano/introduction/', filename: 'cardano-whitepaper.pdf', skip: true },
  { symbol: 'MATIC', url: 'https://polygon.technology/lightpaper-polygon.pdf', filename: 'polygon-whitepaper.pdf' },
  { symbol: 'LTC', url: 'https://whitepaper.io/document/683/litecoin-whitepaper', filename: 'litecoin-whitepaper.pdf', skip: true },
]

const TMP_DIR = '/tmp/whitepapers'
fs.mkdirSync(TMP_DIR, { recursive: true })

async function downloadFile(url, destPath) {
  const res = await fetch(url, { 
    redirect: 'follow',
    headers: { 'User-Agent': 'Mozilla/5.0' }
  })
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`)
  const ct = res.headers.get('content-type') || ''
  if (!ct.includes('pdf') && !ct.includes('octet-stream')) {
    throw new Error(`Not a PDF (content-type: ${ct})`)
  }
  const buf = Buffer.from(await res.arrayBuffer())
  fs.writeFileSync(destPath, buf)
  return buf.length
}

async function uploadToStorage(filePath, storagePath) {
  const fileData = fs.readFileSync(filePath)
  const res = await fetch(`${SUPABASE_URL}/storage/v1/object/${BUCKET}/${storagePath}`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${SERVICE_KEY}`,
      'Content-Type': 'application/pdf',
      'x-upsert': 'true',
    },
    body: fileData,
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Upload failed: ${res.status} ${text}`)
  }
  return fileData.length
}

async function updateDB(symbol, storageUrl, fileSize) {
  // Use Supabase REST API to update
  const res = await fetch(`${SUPABASE_URL}/rest/v1/library_items?crypto_symbols=cs.{${symbol}}&category=eq.whitepaper`, {
    method: 'PATCH',
    headers: {
      'Authorization': `Bearer ${SERVICE_KEY}`,
      'apikey': SERVICE_KEY,
      'Content-Type': 'application/json',
      'Prefer': 'return=representation',
    },
    body: JSON.stringify({
      pdf_url: storageUrl,
      file_key: `whitepapers/${symbol.toLowerCase()}-whitepaper.pdf`,
      file_size_bytes: fileSize,
    }),
  })
  const data = await res.json()
  return data.length || 0
}

async function main() {
  let success = 0, failed = 0, skipped = 0

  for (const wp of WHITEPAPER_PDFS) {
    if (wp.skip) { 
      console.log(`⏭ Skipping ${wp.symbol} (not a direct PDF)`)
      skipped++
      continue 
    }

    const localPath = path.join(TMP_DIR, wp.filename)
    const storagePath = `whitepapers/${wp.filename}`
    const publicUrl = `${STORAGE_BASE}/${storagePath}`

    try {
      console.log(`📥 Downloading ${wp.symbol}...`)
      const size = await downloadFile(wp.url, localPath)
      console.log(`   ${(size / 1024).toFixed(0)} KB`)

      console.log(`📤 Uploading to storage...`)
      await uploadToStorage(localPath, storagePath)

      console.log(`💾 Updating DB...`)
      const updated = await updateDB(wp.symbol, publicUrl, size)
      console.log(`   ✅ ${wp.symbol}: ${updated} rows updated`)
      success++
    } catch (err) {
      console.error(`   ❌ ${wp.symbol}: ${err.message}`)
      failed++
    }

    // Rate limit
    await new Promise(r => setTimeout(r, 2000))
  }

  console.log(`\n📊 Done: ${success} success, ${failed} failed, ${skipped} skipped`)

  // Cleanup
  fs.rmSync(TMP_DIR, { recursive: true, force: true })
}

main().catch(console.error)
