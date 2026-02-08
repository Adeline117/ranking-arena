#!/usr/bin/env node
// Fetch Google Books preview/info links for library books missing pdf_url
// Parallel requests with rate limiting

const SUPABASE_URL = 'https://iknktzifjdyujdccyhsv.supabase.co';
const KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imlrbmt0emlmamR5dWpkY2N5aHN2Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2NjU1MTU1MywiZXhwIjoyMDgyMTI3NTUzfQ.dBTyJ6tPY-eelVj4khLq31RuUg59Opcy5B48zOLLuGE';
const HEADERS = { 'apikey': KEY, 'Authorization': `Bearer ${KEY}`, 'Content-Type': 'application/json' };

import fs from 'fs';
const PROGRESS_FILE = '/Users/adelinewen/ranking-arena/scripts/.book-source-progress.json';
const CONCURRENCY = 5; // parallel Google Books requests

function loadProgress() {
  try { return JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf8')); }
  catch { return { processedSet: [], stats: { found: 0, partial: 0, all_pages: 0, no_pages: 0, not_found: 0, errors: 0, total: 0 } }; }
}
function saveProgress(p) { fs.writeFileSync(PROGRESS_FILE, JSON.stringify({ processedSet: [...p.processedSet], stats: p.stats })); }

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function searchGoogleBooks(query, retries = 2) {
  const url = `https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(query)}&maxResults=1`;
  try {
    const res = await fetch(url);
    if (res.status === 429) {
      if (retries > 0) { await sleep(10000); return searchGoogleBooks(query, retries - 1); }
      return null;
    }
    if (!res.ok) return null;
    const data = await res.json();
    if (!data.items?.length) return null;
    const item = data.items[0];
    return {
      viewability: item.accessInfo?.viewability,
      previewLink: item.volumeInfo?.previewLink,
      infoLink: item.volumeInfo?.infoLink
    };
  } catch { return null; }
}

async function fetchBooks(offset, limit, hasIsbn) {
  let url = `${SUPABASE_URL}/rest/v1/library_items?category=eq.book&pdf_url=is.null&select=id,title,author,isbn&order=id&offset=${offset}&limit=${limit}`;
  url += hasIsbn ? '&isbn=not.is.null' : '&isbn=is.null';
  const res = await fetch(url, { headers: HEADERS });
  return res.json();
}

async function updatePdfUrl(id, pdfUrl) {
  await fetch(`${SUPABASE_URL}/rest/v1/library_items?id=eq.${id}`, {
    method: 'PATCH', headers: { ...HEADERS, 'Prefer': 'return=minimal' },
    body: JSON.stringify({ pdf_url: pdfUrl })
  });
}

async function processOne(book, hasIsbn, stats) {
  const query = hasIsbn ? `isbn:${book.isbn}` : `${book.title}${book.author ? ' ' + book.author : ''}`;
  const result = await searchGoogleBooks(query);
  stats.total++;
  
  if (!result) { stats.not_found++; return; }
  
  const v = result.viewability;
  if (v === 'ALL_PAGES') stats.all_pages++;
  else if (v === 'PARTIAL') stats.partial++;
  else stats.no_pages++;
  
  // Use preview link for PARTIAL/ALL_PAGES, info link otherwise
  const link = (v === 'PARTIAL' || v === 'ALL_PAGES') ? (result.previewLink || result.infoLink) : result.infoLink;
  if (link) {
    await updatePdfUrl(book.id, link);
    stats.found++;
  }
}

async function processBooks(hasIsbn) {
  const progress = loadProgress();
  const processedSet = new Set(progress.processedSet);
  const stats = progress.stats;
  const label = hasIsbn ? 'ISBN' : 'TITLE';
  const BATCH = 500;
  let offset = 0;

  while (true) {
    const books = await fetchBooks(offset, BATCH, hasIsbn);
    if (!books.length) break;
    
    // Filter already processed
    const todo = books.filter(b => !processedSet.has(b.id));
    if (!todo.length) { offset += BATCH; continue; }
    
    // Process in chunks of CONCURRENCY
    for (let i = 0; i < todo.length; i += CONCURRENCY) {
      const chunk = todo.slice(i, i + CONCURRENCY);
      await Promise.all(chunk.map(b => processOne(b, hasIsbn, stats)));
      chunk.forEach(b => processedSet.add(b.id));
      
      if (stats.total % 100 === 0) {
        progress.processedSet = processedSet;
        saveProgress(progress);
        console.log(`[${label}] ${stats.total} processed | Found: ${stats.found} | Partial: ${stats.partial} | All: ${stats.all_pages} | NoMatch: ${stats.not_found} | Err: ${stats.errors}`);
      }
      
      await sleep(200); // ~5 req per 200ms = effective rate limit
    }
    
    offset += BATCH;
  }
  
  progress.processedSet = processedSet;
  saveProgress(progress);
}

async function verifyArxivPdfs() {
  console.log('\n=== Verifying arXiv PDF URLs (10 random) ===');
  const url = `${SUPABASE_URL}/rest/v1/library_items?category=eq.paper&pdf_url=like.*arxiv*&select=id,title,pdf_url&limit=10`;
  const res = await fetch(url, { headers: HEADERS });
  const papers = await res.json();
  let ok = 0;
  for (const p of papers) {
    try {
      const r = await fetch(p.pdf_url, { method: 'HEAD', redirect: 'follow' });
      console.log(`  ${r.status === 200 ? '✓' : '✗'} [${r.status}] ${p.title.substring(0, 60)}`);
      if (r.status === 200) ok++;
    } catch (e) { console.log(`  ✗ ${p.title.substring(0, 60)}: ${e.message}`); }
  }
  console.log(`arXiv: ${ok}/10 OK`);
}

async function main() {
  // Remove old progress to start fresh since we changed the approach
  try { fs.unlinkSync(PROGRESS_FILE); } catch {}
  
  console.log('=== Phase 1: Books with ISBN (851) ===');
  await processBooks(true);
  
  console.log('\n=== Phase 2: Books by title+author (28,697) ===');
  await processBooks(false);
  
  await verifyArxivPdfs();
  
  const p = loadProgress();
  console.log('\n=== FINAL ===');
  console.log(JSON.stringify(p.stats, null, 2));
}

main().catch(console.error);
