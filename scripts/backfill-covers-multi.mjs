#!/usr/bin/env node
/**
 * Multi-source cover search - Google Books + Open Library
 * Phase 1: Books with ISBNs (highest hit rate)
 * Phase 2: Books without ISBNs (title search)
 * Skips papers (rarely have covers)
 */
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  'https://iknktzifjdyujdccyhsv.supabase.co',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imlrbmt0emlmamR5dWpkY2N5aHN2Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2NjU1MTU1MywiZXhwIjoyMDgyMTI3NTUzfQ.dBTyJ6tPY-eelVj4khLq31RuUg59Opcy5B48zOLLuGE'
);

const sleep = ms => new Promise(r => setTimeout(r, ms));
let checked = 0, found = 0;

async function tryGoogle(query) {
  try {
    const res = await fetch(`https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(query)}&maxResults=3`, { signal: AbortSignal.timeout(10000) });
    if (res.status === 429) { await sleep(5000); return null; }
    if (!res.ok) return null;
    const data = await res.json();
    for (const item of (data.items || [])) {
      const img = item.volumeInfo?.imageLinks;
      const cover = img?.thumbnail?.replace('http://', 'https://') || img?.smallThumbnail?.replace('http://', 'https://');
      if (cover) return cover;
    }
    return null;
  } catch { return null; }
}

async function tryOpenLibraryISBN(isbn) {
  try {
    const res = await fetch(`https://covers.openlibrary.org/b/isbn/${isbn}-L.jpg?default=false`, { redirect: 'manual', signal: AbortSignal.timeout(8000) });
    if (res.status === 200) return `https://covers.openlibrary.org/b/isbn/${isbn}-L.jpg`;
    return null;
  } catch { return null; }
}

async function tryOpenLibraryTitle(title) {
  try {
    const res = await fetch(`https://openlibrary.org/search.json?title=${encodeURIComponent(title.slice(0,80))}&limit=1&fields=cover_i`, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) return null;
    const data = await res.json();
    const coverId = data.docs?.[0]?.cover_i;
    if (coverId) return `https://covers.openlibrary.org/b/id/${coverId}-L.jpg`;
    return null;
  } catch { return null; }
}

async function findCover(book) {
  const { isbn, title, author } = book;
  const cleanIsbn = isbn?.replace(/[-\s]/g, '');
  
  // ISBN-based
  if (cleanIsbn) {
    let cover = await tryGoogle(`isbn:${cleanIsbn}`);
    if (cover) return cover;
    await sleep(300);
    cover = await tryOpenLibraryISBN(cleanIsbn);
    if (cover) return cover;
    await sleep(300);
  }
  
  // Title-based
  if (title) {
    let cover = await tryGoogle(`${title} ${author || ''}`.trim().slice(0, 100));
    if (cover) return cover;
    await sleep(300);
    cover = await tryOpenLibraryTitle(title);
    if (cover) return cover;
  }
  
  return null;
}

async function fetchBooks(filter, limit) {
  const all = [];
  const batchSize = 1000;
  for (let offset = 0; offset < limit; offset += batchSize) {
    let q = supabase.from('library_items').select('id, title, isbn, author')
      .is('cover_url', null)
      .in('category', ['book', 'finance']);
    if (filter === 'with_isbn') q = q.not('isbn', 'is', null);
    else q = q.is('isbn', null);
    const { data, error } = await q.order('id').range(offset, offset + batchSize - 1);
    if (error) throw error;
    if (!data?.length) break;
    all.push(...data);
    if (data.length < batchSize) break;
  }
  return all.slice(0, limit);
}

async function main() {
  // Phase 1: Books with ISBNs
  const isbnBooks = await fetchBooks('with_isbn', 1021);
  // Phase 2: Fill rest of 2000 with title-only books  
  const titleBooks = await fetchBooks('no_isbn', 2000 - isbnBooks.length);
  const books = [...isbnBooks, ...titleBooks];
  
  console.log(`=== Cover Backfill ===`);
  console.log(`Phase 1 (ISBN): ${isbnBooks.length} books`);
  console.log(`Phase 2 (title): ${titleBooks.length} books`);
  console.log(`Total: ${books.length}`);
  console.log(`Started: ${new Date().toISOString()}\n`);
  
  for (const book of books) {
    checked++;
    const cover = await findCover(book);
    
    if (cover) {
      found++;
      await supabase.from('library_items').update({ cover_url: cover }).eq('id', book.id);
    }
    
    if (checked % 50 === 0) {
      console.log(`[${new Date().toISOString()}] ${checked}/${books.length} | found=${found} (${(100*found/checked).toFixed(1)}%)`);
    }
    
    await sleep(700);
  }
  
  console.log(`\n✅ Done: ${checked} checked, ${found} covers found (${(100*found/checked).toFixed(1)}%)`);
  console.log(`Finished: ${new Date().toISOString()}`);
}

main().catch(console.error);
