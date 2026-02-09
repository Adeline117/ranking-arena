#!/usr/bin/env node
/**
 * Download PDFs from source URLs and upload to Supabase Storage.
 * Usage: node scripts/upload-library-files.mjs [category] [limit]
 */
import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'fs';
import { resolve } from 'path';

// Load .env.local
const envFile = readFileSync(resolve(import.meta.dirname, '..', '.env.local'), 'utf8');
const env = {};
for (const line of envFile.split('\n')) {
  const m = line.match(/^(\w+)="(.*)"/);
  if (m) env[m[1]] = m[2];
}

const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
const BUCKET = 'library';
const category = process.argv[2] || 'whitepaper';
const limit = parseInt(process.argv[3] || '50');
const CONCURRENCY = 5;
const TIMEOUT_MS = 30000;

function slugify(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80);
}

function categoryFolder(cat) {
  const map = { whitepaper: 'whitepapers', paper: 'papers', book: 'books', finance: 'finance' };
  return map[cat] || cat;
}

async function downloadPdf(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    // Handle GitHub raw content
    let fetchUrl = url;
    if (url.includes('github.com') && url.includes('/blob/')) {
      fetchUrl = url.replace('github.com', 'raw.githubusercontent.com').replace('/blob/', '/');
    }
    
    const res = await fetch(fetchUrl, {
      signal: controller.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; RankingArena/1.0)' },
      redirect: 'follow',
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 1000) throw new Error(`Too small: ${buf.length} bytes`);
    return buf;
  } finally {
    clearTimeout(timer);
  }
}

async function processItem(item) {
  const { id, title, pdf_url, category: cat } = item;
  const folder = categoryFolder(cat);
  const slug = slugify(title);
  const fileKey = `${folder}/${slug}.pdf`;

  try {
    const buf = await downloadPdf(pdf_url);
    
    const { error: uploadErr } = await supabase.storage
      .from(BUCKET)
      .upload(fileKey, buf, {
        contentType: 'application/pdf',
        upsert: true,
      });
    if (uploadErr) throw uploadErr;

    const { data: { publicUrl } } = supabase.storage.from(BUCKET).getPublicUrl(fileKey);

    const { error: updateErr } = await supabase
      .from('library_items')
      .update({
        file_key: fileKey,
        file_size_bytes: buf.length,
        pdf_url: publicUrl,
      })
      .eq('id', id);
    if (updateErr) throw updateErr;

    console.log(`✅ ${title.slice(0, 60)} (${(buf.length / 1024).toFixed(0)}KB)`);
    return true;
  } catch (err) {
    console.log(`❌ ${title.slice(0, 60)}: ${err.message}`);
    return false;
  }
}

async function main() {
  console.log(`Fetching ${category} items without file_key (limit ${limit})...`);
  
  let query = supabase
    .from('library_items')
    .select('id, title, pdf_url, category')
    .eq('category', category)
    .is('file_key', null)
    .not('pdf_url', 'is', null)
    .like('pdf_url', '%.pdf%')
    .limit(limit);

  const { data: items, error } = await query;
  if (error) { console.error(error); process.exit(1); }
  
  console.log(`Found ${items.length} items to process\n`);
  
  let success = 0, fail = 0;
  
  // Process in batches of CONCURRENCY
  for (let i = 0; i < items.length; i += CONCURRENCY) {
    const batch = items.slice(i, i + CONCURRENCY);
    const results = await Promise.all(batch.map(processItem));
    success += results.filter(Boolean).length;
    fail += results.filter(r => !r).length;
  }
  
  console.log(`\nDone: ${success} uploaded, ${fail} failed out of ${items.length}`);
}

main();
