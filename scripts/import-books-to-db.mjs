#!/usr/bin/env node
/**
 * Import collected books into the Supabase library_items table.
 * Reads from data/collected-books.json
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createClient } from '@supabase/supabase-js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INPUT_FILE = path.join(__dirname, '..', 'data', 'collected-books.json');

// Load .env.local
const envPath = path.join(__dirname, '..', '.env.local');
if (fs.existsSync(envPath)) {
  const envContent = fs.readFileSync(envPath, 'utf-8');
  for (const line of envContent.split('\n')) {
    const match = line.match(/^([A-Z_]+)="?([^"]*)"?$/);
    if (match && !process.env[match[1]]) {
      process.env[match[1]] = match[2];
    }
  }
}

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

function categorize(book) {
  const t = (book.title + ' ' + book.description).toLowerCase();
  const tags = [];
  
  if (/bitcoin/i.test(t)) tags.push('bitcoin');
  if (/ethereum/i.test(t)) tags.push('ethereum');
  if (/solana/i.test(t)) tags.push('solana');
  if (/defi|decentralized finance/i.test(t)) tags.push('defi');
  if (/nft|non.?fungible/i.test(t)) tags.push('nft');
  if (/web3/i.test(t)) tags.push('web3');
  if (/trading|trader/i.test(t)) tags.push('trading');
  if (/technical analysis/i.test(t)) tags.push('technical-analysis');
  if (/blockchain/i.test(t)) tags.push('blockchain');
  if (/smart contract|solidity/i.test(t)) tags.push('smart-contracts');
  if (/invest/i.test(t)) tags.push('investing');
  if (/mining/i.test(t)) tags.push('mining');
  if (/crypto/i.test(t)) tags.push('cryptocurrency');
  if (/algorith/i.test(t)) tags.push('algorithmic-trading');
  if (/token/i.test(t)) tags.push('tokenomics');
  
  if (tags.length === 0) tags.push('cryptocurrency');
  
  // Subcategory
  let subcategory = 'cryptocurrency';
  if (/trading|technical analysis|algorith/i.test(t)) subcategory = 'trading';
  else if (/defi/i.test(t)) subcategory = 'defi';
  else if (/smart contract|solidity|develop|program/i.test(t)) subcategory = 'development';
  else if (/invest|portfolio/i.test(t)) subcategory = 'investing';
  else if (/nft/i.test(t)) subcategory = 'nft';
  
  return { tags, subcategory };
}

async function main() {
  console.log('=== Importing Books to Supabase ===\n');
  
  if (!fs.existsSync(INPUT_FILE)) {
    console.error(`Input file not found: ${INPUT_FILE}`);
    console.error('Run collect-free-books.mjs first.');
    process.exit(1);
  }
  
  const books = JSON.parse(fs.readFileSync(INPUT_FILE, 'utf-8'));
  console.log(`Loaded ${books.length} books from JSON\n`);
  
  let inserted = 0, updated = 0, errors = 0;
  const BATCH_SIZE = 20;
  
  for (let i = 0; i < books.length; i += BATCH_SIZE) {
    const batch = books.slice(i, i + BATCH_SIZE);
    const rows = batch.map(book => {
      const { tags, subcategory } = categorize(book);
      return {
        title: book.title,
        author: book.author || null,
        description: book.description || null,
        category: 'book',
        subcategory,
        source: book.source === 'curated' ? 'curated' : book.source,
        source_url: book.source_url || null,
        pdf_url: book.format === 'pdf' ? book.download_url : null,
        epub_url: book.format === 'epub' ? book.download_url : null,
        content_url: book.download_url || null,
        cover_url: book.cover_url || null,
        language: book.language || 'en',
        tags,
        publish_date: book.year ? `${book.year}-01-01` : null,
        page_count: book.pages || null,
        is_free: true,
      };
    });
    
    const { data, error } = await supabase
      .from('library_items')
      .upsert(rows, { onConflict: 'title,author', ignoreDuplicates: false })
      .select('id');
    
    if (error) {
      // Try one by one
      for (const row of rows) {
        const { error: e2 } = await supabase.from('library_items').upsert(row, { onConflict: 'title,author', ignoreDuplicates: true });
        if (e2) {
          // Try insert
          const { error: e3 } = await supabase.from('library_items').insert(row);
          if (e3) { errors++; } else { inserted++; }
        } else { inserted++; }
      }
    } else {
      inserted += rows.length;
    }
    
    process.stdout.write(`\r  Progress: ${Math.min(i + BATCH_SIZE, books.length)}/${books.length} (${inserted} ok, ${errors} errors)`);
  }
  
  console.log(`\n\n=== IMPORT COMPLETE ===`);
  console.log(`  Inserted/Updated: ${inserted}`);
  console.log(`  Errors: ${errors}`);
}

main().catch(console.error);
