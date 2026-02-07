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

// Also try English keywords that often have Chinese editions
const enKeywords = [
  'cryptocurrency','blockchain','bitcoin','ethereum','trading',
  'technical analysis','quantitative trading','algorithmic trading',
  'futures trading','forex','stock investing','value investing',
  'risk management','portfolio','derivatives','behavioral finance',
  'digital currency','smart contract','financial engineering','hedge fund'
];

function categorize(kw) {
  const crypto = ['加密货币','区块链技术','比特币','以太坊','数字货币','Web3','NFT','智能合约','DeFi','去中心化金融','cryptocurrency','blockchain','bitcoin','ethereum','digital currency','smart contract'];
  const trading = ['技术分析','量化交易','算法交易','期货交易','外汇交易','日内交易','trading','technical analysis','quantitative trading','algorithmic trading','futures trading','forex'];
  if (crypto.includes(kw)) return 'crypto';
  if (trading.includes(kw)) return 'trading';
  return 'finance';
}

const seen = new Set();
let totalInserted = 0;

async function fetchJSON(url) {
  try {
    const r = await fetch(url);
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

async function insertBatch(items) {
  if (!items.length) return 0;
  // Check existing titles to avoid duplicates
  const titles = items.map(i => i.title);
  const { data: existing } = await sb.from('library_items').select('title').in('title', titles);
  const existingTitles = new Set((existing || []).map(e => e.title));
  const newItems = items.filter(i => !existingTitles.has(i.title));
  if (!newItems.length) return 0;
  
  const { error } = await sb.from('library_items').insert(newItems);
  if (error) { console.error('  insert error:', error.message); return 0; }
  totalInserted += newItems.length;
  return newItems.length;
}

// Open Library - Chinese keywords
for (const kw of keywords) {
  const sub = categorize(kw);
  const url = `https://openlibrary.org/search.json?q=${encodeURIComponent(kw)}&language=chi&limit=50`;
  const data = await fetchJSON(url);
  const docs = data?.docs || [];

  const batch = [];
  for (const doc of docs) {
    const title = doc.title;
    const author = (doc.author_name || []).join(', ') || 'Unknown';
    const key = title;
    if (!title || seen.has(key)) continue;
    seen.add(key);
    batch.push({
      title, author,
      description: Array.isArray(doc.first_sentence) ? doc.first_sentence.join(' ').slice(0, 2000) : null,
      category: 'book', subcategory: sub, source: 'open_library',
      source_url: doc.key ? `https://openlibrary.org${doc.key}` : null,
      cover_url: doc.cover_i ? `https://covers.openlibrary.org/b/id/${doc.cover_i}-M.jpg` : null,
      language: 'zh', tags: [kw],
      isbn: doc.isbn?.[0] || null,
      page_count: doc.number_of_pages_median || null,
      publish_date: doc.first_publish_year ? `${doc.first_publish_year}` : null,
      is_free: false,
    });
  }
  const n = await insertBatch(batch);
  console.log(`[OpenLib-zh] ${kw}: found ${docs.length}, new ${batch.length}, inserted ${n}`);
  await new Promise(r => setTimeout(r, 600));
}

// Open Library - English keywords with Chinese language filter
for (const kw of enKeywords) {
  const sub = categorize(kw);
  const url = `https://openlibrary.org/search.json?q=${encodeURIComponent(kw)}&language=chi&limit=50`;
  const data = await fetchJSON(url);
  const docs = data?.docs || [];

  const batch = [];
  for (const doc of docs) {
    const title = doc.title;
    const author = (doc.author_name || []).join(', ') || 'Unknown';
    if (!title || seen.has(title)) continue;
    seen.add(title);
    batch.push({
      title, author,
      description: Array.isArray(doc.first_sentence) ? doc.first_sentence.join(' ').slice(0, 2000) : null,
      category: 'book', subcategory: sub, source: 'open_library',
      source_url: doc.key ? `https://openlibrary.org${doc.key}` : null,
      cover_url: doc.cover_i ? `https://covers.openlibrary.org/b/id/${doc.cover_i}-M.jpg` : null,
      language: 'zh', tags: [kw],
      isbn: doc.isbn?.[0] || null,
      page_count: doc.number_of_pages_median || null,
      publish_date: doc.first_publish_year ? `${doc.first_publish_year}` : null,
      is_free: false,
    });
  }
  const n = await insertBatch(batch);
  console.log(`[OpenLib-en] ${kw}: found ${docs.length}, new ${batch.length}, inserted ${n}`);
  await new Promise(r => setTimeout(r, 600));
}

// Well-known Chinese finance/crypto/trading books (manual curation)
const manualBooks = [
  // Crypto & Blockchain
  { title: '区块链：从数字货币到信用社会', author: '长铗, 韩锋', subcategory: 'crypto', tags: ['区块链','比特币'], publish_date: '2016' },
  { title: '区块链革命', author: 'Don Tapscott, Alex Tapscott', subcategory: 'crypto', tags: ['区块链'], publish_date: '2016' },
  { title: '精通比特币', author: 'Andreas M. Antonopoulos', subcategory: 'crypto', tags: ['比特币','技术'], publish_date: '2014', description: '比特币技术深度解析，涵盖密码学、挖矿、交易等核心概念' },
  { title: '精通以太坊', author: 'Andreas M. Antonopoulos, Gavin Wood', subcategory: 'crypto', tags: ['以太坊','智能合约'], publish_date: '2018' },
  { title: '区块链技术驱动金融', author: 'Arvind Narayanan', subcategory: 'crypto', tags: ['区块链','金融'], publish_date: '2016' },
  { title: '数字黄金：比特币鲜为人知的故事', author: 'Nathaniel Popper', subcategory: 'crypto', tags: ['比特币','历史'], publish_date: '2015' },
  { title: '加密资产：数字资产创新投资指南', author: 'Chris Burniske, Jack Tatar', subcategory: 'crypto', tags: ['加密货币','投资'], publish_date: '2017' },
  { title: '区块链：技术驱动金融', author: 'Arvind Narayanan 等', subcategory: 'crypto', tags: ['区块链'], publish_date: '2016' },
  { title: '图说区块链', author: '徐明星, 田颖, 李霁月', subcategory: 'crypto', tags: ['区块链','入门'], publish_date: '2017' },
  { title: '区块链：定义未来金融与经济新格局', author: '张健', subcategory: 'crypto', tags: ['区块链','金融'], publish_date: '2016' },
  { title: '区块链社会：解码区块链全球应用与投资案例', author: '龚鸣', subcategory: 'crypto', tags: ['区块链','应用'], publish_date: '2016' },
  { title: '白话区块链', author: '蒋勇, 文延, 嘉文', subcategory: 'crypto', tags: ['区块链','入门'], publish_date: '2017' },
  { title: '区块链实战', author: '吴为', subcategory: 'crypto', tags: ['区块链','开发'], publish_date: '2018' },
  { title: 'DeFi未来金融', author: 'Campbell R. Harvey', subcategory: 'crypto', tags: ['DeFi','去中心化金融'], publish_date: '2021' },

  // Trading
  { title: '日本蜡烛图技术', author: 'Steve Nison', subcategory: 'trading', tags: ['技术分析','K线'], publish_date: '1991', description: '技术分析经典，K线图形态分析的权威指南' },
  { title: '技术分析（第五版）', author: 'John J. Murphy', subcategory: 'trading', tags: ['技术分析'], publish_date: '1999' },
  { title: '股票大作手回忆录', author: 'Edwin Lefèvre', subcategory: 'trading', tags: ['交易','传记'], publish_date: '1923' },
  { title: '海龟交易法则', author: 'Curtis Faith', subcategory: 'trading', tags: ['交易系统','趋势跟踪'], publish_date: '2007' },
  { title: '交易心理分析', author: 'Mark Douglas', subcategory: 'trading', tags: ['交易心理','纪律'], publish_date: '2000' },
  { title: '以交易为生', author: 'Alexander Elder', subcategory: 'trading', tags: ['交易','技术分析'], publish_date: '1993' },
  { title: '量化交易：如何建立自己的算法交易事业', author: 'Ernest P. Chan', subcategory: 'trading', tags: ['量化交易','算法交易'], publish_date: '2008' },
  { title: '打开量化投资的黑箱', author: 'Rishi K. Narang', subcategory: 'trading', tags: ['量化投资'], publish_date: '2009' },
  { title: '期货市场技术分析', author: 'John J. Murphy', subcategory: 'trading', tags: ['期货','技术分析'], publish_date: '1986' },
  { title: '短线交易秘诀', author: 'Larry Williams', subcategory: 'trading', tags: ['短线交易'], publish_date: '1999' },
  { title: '趋势跟踪', author: 'Michael W. Covel', subcategory: 'trading', tags: ['趋势交易'], publish_date: '2004' },
  { title: '高频交易', author: 'Irene Aldridge', subcategory: 'trading', tags: ['高频交易','算法交易'], publish_date: '2009' },
  { title: '算法交易与直接市场接入', author: 'Barry Johnson', subcategory: 'trading', tags: ['算法交易'], publish_date: '2010' },
  { title: '波浪理论', author: 'Robert R. Prechter', subcategory: 'trading', tags: ['技术分析','波浪理论'], publish_date: '1978' },
  { title: '缠中说禅教你炒股票', author: '缠中说禅', subcategory: 'trading', tags: ['技术分析','缠论'], publish_date: '2008' },
  { title: '炒股的智慧', author: '陈江挺', subcategory: 'trading', tags: ['股票','交易'], publish_date: '1999' },

  // Finance & Investing
  { title: '聪明的投资者', author: 'Benjamin Graham', subcategory: 'finance', tags: ['价值投资'], publish_date: '1949', description: '价值投资的圣经，巴菲特推荐的投资入门书' },
  { title: '证券分析', author: 'Benjamin Graham, David Dodd', subcategory: 'finance', tags: ['价值投资','证券分析'], publish_date: '1934' },
  { title: '巴菲特致股东的信', author: 'Warren Buffett', subcategory: 'finance', tags: ['价值投资','巴菲特'], publish_date: '1996' },
  { title: '漫步华尔街', author: 'Burton G. Malkiel', subcategory: 'finance', tags: ['投资','指数基金'], publish_date: '1973' },
  { title: '投资最重要的事', author: 'Howard Marks', subcategory: 'finance', tags: ['投资哲学'], publish_date: '2011' },
  { title: '穷查理宝典', author: 'Peter D. Kaufman', subcategory: 'finance', tags: ['投资','查理芒格'], publish_date: '2005' },
  { title: '金融炼金术', author: 'George Soros', subcategory: 'finance', tags: ['金融','索罗斯'], publish_date: '1987' },
  { title: '对冲基金风云录', author: 'Barton Biggs', subcategory: 'finance', tags: ['对冲基金'], publish_date: '2006' },
  { title: '期权、期货及其他衍生产品', author: 'John C. Hull', subcategory: 'finance', tags: ['衍生品','期权'], publish_date: '1988' },
  { title: '金融工程学', author: 'John C. Hull', subcategory: 'finance', tags: ['金融工程'], publish_date: '2000' },
  { title: '行为金融学', author: 'James Montier', subcategory: 'finance', tags: ['行为金融学'], publish_date: '2002' },
  { title: '思考，快与慢', author: 'Daniel Kahneman', subcategory: 'finance', tags: ['行为金融学','心理学'], publish_date: '2011' },
  { title: '黑天鹅', author: 'Nassim Nicholas Taleb', subcategory: 'finance', tags: ['风险管理','概率'], publish_date: '2007' },
  { title: '反脆弱', author: 'Nassim Nicholas Taleb', subcategory: 'finance', tags: ['风险管理'], publish_date: '2012' },
  { title: '随机漫步的傻瓜', author: 'Nassim Nicholas Taleb', subcategory: 'finance', tags: ['风险','概率'], publish_date: '2001' },
  { title: '非理性繁荣', author: 'Robert J. Shiller', subcategory: 'finance', tags: ['行为金融学','泡沫'], publish_date: '2000' },
  { title: '大空头', author: 'Michael Lewis', subcategory: 'finance', tags: ['金融危机'], publish_date: '2010' },
  { title: '说谎者的扑克牌', author: 'Michael Lewis', subcategory: 'finance', tags: ['华尔街'], publish_date: '1989' },
  { title: '门口的野蛮人', author: 'Bryan Burrough', subcategory: 'finance', tags: ['并购','杠杆收购'], publish_date: '1989' },
  { title: '金融的逻辑', author: '陈志武', subcategory: 'finance', tags: ['金融','经济'], publish_date: '2009' },
  { title: '货币战争', author: '宋鸿兵', subcategory: 'finance', tags: ['货币','金融史'], publish_date: '2007' },
  { title: '投资中最简单的事', author: '邱国鹭', subcategory: 'finance', tags: ['价值投资','A股'], publish_date: '2014' },
  { title: '手把手教你读财报', author: '唐朝', subcategory: 'finance', tags: ['财务分析','基本面'], publish_date: '2015' },
  { title: '股市进阶之道', author: '李杰', subcategory: 'finance', tags: ['价值投资','A股'], publish_date: '2014' },
];

const manualBatch = manualBooks.filter(b => !seen.has(b.title)).map(b => {
  seen.add(b.title);
  return {
    title: b.title, author: b.author,
    description: b.description || null,
    category: 'book', subcategory: b.subcategory,
    source: 'manual', language: 'zh',
    tags: b.tags, publish_date: b.publish_date || null,
    is_free: false,
  };
});
const mn = await insertBatch(manualBatch);
console.log(`[Manual books] ${mn} inserted`);

// Whitepapers
const whitepapers = [
  { title: '比特币白皮书（中文版）', author: 'Satoshi Nakamoto', subcategory: 'blockchain', source_url: 'https://bitcoin.org/files/bitcoin-paper/bitcoin_zh_cn.pdf', pdf_url: 'https://bitcoin.org/files/bitcoin-paper/bitcoin_zh_cn.pdf', tags: ['bitcoin','whitepaper'], crypto_symbols: ['BTC'], publish_date: '2008-10-31' },
  { title: '以太坊白皮书（中文版）', author: 'Vitalik Buterin', subcategory: 'blockchain', source_url: 'https://github.com/ethereum/wiki/wiki/White-Paper', tags: ['ethereum','whitepaper'], crypto_symbols: ['ETH'], publish_date: '2014-01-01' },
  { title: 'Solana白皮书（中文版）', author: 'Anatoly Yakovenko', subcategory: 'blockchain', source_url: 'https://solana.com/solana-whitepaper.pdf', tags: ['solana','whitepaper'], crypto_symbols: ['SOL'], publish_date: '2017-11-01' },
  { title: 'Polkadot白皮书（中文版）', author: 'Gavin Wood', subcategory: 'blockchain', source_url: 'https://polkadot.network/whitepaper/', tags: ['polkadot','whitepaper'], crypto_symbols: ['DOT'], publish_date: '2016-11-01' },
  { title: 'Cosmos白皮书（中文版）', author: 'Jae Kwon, Ethan Buchman', subcategory: 'blockchain', source_url: 'https://cosmos.network/resources/whitepaper', tags: ['cosmos','whitepaper'], crypto_symbols: ['ATOM'], publish_date: '2016-06-01' },
  { title: 'Uniswap V3白皮书（中文版）', author: 'Hayden Adams et al.', subcategory: 'defi', source_url: 'https://uniswap.org/whitepaper-v3.pdf', tags: ['uniswap','defi','whitepaper'], crypto_symbols: ['UNI'], publish_date: '2021-03-01' },
  { title: 'Chainlink 2.0白皮书（中文版）', author: 'Chainlink Labs', subcategory: 'blockchain', source_url: 'https://chain.link/whitepaper', tags: ['chainlink','oracle','whitepaper'], crypto_symbols: ['LINK'], publish_date: '2021-04-01' },
  { title: 'Filecoin白皮书（中文版）', author: 'Protocol Labs', subcategory: 'blockchain', source_url: 'https://filecoin.io/filecoin.pdf', tags: ['filecoin','storage','whitepaper'], crypto_symbols: ['FIL'], publish_date: '2017-07-01' },
  { title: 'Avalanche白皮书（中文版）', author: 'Team Rocket', subcategory: 'blockchain', source_url: 'https://www.avalabs.org/whitepapers', tags: ['avalanche','whitepaper'], crypto_symbols: ['AVAX'], publish_date: '2018-05-01' },
  { title: 'Aave白皮书（中文版）', author: 'Aave Team', subcategory: 'defi', source_url: 'https://aave.com/whitepaper', tags: ['aave','defi','whitepaper'], crypto_symbols: ['AAVE'], publish_date: '2020-01-01' },
  { title: 'Compound白皮书（中文版）', author: 'Robert Leshner, Geoffrey Hayes', subcategory: 'defi', source_url: 'https://compound.finance/documents/Compound.Whitepaper.pdf', tags: ['compound','defi','whitepaper'], crypto_symbols: ['COMP'], publish_date: '2019-02-01' },
  { title: 'MakerDAO白皮书（中文版）', author: 'MakerDAO Team', subcategory: 'defi', source_url: 'https://makerdao.com/whitepaper', tags: ['makerdao','defi','stablecoin','whitepaper'], crypto_symbols: ['MKR','DAI'], publish_date: '2017-12-01' },
];

const wpBatch = whitepapers.filter(w => !seen.has(w.title)).map(w => {
  seen.add(w.title);
  return {
    title: w.title, author: w.author,
    category: 'whitepaper', subcategory: w.subcategory,
    source: 'manual', source_url: w.source_url,
    pdf_url: w.pdf_url || w.source_url,
    language: 'zh', tags: w.tags,
    crypto_symbols: w.crypto_symbols,
    publish_date: w.publish_date,
    is_free: true,
  };
});
const wn = await insertBatch(wpBatch);
console.log(`[Whitepapers] ${wn} inserted`);

console.log(`\n✅ Done! Total inserted: ${totalInserted}, unique titles seen: ${seen.size}`);
