import { createClient } from '@supabase/supabase-js';

const sb = createClient(
  'https://iknktzifjdyujdccyhsv.supabase.co',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imlrbmt0emlmamR5dWpkY2N5aHN2Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2NjU1MTU1MywiZXhwIjoyMDgyMTI3NTUzfQ.dBTyJ6tPY-eelVj4khLq31RuUg59Opcy5B48zOLLuGE'
);

function fixDate(d) {
  if (!d) return null;
  d = String(d);
  if (/^\d{4}$/.test(d)) return d + '-01-01';
  if (/^\d{4}-\d{2}$/.test(d)) return d + '-01';
  if (/^\d{4}-\d{2}-\d{2}/.test(d)) return d.slice(0, 10);
  return null;
}

// Get existing titles to skip
const { data: existing } = await sb.from('library_items').select('title').eq('language', 'zh');
const existingTitles = new Set((existing || []).map(e => e.title));
console.log(`Existing zh items: ${existingTitles.size}`);

let totalInserted = 0;

async function insertBatch(items) {
  const fresh = items.filter(i => !existingTitles.has(i.title));
  if (!fresh.length) return 0;
  const { error } = await sb.from('library_items').insert(fresh);
  if (error) { console.error('  insert error:', error.message); return 0; }
  fresh.forEach(i => existingTitles.add(i.title));
  totalInserted += fresh.length;
  return fresh.length;
}

// Open Library searches
const allKeywords = [
  'cryptocurrency','blockchain','bitcoin','ethereum','trading',
  'technical analysis','quantitative trading','algorithmic trading',
  'futures trading','forex','stock investing','value investing',
  'risk management','portfolio','derivatives','behavioral finance',
  'digital currency','smart contract','financial engineering','hedge fund',
  'Web3','NFT','DeFi'
];

function categorize(kw) {
  const crypto = ['cryptocurrency','blockchain','bitcoin','ethereum','digital currency','smart contract','Web3','NFT','DeFi'];
  const trading = ['trading','technical analysis','quantitative trading','algorithmic trading','futures trading','forex'];
  if (crypto.includes(kw)) return 'crypto';
  if (trading.includes(kw)) return 'trading';
  return 'finance';
}

for (const kw of allKeywords) {
  const sub = categorize(kw);
  const url = `https://openlibrary.org/search.json?q=${encodeURIComponent(kw)}&language=chi&limit=50`;
  try {
    const r = await fetch(url);
    const data = await r.json();
    const docs = data?.docs || [];
    const batch = docs.filter(d => d.title && !existingTitles.has(d.title)).map(doc => ({
      title: doc.title,
      author: (doc.author_name || []).join(', ') || 'Unknown',
      description: Array.isArray(doc.first_sentence) ? doc.first_sentence.join(' ').slice(0, 2000) : null,
      category: 'book', subcategory: sub, source: 'open_library',
      source_url: doc.key ? `https://openlibrary.org${doc.key}` : null,
      cover_url: doc.cover_i ? `https://covers.openlibrary.org/b/id/${doc.cover_i}-M.jpg` : null,
      language: 'zh', tags: [kw],
      isbn: doc.isbn?.[0] || null,
      page_count: doc.number_of_pages_median || null,
      publish_date: fixDate(doc.first_publish_year),
      is_free: false,
    }));
    // Dedupe within batch
    const uniqueBatch = []; const s = new Set();
    for (const b of batch) { if (!s.has(b.title)) { s.add(b.title); uniqueBatch.push(b); } }
    const n = await insertBatch(uniqueBatch);
    console.log(`[OpenLib] ${kw}: ${docs.length} found, ${n} inserted`);
  } catch (e) { console.log(`[OpenLib] ${kw}: error ${e.message}`); }
  await new Promise(r => setTimeout(r, 600));
}

// Manual curated books
const manualBooks = [
  { title: '区块链：从数字货币到信用社会', author: '长铗, 韩锋', sub: 'crypto', tags: ['区块链','比特币'], date: '2016' },
  { title: '区块链革命', author: 'Don Tapscott, Alex Tapscott', sub: 'crypto', tags: ['区块链'], date: '2016' },
  { title: '精通比特币', author: 'Andreas M. Antonopoulos', sub: 'crypto', tags: ['比特币','技术'], date: '2014', desc: '比特币技术深度解析' },
  { title: '精通以太坊', author: 'Andreas M. Antonopoulos, Gavin Wood', sub: 'crypto', tags: ['以太坊','智能合约'], date: '2018' },
  { title: '区块链技术驱动金融', author: 'Arvind Narayanan', sub: 'crypto', tags: ['区块链','金融'], date: '2016' },
  { title: '数字黄金：比特币鲜为人知的故事', author: 'Nathaniel Popper', sub: 'crypto', tags: ['比特币','历史'], date: '2015' },
  { title: '加密资产：数字资产创新投资指南', author: 'Chris Burniske, Jack Tatar', sub: 'crypto', tags: ['加密货币','投资'], date: '2017' },
  { title: '图说区块链', author: '徐明星, 田颖, 李霁月', sub: 'crypto', tags: ['区块链','入门'], date: '2017' },
  { title: '区块链：定义未来金融与经济新格局', author: '张健', sub: 'crypto', tags: ['区块链','金融'], date: '2016' },
  { title: '区块链社会：解码区块链全球应用与投资案例', author: '龚鸣', sub: 'crypto', tags: ['区块链','应用'], date: '2016' },
  { title: '白话区块链', author: '蒋勇, 文延, 嘉文', sub: 'crypto', tags: ['区块链','入门'], date: '2017' },
  { title: 'DeFi未来金融', author: 'Campbell R. Harvey', sub: 'crypto', tags: ['DeFi','去中心化金融'], date: '2021' },
  { title: '日本蜡烛图技术', author: 'Steve Nison', sub: 'trading', tags: ['技术分析','K线'], date: '1991', desc: 'K线图形态分析权威指南' },
  { title: '期货市场技术分析', author: 'John J. Murphy', sub: 'trading', tags: ['期货','技术分析'], date: '1986' },
  { title: '股票大作手回忆录', author: 'Edwin Lefèvre', sub: 'trading', tags: ['交易','传记'], date: '1923' },
  { title: '海龟交易法则', author: 'Curtis Faith', sub: 'trading', tags: ['交易系统'], date: '2007' },
  { title: '交易心理分析', author: 'Mark Douglas', sub: 'trading', tags: ['交易心理'], date: '2000' },
  { title: '以交易为生', author: 'Alexander Elder', sub: 'trading', tags: ['交易','技术分析'], date: '1993' },
  { title: '量化交易：如何建立自己的算法交易事业', author: 'Ernest P. Chan', sub: 'trading', tags: ['量化交易'], date: '2008' },
  { title: '打开量化投资的黑箱', author: 'Rishi K. Narang', sub: 'trading', tags: ['量化投资'], date: '2009' },
  { title: '短线交易秘诀', author: 'Larry Williams', sub: 'trading', tags: ['短线交易'], date: '1999' },
  { title: '趋势跟踪', author: 'Michael W. Covel', sub: 'trading', tags: ['趋势交易'], date: '2004' },
  { title: '高频交易', author: 'Irene Aldridge', sub: 'trading', tags: ['高频交易'], date: '2009' },
  { title: '波浪理论', author: 'Robert R. Prechter', sub: 'trading', tags: ['技术分析'], date: '1978' },
  { title: '缠中说禅教你炒股票', author: '缠中说禅', sub: 'trading', tags: ['技术分析','缠论'], date: '2008' },
  { title: '炒股的智慧', author: '陈江挺', sub: 'trading', tags: ['股票','交易'], date: '1999' },
  { title: '聪明的投资者', author: 'Benjamin Graham', sub: 'finance', tags: ['价值投资'], date: '1949', desc: '价值投资圣经' },
  { title: '证券分析', author: 'Benjamin Graham, David Dodd', sub: 'finance', tags: ['价值投资','证券分析'], date: '1934' },
  { title: '巴菲特致股东的信', author: 'Warren Buffett', sub: 'finance', tags: ['价值投资'], date: '1996' },
  { title: '漫步华尔街', author: 'Burton G. Malkiel', sub: 'finance', tags: ['投资','指数基金'], date: '1973' },
  { title: '投资最重要的事', author: 'Howard Marks', sub: 'finance', tags: ['投资哲学'], date: '2011' },
  { title: '穷查理宝典', author: 'Peter D. Kaufman', sub: 'finance', tags: ['投资','芒格'], date: '2005' },
  { title: '金融炼金术', author: 'George Soros', sub: 'finance', tags: ['金融','索罗斯'], date: '1987' },
  { title: '对冲基金风云录', author: 'Barton Biggs', sub: 'finance', tags: ['对冲基金'], date: '2006' },
  { title: '期权、期货及其他衍生产品', author: 'John C. Hull', sub: 'finance', tags: ['衍生品','期权'], date: '1988' },
  { title: '思考，快与慢', author: 'Daniel Kahneman', sub: 'finance', tags: ['行为金融学'], date: '2011' },
  { title: '黑天鹅', author: 'Nassim Nicholas Taleb', sub: 'finance', tags: ['风险管理'], date: '2007' },
  { title: '反脆弱', author: 'Nassim Nicholas Taleb', sub: 'finance', tags: ['风险管理'], date: '2012' },
  { title: '随机漫步的傻瓜', author: 'Nassim Nicholas Taleb', sub: 'finance', tags: ['风险','概率'], date: '2001' },
  { title: '非理性繁荣', author: 'Robert J. Shiller', sub: 'finance', tags: ['行为金融学'], date: '2000' },
  { title: '大空头', author: 'Michael Lewis', sub: 'finance', tags: ['金融危机'], date: '2010' },
  { title: '说谎者的扑克牌', author: 'Michael Lewis', sub: 'finance', tags: ['华尔街'], date: '1989' },
  { title: '门口的野蛮人', author: 'Bryan Burrough', sub: 'finance', tags: ['并购'], date: '1989' },
  { title: '金融的逻辑', author: '陈志武', sub: 'finance', tags: ['金融','经济'], date: '2009' },
  { title: '货币战争', author: '宋鸿兵', sub: 'finance', tags: ['货币','金融史'], date: '2007' },
  { title: '投资中最简单的事', author: '邱国鹭', sub: 'finance', tags: ['价值投资'], date: '2014' },
  { title: '手把手教你读财报', author: '唐朝', sub: 'finance', tags: ['财务分析'], date: '2015' },
  { title: '股市进阶之道', author: '李杰', sub: 'finance', tags: ['价值投资'], date: '2014' },
];

const mBatch = manualBooks.filter(b => !existingTitles.has(b.title)).map(b => ({
  title: b.title, author: b.author, description: b.desc || null,
  category: 'book', subcategory: b.sub, source: 'manual',
  language: 'zh', tags: b.tags, publish_date: fixDate(b.date), is_free: false,
}));
const mn = await insertBatch(mBatch);
console.log(`[Manual] ${mn} inserted out of ${manualBooks.length}`);

console.log(`\n✅ Total inserted: ${totalInserted}`);
