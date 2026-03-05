#!/usr/bin/env node
/**
 * 从开源平台下载书籍内容到Supabase Storage
 * 源: Open Library (archive.org), Project Gutenberg, Standard Ebooks
 * 优先级: ISBN搜索 > 标题搜索
 * 下载到Supabase Storage，更新file_key
 */
import { createClient } from '@supabase/supabase-js';
import { writeFileSync, unlinkSync, existsSync, mkdirSync, readFileSync } from 'fs';
import { randomUUID } from 'crypto';

const supabase = createClient(
  'https://iknktzifjdyujdccyhsv.supabase.co',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imlrbmt0emlmamR5dWpkY2N5aHN2Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2NjU1MTU1MywiZXhwIjoyMDgyMTI3NTUzfQ.dBTyJ6tPY-eelVj4khLq31RuUg59Opcy5B48zOLLuGE'
);

const sleep = ms => new Promise(r => setTimeout(r, ms));
const TMP_DIR = '/tmp/arena-books';
if (!existsSync(TMP_DIR)) mkdirSync(TMP_DIR, { recursive: true });

let checked = 0, downloaded = 0, failed = 0;

// Search Open Library for a readable/borrowable book
async function tryOpenLibrary(isbn, title) {
  try {
    // Try by ISBN first
    let searchUrl;
    if (isbn) {
      searchUrl = `https://openlibrary.org/search.json?isbn=${isbn}&fields=key,lending_edition_s,ia,has_fulltext&limit=1`;
    } else {
      const q = encodeURIComponent(title.slice(0, 80));
      searchUrl = `https://openlibrary.org/search.json?title=${q}&fields=key,lending_edition_s,ia,has_fulltext&limit=3`;
    }
    
    const res = await fetch(searchUrl, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) return null;
    const data = await res.json();
    
    for (const doc of (data.docs || [])) {
      // Check if it has an Internet Archive identifier
      const iaIds = doc.ia || [];
      if (iaIds.length === 0) continue;
      
      for (const iaId of iaIds.slice(0, 2)) {
        // Try to get PDF/EPUB from Internet Archive
        const metaRes = await fetch(`https://archive.org/metadata/${iaId}/files`, { signal: AbortSignal.timeout(10000) });
        if (!metaRes.ok) continue;
        const metaData = await metaRes.json();
        const files = metaData.result || [];
        
        // Look for PDF or EPUB
        const pdf = files.find(f => f.name?.endsWith('.pdf') && f.format === 'PDF');
        const epub = files.find(f => f.name?.endsWith('.epub'));
        
        if (pdf) {
          return { url: `https://archive.org/download/${iaId}/${pdf.name}`, format: 'pdf', iaId };
        }
        if (epub) {
          return { url: `https://archive.org/download/${iaId}/${epub.name}`, format: 'epub', iaId };
        }
      }
    }
    return null;
  } catch { return null; }
}

// Try Project Gutenberg (public domain books)
async function tryGutenberg(title, author) {
  try {
    const q = encodeURIComponent(`${title} ${author || ''}`.trim().slice(0, 60));
    const res = await fetch(`https://gutendex.com/books/?search=${q}`, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) return null;
    const data = await res.json();
    
    for (const book of (data.results || []).slice(0, 2)) {
      const formats = book.formats || {};
      // Prefer epub, then PDF
      const epubUrl = formats['application/epub+zip'];
      const pdfUrl = Object.entries(formats).find(([k]) => k.includes('pdf'))?.[1];
      const txtUrl = formats['text/plain; charset=utf-8'] || formats['text/plain'];
      
      if (epubUrl) return { url: epubUrl, format: 'epub', source: 'gutenberg' };
      if (pdfUrl) return { url: pdfUrl, format: 'pdf', source: 'gutenberg' };
    }
    return null;
  } catch { return null; }
}

// Download file and upload to Supabase Storage
async function downloadAndUpload(url, bookId, format) {
  const tmpPath = `${TMP_DIR}/${randomUUID()}.${format}`;
  
  try {
    const res = await fetch(url, { 
      signal: AbortSignal.timeout(60000),
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ArenaBot/1.0)' }
    });
    if (!res.ok || !res.body) return null;
    
    // Check file size (skip if > 50MB)
    const contentLength = parseInt(res.headers.get('content-length') || '0');
    if (contentLength > 50 * 1024 * 1024) return null;
    
    // Download to buffer
    const arrayBuffer = await res.arrayBuffer();
    const fileBuffer = Buffer.from(arrayBuffer);
    if (fileBuffer.length < 1000) return null; // Too small, probably error page
    
    const storagePath = `books/${bookId}.${format}`;
    const { error } = await supabase.storage
      .from('library')
      .upload(storagePath, fileBuffer, {
        contentType: format === 'pdf' ? 'application/pdf' : 'application/epub+zip',
        upsert: true
      });
    
    if (error) {
      console.error(`  Upload error for ${bookId}:`, error.message);
      return null;
    }
    
    return storagePath;
  } catch (e) {
    return null;
  }
}

async function processBook(book) {
  const { id, title, isbn, author } = book;
  checked++;
  
  // Try Open Library first
  let source = await tryOpenLibrary(isbn, title);
  if (!source) {
    await sleep(300);
    source = await tryGutenberg(title, author);
  }
  
  if (!source) return false;
  
  // Download and upload
  const fileKey = await downloadAndUpload(source.url, id, source.format);
  if (!fileKey) return false;
  
  // Update DB
  const updateData = { file_key: fileKey };
  if (source.format === 'pdf') updateData.pdf_url = fileKey;
  if (source.format === 'epub') updateData.epub_url = fileKey;
  
  await supabase.from('library_items').update(updateData).eq('id', id);
  downloaded++;
  return true;
}

async function main() {
  // Get books without content, prioritize those with ISBN
  const { data: books, error } = await supabase
    .from('library_items')
    .select('id, title, isbn, author')
    .in('category', ['book', 'finance'])
    .is('file_key', null)
    .is('pdf_url', null)
    .is('epub_url', null)
    .not('isbn', 'is', null)
    .order('id', { ascending: true })
    .limit(2000);
  
  if (error) { console.error('DB error:', error); return; }
  
  console.log(`=== 书籍内容下载 (Open Library + Gutenberg) ===`);
  console.log(`待处理: ${books.length} (有ISBN的优先)`);
  
  for (const book of books) {
    const found = await processBook(book);
    
    if (checked % 50 === 0) {
      console.log(`[${new Date().toISOString()}] checked=${checked} downloaded=${downloaded} (${(100*downloaded/checked).toFixed(1)}%) — ${book.title?.slice(0, 40)}`);
    }
    
    // Rate limit
    await sleep(1500);
  }
  
  // Second pass: books without ISBN (title search)
  if (downloaded < 500) {
    const { data: noIsbnBooks } = await supabase
      .from('library_items')
      .select('id, title, isbn, author')
      .in('category', ['book', 'finance'])
      .is('file_key', null)
      .is('pdf_url', null)
      .is('epub_url', null)
      .is('isbn', null)
      .order('id', { ascending: true })
      .limit(3000);
    
    if (noIsbnBooks?.length) {
      console.log(`\n=== 第二轮: 无ISBN书籍 (标题搜索) ===`);
      console.log(`待处理: ${noIsbnBooks.length}`);
      
      for (const book of noIsbnBooks) {
        await processBook(book);
        if (checked % 50 === 0) {
          console.log(`[${new Date().toISOString()}] checked=${checked} downloaded=${downloaded} (${(100*downloaded/checked).toFixed(1)}%)`);
        }
        await sleep(2000);
      }
    }
  }
  
  console.log(`\n✅ 完成: ${checked} checked, ${downloaded} downloaded (${(100*downloaded/checked).toFixed(1)}%)`);
}

main().catch(console.error);
