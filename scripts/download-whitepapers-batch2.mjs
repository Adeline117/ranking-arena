#!/usr/bin/env node
/**
 * Batch 2: Download remaining whitepapers with direct PDF URLs from DB,
 * plus manually corrected URLs for known projects.
 */
import fs from 'fs'
import path from 'path'

const SUPABASE_URL = 'https://iknktzifjdyujdccyhsv.supabase.co'
const SERVICE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imlrbmt0emlmamR5dWpkY2N5aHN2Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2NjU1MTU1MywiZXhwIjoyMDgyMTI3NTUzfQ.dBTyJ6tPY-eelVj4khLq31RuUg59Opcy5B48zOLLuGE'
const BUCKET = 'library'
const STORAGE_BASE = `${SUPABASE_URL}/storage/v1/object/public/${BUCKET}`

// Corrected/additional direct PDF URLs
const OVERRIDES = {
  'ecc673de-361d-47d5-aa83-3e92c6364038': 'https://assets.polkadot.network/Polkadot-whitepaper.pdf', // DOT
  '5e83a22c-da39-463e-9f73-d640fd864d5a': 'https://lido.fi/static/Lido:Ethereum-Liquid-Staking.pdf', // LDO
  'dab24791-86d6-4b6a-a56c-046d800cd9bf': 'https://assets.ctfassets.net/vyse88cgwfbl/5UWgHMvz071t2Cq5jKw5gk/3f0cdd7e4c4e07cebcf85e05e054dab3/TetherWhitePaper.pdf', // USDT
  'f509d036-afa5-4560-867f-28b2b31d7bfb': 'https://litecoin.org/litecoin.pdf', // LTC
  'dd980e80-e55e-407f-a5e7-7cf95bc851bf': 'https://www.getmonero.org/resources/research-lab/pubs/cryptonote-whitepaper.pdf', // XMR
  '5e34cf82-6db0-4dc7-a914-ed9014be8a2a': 'https://www.stellar.org/papers/stellar-consensus-protocol.pdf', // XLM
  'e64e8131-8c3f-4ace-8bc7-4dd8810fb6e6': 'https://ipfs.io/ipfs/QmR7GSQM93Cx5eAg6a6yRzNde1FQv7uL6X1o4k7zrJa3LX/ipfs.draft3.pdf', // IPFS
  '1d0308a5-a1ae-4bfb-9b96-e9c5b7459aae': 'https://ton.org/whitepaper.pdf', // TON
  '853178c4-7ab2-47f9-9e41-0af97f200974': 'https://docs.sui.io/paper/sui.pdf', // SUI
  '324afb88-be90-48a6-a29f-efdb84574de0': 'https://raw.githubusercontent.com/OffchainLabs/nitro/master/docs/Nitro-whitepaper.pdf', // ARB
  '2332c108-4090-4384-965f-82a3dca51f47': 'https://assets.polkadot.network/Polkadot-whitepaper.pdf', // DOT zh
}

// IDs to skip (not direct PDFs - docs sites, github repos, etc.)
const SKIP_IDS = new Set([
  '6bc8fa9d-3bef-4343-bd17-1b48e625b98f', // MakerDAO - docs site
  'aedbdc70-16b8-49dc-9f77-809a32e8cde9', // Chainlink - not direct PDF
  '1f50adf8-3f01-4439-9385-05871fd8f97f', // Cosmos - not direct PDF
  'fa76d612-d7e3-4078-bc04-a377a8eda361', // Aave - docs
  '08d0d4c6-3688-46f3-8843-5baefd852516', // MakerDAO MCD - docs
  '258c9cd5-d74b-47b6-8d20-ac4190aa07a8', // Curve - not direct PDF
  '30f6ce0a-c10d-4d69-af59-835cb31c4565', // Optimism - docs
  '31528219-a33c-4dae-8d18-6a5d8de0d9a4', // Polygon - 404
  'c3024967-4947-401c-8023-ba2143368c8a', // The Graph - docs
  '440173d1-5115-4c9a-9baf-1fded65d18f6', // SushiSwap - docs
  'f6593844-17ea-45c3-9391-9647cd18e3e1', // PancakeSwap - docs
  '956728a5-84b1-43e5-8182-c2e6131e3713', // Yearn - docs
  '68347c50-5bb7-4799-8519-7c39b5f5e961', // Synthetix - docs
  '67a99f6b-d34b-4a15-b19e-178f25bbaa0a', // dYdX - docs
  'c2eac427-b6a5-4330-b2aa-4dec1ebdcc25', // Aptos - Korean docs
  '7496f084-e09f-42c9-bbfb-9cd3f98f8e4d', // NEAR - not direct PDF
  '8ecf2829-02f0-449f-b23b-2aceaf24ee2e', // Dogecoin - github
  '9ebf7b85-3313-44b1-80e7-645313237221', // SHIB - website
  'e02de418-d8fa-4db7-89bf-8aa9cc41e190', // PEPE - website
])

const TMP_DIR = '/tmp/whitepapers2'
fs.mkdirSync(TMP_DIR, { recursive: true })

async function downloadFile(url) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 15000)
  const res = await fetch(url, { redirect: 'follow', headers: { 'User-Agent': 'Mozilla/5.0' }, signal: controller.signal }).finally(() => clearTimeout(timeout))
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const buf = Buffer.from(await res.arrayBuffer())
  if (buf.length < 1000) throw new Error(`Too small: ${buf.length} bytes`)
  // Check PDF magic bytes
  if (buf[0] !== 0x25 || buf[1] !== 0x50) throw new Error('Not a PDF file')
  return buf
}

async function uploadToStorage(buf, storagePath) {
  const res = await fetch(`${SUPABASE_URL}/storage/v1/object/${BUCKET}/${storagePath}`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${SERVICE_KEY}`,
      'Content-Type': 'application/pdf',
      'x-upsert': 'true',
    },
    body: buf,
  })
  if (!res.ok) throw new Error(`Upload: ${res.status} ${await res.text()}`)
}

async function updateRow(id, storageUrl, fileKey, fileSize) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/library_items?id=eq.${id}`, {
    method: 'PATCH',
    headers: {
      'Authorization': `Bearer ${SERVICE_KEY}`,
      'apikey': SERVICE_KEY,
      'Content-Type': 'application/json',
      'Prefer': 'return=representation',
    },
    body: JSON.stringify({ pdf_url: storageUrl, file_key: fileKey, file_size_bytes: fileSize }),
  })
  return (await res.json()).length || 0
}

async function main() {
  // Get all whitepapers without file_key that have pdf_url
  const res = await fetch(`${SUPABASE_URL}/rest/v1/library_items?category=eq.whitepaper&file_key=is.null&pdf_url=not.is.null&select=id,title,pdf_url,crypto_symbols`, {
    headers: { 'Authorization': `Bearer ${SERVICE_KEY}`, 'apikey': SERVICE_KEY },
  })
  const items = await res.json()
  console.log(`Found ${items.length} whitepapers without files`)

  let success = 0, failed = 0, skipped = 0

  for (const item of items) {
    if (SKIP_IDS.has(item.id)) {
      skipped++
      continue
    }

    const url = OVERRIDES[item.id] || item.pdf_url
    const symbol = (item.crypto_symbols?.[0] || item.id.slice(0, 8)).toLowerCase()
    const filename = `${symbol}-whitepaper.pdf`
    const storagePath = `whitepapers/${filename}`
    const publicUrl = `${STORAGE_BASE}/${storagePath}`

    try {
      console.log(`📥 ${item.title.slice(0, 50)}... (${url.slice(0, 60)})`)
      const buf = await downloadFile(url)
      console.log(`   ${(buf.length / 1024).toFixed(0)} KB`)

      await uploadToStorage(buf, storagePath)
      const updated = await updateRow(item.id, publicUrl, storagePath, buf.length)
      console.log(`   ✅ ${updated} rows`)
      success++
    } catch (err) {
      console.error(`   ❌ ${err.message}`)
      failed++
    }

    await new Promise(r => setTimeout(r, 2000))
  }

  console.log(`\n📊 Done: ${success} success, ${failed} failed, ${skipped} skipped`)
}

main().catch(console.error)
