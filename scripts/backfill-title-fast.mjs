#!/usr/bin/env node
/**
 * Fast title-based cover backfill with concurrency
 * Targets book/finance categories without covers
 */
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const sleep = ms => new Promise(r => setTimeout(r, ms));
let checked = 0, found = 0, errors = 0;
const CONCURRENCY = 1;
const DELAY_MS = 1200; // ~1 req/s to avoid rate limiting

async function fetchWithTimeout(url, ms = 8000) {
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

async function findCover(title, author) {
  // Try Open Library first (more generous rate limits)
  const q2 = encodeURIComponent(title.slice(0, 80));
  const res2 = await fetchWithTimeout(`https://openlibrary.org/search.json?title=${q2}&limit=1&fields=cover_i`);
  if (res2?.ok) {
    try {
      const data = await res2.json();
      const coverId = data.docs?.[0]?.cover_i;
      if (coverId) return `https://covers.openlibrary.org/b/id/${coverId}-L.jpg`;
    } catch {}
  }
  
  // Then Google Books by title+author
  const q = encodeURIComponent(`${title} ${author || ''}`.trim().slice(0, 120));
  const res = await fetchWithTimeout(`https://www.googleapis.com/books/v1/volumes?q=${q}&maxResults=5&fields=items(volumeInfo(title,imageLinks))`);
  if (res?.status === 429) { errors++; return '__rate_limited__'; }
  if (!res?.ok) return null;
  try {
    const data = await res.json();
    for (const item of (data.items || [])) {
      const img = item.volumeInfo?.imageLinks;
      const cover = img?.thumbnail?.replace('http://', 'https://') || img?.smallThumbnail?.replace('http://', 'https://');
      if (cover) return cover;
    }
  } catch {}
  
  return null;
}

async function fetchAllBooks() {
  const all = [];
  let from = 0;
  const batchSize = 1000;
  while (true) {
    const { data, error } = await supabase.from('library_items')
      .select('id, title, author')
      .in('category', ['book', 'finance'])
      .is('cover_url', null)
      .order('id')
      .range(from, from + batchSize - 1);
    if (error) { console.error('DB error:', error); break; }
    all.push(...data);
    console.log(`  Fetched ${all.length} so far...`);
    if (data.length < batchSize) break;
    from += batchSize;
  }
  return all;
}

async function main() {
  console.log('=== Title-Based Cover Backfill ===\n');
  
  const books = await fetchAllBooks();
  console.log(`Total to process: ${books.length}\n`);
  
  let idx = 0;
  let rateLimitPause = false;
  
  async function worker(id) {
    while (idx < books.length) {
      if (rateLimitPause) { await sleep(5000); continue; }
      const i = idx++;
      const book = books[i];
      if (!book.title) { checked++; continue; }
      
      const cover = await findCover(book.title, book.author);
      checked++;
      
      if (cover === '__rate_limited__') {
        console.log(`  ⚠️ Rate limited at ${checked}, pausing 30s...`);
        rateLimitPause = true;
        await sleep(30000);
        rateLimitPause = false;
        idx = i; // retry
        checked--;
        continue;
      }
      
      if (cover) {
        found++;
        await supabase.from('library_items').update({ cover_url: cover }).eq('id', book.id);
      }
      
      if (checked % 100 === 0) {
        console.log(`[${new Date().toLocaleTimeString()}] ${checked}/${books.length} checked, ${found} found (${(100*found/checked).toFixed(1)}%)`);
      }
      
      await sleep(DELAY_MS);
    }
  }
  
  const workers = Array.from({ length: CONCURRENCY }, (_, i) => worker(i));
  await Promise.all(workers);
  
  console.log(`\n✅ Done: ${checked} checked, ${found} covers found (${(100*found/checked).toFixed(1)}%)`);
}

main().catch(console.error);
