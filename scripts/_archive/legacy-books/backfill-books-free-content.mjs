#!/usr/bin/env node
/**
 * Backfill content_url for books that have known free/open-source versions.
 * Sources: GitHub repos, Open Library readable editions, Project Gutenberg, author websites.
 */
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  'https://iknktzifjdyujdccyhsv.supabase.co',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imlrbmt0emlmamR5dWpkY2N5aHN2Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2NjU1MTU1MywiZXhwIjoyMDgyMTI3NTUzfQ.dBTyJ6tPY-eelVj4khLq31RuUg59Opcy5B48zOLLuGE'
);

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Known free/open-source books with their content URLs
const KNOWN_FREE = {
  'Mastering Ethereum': 'https://github.com/ethereumbook/ethereumbook',
  '精通以太坊': 'https://github.com/ethereumbook/ethereumbook',
  'Mastering Ethereum: Building Smart Contracts and DApps': 'https://github.com/ethereumbook/ethereumbook',
  '精通比特币': 'https://github.com/bitcoinbook/bitcoinbook',
  'How to DeFi: Advanced': 'https://landing.coingecko.com/how-to-defi/',
};

// Try Gutenberg for classic finance books
async function tryGutenberg(title, author) {
  try {
    // "Reminiscences of a Stock Operator" (股票大作手回忆录) by Edwin Lefèvre is from 1923
    const q = encodeURIComponent(title.slice(0, 60));
    const res = await fetch(`https://gutendex.com/books/?search=${q}`, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) return null;
    const data = await res.json();
    for (const book of (data.results || []).slice(0, 3)) {
      // Check author match loosely
      const bookAuthors = (book.authors || []).map(a => a.name.toLowerCase()).join(' ');
      if (author && !bookAuthors.includes(author.split(',')[0].split(' ').pop().toLowerCase())) continue;
      const formats = book.formats || {};
      const txt = formats['text/plain; charset=utf-8'] || formats['text/plain'];
      const epub = formats['application/epub+zip'];
      if (txt || epub) return txt || epub;
    }
  } catch {}
  return null;
}

// Try Open Library for readable editions
async function tryOpenLibrary(title, author, isbn) {
  try {
    let url;
    if (isbn) {
      url = `https://openlibrary.org/search.json?isbn=${isbn}&fields=key,ia,has_fulltext,lending_edition_s&limit=1`;
    } else {
      const q = encodeURIComponent(title.slice(0, 80));
      url = `https://openlibrary.org/search.json?title=${q}&fields=key,ia,has_fulltext,lending_edition_s&limit=3`;
    }
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) return null;
    const data = await res.json();
    for (const doc of (data.docs || [])) {
      if (doc.has_fulltext && doc.ia?.length > 0) {
        return `https://archive.org/details/${doc.ia[0]}`;
      }
      if (doc.lending_edition_s) {
        return `https://openlibrary.org${doc.key}`;
      }
    }
  } catch {}
  return null;
}

// English title mapping for Chinese books to search Gutenberg/OL
const EN_TITLES = {
  '股票大作手回忆录': 'Reminiscences of a Stock Operator',
  '聪明的投资者': 'The Intelligent Investor',
  '证券分析': 'Security Analysis',
  '日本蜡烛图技术': 'Japanese Candlestick Charting Techniques',
  '以交易为生': 'Trading for a Living',
  '漫步华尔街': 'A Random Walk Down Wall Street',
  '思考，快与慢': 'Thinking, Fast and Slow',
  '黑天鹅': 'The Black Swan',
  '反脆弱': 'Antifragile',
  '随机漫步的傻瓜': 'Fooled by Randomness',
  '说谎者的扑克牌': "Liar's Poker",
  '门口的野蛮人': 'Barbarians at the Gate',
  '大空头': 'The Big Short',
  '金融炼金术': 'The Alchemy of Finance',
  '非理性繁荣': 'Irrational Exuberance',
  '海龟交易法则': 'Way of the Turtle',
  '交易心理分析': 'Trading in the Zone',
  '巴菲特致股东的信': "The Essays of Warren Buffett",
  '期货市场技术分析': 'Technical Analysis of the Futures Markets',
  '期权、期货及其他衍生产品': 'Options, Futures, and Other Derivatives',
};

async function main() {
  const { data: books } = await supabase
    .from('library_items')
    .select('id,title,author,isbn')
    .eq('category', 'book')
    .or('content_url.is.null,content_url.eq.')
    .limit(100);

  console.log(`Found ${books.length} books without content_url`);
  let updated = 0;

  for (const book of books) {
    const { id, title, author, isbn } = book;
    let contentUrl = null;

    // 1. Check known free books
    contentUrl = KNOWN_FREE[title];
    if (contentUrl) {
      console.log(`✓ [KNOWN] ${title} → ${contentUrl}`);
    }

    // 2. Try Gutenberg (for older/classic books)
    if (!contentUrl) {
      const enTitle = EN_TITLES[title] || title;
      contentUrl = await tryGutenberg(enTitle, author);
      if (contentUrl) console.log(`✓ [GUTENBERG] ${title} → ${contentUrl}`);
      await sleep(1500);
    }

    // 3. Try Open Library
    if (!contentUrl) {
      const enTitle = EN_TITLES[title] || title;
      contentUrl = await tryOpenLibrary(enTitle, author, isbn);
      if (contentUrl) console.log(`✓ [OPENLIBRARY] ${title} → ${contentUrl}`);
      await sleep(1500);
    }

    if (contentUrl) {
      const { error } = await supabase
        .from('library_items')
        .update({ content_url: contentUrl })
        .eq('id', id);
      if (error) {
        console.error(`✗ Failed to update ${title}:`, error.message);
      } else {
        updated++;
      }
    } else {
      console.log(`  [SKIP] ${title} — no free version found`);
    }
  }

  console.log(`\nDone. Updated ${updated}/${books.length} books.`);
}

main().catch(console.error);
