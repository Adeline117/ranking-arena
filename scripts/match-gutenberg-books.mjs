#!/usr/bin/env node
/**
 * Match library_items with Project Gutenberg books
 * Downloads free EPUB files and uploads to Supabase Storage
 */

import { createClient } from '@supabase/supabase-js'
import fs from 'fs'
import path from 'path'
import { pipeline } from 'stream/promises'

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)
const BATCH_SIZE = 50
const DELAY_MS = 1000 // Be nice to Gutenberg

async function searchGutenberg(title, author) {
  const query = encodeURIComponent(`${title} ${author || ''}`.trim())
  const url = `https://gutendex.com/books/?search=${query}`
  const res = await fetch(url)
  if (!res.ok) return null
  const data = await res.json()
  return data.results || []
}

function findBestMatch(results, title, author) {
  if (!results.length) return null
  
  const normalize = s => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '')
  const titleNorm = normalize(title)
  
  for (const book of results) {
    const bookTitle = normalize(book.title)
    // Title must be a reasonable match (contains or contained)
    if (bookTitle.includes(titleNorm) || titleNorm.includes(bookTitle)) {
      const epubUrl = book.formats['application/epub+zip']
      if (epubUrl) return { gutenbergId: book.id, epubUrl, title: book.title }
    }
  }
  return null
}

async function downloadAndUpload(epubUrl, libraryItemId) {
  const res = await fetch(epubUrl)
  if (!res.ok) throw new Error(`Download failed: ${res.status}`)
  
  const buffer = Buffer.from(await res.arrayBuffer())
  const fileKey = `library/epub/${libraryItemId}.epub`
  
  const { error } = await supabase.storage
    .from('library-files')
    .upload(fileKey, buffer, {
      contentType: 'application/epub+zip',
      upsert: true,
    })
  
  if (error) throw error
  
  const { data: { publicUrl } } = supabase.storage
    .from('library-files')
    .getPublicUrl(fileKey)
  
  return { fileKey, publicUrl }
}

async function main() {
  console.log('Fetching books without files...')
  
  let offset = 0
  let totalMatched = 0
  let totalProcessed = 0
  
  while (true) {
    const { data: books, error } = await supabase
      .from('library_items')
      .select('id, title, author, isbn, category')
      .is('epub_url', null)
      .is('pdf_url', null)
      .is('file_key', null)
      .eq('category', 'book')
      .order('view_count', { ascending: false, nullsFirst: false })
      .range(offset, offset + BATCH_SIZE - 1)
    
    if (error) { console.error('DB error:', error); break }
    if (!books.length) { console.log('No more books to process'); break }
    
    for (const book of books) {
      totalProcessed++
      try {
        const results = await searchGutenberg(book.title, book.author)
        if (!results) continue
        
        const match = findBestMatch(results, book.title, book.author)
        if (!match) {
          if (totalProcessed % 100 === 0) console.log(`Processed ${totalProcessed}, matched ${totalMatched}`)
          await new Promise(r => setTimeout(r, DELAY_MS))
          continue
        }
        
        console.log(`Match: "${book.title}" → Gutenberg "${match.title}" (${match.epubUrl})`)
        
        const { fileKey, publicUrl } = await downloadAndUpload(match.epubUrl, book.id)
        
        await supabase
          .from('library_items')
          .update({
            epub_url: publicUrl,
            file_key: fileKey,
            is_free: true,
          })
          .eq('id', book.id)
        
        totalMatched++
        console.log(`  ✓ Uploaded (${totalMatched} total)`)
      } catch (e) {
        console.error(`  ✗ Error for "${book.title}":`, e.message)
      }
      
      await new Promise(r => setTimeout(r, DELAY_MS))
    }
    
    offset += BATCH_SIZE
  }
  
  console.log(`\nDone! Processed: ${totalProcessed}, Matched: ${totalMatched}`)
}

main().catch(console.error)
