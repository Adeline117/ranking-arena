#!/usr/bin/env node
// Fast parallel backfill of books via OpenLibrary + Google Books for covers
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = 'https://iknktzifjdyujdccyhsv.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imlrbmt0emlmamR5dWpkY2N5aHN2Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2NjU1MTU1MywiZXhwIjoyMDgyMTI3NTUzfQ.dBTyJ6tPY-eelVj4khLq31RuUg59Opcy5B48zOLLuGE';
const sb = createClient(SUPABASE_URL, SUPABASE_KEY);

const sleep = ms => new Promise(r => setTimeout(r, ms));
const CONCURRENCY = 5;
const CATEGORIES = process.argv[2] ? [process.argv[2]] : ['book', 'finance'];
const MAX = parseInt(process.argv[3] || '50000');

async function fetchJSON(url, timeout = 10000) {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'RankingArenaLibrary/1.0' },
      signal: AbortSignal.timeout(timeout),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}

async function processBook(book) {
  const updates = {};
  
  // Search OpenLibrary
  const q = encodeURIComponent(book.title + (book.author ? ' ' + book.author.split(',')[0] : ''));
  const data = await fetchJSON(
    `https://openlibrary.org/search.json?q=${q}&limit=3&fields=key,title,author_name,isbn,cover_i,ia,lending_identifier_s`
  );

  if (data?.docs?.length) {
    const doc = data.docs[0];
    if (doc.ia?.length) {
      updates.pdf_url = `https://archive.org/details/${doc.ia[0]}`;
    } else if (doc.lending_identifier_s) {
      updates.pdf_url = `https://archive.org/details/${doc.lending_identifier_s}`;
    }
    if (!book.cover_url && doc.cover_i) {
      updates.cover_url = `https://covers.openlibrary.org/b/id/${doc.cover_i}-L.jpg`;
    }
    if (!book.isbn && doc.isbn?.length) {
      updates.isbn = doc.isbn[0];
    }
  }

  // If no cover yet, try Google Books
  if (!book.cover_url && !updates.cover_url) {
    const gq = encodeURIComponent(book.title);
    const gdata = await fetchJSON(`https://www.googleapis.com/books/v1/volumes?q=intitle:${gq}&maxResults=1`);
    if (gdata?.items?.[0]?.volumeInfo?.imageLinks?.thumbnail) {
      updates.cover_url = gdata.items[0].volumeInfo.imageLinks.thumbnail.replace('http://', 'https://');
    }
  }

  return { book, updates };
}

for (const category of CATEGORIES) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`[${new Date().toISOString()}] Category: ${category}`);
  console.log(`${'='.repeat(60)}\n`);

  let offset = 0, total = 0, pdfCount = 0, coverCount = 0;

  while (total < MAX) {
    const { data: books, error } = await sb
      .from('library_items')
      .select('id, title, author, isbn, cover_url')
      .eq('category', category)
      .is('pdf_url', null)
      .order('view_count', { ascending: false })
      .range(offset, offset + 99);

    if (error || !books?.length) break;

    // Process in chunks of CONCURRENCY
    for (let i = 0; i < books.length; i += CONCURRENCY) {
      const chunk = books.slice(i, i + CONCURRENCY);
      const results = await Promise.all(chunk.map(processBook));

      for (const { book, updates } of results) {
        total++;
        if (Object.keys(updates).length) {
          await sb.from('library_items').update(updates).eq('id', book.id);
          if (updates.pdf_url) pdfCount++;
          if (updates.cover_url) coverCount++;
          const parts = [];
          if (updates.pdf_url) parts.push('pdf');
          if (updates.cover_url) parts.push('cover');
          console.log(`✓ [${total}] ${book.title.slice(0, 55)} → ${parts.join('+')}`);
        }
      }

      // Rate limit: ~1 req/sec per concurrent request
      await sleep(600);
    }

    offset += 100;

    if (total % 500 === 0) {
      console.log(`\n--- [${new Date().toISOString()}] Progress: ${total} | ${pdfCount} PDFs | ${coverCount} covers ---\n`);
    }
  }

  console.log(`\n=== DONE ${category}: ${total} processed | ${pdfCount} PDFs | ${coverCount} covers ===\n`);
}

console.log(`[${new Date().toISOString()}] All done!`);
