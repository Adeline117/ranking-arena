#!/usr/bin/env node
/**
 * Open Library only cover backfill - no rate limit issues
 * Then Google Books pass after OL is done
 */
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const sleep = ms => new Promise(r => setTimeout(r, ms));
let checked = 0, found = 0;
const CONCURRENCY = 3;

async function fetchWithTimeout(url, ms = 10000) {
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

async function findCoverOL(title, isbn) {
  // Try ISBN first if available
  if (isbn) {
    const cleanIsbn = isbn.replace(/[-\s]/g, '');
    const res = await fetchWithTimeout(`https://covers.openlibrary.org/b/isbn/${cleanIsbn}-L.jpg?default=false`, 5000);
    if (res?.status === 200) return `https://covers.openlibrary.org/b/isbn/${cleanIsbn}-L.jpg`;
  }
  
  // Title search
  const q = encodeURIComponent(title.slice(0, 80));
  const res = await fetchWithTimeout(`https://openlibrary.org/search.json?title=${q}&limit=1&fields=cover_i`);
  if (!res?.ok) return null;
  try {
    const data = await res.json();
    const coverId = data.docs?.[0]?.cover_i;
    if (coverId) return `https://covers.openlibrary.org/b/id/${coverId}-L.jpg`;
  } catch {}
  return null;
}

async function fetchAllBooks() {
  const all = [];
  let from = 0;
  while (true) {
    const { data, error } = await supabase.from('library_items')
      .select('id, title, isbn')
      .in('category', ['book', 'finance'])
      .is('cover_url', null)
      .order('id')
      .range(from, from + 999);
    if (error) { console.error(error); break; }
    all.push(...data);
    if (data.length < 1000) break;
    from += 1000;
  }
  return all;
}

async function main() {
  console.log('=== Open Library Cover Backfill ===\n');
  const books = await fetchAllBooks();
  console.log(`Total: ${books.length}\n`);
  
  let idx = 0;
  async function worker() {
    while (idx < books.length) {
      const i = idx++;
      const book = books[i];
      if (!book.title) { checked++; continue; }
      
      const cover = await findCoverOL(book.title, book.isbn);
      checked++;
      if (cover) {
        found++;
        await supabase.from('library_items').update({ cover_url: cover }).eq('id', book.id);
      }
      if (checked % 100 === 0) {
        console.log(`[${new Date().toLocaleTimeString()}] ${checked}/${books.length} | found: ${found} (${(100*found/checked).toFixed(1)}%)`);
      }
      await sleep(400);
    }
  }
  
  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
  console.log(`\n✅ OL Done: ${checked} checked, ${found} found (${(100*found/checked).toFixed(1)}%)`);
}

main().catch(console.error);
