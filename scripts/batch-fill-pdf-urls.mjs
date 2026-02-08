#!/usr/bin/env node
// Batch fill pdf_url for library_items
import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = 'https://iknktzifjdyujdccyhsv.supabase.co'
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imlrbmt0emlmamR5dWpkY2N5aHN2Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2NjU1MTU1MywiZXhwIjoyMDgyMTI3NTUzfQ.dBTyJ6tPY-eelVj4khLq31RuUg59Opcy5B48zOLLuGE'

const sb = createClient(SUPABASE_URL, SUPABASE_KEY)

let stats = { arxiv: 0, pdfSource: 0, secEdgar: 0, errors: 0 }

// --- 1. ArXiv: /abs/ -> /pdf/ ---
async function fillArxiv() {
  console.log('[arxiv] Fetching items with no pdf_url...')
  let offset = 0
  const batchSize = 500
  let total = 0

  while (true) {
    const { data, error } = await sb
      .from('library_items')
      .select('id, source_url')
      .in('source', ['arxiv', 'arXiv'])
      .is('pdf_url', null)
      .like('source_url', '%arxiv.org/abs/%')
      .range(offset, offset + batchSize - 1)

    if (error) { console.error('[arxiv] fetch error:', error.message); stats.errors++; break }
    if (!data || data.length === 0) break

    console.log(`[arxiv] Processing batch of ${data.length} (offset ${offset})...`)

    // Update in smaller chunks
    const chunkSize = 50
    for (let i = 0; i < data.length; i += chunkSize) {
      const chunk = data.slice(i, i + chunkSize)
      const promises = chunk.map(item => {
        const pdfUrl = item.source_url.replace('/abs/', '/pdf/') + '.pdf'
        return sb.from('library_items').update({ pdf_url: pdfUrl }).eq('id', item.id)
      })
      const results = await Promise.all(promises)
      const errCount = results.filter(r => r.error).length
      if (errCount > 0) stats.errors += errCount
      total += chunk.length - errCount
    }

    offset += batchSize
    if (data.length < batchSize) break
  }

  stats.arxiv = total
  console.log(`[arxiv] Updated ${total} items`)
}

// --- 2. Source URLs ending in .pdf ---
async function fillPdfSources() {
  console.log('[pdf-source] Fetching items with .pdf source_url...')
  let offset = 0
  const batchSize = 500
  let total = 0

  while (true) {
    const { data, error } = await sb
      .from('library_items')
      .select('id, source_url')
      .is('pdf_url', null)
      .not('source_url', 'is', null)
      .like('source_url', '%.pdf')
      .range(offset, offset + batchSize - 1)

    if (error) { console.error('[pdf-source] fetch error:', error.message); break }
    if (!data || data.length === 0) break

    console.log(`[pdf-source] Processing batch of ${data.length} (offset ${offset})...`)

    const chunkSize = 50
    for (let i = 0; i < data.length; i += chunkSize) {
      const chunk = data.slice(i, i + chunkSize)
      const promises = chunk.map(item =>
        sb.from('library_items').update({ pdf_url: item.source_url }).eq('id', item.id)
      )
      const results = await Promise.all(promises)
      const errCount = results.filter(r => r.error).length
      total += chunk.length - errCount
    }

    offset += batchSize
    if (data.length < batchSize) break
  }

  stats.pdfSource = total
  console.log(`[pdf-source] Updated ${total} items`)
}

// --- 3. SEC Edgar: source_url as-is for web reader ---
async function fillSecEdgar() {
  // SEC filings can be read via iframe (web mode), no pdf_url needed if source_url exists
  // But let's check if any have .pdf in source_url
  let offset = 0
  const batchSize = 500
  let total = 0

  while (true) {
    const { data, error } = await sb
      .from('library_items')
      .select('id, source_url')
      .is('pdf_url', null)
      .not('source_url', 'is', null)
      .like('source', '%sec%')
      .range(offset, offset + batchSize - 1)

    if (error) { console.error('[sec] fetch error:', error.message); break }
    if (!data || data.length === 0) break

    // SEC items with source_url already work in web/iframe mode via the reader
    // Only set pdf_url for actual PDF links
    const pdfItems = data.filter(d => d.source_url?.toLowerCase().includes('.pdf'))
    if (pdfItems.length > 0) {
      const promises = pdfItems.map(item =>
        sb.from('library_items').update({ pdf_url: item.source_url }).eq('id', item.id)
      )
      await Promise.all(promises)
      total += pdfItems.length
    }

    offset += batchSize
    if (data.length < batchSize) break
  }

  stats.secEdgar = total
  console.log(`[sec] Updated ${total} items`)
}

// --- Main ---
async function main() {
  console.log('=== Batch PDF URL Fill ===\n')
  await fillArxiv()
  await fillPdfSources()
  await fillSecEdgar()

  console.log('\n=== Summary ===')
  console.log(`arXiv:       ${stats.arxiv}`)
  console.log(`PDF sources: ${stats.pdfSource}`)
  console.log(`SEC Edgar:   ${stats.secEdgar}`)
  console.log(`Total:       ${stats.arxiv + stats.pdfSource + stats.secEdgar}`)
  console.log(`Errors:      ${stats.errors}`)

  // Final count check
  const { count } = await sb
    .from('library_items')
    .select('id', { count: 'exact', head: true })
    .not('pdf_url', 'is', null)
  console.log(`\nTotal items with pdf_url now: ${count}`)

  const { count: totalCount } = await sb
    .from('library_items')
    .select('id', { count: 'exact', head: true })
  console.log(`Total library items: ${totalCount}`)

  // Count items that have either pdf_url or source_url (readable)
  const { count: readableCount } = await sb
    .from('library_items')
    .select('id', { count: 'exact', head: true })
    .or('pdf_url.not.is.null,source_url.not.is.null')
  console.log(`Readable items (pdf_url OR source_url): ${readableCount}`)
  console.log(`Readability: ${((readableCount / totalCount) * 100).toFixed(1)}%`)
}

main().catch(console.error)
