#!/usr/bin/env node
/**
 * Fetch crypto whitepapers from their official sources
 */
import fs from 'fs'
import { execSync } from 'child_process'

const SUPABASE_URL = 'https://iknktzifjdyujdccyhsv.supabase.co'
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const PSQL = '/opt/homebrew/opt/libpq/bin/psql'
const DB_URL = 'postgresql://postgres.iknktzifjdyujdccyhsv:j0qvCCZDzOHDfBka@aws-0-us-west-2.pooler.supabase.com:6543/postgres'
const BUCKET = 'library'
const TMP_DIR = '/tmp/whitepapers'

fs.mkdirSync(TMP_DIR, { recursive: true })

// Known whitepaper URLs (official sources)
const WHITEPAPER_URLS = {
  'MakerDAO Whitepaper': 'https://makerdao.com/en/whitepaper/',
  'Chainlink 2.0': 'https://research.chain.link/whitepaper-v2.pdf',
  'Cosmos': 'https://v1.cosmos.network/resources/whitepaper',
  'Aave Protocol Whitepaper': 'https://github.com/aave/aave-protocol/raw/master/docs/Aave_Protocol_Whitepaper_v1_0.pdf',
  'Curve Finance Whitepaper': 'https://curve.fi/files/crypto-pools-paper.pdf',
  'Litecoin': null, // fork of Bitcoin, no separate whitepaper PDF
  'Near Protocol': 'https://pages.near.org/papers/the-official-near-white-paper/',
  'Optimism': 'https://github.com/ethereum-optimism/optimistic-specs/raw/main/specs/overview.md',
  'Polygon': 'https://polygon.technology/papers/pol-whitepaper',
  'The Graph': 'https://thegraph.com/docs/en/about/',
  'Synthetix': 'https://docs.synthetix.io/synthetix-protocol/the-synthetix-protocol/synthetix-litepaper',
  'dYdX': null,
  'Aptos': 'https://aptos.dev/assets/files/Aptos-Whitepaper-47099b4b907b432f81fc0effd34f3b6a.pdf',
  'Dogecoin': null,
}

// Direct PDF URLs that we can actually download
const DIRECT_PDFS = {
  'Chainlink 2.0: Next Steps in the Evolution of Decentralized Oracle Networks': 'https://research.chain.link/whitepaper-v2.pdf',
  'Aave Protocol Whitepaper v1': 'https://github.com/aave/aave-protocol/raw/master/docs/Aave_Protocol_Whitepaper_v1_0.pdf',
  'Curve Finance Whitepaper': 'https://curve.fi/files/crypto-pools-paper.pdf',
  'Aptos: The Aptos Blockchain': 'https://aptos.dev/assets/files/Aptos-Whitepaper-47099b4b907b432f81fc0effd34f3b6a.pdf',
  'Cosmos: A Network of Distributed Ledgers': 'https://v1.cosmos.network/resources/whitepaper',
}

function queryDB(sql) {
  const out = execSync(`${PSQL} "${DB_URL}" -t -A -F'|' -c "${sql.replace(/"/g, '\\"')}"`, { encoding: 'utf8' })
  return out.trim().split('\n').filter(Boolean).map(line => line.split('|'))
}

async function downloadAndUpload(id, title, url) {
  console.log(`\n📄 ${title}`)
  console.log(`  URL: ${url}`)
  
  const tmpPath = `${TMP_DIR}/${id}.pdf`
  
  try {
    const res = await fetch(url, { 
      redirect: 'follow', 
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' },
      signal: AbortSignal.timeout(30000)
    })
    
    if (!res.ok) {
      console.log(`  ❌ HTTP ${res.status}`)
      return false
    }
    
    const ct = res.headers.get('content-type') || ''
    const buf = Buffer.from(await res.arrayBuffer())
    
    if (buf.length < 1000) {
      console.log(`  ❌ Too small (${buf.length} bytes)`)
      return false
    }
    
    // Check if PDF
    const isPdf = buf.slice(0, 4).toString() === '%PDF'
    if (!isPdf) {
      console.log(`  ⚠️  Not a PDF (content-type: ${ct}, starts with: ${buf.slice(0,20).toString()})`)
      return false
    }
    
    fs.writeFileSync(tmpPath, buf)
    
    // Upload to Supabase Storage
    const storageKey = `whitepapers/${id}.pdf`
    const uploadRes = await fetch(`${SUPABASE_URL}/storage/v1/object/${BUCKET}/${storageKey}`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${SERVICE_KEY}`,
        'Content-Type': 'application/pdf',
        'x-upsert': 'true',
      },
      body: buf,
    })
    
    if (!uploadRes.ok) {
      console.log(`  ❌ Upload failed: ${uploadRes.status}`)
      return false
    }
    
    const publicUrl = `${SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${storageKey}`
    const sql = `UPDATE library_items SET file_key='${storageKey}', file_size_bytes=${buf.length}, pdf_url='${publicUrl}' WHERE id='${id}'`
    execSync(`${PSQL} "${DB_URL}" -c "${sql}"`, { encoding: 'utf8' })
    
    console.log(`  ✅ Done (${(buf.length/1024).toFixed(0)}KB)`)
    fs.unlinkSync(tmpPath)
    return true
  } catch (e) {
    console.log(`  ❌ ${e.message}`)
    if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath)
    return false
  }
}

async function main() {
  // Get all whitepapers without files
  const rows = queryDB(`SELECT id, title FROM library_items WHERE category='whitepaper' AND file_key IS NULL ORDER BY title`)
  console.log(`Found ${rows.length} whitepapers without files\n`)
  
  let success = 0, skipped = 0
  
  for (const [id, title] of rows) {
    const url = DIRECT_PDFS[title]
    if (!url) {
      skipped++
      continue
    }
    const ok = await downloadAndUpload(id, title, url)
    if (ok) success++
  }
  
  console.log(`\n=== SUMMARY ===`)
  console.log(`✅ ${success} downloaded`)
  console.log(`⏭️  ${skipped} skipped (no direct PDF URL)`)
  console.log(`Total: ${rows.length}`)
}

main().catch(e => { console.error(e); process.exit(1) })
