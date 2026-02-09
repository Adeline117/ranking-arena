#!/usr/bin/env node
/**
 * Library Content Enrichment Script
 * 
 * Enriches library_items from free/open APIs:
 * 1. arXiv papers: fill pdf_url, content_url from source_url
 * 2. Open Library books: fetch description, page_count, cover, publish_year, subjects
 * 3. Books with ISBN: additional metadata from Open Library ISBN API
 * 4. Project Gutenberg: match classic books for free reading links
 * 
 * Usage:
 *   node scripts/enrich-library.mjs [--source arxiv|openlibrary|isbn|gutenberg|bad-desc] [--limit N] [--dry-run]
 */

const SUPABASE_URL = 'https://iknktzifjdyujdccyhsv.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imlrbmt0emlmamR5dWpkY2N5aHN2Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2NjU1MTU1MywiZXhwIjoyMDgyMTI3NTUzfQ.dBTyJ6tPY-eelVj4khLq31RuUg59Opcy5B48zOLLuGE';

const args = process.argv.slice(2);
const SOURCE = args.find((a, i) => args[i - 1] === '--source') || 'all';
const LIMIT = parseInt(args.find((a, i) => args[i - 1] === '--limit') || '0') || 0;
const DRY_RUN = args.includes('--dry-run');
const BATCH_SIZE = 50;

const headers = {
  'apikey': SUPABASE_KEY,
  'Authorization': `Bearer ${SUPABASE_KEY}`,
  'Content-Type': 'application/json',
};

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

let stats = { checked: 0, updated: 0, errors: 0, skipped: 0 };

// ─── Supabase helpers ───

async function fetchItems(filter, select = '*', limit = 1000, offset = 0) {
  const url = `${SUPABASE_URL}/rest/v1/library_items?select=${select}&${filter}&limit=${limit}&offset=${offset}&order=id`;
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`Fetch failed: ${res.status} ${await res.text()}`);
  return res.json();
}

async function updateItem(id, data) {
  if (DRY_RUN) {
    console.log(`  [DRY-RUN] Would update ${id}:`, Object.keys(data).join(', '));
    return;
  }
  const res = await fetch(`${SUPABASE_URL}/rest/v1/library_items?id=eq.${id}`, {
    method: 'PATCH',
    headers: { ...headers, 'Prefer': 'return=minimal' },
    body: JSON.stringify({ ...data, updated_at: new Date().toISOString() }),
  });
  if (!res.ok) {
    console.error(`  Update failed for ${id}: ${res.status}`);
    stats.errors++;
    return false;
  }
  stats.updated++;
  return true;
}

async function batchUpdate(items) {
  // Use individual updates since supabase REST doesn't support bulk upsert well with different data per row
  for (const { id, data } of items) {
    await updateItem(id, data);
  }
}

// ─── API Helpers ───

async function fetchJSON(url, retries = 2) {
  for (let i = 0; i <= retries; i++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
      if (res.status === 429) {
        console.log('  Rate limited, waiting 30s...');
        await sleep(30000);
        continue;
      }
      if (!res.ok) return null;
      return await res.json();
    } catch (e) {
      if (i === retries) return null;
      await sleep(2000);
    }
  }
  return null;
}

// ─── 1. arXiv: fill pdf_url and content_url from source_url ───

async function enrichArxiv() {
  console.log('\n=== Enriching arXiv papers ===');
  let offset = 0;
  let total = 0;
  
  while (true) {
    const items = await fetchItems(
      'source_url=like.*arxiv*&or=(pdf_url.is.null,content_url.is.null)',
      'id,title,source_url,pdf_url,content_url',
      BATCH_SIZE, offset
    );
    if (!items.length) break;
    
    for (const item of items) {
      stats.checked++;
      const match = item.source_url.match(/arxiv\.org\/abs\/([\d.]+(?:v\d+)?)/);
      if (!match) { stats.skipped++; continue; }
      
      const arxivId = match[1];
      const updates = {};
      
      if (!item.pdf_url) {
        updates.pdf_url = `https://arxiv.org/pdf/${arxivId}`;
      }
      if (!item.content_url) {
        updates.content_url = `https://arxiv.org/abs/${arxivId}`;
      }
      
      if (Object.keys(updates).length) {
        await updateItem(item.id, updates);
        total++;
      }
    }
    
    offset += BATCH_SIZE;
    if (LIMIT && offset >= LIMIT) break;
    console.log(`  arXiv: processed ${offset}, updated ${total}`);
  }
  console.log(`  arXiv done: ${total} updated`);
}

// ─── 2. Open Library books: fetch metadata ───

async function enrichOpenLibrary() {
  console.log('\n=== Enriching Open Library books ===');
  let offset = 0;
  let total = 0;
  
  while (true) {
    // Books from openlibrary that are missing description or page_count
    const items = await fetchItems(
      'source_url=like.*openlibrary*&or=(description.is.null,description.like.A%20book%20about*,page_count.is.null)',
      'id,title,source_url,description,page_count,cover_url,isbn,publish_date',
      BATCH_SIZE, offset
    );
    if (!items.length) break;
    
    for (const item of items) {
      stats.checked++;
      
      // Extract work ID from source_url
      const workMatch = item.source_url.match(/works\/(OL\w+)/);
      if (!workMatch) { stats.skipped++; continue; }
      
      const workId = workMatch[1];
      const data = await fetchJSON(`https://openlibrary.org/works/${workId}.json`);
      if (!data) { stats.errors++; await sleep(500); continue; }
      
      const updates = {};
      
      // Description
      if (!item.description || item.description.startsWith('A book about')) {
        const desc = typeof data.description === 'string' 
          ? data.description 
          : data.description?.value;
        if (desc && desc.length > 10) {
          updates.description = desc.substring(0, 2000);
        }
      }
      
      // Subjects → tags
      if (data.subjects?.length) {
        updates.tags = data.subjects.slice(0, 10);
      }
      
      // Cover
      if (!item.cover_url && data.covers?.length) {
        updates.cover_url = `https://covers.openlibrary.org/b/id/${data.covers[0]}-L.jpg`;
      }
      
      // Get edition data for page_count, ISBN, publisher
      if (!item.page_count || !item.isbn) {
        const editions = await fetchJSON(`https://openlibrary.org/works/${workId}/editions.json?limit=3`);
        if (editions?.entries?.length) {
          const ed = editions.entries[0];
          if (!item.page_count && ed.number_of_pages) {
            updates.page_count = ed.number_of_pages;
          }
          if (!item.isbn && ed.isbn_13?.length) {
            updates.isbn = ed.isbn_13[0];
          } else if (!item.isbn && ed.isbn_10?.length) {
            updates.isbn = ed.isbn_10[0];
          }
          if (ed.publishers?.length) {
            updates.publisher = ed.publishers[0];
          }
          if (ed.publish_date && !item.publish_date) {
            updates.publish_date = ed.publish_date;
          }
        }
        await sleep(200); // Extra delay for editions call
      }
      
      if (Object.keys(updates).length) {
        await updateItem(item.id, updates);
        total++;
        if (total % 10 === 0) console.log(`  OL: updated ${total} (checked ${stats.checked})`);
      }
      
      await sleep(300); // Rate limit: ~3 req/sec for OL
    }
    
    offset += BATCH_SIZE;
    if (LIMIT && offset >= LIMIT) break;
    console.log(`  OL batch: processed ${offset}, updated ${total}`);
  }
  console.log(`  Open Library done: ${total} updated`);
}

// ─── 3. ISBN enrichment via Open Library ISBN API ───

async function enrichISBN() {
  console.log('\n=== Enriching by ISBN ===');
  let offset = 0;
  let total = 0;
  
  while (true) {
    const items = await fetchItems(
      'isbn=not.is.null&or=(description.is.null,description.like.A%20book%20about*,page_count.is.null,cover_url.is.null)',
      'id,title,isbn,description,page_count,cover_url,publisher',
      BATCH_SIZE, offset
    );
    if (!items.length) break;
    
    for (const item of items) {
      stats.checked++;
      
      const data = await fetchJSON(`https://openlibrary.org/isbn/${item.isbn}.json`);
      if (!data) { await sleep(500); continue; }
      
      const updates = {};
      
      if ((!item.description || item.description.startsWith('A book about')) && data.description) {
        const desc = typeof data.description === 'string' ? data.description : data.description?.value;
        if (desc) updates.description = desc.substring(0, 2000);
      }
      
      if (!item.page_count && data.number_of_pages) {
        updates.page_count = data.number_of_pages;
      }
      
      if (!item.cover_url && data.covers?.length) {
        updates.cover_url = `https://covers.openlibrary.org/b/id/${data.covers[0]}-L.jpg`;
      }
      
      if (!item.publisher && data.publishers?.length) {
        updates.publisher = data.publishers[0];
      }
      
      // Set content_url to Open Library reader
      if (data.key) {
        updates.content_url = `https://openlibrary.org${data.key}`;
      }
      
      if (Object.keys(updates).length) {
        await updateItem(item.id, updates);
        total++;
      }
      
      await sleep(300);
    }
    
    offset += BATCH_SIZE;
    if (LIMIT && offset >= LIMIT) break;
    console.log(`  ISBN batch: processed ${offset}, updated ${total}`);
  }
  console.log(`  ISBN done: ${total} updated`);
}

// ─── 4. Project Gutenberg: match books by title ───

async function enrichGutenberg() {
  console.log('\n=== Enriching from Project Gutenberg ===');
  let offset = 0;
  let total = 0;
  
  while (true) {
    // Books without content_url or pdf_url, likely classics
    const items = await fetchItems(
      'category=eq.book&content_url=is.null&pdf_url=is.null&epub_url=is.null',
      'id,title,author,publish_date',
      BATCH_SIZE, offset
    );
    if (!items.length) break;
    
    for (const item of items) {
      stats.checked++;
      
      // Only try books published before 1930 (likely public domain)
      const year = item.publish_date ? parseInt(item.publish_date) : 0;
      if (year > 1930 && year !== 0) { stats.skipped++; continue; }
      
      // Search Gutenberg API
      const searchTitle = encodeURIComponent(item.title.substring(0, 80));
      const data = await fetchJSON(`https://gutendex.com/books/?search=${searchTitle}`);
      if (!data?.results?.length) { await sleep(500); continue; }
      
      // Try to match by author
      const result = data.results.find(r => {
        if (!item.author) return true;
        const authorLast = item.author.split(' ').pop()?.toLowerCase();
        return r.authors?.some(a => a.name?.toLowerCase().includes(authorLast));
      }) || data.results[0];
      
      const updates = {};
      
      // Prefer HTML for reading, then text, then epub
      if (result.formats?.['text/html']) {
        updates.content_url = result.formats['text/html'];
      } else if (result.formats?.['text/html; charset=utf-8']) {
        updates.content_url = result.formats['text/html; charset=utf-8'];
      } else if (result.formats?.['text/plain; charset=utf-8']) {
        updates.content_url = result.formats['text/plain; charset=utf-8'];
      }
      
      if (result.formats?.['application/epub+zip']) {
        updates.epub_url = result.formats['application/epub+zip'];
      }
      
      if (result.formats?.['image/jpeg']) {
        updates.cover_url = result.formats['image/jpeg'];
      }
      
      if (Object.keys(updates).length) {
        await updateItem(item.id, updates);
        total++;
      }
      
      await sleep(500); // Gutendex is small, be gentle
    }
    
    offset += BATCH_SIZE;
    if (LIMIT && offset >= LIMIT) break;
    console.log(`  Gutenberg batch: processed ${offset}, updated ${total}`);
  }
  console.log(`  Gutenberg done: ${total} updated`);
}

// ─── 5. Set content_url for OL books that have source_url but no content_url ───

async function enrichOLContentUrls() {
  console.log('\n=== Setting content_url for Open Library books ===');
  let offset = 0;
  let total = 0;
  
  while (true) {
    const items = await fetchItems(
      'source_url=like.*openlibrary*&content_url=is.null',
      'id,source_url',
      BATCH_SIZE, offset
    );
    if (!items.length) break;
    
    const batch = items.map(item => ({
      id: item.id,
      data: { content_url: item.source_url } // OL work page is the content link
    }));
    
    await batchUpdate(batch);
    total += batch.length;
    offset += BATCH_SIZE;
    if (LIMIT && offset >= LIMIT) break;
    if (total % 500 === 0) console.log(`  OL content_url: ${total} set`);
  }
  console.log(`  OL content_url done: ${total} set`);
}

// ─── Main ───

async function main() {
  console.log(`Library Enrichment — source: ${SOURCE}, limit: ${LIMIT || 'all'}, dry-run: ${DRY_RUN}`);
  
  const tasks = {
    'arxiv': enrichArxiv,
    'openlibrary': enrichOpenLibrary,
    'isbn': enrichISBN,
    'gutenberg': enrichGutenberg,
    'ol-urls': enrichOLContentUrls,
  };
  
  if (SOURCE === 'all') {
    // Run in order of impact/speed
    await enrichArxiv();
    await enrichOLContentUrls();
    await enrichOpenLibrary();
    await enrichISBN();
    await enrichGutenberg();
  } else if (tasks[SOURCE]) {
    await tasks[SOURCE]();
  } else {
    console.error(`Unknown source: ${SOURCE}. Use: ${Object.keys(tasks).join(', ')}`);
    process.exit(1);
  }
  
  console.log('\n=== Final Stats ===');
  console.log(stats);
}

main().catch(e => { console.error(e); process.exit(1); });
