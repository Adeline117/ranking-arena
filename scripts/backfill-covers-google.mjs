#!/usr/bin/env node
// Fast cover backfill via Google Books API (no rate limits)
import { createClient } from '@supabase/supabase-js';

const sb = createClient(
  'https://iknktzifjdyujdccyhsv.supabase.co',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imlrbmt0emlmamR5dWpkY2N5aHN2Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2NjU1MTU1MywiZXhwIjoyMDgyMTI3NTUzfQ.dBTyJ6tPY-eelVj4khLq31RuUg59Opcy5B48zOLLuGE'
);

const sleep = ms => new Promise(r => setTimeout(r, ms));
const CONCURRENCY = 10;
const CATEGORIES = ['book', 'finance'];

async function fetchCover(title) {
  try {
    const res = await fetch(
      `https://www.googleapis.com/books/v1/volumes?q=intitle:${encodeURIComponent(title)}&maxResults=1`,
      { signal: AbortSignal.timeout(8000) }
    );
    if (!res.ok) return null;
    const data = await res.json();
    const img = data?.items?.[0]?.volumeInfo?.imageLinks;
    if (img?.thumbnail) return img.thumbnail.replace('http://', 'https://');
    return null;
  } catch { return null; }
}

for (const category of CATEGORIES) {
  console.log(`\n=== ${category} covers ===\n`);
  let offset = 0, total = 0, found = 0;

  while (true) {
    const { data: books, error } = await sb
      .from('library_items')
      .select('id, title')
      .eq('category', category)
      .is('cover_url', null)
      .range(offset, offset + 99);

    if (error || !books?.length) break;

    for (let i = 0; i < books.length; i += CONCURRENCY) {
      const chunk = books.slice(i, i + CONCURRENCY);
      const results = await Promise.all(chunk.map(async b => {
        const url = await fetchCover(b.title);
        return { id: b.id, title: b.title, url };
      }));

      for (const r of results) {
        total++;
        if (r.url) {
          await sb.from('library_items').update({ cover_url: r.url }).eq('id', r.id);
          found++;
          if (found % 100 === 0) console.log(`✓ [${total}/${found}] ${r.title.slice(0, 50)}`);
        }
      }
      await sleep(200);
    }

    offset += 100;
    if (total % 1000 === 0) console.log(`--- ${total} processed, ${found} covers found ---`);
  }
  console.log(`\n=== ${category}: ${total} processed, ${found} covers added ===\n`);
}
