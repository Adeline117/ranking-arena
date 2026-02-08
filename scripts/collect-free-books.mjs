#!/usr/bin/env node
/**
 * Collect free crypto/trading/investment ebooks from Anna's Archive and LibGen.
 * Saves results to data/collected-books.json
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = path.join(__dirname, '..', 'data');
const OUTPUT_FILE = path.join(OUTPUT_DIR, 'collected-books.json');

const SEARCH_QUERIES = [
  // English queries
  'cryptocurrency trading', 'bitcoin blockchain', 'ethereum solidity',
  'defi decentralized finance', 'crypto investment strategy',
  'technical analysis trading', 'blockchain technology',
  'web3 development', 'solana programming', 'nft digital assets',
  'portfolio management crypto', 'algorithmic trading',
  'mastering bitcoin', 'bitcoin standard', 'crypto economics',
  'smart contracts ethereum', 'blockchain security',
  'day trading cryptocurrency', 'forex crypto trading',
  'tokenomics', 'yield farming defi', 'crypto mining',
  // Chinese queries
  '加密货币 交易', '比特币 区块链', '数字货币 投资',
  '去中心化金融 DeFi', '以太坊 智能合约', '区块链技术',
  'Web3 开发', '加密货币 技术分析', '量化交易 数字货币',
];

// Classic must-have books to search specifically
const CLASSIC_BOOKS = [
  'Mastering Bitcoin Andreas Antonopoulos',
  'The Bitcoin Standard Saifedean Ammous',
  'Mastering Ethereum',
  'The Internet of Money',
  'Cryptoassets Chris Burniske',
  'Digital Gold Nathaniel Popper',
  'Blockchain Revolution Don Tapscott',
  'The Age of Cryptocurrency',
  'Bitcoin Billionaires',
  'DeFi and the Future of Finance',
  'Token Economy Shermin Voshmgir',
  'How to DeFi',
  'The Infinite Machine Camila Russo',
  'Layered Money Nik Bhatia',
  'Programming Bitcoin Jimmy Song',
  'Bubble or Revolution',
  'Attack of the 50 Foot Blockchain',
  'Out of the Ether',
  'Kings of Crypto',
  'The Truth Machine',
];

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function fetchWithRetry(url, opts = {}, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 30000);
      const res = await fetch(url, { ...opts, signal: controller.signal });
      clearTimeout(timeout);
      if (res.status === 429) {
        console.log(`  Rate limited, waiting ${(i + 1) * 10}s...`);
        await sleep((i + 1) * 10000);
        continue;
      }
      return res;
    } catch (e) {
      if (i === retries - 1) throw e;
      await sleep(3000);
    }
  }
}

// ─── Anna's Archive Search ───
async function searchAnnasArchive(query, lang = '') {
  const books = [];
  try {
    const langParam = lang ? `&lang=${lang}` : '';
    const url = `https://annas-archive.org/search?q=${encodeURIComponent(query)}&content=book_nonfiction&ext=pdf,epub${langParam}`;
    console.log(`  Anna's Archive: "${query}"`);
    const res = await fetchWithRetry(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' }
    });
    if (!res || !res.ok) return books;
    const html = await res.text();

    // Parse search results - look for book entries
    const entryRegex = /<a[^>]*href="(\/md5\/[a-f0-9]+)"[^>]*>[\s\S]*?<\/a>/gi;
    let match;
    let count = 0;
    while ((match = entryRegex.exec(html)) !== null && count < 15) {
      const href = match[1];
      const block = match[0];
      
      // Extract title from the block
      const titleMatch = block.match(/class="[^"]*truncate[^"]*"[^>]*>([^<]+)/i) 
        || block.match(/>([^<]{10,120})</);
      const title = titleMatch ? titleMatch[1].trim() : null;
      if (!title) continue;

      // Extract author
      const authorMatch = block.match(/class="[^"]*italic[^"]*"[^>]*>([^<]+)/i);
      const author = authorMatch ? authorMatch[1].trim() : 'Unknown';

      // Extract year
      const yearMatch = block.match(/(\b20[0-2]\d\b|\b201\d\b|\b200\d\b|\b199\d\b)/);
      const year = yearMatch ? parseInt(yearMatch[1]) : null;

      // Extract format
      const formatMatch = block.match(/\b(pdf|epub)\b/i);
      const format = formatMatch ? formatMatch[1].toLowerCase() : 'pdf';

      // Extract language
      const langMatch = block.match(/\b(English|Chinese|中文)\b/i);
      const language = langMatch ? (langMatch[1].toLowerCase().includes('chin') || langMatch[1].includes('中文') ? 'zh' : 'en') : 'en';

      books.push({
        title,
        author,
        description: '',
        cover_url: null,
        source_url: `https://annas-archive.org${href}`,
        download_url: `https://annas-archive.org${href}`,
        format,
        language,
        year,
        pages: null,
        source: 'annas_archive',
      });
      count++;
    }
  } catch (e) {
    console.log(`  Error searching Anna's Archive: ${e.message}`);
  }
  return books;
}

// ─── LibGen Search ───
async function searchLibgen(query) {
  const books = [];
  try {
    const url = `https://libgen.is/search.php?req=${encodeURIComponent(query)}&lg_topic=libgen&open=0&view=simple&res=25&phrase=1&column=def`;
    console.log(`  LibGen: "${query}"`);
    const res = await fetchWithRetry(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' }
    });
    if (!res || !res.ok) return books;
    const html = await res.text();

    // Parse table rows
    const rowRegex = /<tr[^>]*>[\s\S]*?<\/tr>/gi;
    let rowMatch;
    let skipHeader = true;
    while ((rowMatch = rowRegex.exec(html)) !== null) {
      const row = rowMatch[0];
      if (skipHeader) { skipHeader = false; continue; }
      
      // Extract cells
      const cells = [];
      const cellRegex = /<td[^>]*>([\s\S]*?)<\/td>/gi;
      let cellMatch;
      while ((cellMatch = cellRegex.exec(row)) !== null) {
        cells.push(cellMatch[1]);
      }
      if (cells.length < 9) continue;

      // Extract from cells: [id, author, title, publisher, year, pages, language, size, extension]
      const authorHtml = cells[1];
      const author = (authorHtml.match(/>([^<]+)</)?.[1] || 'Unknown').trim();
      
      const titleHtml = cells[2];
      const titleMatch = titleHtml.match(/<a[^>]*href="([^"]*)"[^>]*>([^<]+)<\/a>/i);
      const title = titleMatch ? titleMatch[2].trim() : null;
      const detailUrl = titleMatch ? titleMatch[1] : null;
      if (!title) continue;

      const year = parseInt(cells[4]?.trim()) || null;
      const pages = parseInt(cells[5]?.trim()) || null;
      const language = cells[6]?.trim().toLowerCase().startsWith('ch') ? 'zh' : 'en';
      const format = cells[8]?.trim().toLowerCase() || 'pdf';

      // Extract MD5 for download link
      const md5Match = (detailUrl || '').match(/md5=([a-fA-F0-9]+)/i) || row.match(/md5=([a-fA-F0-9]+)/i);
      const md5 = md5Match ? md5Match[1] : null;

      books.push({
        title,
        author,
        description: '',
        cover_url: null,
        source_url: detailUrl ? (detailUrl.startsWith('http') ? detailUrl : `https://libgen.is${detailUrl}`) : null,
        download_url: md5 ? `https://libgen.is/get.php?md5=${md5}` : null,
        format: ['pdf', 'epub', 'mobi', 'djvu'].includes(format) ? format : 'pdf',
        language,
        year,
        pages,
        source: 'libgen',
      });
    }
  } catch (e) {
    console.log(`  Error searching LibGen: ${e.message}`);
  }
  return books;
}

// ─── Curated list of well-known crypto books with Open Library / Archive.org links ───
function getCuratedBooks() {
  return [
    { title: "Mastering Bitcoin: Programming the Open Blockchain", author: "Andreas M. Antonopoulos", year: 2017, language: "en", format: "pdf", source_url: "https://github.com/bitcoinbook/bitcoinbook", download_url: "https://github.com/bitcoinbook/bitcoinbook", description: "The definitive technical guide to Bitcoin, covering how the technology works at a technical level.", pages: 416, source: "curated" },
    { title: "Mastering Bitcoin (2nd Edition)", author: "Andreas M. Antonopoulos", year: 2017, language: "en", format: "pdf", source_url: "https://archive.org/details/masteringbitcoin0000anto_k3r2", download_url: "https://archive.org/details/masteringbitcoin0000anto_k3r2", description: "Second edition of the comprehensive guide to Bitcoin and blockchain technology.", pages: 408, source: "curated" },
    { title: "Mastering Ethereum: Building Smart Contracts and DApps", author: "Andreas M. Antonopoulos, Gavin Wood", year: 2018, language: "en", format: "pdf", source_url: "https://github.com/ethereumbook/ethereumbook", download_url: "https://github.com/ethereumbook/ethereumbook", description: "A guide to operating and using the Ethereum platform.", pages: 424, source: "curated" },
    { title: "The Bitcoin Standard: The Decentralized Alternative to Central Banking", author: "Saifedean Ammous", year: 2018, language: "en", format: "pdf", source_url: "https://archive.org/search?query=bitcoin+standard+ammous", download_url: "https://archive.org/search?query=bitcoin+standard+ammous", description: "Analysis of the historical context of Bitcoin and its role as a form of sound money.", pages: 304, source: "curated" },
    { title: "The Internet of Money", author: "Andreas M. Antonopoulos", year: 2016, language: "en", format: "pdf", source_url: "https://archive.org/search?query=internet+of+money+antonopoulos", download_url: "https://archive.org/search?query=internet+of+money+antonopoulos", description: "Collection of talks about why Bitcoin matters.", pages: 150, source: "curated" },
    { title: "Digital Gold: Bitcoin and the Inside Story of the Misfits and Millionaires Trying to Reinvent Money", author: "Nathaniel Popper", year: 2015, language: "en", format: "epub", source_url: "https://archive.org/search?query=digital+gold+popper", download_url: "https://archive.org/search?query=digital+gold+popper", description: "The story of Bitcoin from a New York Times reporter.", pages: 432, source: "curated" },
    { title: "Cryptoassets: The Innovative Investor's Guide to Bitcoin and Beyond", author: "Chris Burniske, Jack Tatar", year: 2017, language: "en", format: "pdf", source_url: "https://archive.org/search?query=cryptoassets+burniske", download_url: "https://archive.org/search?query=cryptoassets+burniske", description: "Framework for investigating and valuing cryptoassets.", pages: 368, source: "curated" },
    { title: "Blockchain Revolution", author: "Don Tapscott, Alex Tapscott", year: 2016, language: "en", format: "pdf", source_url: "https://archive.org/search?query=blockchain+revolution+tapscott", download_url: "https://archive.org/search?query=blockchain+revolution+tapscott", description: "How blockchain technology will change money, business, and the world.", pages: 368, source: "curated" },
    { title: "The Age of Cryptocurrency", author: "Paul Vigna, Michael J. Casey", year: 2015, language: "en", format: "pdf", source_url: "https://archive.org/search?query=age+cryptocurrency+vigna", download_url: "https://archive.org/search?query=age+cryptocurrency+vigna", description: "How Bitcoin and digital money are challenging the global economic order.", pages: 384, source: "curated" },
    { title: "Programming Bitcoin: Learn How to Program Bitcoin from Scratch", author: "Jimmy Song", year: 2019, language: "en", format: "pdf", source_url: "https://github.com/jimmysong/programmingbitcoin", download_url: "https://github.com/jimmysong/programmingbitcoin", description: "Learn Bitcoin programming from the ground up.", pages: 322, source: "curated" },
    { title: "Bitcoin and Cryptocurrency Technologies", author: "Arvind Narayanan, Joseph Bonneau, Edward Felten, Andrew Miller, Steven Goldfeder", year: 2016, language: "en", format: "pdf", source_url: "https://bitcoinbook.cs.princeton.edu/", download_url: "https://bitcoinbook.cs.princeton.edu/", description: "Princeton University textbook on Bitcoin and cryptocurrency technologies. Free online draft.", pages: 308, source: "curated" },
    { title: "DeFi and the Future of Finance", author: "Campbell R. Harvey, Ashwin Ramachandran, Joey Santoro", year: 2021, language: "en", format: "pdf", source_url: "https://archive.org/search?query=defi+future+finance+harvey", download_url: "https://archive.org/search?query=defi+future+finance+harvey", description: "Academic treatment of decentralized finance and its implications.", pages: 208, source: "curated" },
    { title: "Token Economy: How the Web3 reinvents the Internet", author: "Shermin Voshmgir", year: 2020, language: "en", format: "pdf", source_url: "https://github.com/Token-Economy-Book/", download_url: "https://github.com/Token-Economy-Book/", description: "Comprehensive guide to tokens, DAOs, and the token economy. Free/open source book.", pages: 300, source: "curated" },
    { title: "How to DeFi: Beginner", author: "CoinGecko", year: 2021, language: "en", format: "pdf", source_url: "https://landing.coingecko.com/how-to-defi/", download_url: "https://landing.coingecko.com/how-to-defi/", description: "Beginner's guide to DeFi protocols and applications.", pages: 228, source: "curated" },
    { title: "How to DeFi: Advanced", author: "CoinGecko", year: 2021, language: "en", format: "pdf", source_url: "https://landing.coingecko.com/how-to-defi/", download_url: "https://landing.coingecko.com/how-to-defi/", description: "Advanced guide to DeFi strategies and protocols.", pages: 300, source: "curated" },
    { title: "The Infinite Machine: How an Army of Crypto-hackers Is Building the Next Internet with Ethereum", author: "Camila Russo", year: 2020, language: "en", format: "epub", source_url: "https://archive.org/search?query=infinite+machine+russo+ethereum", download_url: "https://archive.org/search?query=infinite+machine+russo+ethereum", description: "The story of Ethereum's creation.", pages: 352, source: "curated" },
    { title: "Layered Money: From Gold and Dollars to Bitcoin and Central Bank Digital Currencies", author: "Nik Bhatia", year: 2021, language: "en", format: "pdf", source_url: "https://archive.org/search?query=layered+money+bhatia", download_url: "https://archive.org/search?query=layered+money+bhatia", description: "Understanding money as a layered system from gold to Bitcoin.", pages: 180, source: "curated" },
    { title: "The Truth Machine: The Blockchain and the Future of Everything", author: "Paul Vigna, Michael J. Casey", year: 2018, language: "en", format: "pdf", source_url: "https://archive.org/search?query=truth+machine+vigna+casey", download_url: "https://archive.org/search?query=truth+machine+vigna+casey", description: "How blockchain can restore personal freedom, support the world's poor, and more.", pages: 320, source: "curated" },
    { title: "Bubble or Revolution: The Present and Future of Blockchain and Cryptocurrencies", author: "Neel Mehta, Aditya Agashe, Parth Detroja", year: 2019, language: "en", format: "pdf", source_url: "https://archive.org/search?query=bubble+revolution+blockchain", download_url: "https://archive.org/search?query=bubble+revolution+blockchain", description: "The real truth about blockchain from tech executives.", pages: 242, source: "curated" },
    { title: "Out of the Ether: The Amazing Story of Ethereum and the $55 Million Heist", author: "Matthew Leising", year: 2020, language: "en", format: "epub", source_url: "https://archive.org/search?query=out+ether+leising+ethereum", download_url: "https://archive.org/search?query=out+ether+leising+ethereum", description: "The story of the DAO hack and its aftermath.", pages: 272, source: "curated" },
    { title: "Kings of Crypto: One Startup's Quest to Take Cryptocurrency Out of Silicon Valley and Onto Wall Street", author: "Jeff John Roberts", year: 2020, language: "en", format: "epub", source_url: "https://archive.org/search?query=kings+crypto+roberts+coinbase", download_url: "https://archive.org/search?query=kings+crypto+roberts+coinbase", description: "The story of Coinbase.", pages: 288, source: "curated" },
    { title: "Attack of the 50 Foot Blockchain", author: "David Gerard", year: 2017, language: "en", format: "pdf", source_url: "https://davidgerard.co.uk/blockchain/book/", download_url: "https://davidgerard.co.uk/blockchain/book/", description: "A skeptical take on Bitcoin, blockchain, and cryptocurrency.", pages: 175, source: "curated" },
    { title: "Hands-On Smart Contract Development with Solidity and Ethereum", author: "Kevin Solorio, Randall Kanna, David H. Hoover", year: 2019, language: "en", format: "pdf", source_url: "https://archive.org/search?query=smart+contract+solidity+ethereum", download_url: "https://archive.org/search?query=smart+contract+solidity+ethereum", description: "Practical guide to Ethereum smart contract development.", pages: 200, source: "curated" },
    { title: "Solana Cookbook", author: "Solana Foundation", year: 2023, language: "en", format: "pdf", source_url: "https://solanacookbook.com/", download_url: "https://solanacookbook.com/", description: "Developer resource for building on Solana.", pages: null, source: "curated" },
    { title: "Ethereum Development with Go", author: "Miguel Mota", year: 2019, language: "en", format: "pdf", source_url: "https://goethereumbook.org/en/", download_url: "https://goethereumbook.org/en/", description: "Free online book for Ethereum development with Go.", pages: null, source: "curated" },
    { title: "Grokking Bitcoin", author: "Kalle Rosenbaum", year: 2019, language: "en", format: "pdf", source_url: "https://archive.org/search?query=grokking+bitcoin+rosenbaum", download_url: "https://archive.org/search?query=grokking+bitcoin+rosenbaum", description: "Illustrated guide to understanding Bitcoin.", pages: 480, source: "curated" },
    { title: "Bitcoin Money: A Tale of Bitville Discovering Good Money", author: "Michael Caras", year: 2019, language: "en", format: "pdf", source_url: "https://archive.org/search?query=bitcoin+money+bitville", download_url: "https://archive.org/search?query=bitcoin+money+bitville", description: "Children's book about Bitcoin.", pages: 32, source: "curated" },
    { title: "Inventing Bitcoin: The Technology Behind the First Truly Scarce and Decentralized Money Explained", author: "Yan Pritzker", year: 2019, language: "en", format: "pdf", source_url: "https://archive.org/search?query=inventing+bitcoin+pritzker", download_url: "https://archive.org/search?query=inventing+bitcoin+pritzker", description: "Accessible explanation of Bitcoin technology.", pages: 115, source: "curated" },
    { title: "Life After Google: The Fall of Big Data and the Rise of the Blockchain Economy", author: "George Gilder", year: 2018, language: "en", format: "epub", source_url: "https://archive.org/search?query=life+after+google+gilder", download_url: "https://archive.org/search?query=life+after+google+gilder", description: "How blockchain challenges Silicon Valley's dominance.", pages: 272, source: "curated" },
    { title: "The Basics of Bitcoins and Blockchains", author: "Antony Lewis", year: 2018, language: "en", format: "pdf", source_url: "https://archive.org/search?query=basics+bitcoins+blockchains+lewis", download_url: "https://archive.org/search?query=basics+bitcoins+blockchains+lewis", description: "Introduction to cryptocurrencies and blockchain technology.", pages: 408, source: "curated" },
    { title: "Blockchain Basics: A Non-Technical Introduction in 25 Steps", author: "Daniel Drescher", year: 2017, language: "en", format: "pdf", source_url: "https://archive.org/search?query=blockchain+basics+drescher", download_url: "https://archive.org/search?query=blockchain+basics+drescher", description: "Step-by-step introduction to blockchain for non-technical readers.", pages: 255, source: "curated" },
    // Trading books
    { title: "Technical Analysis of the Financial Markets", author: "John J. Murphy", year: 1999, language: "en", format: "pdf", source_url: "https://archive.org/search?query=technical+analysis+financial+markets+murphy", download_url: "https://archive.org/search?query=technical+analysis+financial+markets+murphy", description: "The classic guide to technical analysis methods and applications.", pages: 576, source: "curated" },
    { title: "A Random Walk Down Wall Street", author: "Burton G. Malkiel", year: 2019, language: "en", format: "pdf", source_url: "https://archive.org/search?query=random+walk+wall+street+malkiel", download_url: "https://archive.org/search?query=random+walk+wall+street+malkiel", description: "Classic investment book on market efficiency and indexing.", pages: 432, source: "curated" },
    { title: "Flash Boys: A Wall Street Revolt", author: "Michael Lewis", year: 2014, language: "en", format: "epub", source_url: "https://archive.org/search?query=flash+boys+michael+lewis", download_url: "https://archive.org/search?query=flash+boys+michael+lewis", description: "High-frequency trading and Wall Street.", pages: 288, source: "curated" },
    { title: "Trading and Exchanges: Market Microstructure for Practitioners", author: "Larry Harris", year: 2003, language: "en", format: "pdf", source_url: "https://archive.org/search?query=trading+exchanges+harris+microstructure", download_url: "https://archive.org/search?query=trading+exchanges+harris+microstructure", description: "Comprehensive guide to market microstructure.", pages: 643, source: "curated" },
    { title: "Quantitative Trading: How to Build Your Own Algorithmic Trading Business", author: "Ernest P. Chan", year: 2021, language: "en", format: "pdf", source_url: "https://archive.org/search?query=quantitative+trading+ernest+chan", download_url: "https://archive.org/search?query=quantitative+trading+ernest+chan", description: "Guide to building algorithmic trading systems.", pages: 394, source: "curated" },
    { title: "The Intelligent Investor", author: "Benjamin Graham", year: 2006, language: "en", format: "pdf", source_url: "https://archive.org/search?query=intelligent+investor+graham", download_url: "https://archive.org/search?query=intelligent+investor+graham", description: "The definitive book on value investing.", pages: 640, source: "curated" },
    { title: "Market Wizards", author: "Jack D. Schwager", year: 2012, language: "en", format: "pdf", source_url: "https://archive.org/search?query=market+wizards+schwager", download_url: "https://archive.org/search?query=market+wizards+schwager", description: "Interviews with top traders.", pages: 480, source: "curated" },
    // Chinese crypto books
    { title: "区块链：从数字货币到信用社会", author: "长铗, 韩锋", year: 2016, language: "zh", format: "pdf", source_url: "https://archive.org/search?query=区块链+数字货币+信用社会", download_url: "https://archive.org/search?query=区块链+数字货币+信用社会", description: "从数字货币的历史谈起，全面介绍区块链技术。", pages: 320, source: "curated" },
    { title: "比特币：一个虚幻而真实的金融世界", author: "李钧, 长铗", year: 2014, language: "zh", format: "pdf", source_url: "https://archive.org/search?query=比特币+虚幻+真实+金融世界", download_url: "https://archive.org/search?query=比特币+虚幻+真实+金融世界", description: "中国最早期的比特币科普书籍之一。", pages: 256, source: "curated" },
    { title: "图说区块链", author: "徐明星, 田颖, 李霁月", year: 2017, language: "zh", format: "pdf", source_url: "https://archive.org/search?query=图说区块链", download_url: "https://archive.org/search?query=图说区块链", description: "用图解方式讲解区块链技术原理与应用。", pages: 240, source: "curated" },
    { title: "区块链革命：比特币底层技术如何改变货币、商业和世界", author: "唐塔普斯科特", year: 2016, language: "zh", format: "pdf", source_url: "https://archive.org/search?query=区块链革命+比特币", download_url: "https://archive.org/search?query=区块链革命+比特币", description: "Blockchain Revolution中文版。", pages: 368, source: "curated" },
    { title: "数字黄金：比特币鲜为人知的故事", author: "纳撒尼尔·波普尔", year: 2017, language: "zh", format: "pdf", source_url: "https://archive.org/search?query=数字黄金+比特币", download_url: "https://archive.org/search?query=数字黄金+比特币", description: "Digital Gold中文版，讲述比特币的起源故事。", pages: 350, source: "curated" },
    { title: "精通比特币", author: "Andreas M. Antonopoulos", year: 2018, language: "zh", format: "pdf", source_url: "https://github.com/tianmingyun/MasterBitcoin2CN", download_url: "https://github.com/tianmingyun/MasterBitcoin2CN", description: "Mastering Bitcoin中文翻译版。", pages: 400, source: "curated" },
    { title: "精通以太坊", author: "Andreas M. Antonopoulos, Gavin Wood", year: 2019, language: "zh", format: "pdf", source_url: "https://github.com/inoutcode/ethereum_book", download_url: "https://github.com/inoutcode/ethereum_book", description: "Mastering Ethereum中文翻译版。", pages: 400, source: "curated" },
    { title: "白话区块链", author: "蒋勇, 文延, 嘉文", year: 2017, language: "zh", format: "pdf", source_url: "https://archive.org/search?query=白话区块链", download_url: "https://archive.org/search?query=白话区块链", description: "用通俗易懂的语言介绍区块链技术。", pages: 280, source: "curated" },
    { title: "区块链技术驱动金融", author: "阿尔文德·纳拉亚南", year: 2016, language: "zh", format: "pdf", source_url: "https://archive.org/search?query=区块链技术驱动金融", download_url: "https://archive.org/search?query=区块链技术驱动金融", description: "Bitcoin and Cryptocurrency Technologies中文版。", pages: 350, source: "curated" },
    { title: "加密货币投资指南", author: "王博", year: 2021, language: "zh", format: "pdf", source_url: "https://archive.org/search?query=加密货币+投资指南", download_url: "https://archive.org/search?query=加密货币+投资指南", description: "加密货币投资入门与策略。", pages: null, source: "curated" },
    // More recent books
    { title: "The Cryptopians: Idealism, Greed, Lies, and the Making of the First Big Cryptocurrency Craze", author: "Laura Shin", year: 2022, language: "en", format: "epub", source_url: "https://archive.org/search?query=cryptopians+laura+shin", download_url: "https://archive.org/search?query=cryptopians+laura+shin", description: "The riveting story behind the rise of Ethereum.", pages: 496, source: "curated" },
    { title: "Read Write Own: Building the Next Era of the Internet", author: "Chris Dixon", year: 2024, language: "en", format: "epub", source_url: "https://archive.org/search?query=read+write+own+chris+dixon", download_url: "https://archive.org/search?query=read+write+own+chris+dixon", description: "a16z partner on blockchain networks and the future of the internet.", pages: 320, source: "curated" },
    { title: "Number Go Up: Inside Crypto's Wild Rise and Staggering Fall", author: "Zeke Faux", year: 2023, language: "en", format: "epub", source_url: "https://archive.org/search?query=number+go+up+zeke+faux", download_url: "https://archive.org/search?query=number+go+up+zeke+faux", description: "Investigation into the crypto world's excesses.", pages: 304, source: "curated" },
    { title: "Going Infinite: The Rise and Fall of a New Tycoon", author: "Michael Lewis", year: 2023, language: "en", format: "epub", source_url: "https://archive.org/search?query=going+infinite+michael+lewis+sbf", download_url: "https://archive.org/search?query=going+infinite+michael+lewis+sbf", description: "The story of Sam Bankman-Fried and FTX.", pages: 272, source: "curated" },
    { title: "Easy Money: Cryptocurrency, Casino Capitalism, and the Golden Age of Fraud", author: "Ben McKenzie, Jacob Silverman", year: 2023, language: "en", format: "epub", source_url: "https://archive.org/search?query=easy+money+cryptocurrency+mckenzie", download_url: "https://archive.org/search?query=easy+money+cryptocurrency+mckenzie", description: "A critical look at the crypto industry.", pages: 320, source: "curated" },
    { title: "Proof of Stake: The Making of Ethereum and the Philosophy of Blockchains", author: "Vitalik Buterin", year: 2022, language: "en", format: "epub", source_url: "https://archive.org/search?query=proof+stake+vitalik+buterin", download_url: "https://archive.org/search?query=proof+stake+vitalik+buterin", description: "Collection of Vitalik Buterin's writings.", pages: 400, source: "curated" },
    { title: "Web3: Charting the Internet's Next Economic and Cultural Frontier", author: "Alex Tapscott", year: 2023, language: "en", format: "epub", source_url: "https://archive.org/search?query=web3+tapscott+frontier", download_url: "https://archive.org/search?query=web3+tapscott+frontier", description: "How Web3 will transform industries.", pages: 400, source: "curated" },
    { title: "Broken Money: Why Our Financial System is Failing Us", author: "Lyn Alden", year: 2023, language: "en", format: "epub", source_url: "https://archive.org/search?query=broken+money+lyn+alden", download_url: "https://archive.org/search?query=broken+money+lyn+alden", description: "History and future of money, including Bitcoin.", pages: 536, source: "curated" },
    { title: "Tracers in the Dark: The Global Hunt for the Crime Lords of Cryptocurrency", author: "Andy Greenberg", year: 2022, language: "en", format: "epub", source_url: "https://archive.org/search?query=tracers+dark+greenberg+cryptocurrency", download_url: "https://archive.org/search?query=tracers+dark+greenberg+cryptocurrency", description: "How cryptocurrency tracing caught criminals.", pages: 400, source: "curated" },
    { title: "The Promise of Bitcoin", author: "Bobby C. Lee", year: 2021, language: "en", format: "pdf", source_url: "https://archive.org/search?query=promise+bitcoin+bobby+lee", download_url: "https://archive.org/search?query=promise+bitcoin+bobby+lee", description: "The future of Bitcoin by the co-founder of BTCC.", pages: 256, source: "curated" },
    // DeFi / NFT specific
    { title: "The NFT Handbook", author: "Matt Fortnow, QuHarrison Terry", year: 2021, language: "en", format: "pdf", source_url: "https://archive.org/search?query=nft+handbook+fortnow", download_url: "https://archive.org/search?query=nft+handbook+fortnow", description: "Guide to creating, selling, and buying NFTs.", pages: 240, source: "curated" },
    { title: "Mastering Blockchain: A deep dive into distributed ledgers, consensus protocols, smart contracts, DApps, cryptocurrencies, Ethereum, and more", author: "Imran Bashir", year: 2020, language: "en", format: "pdf", source_url: "https://archive.org/search?query=mastering+blockchain+bashir", download_url: "https://archive.org/search?query=mastering+blockchain+bashir", description: "Comprehensive blockchain technical reference.", pages: 756, source: "curated" },
    { title: "Building Ethereum DApps", author: "Roberto Infante", year: 2019, language: "en", format: "pdf", source_url: "https://archive.org/search?query=building+ethereum+dapps+infante", download_url: "https://archive.org/search?query=building+ethereum+dapps+infante", description: "Practical guide to building decentralized applications.", pages: 502, source: "curated" },
    { title: "Solidity Programming Essentials", author: "Ritesh Modi", year: 2022, language: "en", format: "pdf", source_url: "https://archive.org/search?query=solidity+programming+essentials+modi", download_url: "https://archive.org/search?query=solidity+programming+essentials+modi", description: "Learn Solidity for Ethereum smart contracts.", pages: 250, source: "curated" },
  ];
}

// ─── Main ───
async function main() {
  console.log('=== Collecting Free Crypto/Trading/Investment Books ===\n');
  
  const allBooks = new Map(); // title_lower -> book (dedup)
  
  // 1. Add curated books first
  console.log('Adding curated must-read books...');
  const curated = getCuratedBooks();
  for (const book of curated) {
    const key = book.title.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]/g, '');
    allBooks.set(key, { ...book, cover_url: book.cover_url || null, description: book.description || '' });
  }
  console.log(`  Added ${curated.length} curated books\n`);

  // 2. Anna's Archive - skip (blocks automated requests)
  console.log('Skipping Anna\'s Archive (blocks automated requests)\n');

  // 3. Search LibGen
  console.log('Searching LibGen...');
  const libgenQueries = ['cryptocurrency', 'bitcoin blockchain', 'ethereum smart contracts', 
    'defi decentralized', 'trading strategies crypto', 'blockchain technology',
    'technical analysis', 'algorithmic trading', 'web3', 'digital currency',
    'NFT tokens', 'crypto mining', 'solana', 'tokenomics'];
  for (const query of libgenQueries) {
    const books = await searchLibgen(query);
    for (const book of books) {
      const key = book.title.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]/g, '');
      if (!allBooks.has(key)) allBooks.set(key, book);
    }
    await sleep(3000);
  }
  console.log(`  Total so far: ${allBooks.size}\n`);

  // 4. Search LibGen for classic books
  console.log('Searching LibGen for classic titles...');
  for (const title of CLASSIC_BOOKS.slice(0, 10)) {
    const books = await searchLibgen(title);
    for (const book of books) {
      const key = book.title.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]/g, '');
      if (!allBooks.has(key)) allBooks.set(key, book);
    }
    await sleep(2000);
  }

  // Convert to array
  const result = Array.from(allBooks.values());
  
  // Save
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(result, null, 2));
  
  console.log(`\n=== RESULTS ===`);
  console.log(`Total books collected: ${result.length}`);
  console.log(`  Curated: ${result.filter(b => b.source === 'curated').length}`);
  console.log(`  Anna's Archive: ${result.filter(b => b.source === 'annas_archive').length}`);
  console.log(`  LibGen: ${result.filter(b => b.source === 'libgen').length}`);
  console.log(`  English: ${result.filter(b => b.language === 'en').length}`);
  console.log(`  Chinese: ${result.filter(b => b.language === 'zh').length}`);
  console.log(`\nSaved to: ${OUTPUT_FILE}`);
}

main().catch(console.error);
