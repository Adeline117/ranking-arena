#!/usr/bin/env node
/**
 * Source free crypto/trading/investment ebooks from Anna's Archive
 * Collects metadata and stores in Supabase library_items table.
 * Does NOT download files - only stores metadata + source URLs.
 */

import { createClient } from '@supabase/supabase-js';
import * as cheerio from 'cheerio';

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const AA_BASE = 'https://annas-archive.li';
const DELAY_MS = 2000; // Be polite

const SEARCH_TERMS = [
  'cryptocurrency trading',
  'bitcoin',
  'ethereum',
  'blockchain',
  'DeFi decentralized finance',
  'technical analysis trading',
  'quantitative trading',
  'algorithmic trading',
  'crypto investing',
  'NFT web3',
  'smart contracts solidity',
  'day trading strategies',
  'swing trading',
  'options trading crypto',
  'market making',
  'financial markets trading',
  'portfolio management investing',
  'risk management trading',
  'candlestick patterns',
  'forex trading',
];

const ZH_SEARCH_TERMS = [
  '加密货币',
  '区块链',
  '量化交易',
  '比特币',
  '以太坊',
  '数字货币投资',
  '技术分析',
];

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function fetchWithRetry(url, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
          'Accept': 'text/html,application/xhtml+xml',
          'Accept-Language': 'en-US,en;q=0.9',
        },
      });
      if (res.status === 429) {
        console.log(`  Rate limited, waiting ${10 * (i + 1)}s...`);
        await sleep(10000 * (i + 1));
        continue;
      }
      if (!res.ok) {
        console.log(`  HTTP ${res.status} for ${url}`);
        await sleep(5000);
        continue;
      }
      return await res.text();
    } catch (e) {
      console.log(`  Fetch error (attempt ${i + 1}): ${e.message}`);
      await sleep(5000);
    }
  }
  return null;
}

function parseSearchResults(html) {
  const $ = cheerio.load(html);
  const results = [];
  const covers = $('[id^="list_cover_"]');

  covers.each((i, el) => {
    const id = $(el).attr('id');
    const md5Match = id.match(/md5:([a-f0-9]{32})/);
    if (!md5Match) return;
    const md5 = md5Match[1];

    const dataContentDivs = $(el).find('[data-content]');
    const title = dataContentDivs.first().attr('data-content') || '';
    const author = dataContentDivs.length > 1 ? dataContentDivs.last().attr('data-content') || '' : '';
    const coverImg = $(el).find('img').attr('src') || null;

    // Get the parent container text for year/size/format
    const parentLink = $(el).closest('a');
    const container = parentLink.parent();
    const containerText = container.text().replace(/\s+/g, ' ');

    const yearMatch = containerText.match(/·\s*(\d{4})\s*·/);
    const sizeMatch = containerText.match(/(\d+\.?\d*)\s*(MB|KB|GB)/i);
    const formatMatch = containerText.match(/·\s*(PDF|EPUB|MOBI|DJVU|AZW3|FB2|LIT|RTF)\s*·/i);
    const langMatch = containerText.match(/\[(\w{2})\]/);

    if (!title) return;

    results.push({
      md5,
      title: title.trim(),
      author: author.trim(),
      cover_url: coverImg,
      year: yearMatch ? parseInt(yearMatch[1]) : null,
      size: sizeMatch ? `${sizeMatch[1]}${sizeMatch[2]}` : null,
      format: formatMatch ? formatMatch[1].toUpperCase() : 'PDF',
      language: langMatch ? langMatch[1] : 'en',
      source_url: `${AA_BASE}/md5/${md5}`,
    });
  });

  return results;
}

async function fetchDetailPage(md5) {
  const html = await fetchWithRetry(`${AA_BASE}/md5/${md5}`);
  if (!html) return {};

  const $ = cheerio.load(html);
  const text = $('body').text();

  // Extract ISBN
  const isbnMatch = text.match(/ISBN-13:\s*[\s\S]*?(97[89]\d{10})/);
  const isbn = isbnMatch ? isbnMatch[1] : null;

  // Extract description
  let description = '';
  // Look for the book description in the page
  $('div').each((i, el) => {
    const t = $(el).text().trim();
    if (t.length > 200 && t.length < 5000 && !description) {
      // Check if it contains typical description indicators
      if (t.includes('This book') || t.includes('Learn') || t.includes('Guide') ||
          t.includes('trading') || t.includes('crypto') || t.includes('blockchain')) {
        // Avoid navigation/menu text
        if (!t.includes('Anna\'s Archive') && !t.includes('Search') && !t.includes('Donate')) {
          description = t.substring(0, 1000);
        }
      }
    }
  });

  // Extract publisher
  const pubMatch = text.match(/Publisher:\s*([^\n]+)/);
  const publisher = pubMatch ? pubMatch[1].trim().substring(0, 200) : null;

  // Extract pages
  const pagesMatch = text.match(/Pages:\s*(\d+)/);
  const pages = pagesMatch ? parseInt(pagesMatch[1]) : null;

  return { isbn, description, publisher, pages };
}

async function getExistingTitles() {
  console.log('Fetching existing library items for deduplication...');
  const allTitles = new Set();
  let offset = 0;
  const batchSize = 1000;

  while (true) {
    const { data, error } = await supabase
      .from('library_items')
      .select('title, author')
      .range(offset, offset + batchSize - 1);

    if (error) {
      console.error('Error fetching existing items:', error.message);
      break;
    }
    if (!data || data.length === 0) break;

    data.forEach(item => {
      const key = normalizeKey(item.title, item.author);
      allTitles.add(key);
    });

    offset += batchSize;
    if (data.length < batchSize) break;
  }

  console.log(`Found ${allTitles.size} existing items`);
  return allTitles;
}

function normalizeKey(title, author) {
  const t = (title || '').toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]/g, '').substring(0, 60);
  const a = (author || '').toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]/g, '').substring(0, 30);
  return `${t}::${a}`;
}

function categorizeBook(title, description) {
  const text = `${title} ${description}`.toLowerCase();
  if (text.includes('bitcoin') || text.includes('ethereum') || text.includes('crypto') ||
      text.includes('blockchain') || text.includes('defi') || text.includes('web3') ||
      text.includes('nft') || text.includes('solidity') || text.includes('smart contract') ||
      text.includes('比特币') || text.includes('以太坊') || text.includes('加密') || text.includes('区块链')) {
    return { category: 'crypto', subcategory: guessSubcategory(text) };
  }
  if (text.includes('quantitative') || text.includes('algorithmic') || text.includes('algo trading') ||
      text.includes('量化')) {
    return { category: 'trading', subcategory: 'quantitative' };
  }
  if (text.includes('technical analysis') || text.includes('candlestick') || text.includes('chart pattern') ||
      text.includes('技术分析')) {
    return { category: 'trading', subcategory: 'technical-analysis' };
  }
  if (text.includes('options') || text.includes('derivatives') || text.includes('futures')) {
    return { category: 'trading', subcategory: 'derivatives' };
  }
  if (text.includes('day trad') || text.includes('swing trad') || text.includes('scalp')) {
    return { category: 'trading', subcategory: 'day-trading' };
  }
  if (text.includes('forex') || text.includes('foreign exchange')) {
    return { category: 'trading', subcategory: 'forex' };
  }
  if (text.includes('portfolio') || text.includes('invest') || text.includes('wealth') ||
      text.includes('value invest') || text.includes('投资')) {
    return { category: 'investing', subcategory: 'portfolio' };
  }
  if (text.includes('trading') || text.includes('交易')) {
    return { category: 'trading', subcategory: 'general' };
  }
  return { category: 'finance', subcategory: 'general' };
}

function guessSubcategory(text) {
  if (text.includes('defi')) return 'defi';
  if (text.includes('nft')) return 'nft';
  if (text.includes('solidity') || text.includes('smart contract')) return 'development';
  if (text.includes('bitcoin')) return 'bitcoin';
  if (text.includes('ethereum')) return 'ethereum';
  if (text.includes('trading') || text.includes('交易')) return 'trading';
  if (text.includes('invest') || text.includes('投资')) return 'investing';
  if (text.includes('blockchain') || text.includes('区块链')) return 'blockchain';
  return 'general';
}

function extractTags(title, description) {
  const text = `${title} ${description}`.toLowerCase();
  const tags = [];
  const tagMap = {
    'bitcoin': 'bitcoin', 'btc': 'bitcoin',
    'ethereum': 'ethereum', 'eth ': 'ethereum',
    'defi': 'defi', 'decentralized finance': 'defi',
    'nft': 'nft', 'non-fungible': 'nft',
    'blockchain': 'blockchain',
    'solidity': 'solidity', 'smart contract': 'smart-contracts',
    'trading': 'trading', 'technical analysis': 'technical-analysis',
    'quantitative': 'quantitative', 'algorithmic': 'algorithmic-trading',
    'web3': 'web3', 'metaverse': 'metaverse',
    'stablecoin': 'stablecoins', 'mining': 'mining',
    'wallet': 'wallets', 'exchange': 'exchanges',
    'ico': 'ico', 'token': 'tokenomics',
    'risk management': 'risk-management',
    'portfolio': 'portfolio', 'investing': 'investing',
    'beginner': 'beginner', 'advanced': 'advanced',
    'python': 'python', 'machine learning': 'machine-learning',
  };

  for (const [keyword, tag] of Object.entries(tagMap)) {
    if (text.includes(keyword) && !tags.includes(tag)) tags.push(tag);
  }
  return tags.slice(0, 10);
}

function extractCryptoSymbols(title, description) {
  const text = `${title} ${description}`.toUpperCase();
  const symbols = [];
  const symbolMap = {
    'BITCOIN': 'BTC', 'ETHEREUM': 'ETH', 'SOLANA': 'SOL',
    'CARDANO': 'ADA', 'POLKADOT': 'DOT', 'CHAINLINK': 'LINK',
    'UNISWAP': 'UNI', 'AAVE': 'AAVE', 'RIPPLE': 'XRP',
    'LITECOIN': 'LTC', 'DOGECOIN': 'DOGE', 'AVALANCHE': 'AVAX',
    'POLYGON': 'MATIC', 'COSMOS': 'ATOM', 'MONERO': 'XMR',
  };
  for (const [name, sym] of Object.entries(symbolMap)) {
    if (text.includes(name) && !symbols.includes(sym)) symbols.push(sym);
  }
  return symbols.length > 0 ? symbols : null;
}

async function searchAnnas(query, lang = 'en', page = 1) {
  const langParam = lang === 'zh' ? 'zh' : 'en';
  const url = `${AA_BASE}/search?q=${encodeURIComponent(query)}&lang=${langParam}&content=book_nonfiction&sort=most_relevant&page=${page}`;
  console.log(`  Searching: ${query} (page ${page}, lang=${langParam})`);

  const html = await fetchWithRetry(url);
  if (!html) return [];

  return parseSearchResults(html);
}

async function main() {
  console.log('=== Free Books Sourcer for Ranking Arena ===\n');

  const existingKeys = await getExistingTitles();
  const allBooks = new Map(); // md5 -> book data
  let duplicateCount = 0;

  // Search English terms
  for (const term of SEARCH_TERMS) {
    for (let page = 1; page <= 3; page++) {
      const results = await searchAnnas(term, 'en', page);
      if (results.length === 0) break;

      for (const book of results) {
        if (allBooks.has(book.md5)) continue;
        const key = normalizeKey(book.title, book.author);
        if (existingKeys.has(key)) {
          duplicateCount++;
          continue;
        }
        allBooks.set(book.md5, book);
      }

      console.log(`    Page ${page}: ${results.length} results, total unique: ${allBooks.size}`);
      await sleep(DELAY_MS);
    }
  }

  // Search Chinese terms
  for (const term of ZH_SEARCH_TERMS) {
    for (let page = 1; page <= 2; page++) {
      const results = await searchAnnas(term, 'zh', page);
      if (results.length === 0) break;

      for (const book of results) {
        if (allBooks.has(book.md5)) continue;
        book.language = 'zh';
        const key = normalizeKey(book.title, book.author);
        if (existingKeys.has(key)) {
          duplicateCount++;
          continue;
        }
        allBooks.set(book.md5, book);
      }

      console.log(`    Page ${page}: ${results.length} results, total unique: ${allBooks.size}`);
      await sleep(DELAY_MS);
    }
  }

  console.log(`\nTotal unique books found: ${allBooks.size}`);
  console.log(`Duplicates skipped: ${duplicateCount}`);

  // Fetch detail pages for top books (first 100 to get ISBN/description)
  const books = Array.from(allBooks.values());
  console.log(`\nFetching detail pages for up to 100 books...`);
  let detailCount = 0;
  for (const book of books.slice(0, 100)) {
    const detail = await fetchDetailPage(book.md5);
    if (detail.isbn) book.isbn = detail.isbn;
    if (detail.description) book.description = detail.description;
    if (detail.publisher) book.publisher = detail.publisher;
    if (detail.pages) book.pages = detail.pages;
    detailCount++;
    if (detailCount % 10 === 0) console.log(`  Fetched ${detailCount}/100 detail pages`);
    await sleep(DELAY_MS);
  }

  // Insert into Supabase
  console.log(`\nInserting ${books.length} books into library_items...`);

  const batchSize = 50;
  let insertedCount = 0;
  let errorCount = 0;

  for (let i = 0; i < books.length; i += batchSize) {
    const batch = books.slice(i, i + batchSize).map(book => {
      const { category, subcategory } = categorizeBook(book.title, book.description || '');
      const tags = extractTags(book.title, book.description || '');
      const symbols = extractCryptoSymbols(book.title, book.description || '');

      return {
        title: book.title.substring(0, 500),
        author: book.author || null,
        description: (book.description || '').substring(0, 2000) || null,
        category,
        subcategory,
        source: 'annas-archive',
        source_url: book.source_url,
        pdf_url: book.source_url, // Link to Anna's Archive page
        cover_url: book.cover_url,
        language: book.language || 'en',
        tags,
        crypto_symbols: symbols,
        publish_date: book.year ? `${book.year}-01-01` : null,
        isbn: book.isbn || null,
        page_count: book.pages || null,
        publisher: book.publisher || null,
        is_free: true,
        view_count: 0,
        download_count: 0,
      };
    });

    const { data, error } = await supabase
      .from('library_items')
      .insert(batch)
      .select('id');

    if (error) {
      console.error(`  Batch ${Math.floor(i / batchSize) + 1} error:`, error.message);
      errorCount += batch.length;
      // Try inserting one by one on batch error
      for (const item of batch) {
        const { error: singleError } = await supabase.from('library_items').insert(item);
        if (singleError) {
          errorCount++;
        } else {
          insertedCount++;
        }
      }
    } else {
      insertedCount += data?.length || batch.length;
    }

    console.log(`  Inserted batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(books.length / batchSize)} (${insertedCount} total)`);
  }

  console.log(`\n=== RESULTS ===`);
  console.log(`Books found: ${allBooks.size}`);
  console.log(`Books inserted: ${insertedCount}`);
  console.log(`Errors: ${errorCount}`);
  console.log(`Duplicates skipped: ${duplicateCount}`);

  // Category breakdown
  const categories = {};
  books.forEach(b => {
    const { category } = categorizeBook(b.title, b.description || '');
    categories[category] = (categories[category] || 0) + 1;
  });
  console.log('\nCategory breakdown:');
  Object.entries(categories).sort((a, b) => b[1] - a[1]).forEach(([cat, count]) => {
    console.log(`  ${cat}: ${count}`);
  });
}

main().catch(console.error);
