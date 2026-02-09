#!/usr/bin/env node
// Backfill books with PDF URLs from OpenLibrary/Internet Archive
// Also fills cover_url where missing
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = 'https://iknktzifjdyujdccyhsv.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imlrbmt0emlmamR5dWpkY2N5aHN2Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2NjU1MTU1MywiZXhwIjoyMDgyMTI3NTUzfQ.dBTyJ6tPY-eelVj4khLq31RuUg59Opcy5B48zOLLuGE';
const sb = createClient(SUPABASE_URL, SUPABASE_KEY);

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function fetchJSON(url, retries = 2) {
  for (let i = 0; i <= retries; i++) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'RankingArenaLibrary/1.0 (library@rankingarena.com)' },
        signal: AbortSignal.timeout(10000),
      });
      if (res.status === 429) {
        console.log('  Rate limited, waiting 10s...');
        await sleep(10000);
        continue;
      }
      if (!res.ok) return null;
      return await res.json();
    } catch (e) {
      if (i < retries) await sleep(2000);
    }
  }
  return null;
}

// Categories to process in order
const CATEGORIES = process.argv[2] ? [process.argv[2]] : ['book', 'finance'];
const BATCH_SIZE = 100;
const MAX_PER_CATEGORY = parseInt(process.argv[3] || '30000');

for (const category of CATEGORIES) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`Processing category: ${category}`);
  console.log(`${'='.repeat(60)}\n`);

  let offset = 0;
  let totalProcessed = 0;
  let pdfFound = 0;
  let coverFound = 0;

  while (totalProcessed < MAX_PER_CATEGORY) {
    const { data: books, error } = await sb
      .from('library_items')
      .select('id, title, author, isbn, cover_url')
      .eq('category', category)
      .is('pdf_url', null)
      .order('view_count', { ascending: false }) // prioritize popular books
      .range(offset, offset + BATCH_SIZE - 1);

    if (error) { console.error('DB error:', error.message); break; }
    if (!books?.length) { console.log('No more books to process'); break; }

    for (const book of books) {
      totalProcessed++;
      
      // Build search query
      const q = book.title + (book.author ? ' ' + book.author : '');
      const params = new URLSearchParams({
        q,
        limit: '3',
        fields: 'key,title,author_name,isbn,cover_i,ia,lending_identifier_s',
      });

      const data = await fetchJSON(`https://openlibrary.org/search.json?${params}`);
      
      const updates = {};

      if (data?.docs?.length) {
        const doc = data.docs[0];
        
        // Check for Internet Archive availability
        if (doc.ia?.length) {
          updates.pdf_url = `https://archive.org/details/${doc.ia[0]}`;
          pdfFound++;
        } else if (doc.lending_identifier_s) {
          updates.pdf_url = `https://archive.org/details/${doc.lending_identifier_s}`;
          pdfFound++;
        }

        // Fill cover if missing
        if (!book.cover_url && doc.cover_i) {
          updates.cover_url = `https://covers.openlibrary.org/b/id/${doc.cover_i}-L.jpg`;
          coverFound++;
        }

        // Fill ISBN if we don't have one
        if (!book.isbn && doc.isbn?.length) {
          updates.isbn = doc.isbn[0];
        }
      }

      if (Object.keys(updates).length) {
        const { error: ue } = await sb
          .from('library_items')
          .update(updates)
          .eq('id', book.id);
        if (!ue) {
          const parts = [];
          if (updates.pdf_url) parts.push('pdf');
          if (updates.cover_url) parts.push('cover');
          if (updates.isbn) parts.push('isbn');
          console.log(`✓ [${totalProcessed}] ${book.title.slice(0, 60)} → ${parts.join('+')}`);
        }
      } else {
        if (totalProcessed % 50 === 0) {
          console.log(`  [${totalProcessed}] (no match) ${book.title.slice(0, 50)}`);
        }
      }

      // Rate limit: ~1 req/sec for OpenLibrary
      await sleep(1000);

      // Progress every 100
      if (totalProcessed % 100 === 0) {
        console.log(`\n--- Progress: ${totalProcessed} processed | ${pdfFound} PDFs | ${coverFound} covers ---\n`);
      }
    }

    offset += BATCH_SIZE;
  }

  console.log(`\n=== ${category}: ${totalProcessed} processed, ${pdfFound} PDFs found, ${coverFound} covers found ===\n`);
}
