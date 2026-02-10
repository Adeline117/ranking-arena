#!/usr/bin/env node
/**
 * Google Books 标题搜索封面补全 (无ISBN的书籍)
 * Rate limit: ~1 req/sec to avoid 429
 */
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  'https://iknktzifjdyujdccyhsv.supabase.co',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imlrbmt0emlmamR5dWpkY2N5aHN2Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2NjU1MTU1MywiZXhwIjoyMDgyMTI3NTUzfQ.dBTyJ6tPY-eelVj4khLq31RuUg59Opcy5B48zOLLuGE'
);

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function searchGoogleBooks(title) {
  const q = encodeURIComponent(title.slice(0, 100));
  const url = `https://www.googleapis.com/books/v1/volumes?q=intitle:${q}&maxResults=1&fields=items(volumeInfo/imageLinks)`;
  const res = await fetch(url);
  if (!res.ok) return null;
  const data = await res.json();
  const links = data?.items?.[0]?.volumeInfo?.imageLinks;
  if (!links) return null;
  // Prefer larger images
  const coverUrl = links.extraLarge || links.large || links.medium || links.small || links.thumbnail || links.smallThumbnail;
  return coverUrl?.replace('http://', 'https://') || null;
}

async function main() {
  let offset = 0;
  const batchSize = 100;
  let found = 0, checked = 0;

  while (true) {
    const { data: books, error } = await supabase
      .from('library_items')
      .select('id, title')
      .eq('category', 'book')
      .is('cover_url', null)
      .is('isbn', null)
      .order('id')
      .range(offset, offset + batchSize - 1);

    if (error || !books?.length) break;

    for (const book of books) {
      checked++;
      try {
        const cover = await searchGoogleBooks(book.title);
        if (cover) {
          await supabase.from('library_items').update({ cover_url: cover }).eq('id', book.id);
          found++;
        }
      } catch (e) {
        // skip
      }
      if (checked % 50 === 0) {
        console.log(`[${new Date().toISOString()}] checked=${checked} found=${found} (${(found/checked*100).toFixed(1)}%)`);
      }
      await sleep(1200); // rate limit
    }
    offset += batchSize;
  }
  console.log(`Done. checked=${checked} found=${found}`);
}

main().catch(console.error);
