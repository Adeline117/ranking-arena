import { createClient } from '@supabase/supabase-js';

const sb = createClient(
  'https://iknktzifjdyujdccyhsv.supabase.co',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imlrbmt0emlmamR5dWpkY2N5aHN2Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2NjU1MTU1MywiZXhwIjoyMDgyMTI3NTUzfQ.dBTyJ6tPY-eelVj4khLq31RuUg59Opcy5B48zOLLuGE'
);

const keywords = [
  '加密货币','区块链技术','比特币','以太坊','去中心化金融',
  '技术分析','量化交易','算法交易','期货交易','外汇交易',
  '股票投资','价值投资','日内交易','风险管理','投资组合',
  '金融衍生品','行为金融学','数字货币','Web3','NFT',
  '智能合约','DeFi','金融工程','对冲基金'
];

function categorize(kw) {
  if (['加密货币','区块链技术','比特币','以太坊','数字货币','Web3','NFT','智能合约','DeFi','去中心化金融'].includes(kw))
    return { category: 'book', subcategory: 'crypto' };
  if (['技术分析','量化交易','算法交易','期货交易','外汇交易','日内交易'].includes(kw))
    return { category: 'book', subcategory: 'trading' };
  return { category: 'book', subcategory: 'finance' };
}

const seen = new Set();
let totalUpserted = 0;

async function fetchJSON(url) {
  try {
    const r = await fetch(url);
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

async function upsertBatch(items) {
  if (!items.length) return;
  const { error, data } = await sb.from('library_items').upsert(items, { onConflict: 'title,author', ignoreDuplicates: true });
  if (error) console.error('  upsert error:', error.message);
  else totalUpserted += items.length;
}

// Google Books
for (const kw of keywords) {
  const cat = categorize(kw);
  const url = `https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(kw)}&langRestrict=zh&maxResults=40`;
  const data = await fetchJSON(url);
  if (!data?.items) { console.log(`[Google] ${kw}: no results`); continue; }

  const batch = [];
  for (const item of data.items) {
    const v = item.volumeInfo || {};
    const title = v.title;
    const author = (v.authors || []).join(', ') || 'Unknown';
    const key = `${title}||${author}`;
    if (!title || seen.has(key)) continue;
    seen.add(key);

    batch.push({
      title,
      author,
      description: (v.description || '').slice(0, 2000) || null,
      category: cat.category,
      subcategory: cat.subcategory,
      source: 'google_books',
      source_url: v.infoLink || null,
      cover_url: v.imageLinks?.thumbnail || null,
      language: 'zh',
      tags: [kw],
      isbn: (v.industryIdentifiers || []).find(i => i.type === 'ISBN_13')?.identifier || (v.industryIdentifiers || []).find(i => i.type === 'ISBN_10')?.identifier || null,
      page_count: v.pageCount || null,
      publish_date: v.publishedDate || null,
      is_free: false,
    });
  }
  await upsertBatch(batch);
  console.log(`[Google] ${kw}: ${batch.length} books`);
  await new Promise(r => setTimeout(r, 300));
}

// Open Library
for (const kw of keywords) {
  const cat = categorize(kw);
  const url = `https://openlibrary.org/search.json?q=${encodeURIComponent(kw)}&language=chi&limit=50`;
  const data = await fetchJSON(url);
  if (!data?.docs) { console.log(`[OpenLib] ${kw}: no results`); continue; }

  const batch = [];
  for (const doc of data.docs) {
    const title = doc.title;
    const author = (doc.author_name || []).join(', ') || 'Unknown';
    const key = `${title}||${author}`;
    if (!title || seen.has(key)) continue;
    seen.add(key);

    batch.push({
      title,
      author,
      description: doc.first_sentence?.join(' ')?.slice(0, 2000) || null,
      category: cat.category,
      subcategory: cat.subcategory,
      source: 'open_library',
      source_url: doc.key ? `https://openlibrary.org${doc.key}` : null,
      cover_url: doc.cover_i ? `https://covers.openlibrary.org/b/id/${doc.cover_i}-M.jpg` : null,
      language: 'zh',
      tags: [kw],
      isbn: doc.isbn?.[0] || null,
      page_count: doc.number_of_pages_median || null,
      publish_date: doc.first_publish_year ? `${doc.first_publish_year}` : null,
      is_free: false,
    });
  }
  await upsertBatch(batch);
  console.log(`[OpenLib] ${kw}: ${batch.length} books`);
  await new Promise(r => setTimeout(r, 500));
}

// Chinese whitepapers
const whitepapers = [
  { title: '比特币白皮书（中文版）', author: 'Satoshi Nakamoto', subcategory: 'blockchain', source_url: 'https://bitcoin.org/files/bitcoin-paper/bitcoin_zh_cn.pdf', pdf_url: 'https://bitcoin.org/files/bitcoin-paper/bitcoin_zh_cn.pdf', tags: ['bitcoin','whitepaper'], crypto_symbols: ['BTC'], publish_date: '2008-10-31' },
  { title: '以太坊白皮书（中文版）', author: 'Vitalik Buterin', subcategory: 'blockchain', source_url: 'https://github.com/ethereum/wiki/wiki/%5B%E4%B8%AD%E6%96%87%5D-%E4%BB%A5%E5%A4%AA%E5%9D%8A%E7%99%BD%E7%9A%AE%E4%B9%A6', tags: ['ethereum','whitepaper'], crypto_symbols: ['ETH'], publish_date: '2014-01-01' },
  { title: 'Solana白皮书（中文版）', author: 'Anatoly Yakovenko', subcategory: 'blockchain', source_url: 'https://solana.com/solana-whitepaper.pdf', tags: ['solana','whitepaper'], crypto_symbols: ['SOL'], publish_date: '2017-11-01' },
  { title: 'Polkadot白皮书（中文版）', author: 'Gavin Wood', subcategory: 'blockchain', source_url: 'https://polkadot.network/whitepaper/', tags: ['polkadot','whitepaper'], crypto_symbols: ['DOT'], publish_date: '2016-11-01' },
  { title: 'Cosmos白皮书（中文版）', author: 'Jae Kwon, Ethan Buchman', subcategory: 'blockchain', source_url: 'https://cosmos.network/resources/whitepaper', tags: ['cosmos','whitepaper'], crypto_symbols: ['ATOM'], publish_date: '2016-06-01' },
  { title: 'Uniswap V3白皮书（中文版）', author: 'Hayden Adams et al.', subcategory: 'defi', source_url: 'https://uniswap.org/whitepaper-v3.pdf', tags: ['uniswap','defi','whitepaper'], crypto_symbols: ['UNI'], publish_date: '2021-03-01' },
  { title: 'Chainlink 2.0白皮书（中文版）', author: 'Chainlink Labs', subcategory: 'blockchain', source_url: 'https://chain.link/whitepaper', tags: ['chainlink','oracle','whitepaper'], crypto_symbols: ['LINK'], publish_date: '2021-04-01' },
  { title: 'Filecoin白皮书（中文版）', author: 'Protocol Labs', subcategory: 'blockchain', source_url: 'https://filecoin.io/filecoin.pdf', tags: ['filecoin','storage','whitepaper'], crypto_symbols: ['FIL'], publish_date: '2017-07-01' },
];

const wpBatch = whitepapers.map(wp => ({
  ...wp,
  category: 'whitepaper',
  source: 'manual',
  language: 'zh',
  is_free: true,
  pdf_url: wp.pdf_url || wp.source_url,
}));
await upsertBatch(wpBatch);
console.log(`[Whitepapers] ${wpBatch.length} Chinese whitepapers upserted`);

console.log(`\n✅ Done! Total items attempted to upsert: ${totalUpserted}, unique titles seen: ${seen.size}`);
