#!/usr/bin/env node
/**
 * Library Language Merge
 * 
 * Groups same books with different language editions:
 * 1. ISBN duplicates → merge into one record
 * 2. Same title (normalized) different language → group via language_group_id
 * 3. Ensure title_en + title_zh are populated on grouped records
 * 
 * DRY RUN by default. Set DRY_RUN=false to execute.
 */
import dotenv from 'dotenv'
dotenv.config({ path: '.env.local' })
import { createClient } from '@supabase/supabase-js'

const DRY_RUN = process.env.DRY_RUN !== 'false'

const supabase = createClient(
  process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

function normalize(title) {
  if (!title) return ''
  return title.toLowerCase()
    .replace(/[^\w\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

async function fetchAllItems() {
  const items = []
  let offset = 0
  while (true) {
    const { data, error } = await supabase
      .from('library_items')
      .select('id, title, title_en, title_zh, language, isbn, language_group_id, cover_url, pdf_url, rating, view_count, download_count, created_at')
      .range(offset, offset + 999)
      .order('created_at', { ascending: true })
    if (error) { console.error('Fetch error:', error); break }
    if (!data || data.length === 0) break
    items.push(...data)
    offset += data.length
    if (data.length < 1000) break
    process.stdout.write(`\rFetched ${items.length}...`)
  }
  console.log(`\rFetched ${items.length} total items`)
  return items
}

async function main() {
  console.log(`Mode: ${DRY_RUN ? 'DRY RUN' : 'LIVE'}`)
  
  const items = await fetchAllItems()
  
  // === Step 1: Deduplicate ISBN duplicates ===
  console.log('\n=== Step 1: ISBN Deduplication ===')
  const byIsbn = {}
  items.forEach(item => {
    if (item.isbn) {
      const isbn = item.isbn.replace(/[-\s]/g, '')
      if (!byIsbn[isbn]) byIsbn[isbn] = []
      byIsbn[isbn].push(item)
    }
  })
  
  const isbnDupes = Object.entries(byIsbn).filter(([, g]) => g.length > 1)
  console.log(`Found ${isbnDupes.length} ISBNs with duplicates`)
  
  let mergedCount = 0
  const removedIds = new Set()
  
  for (const [isbn, group] of isbnDupes) {
    // Keep the one with more data (pdf, cover, higher views)
    group.sort((a, b) => {
      const scoreA = (a.pdf_url ? 10 : 0) + (a.cover_url ? 5 : 0) + (a.view_count || 0)
      const scoreB = (b.pdf_url ? 10 : 0) + (b.cover_url ? 5 : 0) + (b.view_count || 0)
      return scoreB - scoreA
    })
    
    const primary = group[0]
    const others = group.slice(1)
    
    console.log(`  ISBN ${isbn}: keeping "${primary.title?.substring(0,50)}", merging ${others.length} duplicate(s)`)
    
    // Merge title_en/title_zh from others into primary
    let updates = {}
    for (const other of others) {
      if (!primary.title_en && other.title_en) updates.title_en = other.title_en
      if (!primary.title_zh && other.title_zh) updates.title_zh = other.title_zh
      if (!primary.cover_url && other.cover_url) updates.cover_url = other.cover_url
      if (!primary.pdf_url && other.pdf_url) updates.pdf_url = other.pdf_url
      removedIds.add(other.id)
    }
    
    // Set language_group_id on primary
    updates.language_group_id = primary.id
    
    if (Object.keys(updates).length > 0) {
      if (!DRY_RUN) {
        await supabase.from('library_items').update({
          ...updates, updated_at: new Date().toISOString()
        }).eq('id', primary.id)
        
        // Point duplicates to primary's group (don't delete - just mark)
        for (const other of others) {
          await supabase.from('library_items').update({
            language_group_id: primary.id,
            updated_at: new Date().toISOString()
          }).eq('id', other.id)
        }
      }
      mergedCount++
    }
  }
  console.log(`ISBN merge: ${mergedCount} groups merged`)

  // === Step 2: Group by normalized title (cross-language) ===
  console.log('\n=== Step 2: Title-based Language Grouping ===')
  
  // Only look at items that have title_en AND title_zh (bilingual candidates)
  const bilingualItems = items.filter(i => i.title_en && i.title_zh && !removedIds.has(i.id))
  console.log(`Items with both title_en and title_zh: ${bilingualItems.length}`)
  
  // Group by normalized title_en
  const byTitleEn = {}
  bilingualItems.forEach(item => {
    const key = normalize(item.title_en)
    if (key.length < 5) return // skip very short titles
    if (!byTitleEn[key]) byTitleEn[key] = []
    byTitleEn[key].push(item)
  })
  
  const titleDupes = Object.entries(byTitleEn).filter(([, g]) => g.length > 1)
  console.log(`Title groups with >1 item: ${titleDupes.length}`)
  
  let groupedCount = 0
  for (const [, group] of titleDupes) {
    // Pick primary (most data)
    group.sort((a, b) => {
      const scoreA = (a.pdf_url ? 10 : 0) + (a.cover_url ? 5 : 0) + (a.view_count || 0)
      const scoreB = (b.pdf_url ? 10 : 0) + (b.cover_url ? 5 : 0) + (b.view_count || 0)
      return scoreB - scoreA
    })
    
    const primary = group[0]
    const groupId = primary.id
    
    // Check if already grouped
    if (group.every(i => i.language_group_id === groupId)) continue
    
    if (!DRY_RUN) {
      for (const item of group) {
        await supabase.from('library_items').update({
          language_group_id: groupId,
          updated_at: new Date().toISOString()
        }).eq('id', item.id)
      }
    } else {
      console.log(`  Group: "${group[0].title_en?.substring(0,60)}" (${group.length} items)`)
    }
    groupedCount++
  }
  console.log(`Title grouping: ${groupedCount} groups created`)

  // === Step 3: Stats ===
  console.log('\n=== Summary ===')
  const withEn = items.filter(i => i.title_en).length
  const withZh = items.filter(i => i.title_zh).length
  const withBoth = items.filter(i => i.title_en && i.title_zh).length
  console.log(`Total items: ${items.length}`)
  console.log(`With title_en: ${withEn}`)
  console.log(`With title_zh: ${withZh}`)
  console.log(`With both: ${withBoth}`)
  console.log(`ISBN dupes merged: ${mergedCount}`)
  console.log(`Title groups created: ${groupedCount}`)
  
  if (DRY_RUN) console.log('\nRun with DRY_RUN=false to execute.')
}

main().catch(console.error)
