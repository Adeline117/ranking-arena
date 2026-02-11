#!/usr/bin/env node
/**
 * Fast concurrent cover backfill
 * Phase 1: ISBN-based (Google + Open Library)
 * Phase 2: Title-based (Google Books)
 */
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  'https://iknktzifjdyujdccyhsv.supabase.co',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imlrbmt0emlmamR5dWpkY2N5aHN2Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2NjU1MTU1MywiZXhwIjoyMDgyMTI3NTUzfQ.dBTyJ6tPY-eelVj4khLq31RuUg59Opcy5B48zOLLuGE'
);

const sleep = ms => new Promise(r => setTimeout(r, ms));
let totalChecked = 0, totalFound = 0;

async function fetchWithTimeout(url, ms = 5000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    clearTimeout(timer);
    return res;
  } catch {
    clearTimeout(timer);
    return null;
  }
}

async function findCoverByISBN(isbn) {
  // Google Books
  const res = await fetchWithTimeout(`https://www.googleapis.com/books/v1/volumes?q=isbn:${isbn}&maxResults=1&fields=items(volumeInfo/imageLinks)`);
  if (res?.ok) {
    const data = await res.json();
    const img = data.items?.[0]?.volumeInfo?.imageLinks;
    const cover = img?.thumbnail?.replace('http://', 'https://') || img?.smallThumbnail?.replace('http://', 'https://');
    if (cover) return cover;
  }
  // Open Library
  const res2 = await fetchWithTimeout(`https://covers.openlibrary.org/b/isbn/${isbn}-L.jpg?default=false`, 5000);
  if (res2?.status === 200) return `https://covers.openlibrary.org/b/isbn/${isbn}-L.jpg`;
  return null;
}

async function findCoverByTitle(title, author) {
  const q = encodeURIComponent(`${title} ${author || ''}`.trim().slice(0, 100));
  const res = await fetchWithTimeout(`https://www.googleapis.com/books/v1/volumes?q=${q}&maxResults=3&fields=items(volumeInfo(title,imageLinks))`);
  if (!res?.ok) return null;
  const data = await res.json();
  for (const item of (data.items || [])) {
    const img = item.volumeInfo?.imageLinks;
    const cover = img?.thumbnail?.replace('http://', 'https://') || img?.smallThumbnail?.replace('http://', 'https://');
    if (cover) return cover;
  }
  return null;
}

async function processBook(book, mode) {
  const isbn = book.isbn?.replace(/[-\s]/g, '');
  let cover = null;
  if (mode === 'isbn' && isbn) {
    cover = await findCoverByISBN(isbn);
  } else if (mode === 'title' && book.title) {
    cover = await findCoverByTitle(book.title, book.author);
  }
  if (cover) {
    await supabase.from('library_items').update({ cover_url: cover }).eq('id', book.id);
    return true;
  }
  return false;
}

async function processBatch(books, mode, concurrency = 5) {
  let idx = 0, checked = 0, found = 0;
  
  async function worker() {
    while (idx < books.length) {
      const i = idx++;
      const book = books[i];
      const result = await processBook(book, mode);
      checked++;
      if (result) found++;
      totalChecked++;
      if (result) totalFound++;
      if (checked % 50 === 0 || (found > 0 && found % 10 === 0)) {
        console.log(`  [${mode}] ${checked}/${books.length} checked, ${found} found (${(100*found/checked).toFixed(1)}%)`);
      }
      await sleep(200); // rate limit per worker
    }
  }
  
  const workers = Array.from({ length: Math.min(concurrency, books.length) }, () => worker());
  await Promise.all(workers);
  console.log(`  [${mode}] Done: ${checked} checked, ${found} found`);
  return { checked, found };
}

async function fetchAll(filter) {
  const all = [];
  let from = 0;
  const batchSize = 1000;
  while (true) {
    let query = supabase.from('library_items').select('id, title, isbn, author')
      .in('category', ['book', 'finance']).is('cover_url', null).order('id');
    if (filter === 'isbn') query = query.not('isbn', 'is', null);
    else query = query.is('isbn', null);
    const { data, error } = await query.range(from, from + batchSize - 1);
    if (error) { console.error('DB error:', error); break; }
    all.push(...data);
    if (data.length < batchSize) break;
    from += batchSize;
  }
  return all;
}

async function main() {
  console.log('=== Fast Cover Backfill ===\n');
  
  // Phase 1: ISBN books
  console.log('Phase 1: Fetching books with ISBN...');
  const isbnBooks = await fetchAll('isbn');
  console.log(`  Found ${isbnBooks.length} books with ISBN but no cover`);
  if (isbnBooks.length > 0) {
    await processBatch(isbnBooks, 'isbn', 5);
  }
  
  // Phase 2: Title-only books
  console.log('\nPhase 2: Fetching books without ISBN (title search)...');
  const titleBooks = await fetchAll('title');
  console.log(`  Found ${titleBooks.length} books without ISBN`);
  if (titleBooks.length > 0) {
    await processBatch(titleBooks, 'title', 3);
  }
  
  console.log(`\n✅ Total: ${totalChecked} checked, ${totalFound} found (${(100*totalFound/totalChecked).toFixed(1)}%)`);
}

main().catch(console.error);
