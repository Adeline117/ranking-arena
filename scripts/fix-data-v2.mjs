#!/usr/bin/env node
const SB_URL = 'https://iknktzifjdyujdccyhsv.supabase.co';
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const headers = { 'apikey': SB_KEY, 'Authorization': `Bearer ${SB_KEY}`, 'Content-Type': 'application/json' };

async function batch(table, data, prefer = 'return=minimal,resolution=ignore-duplicates') {
  for (let i = 0; i < data.length; i += 50) {
    const chunk = data.slice(i, i + 50);
    const res = await fetch(`${SB_URL}/rest/v1/${table}`, {
      method: 'POST', headers: { ...headers, Prefer: prefer }, body: JSON.stringify(chunk)
    });
    if (!res.ok) {
      const t = await res.text();
      console.warn(`  ⚠️ ${table} batch ${i}: ${t.slice(0, 200)}`);
    }
  }
}

async function main() {
  // Get seed auth user IDs
  const listRes = await (await fetch(`${SB_URL}/auth/v1/admin/users?page=1&per_page=50`, { headers })).json();
  const seedUsers = listRes.users.filter(u => u.email?.includes('arena-test.com')).sort((a, b) => a.email.localeCompare(b.email));
  const userIds = seedUsers.map(u => u.id);
  console.log(`Found ${userIds.length} seed auth users`);

  // 1. Insert into users table
  console.log('Inserting into users table...');
  const usersData = seedUsers.map(u => ({ id: u.id, email: u.email }));
  await batch('users', usersData);
  
  // Verify
  const uc = await fetch(`${SB_URL}/rest/v1/users?select=id&limit=0`, { headers: { ...headers, Prefer: 'count=exact' } });
  console.log(`  users table: ${uc.headers.get('content-range')?.split('/')[1]} rows`);

  // 2. Seed book_ratings
  console.log('Seeding book_ratings...');
  const booksRes = await (await fetch(`${SB_URL}/rest/v1/library_items?select=id&limit=200`, { headers })).json();
  const reviews = [
    '非常实用的一本书，强烈推荐！', 'Great read, learned a lot.',
    '内容扎实，适合有一定基础的读者', 'Must read for any serious trader.',
    '经典之作，值得反复阅读', 'Changed my perspective on trading.',
    null, null, null, null,
  ];
  const ratings = [];
  for (const book of booksRes.slice(0, 65)) {
    const n = 3 + Math.floor(Math.random() * 4);
    const shuffled = [...userIds].sort(() => Math.random() - 0.5);
    for (let j = 0; j < Math.min(n, shuffled.length); j++) {
      const r = Math.random();
      const rating = r < 0.05 ? 1 : r < 0.15 ? 2 : r < 0.35 ? 3 : r < 0.65 ? 4 : 5;
      ratings.push({
        user_id: shuffled[j],
        library_item_id: book.id,
        rating,
        review: Math.random() < 0.3 ? reviews[Math.floor(Math.random() * reviews.length)] : null,
      });
    }
  }
  const unique = [...new Map(ratings.map(r => [`${r.user_id}-${r.library_item_id}`, r])).values()];
  await batch('book_ratings', unique);
  const brc = await fetch(`${SB_URL}/rest/v1/book_ratings?select=id&limit=0`, { headers: { ...headers, Prefer: 'count=exact' } });
  console.log(`  book_ratings: ${brc.headers.get('content-range')?.split('/')[1]} rows`);

  // 3. Flash news with correct importance values (breaking, important, normal)
  console.log('Seeding flash_news...');
  const templates = [
    { zh: 'BTC突破{p}美元关口，24小时涨幅达{pct}%', en: 'BTC breaks ${p}, up {pct}% in 24h', cat: 'crypto', imp: 'breaking', tags: ['bitcoin','price'] },
    { zh: 'BTC短线回调至{p}美元，多空分歧加大', en: 'BTC pulls back to ${p}', cat: 'crypto', imp: 'normal', tags: ['bitcoin','price'] },
    { zh: '比特币算力创新高突破{h}EH/s', en: 'BTC hashrate ATH {h}EH/s', cat: 'crypto', imp: 'normal', tags: ['bitcoin','mining'] },
    { zh: 'GBTC单日净流入{a}亿美元', en: 'GBTC ${a}B daily net inflow', cat: 'crypto', imp: 'important', tags: ['bitcoin','etf'] },
    { zh: 'MicroStrategy再增持{a}枚BTC', en: 'MicroStrategy buys {a} more BTC', cat: 'crypto', imp: 'important', tags: ['bitcoin','institutional'] },
    { zh: 'BTC期货未平仓合约达{a}亿美元', en: 'BTC OI reaches ${a}B', cat: 'crypto', imp: 'normal', tags: ['bitcoin','derivatives'] },
    { zh: '{a}枚BTC从交易所大量转出', en: '{a} BTC withdrawn from exchanges', cat: 'crypto', imp: 'important', tags: ['bitcoin','whale'] },
    { zh: 'ETH突破{p}美元，链上活动激增', en: 'ETH breaks ${p}', cat: 'crypto', imp: 'important', tags: ['ethereum','price'] },
    { zh: '以太坊Gas费降至{g}gwei', en: 'ETH gas drops to {g} gwei', cat: 'crypto', imp: 'normal', tags: ['ethereum','gas'] },
    { zh: 'ETH质押量突破{a}万枚', en: 'ETH staked exceeds {a}K', cat: 'crypto', imp: 'normal', tags: ['ethereum','staking'] },
    { zh: '以太坊L2 TVL突破{a}亿美元', en: 'ETH L2 TVL exceeds ${a}B', cat: 'crypto', imp: 'normal', tags: ['ethereum','layer2'] },
    { zh: 'Vitalik发文讨论以太坊路线图更新', en: 'Vitalik on ETH roadmap update', cat: 'crypto', imp: 'important', tags: ['ethereum','dev'] },
    { zh: 'DeFi总锁仓量突破{a}亿美元新高', en: 'DeFi TVL ATH ${a}B', cat: 'crypto', imp: 'important', tags: ['defi','tvl'] },
    { zh: 'Aave V4新市场上线，TVL增{pct}%', en: 'Aave V4 new market, TVL +{pct}%', cat: 'crypto', imp: 'normal', tags: ['defi','aave'] },
    { zh: 'Uniswap日交易量突破{a}亿美元', en: 'Uniswap daily volume ${a}B', cat: 'crypto', imp: 'normal', tags: ['defi','uniswap'] },
    { zh: 'DeFi协议遭闪电贷攻击损失{a}万美元', en: 'DeFi flash loan attack ${a}M lost', cat: 'crypto', imp: 'breaking', tags: ['defi','hack'] },
    { zh: 'MakerDAO调整DAI储蓄利率至{pct}%', en: 'MakerDAO DSR to {pct}%', cat: 'crypto', imp: 'normal', tags: ['defi','stablecoin'] },
    { zh: '美SEC批准新加密货币现货ETF', en: 'SEC approves new spot crypto ETF', cat: 'crypto', imp: 'breaking', tags: ['regulation','etf'] },
    { zh: '欧盟MiCA法规正式实施', en: 'EU MiCA takes effect', cat: 'crypto', imp: 'important', tags: ['regulation','eu'] },
    { zh: '香港虚拟资产新规出台', en: 'HK new virtual asset rules', cat: 'crypto', imp: 'important', tags: ['regulation','hk'] },
    { zh: '日本考虑下调加密税率至{pct}%', en: 'Japan crypto tax cut to {pct}%', cat: 'crypto', imp: 'normal', tags: ['regulation','japan'] },
    { zh: '美联储暗示可能降息', en: 'Fed hints at rate cut', cat: 'crypto', imp: 'breaking', tags: ['macro','fed'] },
    { zh: '美CPI公布通胀率降至{pct}%', en: 'US CPI: inflation at {pct}%', cat: 'crypto', imp: 'important', tags: ['macro','cpi'] },
    { zh: 'SOL突破{p}美元Solana生态火热', en: 'SOL breaks ${p}', cat: 'crypto', imp: 'normal', tags: ['solana','price'] },
    { zh: '加密市场总市值突破{a}万亿美元', en: 'Crypto cap ${a}T', cat: 'crypto', imp: 'important', tags: ['market','cap'] },
    { zh: '24小时{a}亿美元合约被清算', en: '${a}B liquidated in 24h', cat: 'crypto', imp: 'important', tags: ['derivatives','liq'] },
    { zh: 'AI代币板块集体上涨FET领涨{pct}%', en: 'AI tokens rally FET +{pct}%', cat: 'crypto', imp: 'normal', tags: ['ai','altcoin'] },
    { zh: 'DOGE暴涨{pct}%马斯克再发推', en: 'DOGE +{pct}% Musk tweets', cat: 'crypto', imp: 'normal', tags: ['doge','meme'] },
    { zh: 'XRP诉讼新进展SEC考虑和解', en: 'XRP case: SEC considers settlement', cat: 'crypto', imp: 'important', tags: ['xrp','regulation'] },
    { zh: 'Tether新增印刷{a}亿USDT', en: 'Tether mints ${a}B USDT', cat: 'crypto', imp: 'normal', tags: ['stablecoin','tether'] },
    { zh: 'Coinbase Q4财报超预期收入增{pct}%', en: 'Coinbase Q4 beats, rev +{pct}%', cat: 'crypto', imp: 'important', tags: ['coinbase','earnings'] },
    { zh: 'DePIN赛道总市值突破{a}亿美元', en: 'DePIN cap ${a}B', cat: 'crypto', imp: 'normal', tags: ['depin','sector'] },
    { zh: '链上数据显示巨鲸大量买入ETH', en: 'Whales accumulating ETH', cat: 'crypto', imp: 'normal', tags: ['whale','ethereum'] },
    { zh: 'Binance交易量创{a}亿美元月度新高', en: 'Binance volume ${a}B monthly high', cat: 'crypto', imp: 'normal', tags: ['binance','volume'] },
    { zh: 'BTC恐惧贪婪指数达{n}极度贪婪', en: 'BTC Fear/Greed at {n}', cat: 'crypto', imp: 'normal', tags: ['bitcoin','sentiment'] },
    { zh: '韩国Upbit交易量超Coinbase', en: 'Upbit surpasses Coinbase volume', cat: 'crypto', imp: 'normal', tags: ['exchange','korea'] },
    { zh: 'NFT市场回暖蓝筹地板价上涨', en: 'NFT blue chips floor up', cat: 'crypto', imp: 'normal', tags: ['nft','market'] },
    { zh: 'ARB空投第二轮即将开始', en: 'ARB airdrop round 2 incoming', cat: 'crypto', imp: 'normal', tags: ['arbitrum','airdrop'] },
    { zh: 'Curve推出新稳定币池APY达{pct}%', en: 'Curve new pool {pct}% APY', cat: 'crypto', imp: 'normal', tags: ['curve','defi'] },
    { zh: '新加坡央行发布CBDC试点报告', en: 'Singapore MAS CBDC pilot report', cat: 'crypto', imp: 'normal', tags: ['cbdc','singapore'] },
    { zh: 'BTC矿工收入单日突破{a}百万美元', en: 'BTC miner rev ${a}M daily', cat: 'crypto', imp: 'normal', tags: ['bitcoin','mining'] },
  ];

  const sources = ['CoinDesk','The Block','CoinTelegraph','Decrypt','BlockBeats','PANews','Odaily','Foresight News','Wu Blockchain','ChainCatcher'];
  const now = Date.now();
  const news = [];
  for (let i = 0; i < 230; i++) {
    const t = templates[i % templates.length];
    const fill = (s) => s.replace('{p}', ''+(95000+Math.floor(Math.random()*10)*1000))
      .replace('{h}', ''+(700+Math.floor(Math.random()*200)))
      .replace('{a}', ''+(1+Math.floor(Math.random()*50)))
      .replace('{pct}', ''+(2+Math.floor(Math.random()*25)))
      .replace('{g}', ''+(5+Math.floor(Math.random()*25)))
      .replace('{n}', ''+(60+Math.floor(Math.random()*30)));
    const pub = new Date(now - Math.random() * 7 * 86400000).toISOString();
    news.push({
      title: fill(t.zh),
      title_zh: fill(t.zh),
      title_en: fill(t.en),
      content: fill(t.zh) + '。市场分析人士关注后续走势。',
      source: sources[Math.floor(Math.random() * sources.length)],
      source_url: 'https://example.com/n/' + i,
      category: t.cat,
      importance: t.imp,
      tags: t.tags,
      published_at: pub,
      created_at: new Date(new Date(pub).getTime() + 60000).toISOString(),
    });
  }
  await batch('flash_news', news);
  const fnc = await fetch(`${SB_URL}/rest/v1/flash_news?select=id&limit=0`, { headers: { ...headers, Prefer: 'count=exact' } });
  console.log(`  flash_news: ${fnc.headers.get('content-range')?.split('/')[1]} rows`);

  // Final verification
  console.log('\n📊 Final counts:');
  for (const t of ['users','group_members','user_follows','follows','book_ratings','flash_news']) {
    const r = await fetch(`${SB_URL}/rest/v1/${t}?select=id&limit=0`, { headers: { ...headers, Prefer: 'count=exact' } });
    console.log(`  ${t}: ${r.headers.get('content-range')?.split('/')[1]}`);
  }
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
