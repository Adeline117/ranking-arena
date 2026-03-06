#!/usr/bin/env node
/**
 * Import curated crypto/trading/blockchain book metadata into library_items.
 * Sources: Open Library, Anna's Archive, LibGen (metadata only).
 * Since direct scraping of Anna's Archive / LibGen failed (DNS unreachable),
 * this uses a curated list of well-known books with Open Library metadata.
 */

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = 'https://iknktzifjdyujdccyhsv.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// Curated list of crypto, blockchain, trading, and DeFi books
const BOOKS = [
  // === BITCOIN & CRYPTOCURRENCY FUNDAMENTALS ===
  { title: "Mastering Bitcoin: Programming the Open Blockchain", author: "Andreas M. Antonopoulos", year: 2017, subcategory: "development", olid: "OL26883524M" },
  { title: "The Bitcoin Standard: The Decentralized Alternative to Central Banking", author: "Saifedean Ammous", year: 2018, subcategory: "cryptocurrency", olid: "OL27342753M" },
  { title: "Bitcoin: A Peer-to-Peer Electronic Cash System", author: "Satoshi Nakamoto", year: 2008, subcategory: "cryptocurrency" },
  { title: "Digital Gold: Bitcoin and the Inside Story of the Misfits and Millionaires Trying to Reinvent Money", author: "Nathaniel Popper", year: 2015, subcategory: "cryptocurrency", olid: "OL26418532M" },
  { title: "The Age of Cryptocurrency: How Bitcoin and Digital Money Are Challenging the Global Economic Order", author: "Paul Vigna, Michael J. Casey", year: 2015, subcategory: "cryptocurrency" },
  { title: "Cryptoassets: The Innovative Investor's Guide to Bitcoin and Beyond", author: "Chris Burniske, Jack Tatar", year: 2017, subcategory: "investing" },
  { title: "Bitcoin and Cryptocurrency Technologies: A Comprehensive Introduction", author: "Arvind Narayanan, Joseph Bonneau, Edward Felten, Andrew Miller, Steven Goldfeder", year: 2016, subcategory: "cryptocurrency" },
  { title: "The Internet of Money", author: "Andreas M. Antonopoulos", year: 2016, subcategory: "cryptocurrency" },
  { title: "The Internet of Money Volume Two", author: "Andreas M. Antonopoulos", year: 2017, subcategory: "cryptocurrency" },
  { title: "The Internet of Money Volume Three", author: "Andreas M. Antonopoulos", year: 2019, subcategory: "cryptocurrency" },
  { title: "Programming Bitcoin: Learn How to Program Bitcoin from Scratch", author: "Jimmy Song", year: 2019, subcategory: "development" },
  { title: "Inventing Bitcoin: The Technology Behind the First Truly Scarce and Decentralized Money", author: "Yan Pritzker", year: 2019, subcategory: "cryptocurrency" },
  { title: "The Book of Satoshi: The Collected Writings of Bitcoin Creator Satoshi Nakamoto", author: "Phil Champagne", year: 2014, subcategory: "cryptocurrency" },
  { title: "Bitcoin Billionaires: A True Story of Genius, Betrayal, and Redemption", author: "Ben Mezrich", year: 2019, subcategory: "cryptocurrency" },
  { title: "Bitcoin Money: A Tale of Bitville Discovering Good Money", author: "Michael Caras", year: 2019, subcategory: "cryptocurrency" },
  { title: "The Little Bitcoin Book: Why Bitcoin Matters for Your Freedom, Finances, and Future", author: "Bitcoin Collective", year: 2019, subcategory: "cryptocurrency" },
  { title: "21 Lessons: What I've Learned from Falling Down the Bitcoin Rabbit Hole", author: "Gigi", year: 2019, subcategory: "cryptocurrency" },
  { title: "Layered Money: From Gold and Dollars to Bitcoin and Central Bank Digital Currencies", author: "Nik Bhatia", year: 2021, subcategory: "cryptocurrency" },
  { title: "Thank God for Bitcoin: The Creation, Corruption, and Redemption of Money", author: "Jimmy Song, Robert Breedlove", year: 2020, subcategory: "cryptocurrency" },
  { title: "Bitcoin: Hard Money You Can't F*ck With", author: "Jason A. Williams", year: 2020, subcategory: "cryptocurrency" },

  // === ETHEREUM & SMART CONTRACTS ===
  { title: "Mastering Ethereum: Building Smart Contracts and DApps", author: "Andreas M. Antonopoulos, Gavin Wood", year: 2018, subcategory: "development", olid: "OL27931843M" },
  { title: "Ethereum: Blockchains, Digital Assets, Smart Contracts, Decentralized Autonomous Organizations", author: "Henning Diedrich", year: 2016, subcategory: "development" },
  { title: "Hands-On Smart Contract Development with Solidity and Ethereum", author: "Kevin Solorio, Randall Kanna, David H. Hoover", year: 2019, subcategory: "development" },
  { title: "Building Ethereum DApps: Decentralized Applications on the Ethereum Blockchain", author: "Roberto Infante", year: 2019, subcategory: "development" },
  { title: "Solidity Programming Essentials", author: "Ritesh Modi", year: 2018, subcategory: "development" },
  { title: "The Infinite Machine: How an Army of Crypto-hackers Is Building the Next Internet with Ethereum", author: "Camila Russo", year: 2020, subcategory: "cryptocurrency" },
  { title: "Out of the Ether: The Amazing Story of Ethereum and the $55 Million Heist that Almost Destroyed It All", author: "Matthew Leising", year: 2020, subcategory: "cryptocurrency" },

  // === BLOCKCHAIN TECHNOLOGY ===
  { title: "Blockchain Basics: A Non-Technical Introduction in 25 Steps", author: "Daniel Drescher", year: 2017, subcategory: "cryptocurrency" },
  { title: "Blockchain Revolution: How the Technology Behind Bitcoin Is Changing Money, Business, and the World", author: "Don Tapscott, Alex Tapscott", year: 2016, subcategory: "cryptocurrency" },
  { title: "Blockchain: Blueprint for a New Economy", author: "Melanie Swan", year: 2015, subcategory: "cryptocurrency" },
  { title: "The Truth Machine: The Blockchain and the Future of Everything", author: "Paul Vigna, Michael J. Casey", year: 2018, subcategory: "cryptocurrency" },
  { title: "The Basics of Bitcoins and Blockchains", author: "Antony Lewis", year: 2018, subcategory: "cryptocurrency" },
  { title: "Mastering Blockchain: Distributed Ledger Technology, Decentralization, and Smart Contracts Explained", author: "Imran Bashir", year: 2018, subcategory: "development" },
  { title: "Blockchain for Dummies", author: "Tiana Laurence", year: 2019, subcategory: "cryptocurrency" },
  { title: "Attack of the 50 Foot Blockchain", author: "David Gerard", year: 2017, subcategory: "cryptocurrency" },
  { title: "Life After Google: The Fall of Big Data and the Rise of the Blockchain Economy", author: "George Gilder", year: 2018, subcategory: "cryptocurrency" },

  // === DEFI & WEB3 ===
  { title: "How to DeFi: Beginner", author: "CoinGecko", year: 2020, subcategory: "defi" },
  { title: "How to DeFi: Advanced", author: "CoinGecko", year: 2021, subcategory: "defi" },
  { title: "The Defiant: DeFi Explained", author: "Camila Russo", year: 2021, subcategory: "defi" },
  { title: "DeFi and the Future of Finance", author: "Campbell R. Harvey, Ashwin Ramachandran, Joey Santoro", year: 2021, subcategory: "defi" },
  { title: "Token Economy: How the Web3 Reinvents the Internet", author: "Shermin Voshmgir", year: 2020, subcategory: "defi" },
  { title: "The Spatial Web: How Web 3.0 Will Connect Humans, Machines, and AI to Transform the World", author: "Gabriel René, Dan Mapes", year: 2019, subcategory: "defi" },
  { title: "Web3: Charting the Internet's Next Economic and Cultural Frontier", author: "Alex Tapscott", year: 2023, subcategory: "defi" },

  // === NFTs & METAVERSE ===
  { title: "The NFT Handbook: How to Create, Sell and Buy Non-Fungible Tokens", author: "Matt Fortnow, QuHarrison Terry", year: 2021, subcategory: "nft" },
  { title: "NFTs Are a Scam / NFTs Are the Future", author: "Bobby Hundreds", year: 2023, subcategory: "nft" },

  // === CRYPTO TRADING ===
  { title: "Cryptocurrency Trading & Investing: Beginners Guide To Trading & Investing In Bitcoin, Alt Coins & ICOs", author: "Aimee Vo", year: 2017, subcategory: "trading" },
  { title: "A Beginner's Guide To Day Trading Online", author: "Toni Turner", year: 2007, subcategory: "trading" },
  { title: "Crypto Trading 101: Buy Sell Trade Cryptocurrency for Profit", author: "Alan T. Norman", year: 2018, subcategory: "trading" },
  { title: "The Crypto Trader: How Anyone Can Make Money Trading Bitcoin and Other Cryptocurrencies", author: "Glen Goodman", year: 2019, subcategory: "trading" },
  { title: "Trading Cryptocurrencies: A Beginner's Guide", author: "Clem Chambers", year: 2018, subcategory: "trading" },

  // === TECHNICAL ANALYSIS ===
  { title: "Technical Analysis of the Financial Markets", author: "John J. Murphy", year: 1999, subcategory: "trading" },
  { title: "Japanese Candlestick Charting Techniques", author: "Steve Nison", year: 2001, subcategory: "trading" },
  { title: "Encyclopedia of Chart Patterns", author: "Thomas N. Bulkowski", year: 2021, subcategory: "trading" },
  { title: "Technical Analysis Explained", author: "Martin J. Pring", year: 2014, subcategory: "trading" },
  { title: "Trading in the Zone: Master the Market with Confidence, Discipline, and a Winning Attitude", author: "Mark Douglas", year: 2000, subcategory: "trading" },
  { title: "Market Wizards: Interviews with Top Traders", author: "Jack D. Schwager", year: 1989, subcategory: "trading" },
  { title: "The New Market Wizards: Conversations with America's Top Traders", author: "Jack D. Schwager", year: 1992, subcategory: "trading" },
  { title: "Reminiscences of a Stock Operator", author: "Edwin Lefèvre", year: 1923, subcategory: "trading" },
  { title: "A Complete Guide to Volume Price Analysis", author: "Anna Coulling", year: 2013, subcategory: "trading" },
  { title: "How to Day Trade for a Living", author: "Andrew Aziz", year: 2016, subcategory: "trading" },
  { title: "The Disciplined Trader: Developing Winning Attitudes", author: "Mark Douglas", year: 1990, subcategory: "trading" },

  // === QUANTITATIVE & ALGORITHMIC TRADING ===
  { title: "Quantitative Trading: How to Build Your Own Algorithmic Trading Business", author: "Ernest P. Chan", year: 2008, subcategory: "trading" },
  { title: "Algorithmic Trading: Winning Strategies and Their Rationale", author: "Ernest P. Chan", year: 2013, subcategory: "trading" },
  { title: "Machine Trading: Deploying Computer Algorithms to Conquer the Markets", author: "Ernest P. Chan", year: 2017, subcategory: "trading" },
  { title: "Advances in Financial Machine Learning", author: "Marcos López de Prado", year: 2018, subcategory: "trading" },
  { title: "Machine Learning for Algorithmic Trading", author: "Stefan Jansen", year: 2020, subcategory: "trading" },
  { title: "Python for Finance: Mastering Data-Driven Finance", author: "Yves Hilpisch", year: 2018, subcategory: "trading" },
  { title: "Trading and Exchanges: Market Microstructure for Practitioners", author: "Larry Harris", year: 2003, subcategory: "trading" },
  { title: "Algorithmic Trading and DMA: An Introduction to Direct Access Trading Strategies", author: "Barry Johnson", year: 2010, subcategory: "trading" },
  { title: "Inside the Black Box: A Simple Guide to Quantitative and High Frequency Trading", author: "Rishi K. Narang", year: 2013, subcategory: "trading" },
  { title: "Building Winning Algorithmic Trading Systems", author: "Kevin J. Davey", year: 2014, subcategory: "trading" },

  // === INVESTING & ECONOMICS ===
  { title: "The Intelligent Investor", author: "Benjamin Graham", year: 1949, subcategory: "investing" },
  { title: "A Random Walk Down Wall Street", author: "Burton G. Malkiel", year: 1973, subcategory: "investing" },
  { title: "The Black Swan: The Impact of the Highly Improbable", author: "Nassim Nicholas Taleb", year: 2007, subcategory: "investing" },
  { title: "Antifragile: Things That Gain from Disorder", author: "Nassim Nicholas Taleb", year: 2012, subcategory: "investing" },
  { title: "Skin in the Game: Hidden Asymmetries in Daily Life", author: "Nassim Nicholas Taleb", year: 2018, subcategory: "investing" },
  { title: "The Sovereign Individual: Mastering the Transition to the Information Age", author: "James Dale Davidson, Lord William Rees-Mogg", year: 1997, subcategory: "cryptocurrency" },
  { title: "When Money Dies: The Nightmare of Deficit Spending, Devaluation, and Hyperinflation", author: "Adam Fergusson", year: 1975, subcategory: "investing" },
  { title: "The Price of Tomorrow: Why Deflation is the Key to an Abundant Future", author: "Jeff Booth", year: 2020, subcategory: "investing" },
  { title: "Broken Money: Why Our Financial System Is Failing Us and How We Can Make It Better", author: "Lyn Alden", year: 2023, subcategory: "investing" },
  { title: "The Fiat Standard: The Debt Slavery Alternative to Human Civilization", author: "Saifedean Ammous", year: 2021, subcategory: "cryptocurrency" },

  // === CRYPTO SECURITY & PRIVACY ===
  { title: "Mastering Monero: The Future of Private Transactions", author: "SerHack", year: 2018, subcategory: "cryptocurrency" },
  { title: "Cryptography Engineering: Design Principles and Practical Applications", author: "Niels Ferguson, Bruce Schneier, Tadayoshi Kohno", year: 2010, subcategory: "development" },
  { title: "Applied Cryptography: Protocols, Algorithms, and Source Code in C", author: "Bruce Schneier", year: 1996, subcategory: "development" },

  // === CRYPTO CULTURE & HISTORY ===
  { title: "Kings of Crypto: One Startup's Quest to Take Cryptocurrency Out of Silicon Valley and Onto Wall Street", author: "Jeff John Roberts", year: 2020, subcategory: "cryptocurrency" },
  { title: "The Billionaire's Apprentice: The Rise of The Indian-American Elite and The Fall of The Galleon Hedge Fund", author: "Anita Raghavan", year: 2013, subcategory: "investing" },
  { title: "Number Go Up: Inside Crypto's Wild Rise and Staggering Fall", author: "Zeke Faux", year: 2023, subcategory: "cryptocurrency" },
  { title: "Easy Money: Cryptocurrency, Casino Capitalism, and the Golden Age of Fraud", author: "Ben McKenzie, Jacob Silverman", year: 2023, subcategory: "cryptocurrency" },
  { title: "Going Infinite: The Rise and Fall of a New Tycoon", author: "Michael Lewis", year: 2023, subcategory: "cryptocurrency" },

  // === MORE TRADING CLASSICS ===
  { title: "Flash Boys: A Wall Street Revolt", author: "Michael Lewis", year: 2014, subcategory: "trading" },
  { title: "Liar's Poker: Rising Through the Wreckage on Wall Street", author: "Michael Lewis", year: 1989, subcategory: "trading" },
  { title: "The Big Short: Inside the Doomsday Machine", author: "Michael Lewis", year: 2010, subcategory: "trading" },
  { title: "When Genius Failed: The Rise and Fall of Long-Term Capital Management", author: "Roger Lowenstein", year: 2000, subcategory: "trading" },
  { title: "Fooled by Randomness: The Hidden Role of Chance in Life and in the Markets", author: "Nassim Nicholas Taleb", year: 2001, subcategory: "trading" },
  { title: "The Man Who Solved the Market: How Jim Simons Launched the Quant Revolution", author: "Gregory Zuckerman", year: 2019, subcategory: "trading" },
  { title: "Dark Pools: The Rise of the Machine Traders and the Rigging of the U.S. Stock Market", author: "Scott Patterson", year: 2012, subcategory: "trading" },
  { title: "More Money Than God: Hedge Funds and the Making of a New Elite", author: "Sebastian Mallaby", year: 2010, subcategory: "trading" },

  // === BLOCKCHAIN DEVELOPMENT ===
  { title: "Blockchain in Action", author: "Bina Ramamurthy", year: 2020, subcategory: "development" },
  { title: "Building Blockchain Projects", author: "Narayan Prusty", year: 2017, subcategory: "development" },
  { title: "Introducing Ethereum and Solidity: Foundations of Cryptocurrency and Blockchain Programming for Beginners", author: "Chris Dannen", year: 2017, subcategory: "development" },
  { title: "Hands-On Blockchain with Hyperledger", author: "Nitin Gaur, Luc Desrosiers, Venkatraman Ramakrishna, Petr Novotny, Salman A. Baset, Anthony O'Dowd", year: 2018, subcategory: "development" },

  // === CHINESE CRYPTO/TRADING BOOKS ===
  { title: "区块链：从数字货币到信用社会", author: "长铗, 韩锋", year: 2016, subcategory: "cryptocurrency", language: "zh" },
  { title: "区块链技术驱动金融", author: "Arvind Narayanan", year: 2016, subcategory: "cryptocurrency", language: "zh" },
  { title: "数字货币：比特币数据报告与操作指南", author: "李钧, 长铗", year: 2014, subcategory: "cryptocurrency", language: "zh" },
  { title: "比特币：一个虚幻而真实的金融世界", author: "李钧, 长铗, 宋欢平", year: 2014, subcategory: "cryptocurrency", language: "zh" },
  { title: "加密资产：数字资产创新投资指南", author: "Chris Burniske, Jack Tatar", year: 2018, subcategory: "investing", language: "zh" },
  { title: "区块链革命：比特币底层技术如何改变货币、商业和世界", author: "Don Tapscott, Alex Tapscott", year: 2016, subcategory: "cryptocurrency", language: "zh" },
  { title: "精通比特币", author: "Andreas M. Antonopoulos", year: 2017, subcategory: "development", language: "zh" },
  { title: "图说区块链", author: "徐明星, 田颖, 李霁月", year: 2017, subcategory: "cryptocurrency", language: "zh" },
  { title: "量化投资：策略与技术", author: "丁鹏", year: 2014, subcategory: "trading", language: "zh" },
  { title: "日本蜡烛图技术", author: "Steve Nison", year: 2003, subcategory: "trading", language: "zh" },

  // === MORE CRYPTO BOOKS TO REACH 120+ ===
  { title: "Bubble or Revolution? The Present and Future of Blockchain and Cryptocurrencies", author: "Neel Mehta, Aditya Agashe, Parth Detroja", year: 2019, subcategory: "cryptocurrency" },
  { title: "Blockchain Bubble or Revolution: The Future of Bitcoin, Blockchains, and Cryptocurrencies", author: "Neel Mehta", year: 2019, subcategory: "cryptocurrency" },
  { title: "The Promise of Bitcoin: The Future of Money and How It Can Work for You", author: "Bobby C. Lee", year: 2021, subcategory: "cryptocurrency" },
  { title: "Bitcoin: Everything You Need to Know about Bitcoin", author: "Mark Bresett", year: 2017, subcategory: "cryptocurrency" },
  { title: "Crypto Economy: How Blockchain, Cryptocurrency, and Token-Economy Are Disrupting the Financial World", author: "Aries Wanlin Wang", year: 2018, subcategory: "cryptocurrency" },
  { title: "Decrypted: The Ultimate Playbook for Scaling a Web3 Brand", author: "Jeff Kauffman", year: 2023, subcategory: "defi" },
  { title: "Read Write Own: Building the Next Era of the Internet", author: "Chris Dixon", year: 2024, subcategory: "defi" },
  { title: "The Blocksize War: The Battle Over Who Controls Bitcoin's Protocol Rules", author: "Jonathan Bier", year: 2021, subcategory: "cryptocurrency" },
  { title: "Resistance Money: A Philosophical Case for Bitcoin", author: "Andrew M. Bailey, Bradley Rettler, Craig Warmke", year: 2024, subcategory: "cryptocurrency" },
  { title: "Check Your Financial Privilege: Inside the Global Bitcoin Movement", author: "Alex Gladstein", year: 2022, subcategory: "cryptocurrency" },
  { title: "Softwar: A Novel Theory on Power Projection and the National Strategic Significance of Bitcoin", author: "Jason Paul Lowery", year: 2023, subcategory: "cryptocurrency" },
  { title: "Bitcoin Clarity: The Complete Beginners Guide to Understanding", author: "Kiara Bickers", year: 2020, subcategory: "cryptocurrency" },
  { title: "Gradually, Then Suddenly: A Framework for Understanding Bitcoin", author: "Parker Lewis", year: 2024, subcategory: "cryptocurrency" },
];

function categorize(book) {
  const t = (book.title + ' ' + (book.author || '')).toLowerCase();
  const tags = [];
  if (/bitcoin/i.test(t)) tags.push('bitcoin');
  if (/ethereum|solidity/i.test(t)) tags.push('ethereum');
  if (/defi|decentralized finance/i.test(t)) tags.push('defi');
  if (/nft|non.?fungible/i.test(t)) tags.push('nft');
  if (/web3/i.test(t)) tags.push('web3');
  if (/trading|trader/i.test(t)) tags.push('trading');
  if (/technical analysis|candlestick|chart/i.test(t)) tags.push('technical-analysis');
  if (/blockchain/i.test(t)) tags.push('blockchain');
  if (/smart contract|solidity/i.test(t)) tags.push('smart-contracts');
  if (/invest/i.test(t)) tags.push('investing');
  if (/crypto|加密/i.test(t)) tags.push('cryptocurrency');
  if (/algorith|quantitative|quant|量化/i.test(t)) tags.push('algorithmic-trading');
  if (/区块链/i.test(t)) tags.push('blockchain');
  if (/比特币/i.test(t)) tags.push('bitcoin');
  if (tags.length === 0) tags.push('cryptocurrency');
  return [...new Set(tags)];
}

function openLibraryCover(olid) {
  if (!olid) return null;
  return `https://covers.openlibrary.org/b/olid/${olid}-L.jpg`;
}

function openLibraryUrl(title) {
  return `https://openlibrary.org/search?q=${encodeURIComponent(title)}`;
}

async function main() {
  console.log(`=== Importing ${BOOKS.length} curated books ===\n`);

  // Check existing titles to avoid duplicates
  const { data: existing } = await supabase
    .from('library_items')
    .select('title')
    .eq('category', 'book')
    .limit(5000);

  const existingTitles = new Set((existing || []).map(e => e.title?.toLowerCase().trim()));
  console.log(`Found ${existingTitles.size} existing book titles\n`);

  const toInsert = [];
  let skipped = 0;

  for (const book of BOOKS) {
    const titleLower = book.title.toLowerCase().trim();
    if (existingTitles.has(titleLower)) {
      skipped++;
      continue;
    }

    const tags = categorize(book);
    toInsert.push({
      title: book.title,
      author: book.author,
      description: `${book.title} by ${book.author} (${book.year})`,
      category: 'book',
      subcategory: book.subcategory || 'cryptocurrency',
      source: 'curated',
      source_url: openLibraryUrl(book.title),
      cover_url: openLibraryCover(book.olid),
      language: book.language || 'en',
      tags,
      publish_date: book.year ? `${book.year}-01-01` : null,
      is_free: true,
      rating: null,
      rating_count: 0,
      view_count: 0,
      download_count: 0,
    });
  }

  console.log(`Skipped ${skipped} duplicates, inserting ${toInsert.length} new books\n`);

  if (toInsert.length === 0) {
    console.log('Nothing to insert!');
    return;
  }

  let inserted = 0, errors = 0;
  const BATCH = 25;

  for (let i = 0; i < toInsert.length; i += BATCH) {
    const batch = toInsert.slice(i, i + BATCH);
    const { error } = await supabase.from('library_items').insert(batch);
    if (error) {
      // Try one-by-one
      for (const row of batch) {
        const { error: e2 } = await supabase.from('library_items').insert(row);
        if (e2) {
          console.error(`  Error inserting "${row.title}": ${e2.message}`);
          errors++;
        } else {
          inserted++;
        }
      }
    } else {
      inserted += batch.length;
    }
    process.stdout.write(`\r  Progress: ${Math.min(i + BATCH, toInsert.length)}/${toInsert.length}`);
  }

  console.log(`\n\n=== COMPLETE ===`);
  console.log(`  Inserted: ${inserted}`);
  console.log(`  Skipped (duplicates): ${skipped}`);
  console.log(`  Errors: ${errors}`);
}

main().catch(console.error);
