#!/usr/bin/env node

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = 'https://iknktzifjdyujdccyhsv.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imlrbmt0emlmamR5dWpkY2N5aHN2Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2NjU1MTU1MywiZXhwIjoyMDgyMTI3NTUzfQ.dBTyJ6tPY-eelVj4khLq31RuUg59Opcy5B48zOLLuGE';

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function fetchJSON(url) {
  try {
    const res = await fetch(url, { 
      headers: { 'User-Agent': 'RankingArenaBot/1.0' },
      signal: AbortSignal.timeout(8000),
      redirect: 'follow'
    });
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}

// Process 3 books at a time with staggered starts
async function processChunk(books) {
  return Promise.all(books.map(async (book) => {
    const data = await fetchJSON(`https://openlibrary.org/isbn/${book.isbn}.json`);
    let ocaid = data?.ocaid;
    if (!ocaid && data?.key) {
      const olid = data.key.split('/').pop();
      const ed = await fetchJSON(`https://openlibrary.org/books/${olid}.json`);
      ocaid = ed?.ocaid;
    }
    if (ocaid) {
      const url = `https://archive.org/details/${ocaid}`;
      await supabase.from('library_items').update({ pdf_url: url }).eq('id', book.id);
      return { title: book.title, url };
    }
    return null;
  }));
}

console.log('=== PDF URL Fetch - ISBN Phase ===\n');
let offset = 0, totalUpdated = 0, totalProcessed = 0;

while (totalProcessed < 500) {
  const { data: books, error } = await supabase
    .from('library_items')
    .select('id, title, author, isbn')
    .eq('category', 'book')
    .is('pdf_url', null)
    .not('isbn', 'is', null)
    .order('id')
    .range(offset, offset + 99);

  if (error || !books?.length) break;

  // Process in chunks of 3
  for (let i = 0; i < books.length; i += 3) {
    const chunk = books.slice(i, i + 3);
    const results = await processChunk(chunk);
    for (const r of results) {
      totalProcessed++;
      if (r) {
        totalUpdated++;
        console.log(`✓ [${totalProcessed}] ${r.title} → ${r.url}`);
      }
    }
    if (totalProcessed % 30 === 0) console.log(`--- ${totalProcessed} done, ${totalUpdated} matched ---`);
    await sleep(300);
  }

  offset += 100;
}

console.log(`\n=== ISBN Phase: ${totalProcessed} processed, ${totalUpdated} updated ===`);

// Phase 2
console.log('\n=== Phase 2: Title+Author Search ===\n');
offset = 0; let p2U = 0, p2P = 0;

while (p2P < 500) {
  const { data: books, error } = await supabase
    .from('library_items')
    .select('id, title, author')
    .eq('category', 'book')
    .is('pdf_url', null)
    .order('id')
    .range(offset, offset + 99);

  if (error || !books?.length) break;

  for (const book of books) {
    p2P++;
    const params = new URLSearchParams({ limit: '1' });
    if (book.title) params.set('title', book.title);
    if (book.author) params.set('author', book.author);
    const data = await fetchJSON(`https://openlibrary.org/search.json?${params}`);
    if (data?.docs?.length && data.docs[0].ia?.length) {
      const url = `https://archive.org/details/${data.docs[0].ia[0]}`;
      await supabase.from('library_items').update({ pdf_url: url }).eq('id', book.id);
      p2U++;
      console.log(`✓ [${p2P}] ${book.title} → ${url}`);
    }
    if (p2P % 30 === 0) console.log(`--- search: ${p2P} done, ${p2U} matched ---`);
    await sleep(500);
  }
  offset += 100;
}

console.log(`\nPhase 2: ${p2P} processed, ${p2U} updated`);
console.log(`Grand total: ${totalUpdated + p2U} books with PDF URLs`);
