#!/usr/bin/env node
/**
 * Import generated institutions and tools data into Supabase
 * Deduplicates by name (case-insensitive)
 */

import { createClient } from '@supabase/supabase-js'
import fs from 'fs'
import path from 'path'

const SUPABASE_URL = 'https://iknktzifjdyujdccyhsv.supabase.co'
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!SUPABASE_KEY) { console.error('Set SUPABASE_SERVICE_ROLE_KEY'); process.exit(1) }

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)
const DATA_DIR = path.join(process.cwd(), 'data/generated')

async function getExistingNames(table) {
  const { data } = await supabase.from(table).select('name')
  return new Set((data || []).map(r => r.name.toLowerCase()))
}

async function importInstitutions() {
  const files = [
    'institutions-exchanges.json',
    'institutions-funds.json', 
    'institutions-projects.json',
    'institutions-services.json',
    'institutions-media.json',
  ]
  
  const existing = await getExistingNames('institutions')
  console.log(`Existing institutions: ${existing.size}`)
  
  let imported = 0, skipped = 0
  
  for (const file of files) {
    const filePath = path.join(DATA_DIR, file)
    if (!fs.existsSync(filePath)) { console.log(`Skip missing: ${file}`); continue }
    
    const items = JSON.parse(fs.readFileSync(filePath, 'utf-8'))
    console.log(`\n${file}: ${items.length} entries`)
    
    const toInsert = []
    for (const item of items) {
      if (existing.has(item.name.toLowerCase())) {
        skipped++
        continue
      }
      existing.add(item.name.toLowerCase())
      
      toInsert.push({
        name: item.name,
        category: item.subcategory || item.category,
        description: item.description,
        website: item.website,
        logo_url: item.logo_url || null,
        tags: item.tags || [],
        is_active: !item.tags?.includes('defunct'),
      })
    }
    
    if (toInsert.length > 0) {
      // Insert in batches of 50
      for (let i = 0; i < toInsert.length; i += 50) {
        const batch = toInsert.slice(i, i + 50)
        const { error } = await supabase.from('institutions').insert(batch)
        if (error) {
          console.error(`  Error inserting batch: ${error.message}`)
          // Try one by one
          for (const item of batch) {
            const { error: e2 } = await supabase.from('institutions').insert(item)
            if (e2) console.error(`  Skip "${item.name}": ${e2.message}`)
            else imported++
          }
        } else {
          imported += batch.length
        }
      }
    }
    
    console.log(`  Inserted: ${toInsert.length}, Skipped (dup): ${items.length - toInsert.length}`)
  }
  
  console.log(`\nInstitutions total imported: ${imported}, skipped: ${skipped}`)
  return imported
}

async function importTools() {
  const files = [
    'tools-analytics.json',
    'tools-trading.json',
    'tools-dev.json',
    'tools-wallets.json',
    'tools-tax.json',
    'tools-news.json',
  ]
  
  const existing = await getExistingNames('tools')
  console.log(`\nExisting tools: ${existing.size}`)
  
  let imported = 0, skipped = 0
  
  for (const file of files) {
    const filePath = path.join(DATA_DIR, file)
    if (!fs.existsSync(filePath)) { console.log(`Skip missing: ${file}`); continue }
    
    const items = JSON.parse(fs.readFileSync(filePath, 'utf-8'))
    console.log(`\n${file}: ${items.length} entries`)
    
    const toInsert = []
    for (const item of items) {
      if (existing.has(item.name.toLowerCase())) {
        skipped++
        continue
      }
      existing.add(item.name.toLowerCase())
      
      toInsert.push({
        name: item.name,
        category: item.subcategory || item.category,
        description: item.description,
        website: item.website,
        logo_url: item.logo_url || null,
        tags: item.tags || [],
        is_active: !item.tags?.includes('defunct'),
      })
    }
    
    if (toInsert.length > 0) {
      for (let i = 0; i < toInsert.length; i += 50) {
        const batch = toInsert.slice(i, i + 50)
        const { error } = await supabase.from('tools').insert(batch)
        if (error) {
          console.error(`  Error inserting batch: ${error.message}`)
          for (const item of batch) {
            const { error: e2 } = await supabase.from('tools').insert(item)
            if (e2) console.error(`  Skip "${item.name}": ${e2.message}`)
            else imported++
          }
        } else {
          imported += batch.length
        }
      }
    }
    
    console.log(`  Inserted: ${toInsert.length}, Skipped (dup): ${items.length - toInsert.length}`)
  }
  
  console.log(`\nTools total imported: ${imported}, skipped: ${skipped}`)
  return imported
}

async function main() {
  const instCount = await importInstitutions()
  const toolCount = await importTools()
  
  // Verify
  const { data: instTotal } = await supabase.from('institutions').select('id', { count: 'exact', head: true })
  const { data: toolTotal } = await supabase.from('tools').select('id', { count: 'exact', head: true })
  
  console.log('\n=== Final Counts ===')
  console.log(`Institutions imported: ${instCount}`)
  console.log(`Tools imported: ${toolCount}`)
}

main().catch(console.error)
