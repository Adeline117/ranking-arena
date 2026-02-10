#!/usr/bin/env node
/**
 * 多源封面搜索 - Google Books + Open Library + Amazon
 * 针对有ISBN但之前搜不到的书，用多个源尝试
 * 也处理无ISBN的热门书籍（按title搜）
 */
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  'https://iknktzifjdyujdccyhsv.supabase.co',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imlrbmt0emlmamR5dWpkY2N5aHN2Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2NjU1MTU1MywiZXhwIjoyMDgyMTI3NTUzfQ.dBTyJ6tPY-eelVj4khLq31RuUg59Opcy5B48zOLLuGE'
);

const sleep = ms => new Promise(r => setTimeout(r, ms));
let checked = 0, found = 0;

async function tryGoogleByISBN(isbn) {
  try {
    const res = await fetch(`https://www.googleapis.com/books/v1/volumes?q=isbn:${isbn}&maxResults=1&fields=items(volumeInfo/imageLinks)`);
    if (!res.ok) return null;
    const data = await res.json();
    const img = data.items?.[0]?.volumeInfo?.imageLinks;
    return img?.thumbnail?.replace('http://', 'https://') || img?.smallThumbnail?.replace('http://', 'https://') || null;
  } catch { return null; }
}

async function tryGoogleByTitle(title, author) {
  try {
    const q = encodeURIComponent(`${title} ${author || ''}`.trim().slice(0, 100));
    const res = await fetch(`https://www.googleapis.com/books/v1/volumes?q=${q}&maxResults=3&fields=items(volumeInfo(title,imageLinks))`);
    if (!res.ok) return null;
    const data = await res.json();
    // Find best match
    for (const item of (data.items || [])) {
      const img = item.volumeInfo?.imageLinks;
      const cover = img?.thumbnail?.replace('http://', 'https://') || img?.smallThumbnail?.replace('http://', 'https://');
      if (cover) return cover;
    }
    return null;
  } catch { return null; }
}

async function tryOpenLibrary(isbn) {
  try {
    const res = await fetch(`https://covers.openlibrary.org/b/isbn/${isbn}-L.jpg?default=false`, { redirect: 'manual' });
    if (res.status === 200) return `https://covers.openlibrary.org/b/isbn/${isbn}-L.jpg`;
    return null;
  } catch { return null; }
}

async function tryOpenLibraryByTitle(title) {
  try {
    const q = encodeURIComponent(title.slice(0, 80));
    const res = await fetch(`https://openlibrary.org/search.json?title=${q}&limit=1&fields=cover_i`);
    if (!res.ok) return null;
    const data = await res.json();
    const coverId = data.docs?.[0]?.cover_i;
    if (coverId) return `https://covers.openlibrary.org/b/id/${coverId}-L.jpg`;
    return null;
  } catch { return null; }
}

async function findCover(book) {
  const { isbn, title, author } = book;
  
  // Try ISBN-based searches first
  if (isbn) {
    const cleanIsbn = isbn.replace(/[-\s]/g, '');
    let cover = await tryGoogleByISBN(cleanIsbn);
    if (cover) return cover;
    await sleep(200);
    
    cover = await tryOpenLibrary(cleanIsbn);
    if (cover) return cover;
    await sleep(200);
  }
  
  // Fall back to title search
  if (title) {
    let cover = await tryGoogleByTitle(title, author);
    if (cover) return cover;
    await sleep(200);
    
    cover = await tryOpenLibraryByTitle(title);
    if (cover) return cover;
    await sleep(200);
  }
  
  return null;
}

async function main() {
  // Get books without covers, prioritize English titles (more likely to find)
  const { data: books, error } = await supabase
    .from('library_items')
    .select('id, title, isbn, author')
    .in('category', ['book', 'finance'])
    .is('cover_url', null)
    .order('id', { ascending: true })
    .limit(5000);
  
  if (error) { console.error('DB error:', error); return; }
  
  console.log(`=== 多源封面搜索 ===`);
  console.log(`待处理: ${books.length}`);
  
  for (const book of books) {
    checked++;
    const cover = await findCover(book);
    
    if (cover) {
      found++;
      await supabase.from('library_items').update({ cover_url: cover }).eq('id', book.id);
      if (found % 10 === 0) {
        console.log(`[${new Date().toISOString()}] checked=${checked} found=${found} (${(100*found/checked).toFixed(1)}%) — last: ${book.title?.slice(0, 50)}`);
      }
    }
    
    if (checked % 100 === 0) {
      console.log(`[${new Date().toISOString()}] checked=${checked} found=${found} (${(100*found/checked).toFixed(1)}%)`);
    }
    
    // Rate limit: ~1.5 sec per book (multiple API calls)
    await sleep(500);
  }
  
  console.log(`\n✅ 完成: ${checked} checked, ${found} found (${(100*found/checked).toFixed(1)}%)`);
}

main().catch(console.error);
