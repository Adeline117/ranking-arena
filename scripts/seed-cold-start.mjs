#!/usr/bin/env node
/**
 * Cold-start seed script for ranking-arena
 * Creates 20 simulated users, joins groups, creates posts & comments, follows
 */

const SB_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;

const headers = {
  'apikey': SB_KEY,
  'Authorization': `Bearer ${SB_KEY}`,
  'Content-Type': 'application/json',
};

async function api(method, path, body) {
  const url = path.startsWith('http') ? path : `${SB_URL}${path}`;
  const res = await fetch(url, {
    method,
    headers: { ...headers, ...(method === 'POST' ? { Prefer: 'return=representation' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} ${res.status}: ${text}`);
  return text ? JSON.parse(text) : null;
}

// ─── Users ───
const USERS = [
  { handle: 'crypto_whale_88', bio: '做过3轮牛熊，现在只做BTC和ETH', email: 'user1@arena-test.com' },
  { handle: '币圈老韭菜', bio: '被割了无数次，终于学会了止损', email: 'user2@arena-test.com' },
  { handle: 'DeFiHunter', bio: 'Yield farming specialist. DeFi degen since 2020.', email: 'user3@arena-test.com' },
  { handle: '量化小王子', bio: '用Python写策略，靠数据吃饭', email: 'user4@arena-test.com' },
  { handle: 'diamond_hands_69', bio: 'HODL is my middle name. Never selling.', email: 'user5@arena-test.com' },
  { handle: '梭哈战神', bio: '要么暴富要么归零，人生就是要梭哈', email: 'user6@arena-test.com' },
  { handle: 'OnChainSleuth', bio: 'Tracking whale wallets and smart money flows 24/7', email: 'user7@arena-test.com' },
  { handle: '波段王者', bio: '高抛低吸，波段为王，不追涨不杀跌', email: 'user8@arena-test.com' },
  { handle: 'AlphaSeeker_', bio: 'Finding alpha in the noise. Contrarian by nature.', email: 'user9@arena-test.com' },
  { handle: '合约爆仓日记', bio: '记录每一次爆仓的血泪史，警示后人', email: 'user10@arena-test.com' },
  { handle: 'grid_bot_guru', bio: 'Grid trading enthusiast. Let the bots do the work.', email: 'user11@arena-test.com' },
  { handle: '币圈养生达人', bio: '炒币不熬夜，身体是革命的本钱', email: 'user12@arena-test.com' },
  { handle: 'NFT_Flipper', bio: 'Flipping JPEGs since 2021. Art + alpha = profit.', email: 'user13@arena-test.com' },
  { handle: '技术分析狂人', bio: 'K线图就是我的情书，MACD是我的初恋', email: 'user14@arena-test.com' },
  { handle: 'macro_trader_x', bio: 'Macro-driven trades. Fed policy > chart patterns.', email: 'user15@arena-test.com' },
  { handle: '山寨币猎人', bio: '专门挖掘百倍山寨币，踩过很多坑', email: 'user16@arena-test.com' },
  { handle: 'SatoshiDisciple', bio: 'Bitcoin maximalist. Everything else is a shitcoin.', email: 'user17@arena-test.com' },
  { handle: '摸鱼交易员', bio: '上班摸鱼看K线，下班熬夜盯盘面', email: 'user18@arena-test.com' },
  { handle: 'leverage_king', bio: '100x or nothing. High risk, high reward lifestyle.', email: 'user19@arena-test.com' },
  { handle: '读书炒币两不误', bio: '每月读2本交易书，边学边实战', email: 'user20@arena-test.com' },
];

// ─── Groups ───
const GROUP_IDS = [
  '133090b0-4a49-4864-86d3-c242a8a576e2', // 交易书籍推荐
  '297c5d1e-12fb-4bde-8c2a-9cbba6643713', // 被套互助会
  '573bbd40-fd09-41a0-95ed-75cdd6164085', // 韭菜成长日记
  'a5c21f1c-880e-444d-9a4d-caf907290830', // 梭哈艺术家
  '72f997d7-3d81-49f8-9218-96ce63adbd08', // 抄底抄在半山腰
  '3b97c31b-d610-430a-8962-976c4712338d', // 上班摸鱼交易
  'b0f859b4-cc23-4e0b-ba57-d302e838fe52', // 晒单区
  '7de95eb5-7108-4f72-b3fb-7871150e343e', // 交易所吐槽大会
  '7c6cfe0c-22eb-48e7-96aa-cb0907b0e709', // 交易员养生堂
  'bedc4b72-3b94-489d-9410-d01a3a64938f', // 网格交易爱好者
  '8eefdc5d-e3e1-42ad-8fd9-7c65e689e09a', // 合约交易研习社
  '9b09ae65-0df3-4ec3-8496-a0f62eef16c9', // 波段交易者
  '390377ea-4ced-42df-8216-3513768b4085', // 交易员的桌面
  '6d2677ed-006a-42ac-8134-a3614966ed98', // 链上数据分析
  '5cdd875a-55a8-4b88-a170-6533ed7ad545', // 山寨币猎人
  '0f658894-74ca-45c5-8e33-b6c23a100708', // 比特币信仰者
  '7b1ab819-4b15-49e4-bea0-94c77c51627a', // DeFi农民
  '7e373cde-2cac-42cf-bc1a-d4ff4ff21f8f', // 技术指标研究
  '43bb1337-a5e5-4094-8e6c-24eaa95ca59f', // 量化编程交流
  'b0a167c0-47e1-49c0-8ede-fd52f1873b04', // 交易心理学
];

// ─── Posts ───
const POSTS = [
  { userIdx: 0, groupIdx: 0, title: '推荐《交易心理分析》', content: '这本书彻底改变了我的交易心态。Mark Douglas讲的"概率思维"让我从一个追涨杀跌的韭菜变成了一个有纪律的交易者。强烈推荐给每一个还在亏钱的朋友。' },
  { userIdx: 1, groupIdx: 1, title: 'ETH被套在4800，还有救吗', content: '上个月FOMO追高买的ETH，均价4800刀，现在跌到3200了。要不要割肉？还是继续拿着等下一波？求老哥们给点建议🥲' },
  { userIdx: 2, groupIdx: 16, title: 'New Aave V4 farming strategy', content: 'Found a neat loop on Aave V4: supply ETH → borrow stablecoins → supply to Curve → use CRV rewards to pay interest. Net APY ~18% after gas. Not financial advice but the numbers look solid.' },
  { userIdx: 3, groupIdx: 18, title: '分享一个简单的均线交叉策略', content: '用EMA12和EMA26做交叉，配合RSI过滤假信号。回测了6个月BTC/USDT 4H数据，胜率62%，盈亏比1.8。代码放GitHub了，有兴趣的可以一起优化。' },
  { userIdx: 4, groupIdx: 15, title: 'Why I only hold BTC now', content: 'After 5 years of chasing altcoin pumps and losing 80% of my portfolio, I finally converted everything to BTC. Sleep better, trade less, make more. The orange pill is real.' },
  { userIdx: 5, groupIdx: 3, title: '昨晚SOL全仓梭哈结果', content: '看到SOL突破200就忍不住了，全仓杀入。结果今早醒来直接闪崩到175，账户浮亏15%。不过我不慌，SOL生态这么强，拿着！梭哈的快乐你们不懂😎' },
  { userIdx: 6, groupIdx: 13, title: 'Whale alert: 50K ETH moved to Binance', content: 'Just spotted a massive transfer from a known whale wallet. 50,000 ETH moved to Binance hot wallet in the last hour. This usually signals selling pressure incoming. Stay cautious for the next 24-48h.' },
  { userIdx: 7, groupIdx: 11, title: '波段操作的三个铁律', content: '做了5年波段总结出三条铁律：1. 永远不追突破后的第一根大阳线 2. 回调到EMA20是最佳买点 3. 利润超过15%必须移动止损。这三条帮我从亏损变成稳定盈利。' },
  { userIdx: 8, groupIdx: 17, title: 'RSI divergence is the most reliable signal', content: 'I\'ve backtested every indicator under the sun. Nothing beats hidden bullish RSI divergence on the 4H chart for catching reversals. Combine it with volume confirmation and you have a 70%+ win rate setup.' },
  { userIdx: 9, groupIdx: 10, title: '今天又爆仓了，第17次', content: '20倍杠杆做多BTC，止损没设好，一根大阴线直接清零。这个月已经爆仓3次了，总共亏了8000U。我是不是该休息一下？还是说合约就不适合我？' },
  { userIdx: 10, groupIdx: 9, title: 'My grid bot made $2,400 last month', content: 'Running a grid bot on BTC/USDT with $50K capital, 5% grid spacing, 30 grids from $85K to $105K. Made $2,400 in pure grid profit last month. Boring but profitable. Happy to share settings.' },
  { userIdx: 11, groupIdx: 8, title: '交易员必备的5个养生习惯', content: '1. 盯盘不超过4小时，设好提醒就去运动 2. 每天冥想15分钟控制情绪 3. 不在深夜做交易决策 4. 每周至少2天完全不看盘 5. 亏损后先跑步再复盘，别冲动交易' },
  { userIdx: 13, groupIdx: 17, title: 'MACD+布林带组合策略详解', content: 'MACD金叉+价格触及布林带下轨=强烈买入信号。我用这个组合在BTC 1H图上操作，过去3个月胜率58%，但盈亏比达到2.3。关键是要严格止损，不要扛单。' },
  { userIdx: 14, groupIdx: 15, title: 'Fed pivot incoming — here\'s my play', content: 'With CPI trending down and unemployment rising, I expect a rate cut by Q2. Loading up on BTC and ETH before the pivot. Historical data shows crypto rallies 60-90 days before the first cut. Position sizing: 40% BTC, 30% ETH, 30% cash.' },
  { userIdx: 15, groupIdx: 14, title: '发现一个潜力百倍币', content: '刚挖到一个新项目，做AI+DePIN赛道的，市值才500万美金。团队背景不错，有前Google工程师。不过说实话我也看走眼过很多次了，大家DYOR，轻仓试试就好。' },
  { userIdx: 16, groupIdx: 15, title: 'The case for $500K BTC by 2028', content: 'With the halving done, ETF inflows growing, and nation-state adoption accelerating, $500K BTC by 2028 is not hopium — it\'s math. Supply shock + demand surge = price go up. Simple as.' },
  { userIdx: 17, groupIdx: 5, title: '上班摸鱼看盘的最佳姿势', content: '分享一下我的摸鱼心得：1. 用TradingView的手机widget，不用开app 2. 设好价格警报，平时不看 3. 把交易界面伪装成Excel 4. 午休时间集中操作。老板看到都以为我在做报表😂' },
  { userIdx: 18, groupIdx: 10, title: 'How I turned $500 into $50K with leverage', content: 'Started with $500, used 25x leverage on SOL when it was at $20. Rode it to $120 with trailing stops. Key was pyramiding — adding to winners, not losers. Then lost half of it the next month lol. Easy come, easy go.' },
  { userIdx: 19, groupIdx: 0, title: '读完《海龟交易法则》的感悟', content: '这本书最大的启发是"趋势跟踪"的理念。不需要预测市场方向，只需要在趋势出现时跟上就好。配合严格的仓位管理和止损，即使胜率只有40%也能赚钱。强烈推荐新手阅读。' },
  { userIdx: 12, groupIdx: 6, title: 'Just made 300% on a BAYC flip', content: 'Sniped a rare BAYC for 12 ETH, flipped it for 48 ETH in 3 days. The trick is watching the trait floor prices, not the collection floor. Rare traits are always underpriced in a down market.' },
  { userIdx: 0, groupIdx: 19, title: '交易情绪管理：我的三个方法', content: '1. 每次交易前写下理由和止损位，亏损时对照检查是否执行了计划 2. 连续亏损2次后强制休息1天 3. 记录每次冲动交易的后果，形成负面激励。这三招帮我年化从-30%变成+40%。' },
  { userIdx: 3, groupIdx: 18, title: 'Python回测框架对比', content: 'backtrader vs vectorbt vs zipline，用了一圈下来觉得vectorbt最适合加密货币回测。速度快，向量化计算，支持多币种同时回测。唯一的缺点是文档不太友好，新手上手需要点时间。' },
  { userIdx: 7, groupIdx: 4, title: '又抄底抄在半山腰了😭', content: 'BTC跌到92K的时候觉得是底了，重仓买入。结果继续跌到88K。每次都这样，总觉得跌够了，结果还能再跌。有没有大佬教教怎么判断真正的底部？' },
  { userIdx: 1, groupIdx: 2, title: '韭菜成长记录：第一次学会止损', content: '入圈2年，终于在这次下跌中第一次主动止损了！虽然亏了2000U，但比之前被套50%强多了。成长的代价就是真金白银，但至少我在进步💪' },
  { userIdx: 6, groupIdx: 13, title: 'On-chain metrics show accumulation phase', content: 'Exchange reserves hitting 5-year lows, long-term holder supply ratio at ATH, MVRV Z-score below 1. All classic signs of smart money accumulation. The next leg up could be massive. Data doesn\'t lie.' },
  { userIdx: 9, groupIdx: 3, title: '最后一次梭哈，我保证', content: '上次说最后一次梭哈是第15次了...这次真的是最后一次。BTC看到10万美金支撑位直接全仓。如果这次再亏，我就真的去学习量化了，不再手动交易。立帖为证！' },
  { userIdx: 11, groupIdx: 8, title: '熬夜盯盘一个月后的身体变化', content: '连续熬夜盯盘一个月，结果：掉了一把头发，长了5斤肉，黑眼圈重到同事以为我失恋了。赚了3000U，但体检报告亮了3个指标。兄弟们，身体真的比钱重要。' },
  { userIdx: 4, groupIdx: 15, title: 'Dollar cost averaging into BTC: 2 year results', content: 'Started DCA\'ing $500/week into BTC in Jan 2024. Total invested: $52,000. Current value: $89,000. That\'s 71% return with zero stress. No charts, no leverage, no sleepless nights. Boring works.' },
  { userIdx: 14, groupIdx: 17, title: 'Fibonacci retracements actually work', content: 'Was a skeptic until I started tracking BTC bounces at the 0.618 fib level. Out of the last 20 major pullbacks, 14 bounced within 2% of the golden ratio. That\'s a 70% hit rate. Now it\'s a core part of my setup.' },
  { userIdx: 2, groupIdx: 16, title: 'Warning: new DeFi protocol rug pull risk', content: 'The new "YieldMax" protocol on Arbitrum has some red flags: unverified contracts, anonymous team, TVL growing suspiciously fast from a single whale wallet. I pulled my funds. Better safe than sorry. DYOR.' },
  { userIdx: 15, groupIdx: 14, title: 'AI赛道代币深度分析', content: 'AI赛道目前市值前5的项目：FET、RENDER、TAO、NEAR、AR。从基本面看，TAO的去中心化AI网络最有想象空间，但估值已经不便宜了。建议关注RENDER，算力需求是实打实的。' },
  { userIdx: 8, groupIdx: 11, title: 'My swing trading checklist', content: '1. Is the weekly trend up? 2. Has price pulled back to a key MA? 3. Is RSI oversold on daily? 4. Is there a bullish candlestick pattern? 5. Is volume declining on the pullback? If all 5 check out, I enter. Simple system, consistent results.' },
  { userIdx: 10, groupIdx: 9, title: '网格交易参数设置心得', content: '分享一下我的网格参数心得：1. 网格间距建议2-3%，太密手续费吃利润 2. 总网格数20-30个最合适 3. 底部价格设在支撑位下方10% 4. 总仓位不超过总资金50%。稳稳当当每月3-5%收益。' },
  { userIdx: 5, groupIdx: 6, title: '晒单：这波SOL赚了3万U', content: '上周SOL 160买入，今天210卖出。5万U本金赚了3万多。虽然之前梭哈亏过很多，但这一单直接回血了。截图为证，不吹不黑。下一单继续梭！' },
  { userIdx: 17, groupIdx: 12, title: '交易员桌面分享', content: '终于把我的交易桌面升级了：3个27寸4K屏幕，一个看K线，一个看持仓，一个摸鱼。机械键盘Cherry红轴，鼠标罗技MX Master。最重要的是人体工学椅，毕竟要坐一天。' },
  { userIdx: 16, groupIdx: 15, title: 'Bitcoin ETF flows analysis — Feb 2026', content: 'Net inflows for Jan 2026: $4.2B. BlackRock\'s IBIT alone accounted for $2.8B. Grayscale outflows have basically stopped. Institutional adoption is accelerating faster than anyone predicted. This is just the beginning.' },
  { userIdx: 13, groupIdx: 17, title: 'KDJ指标在加密市场的应用', content: 'KDJ在传统市场用得多，但在加密市场需要调整参数。我把默认的9,3,3改成了14,5,3，过滤掉了很多假信号。配合4小时图使用效果最好，1小时图噪音太多。' },
  { userIdx: 19, groupIdx: 0, title: '《随机漫步的傻瓜》读后感', content: 'Nassim Taleb这本书让我意识到，很多交易者的"成功"其实只是运气。真正的交易能力需要经过足够多的样本检验。现在我每次看到有人晒暴富战绩，第一反应就是：样本量够吗？' },
  { userIdx: 18, groupIdx: 10, title: 'Liquidation cascade incoming?', content: 'Over $2B in long positions will get liquidated if BTC drops to $92K. The leveraged long/short ratio is at 2.1, way above average. If we get a flush, it could be violent. I\'m sitting in stables waiting for the dip.' },
  { userIdx: 12, groupIdx: 7, title: 'Binance又改手续费了', content: 'Binance刚宣布现货手续费从0.075%涨到0.1%，合约maker费率也上调了。一年下来多出来的手续费够买一部iPhone了。有没有人转去用其他交易所的？求推荐手续费低的。' },
  { userIdx: 4, groupIdx: 0, title: '《金融炼金术》值得读吗', content: '索罗斯的这本书说实话很难读，反身性理论讲得太抽象了。但是如果你能啃下来，对理解市场的非理性行为会有很大帮助。建议先读《交易心理分析》再读这本，会更容易理解。' },
  { userIdx: 3, groupIdx: 19, title: '量化交易者的心理陷阱', content: '做量化最大的心理陷阱是过度拟合。回测结果太好看的策略往往实盘表现很差。我的经验是：如果回测胜率超过70%，大概率是过拟合了。好的策略胜率通常在50-60%之间，靠盈亏比赚钱。' },
  { userIdx: 6, groupIdx: 13, title: 'Top 10 whale wallets activity this week', content: 'Summary of major movements:\n1. Wallet "0x7a9..." accumulated 2,000 BTC\n2. Jump Trading moved $150M USDC to Coinbase\n3. A dormant wallet from 2014 moved 500 BTC\n4. Wintermute increased ETH position by 15K\nFull analysis in the thread below.' },
  { userIdx: 8, groupIdx: 19, title: 'The psychology of revenge trading', content: 'Lost $5K on a bad trade yesterday. My first instinct was to immediately make it back with a bigger position. Recognized the pattern, closed the laptop, went for a run. Saved myself probably another $5K. The market will be there tomorrow.' },
  { userIdx: 2, groupIdx: 16, title: 'Airdrop farming guide — Feb 2026', content: 'Top protocols to farm right now:\n1. LayerZero V2 — bridge across chains\n2. Scroll — use the testnet + mainnet\n3. Berachain — LP and governance\n4. Monad — testnet interactions\nEstimated value: $2K-$10K per wallet if you\'re early enough.' },
  { userIdx: 15, groupIdx: 14, title: '下一个百倍币在哪个赛道', content: '分析了过去几轮牛市的百倍币特征：1. 新叙事（不是上一轮的热点）2. 市值低于1000万 3. 有实际产品而不只是白皮书 4. 社区活跃但还没出圈。目前最符合的赛道：DePIN和AI Agent。' },
  { userIdx: 7, groupIdx: 11, title: '如何识别波段交易的最佳入场点', content: '我用的方法：1. 先看周线确定大方向 2. 日线找支撑阻力位 3. 4小时图等回调到关键位 4. 1小时图找反转K线形态入场。多级别共振的入场点胜率最高，单级别的信号容易被假突破骗。' },
  { userIdx: 9, groupIdx: 1, title: 'BTC被套在105K的来报到', content: '年初追高买在105K，现在96K，被套了差不多10%。说好的10万是起点呢？有没有同病相怜的朋友，大家一起等解套🥲 反正我是不割了，大不了变长期投资。' },
  { userIdx: 14, groupIdx: 10, title: 'Risk management with leverage: my rules', content: '1. Never use more than 10x 2. Position size max 5% of portfolio per trade 3. Always set stop loss BEFORE entering 4. If I lose 3 trades in a row, stop for 24h 5. Take profit at 2:1 R:R minimum. These rules saved my account multiple times.' },
  { userIdx: 11, groupIdx: 8, title: '推荐几个交易员友好的零食', content: '盯盘的时候需要补充能量但不能吃太油腻：1. 坚果混合（核桃+杏仁）2. 黑巧克力（70%以上）3. 蓝莓 4. 燕麦能量棒 5. 绿茶代替咖啡。吃得健康交易才能持久啊兄弟们。' },
  { userIdx: 16, groupIdx: 15, title: 'Unpopular opinion: we\'re still early', content: 'Global crypto market cap is $3T. Gold is $15T. Global real estate is $300T. If Bitcoin captures just 10% of gold\'s market cap, that\'s $150K per BTC. We\'re not early in crypto — we\'re early in Bitcoin\'s monetization cycle.' },
];

// ─── Comments ───
const COMMENTS = [
  { postIdx: 0, userIdx: 19, content: '同意！这本书我读了三遍，每次都有新的领悟。' },
  { postIdx: 0, userIdx: 3, content: '配合《通往财务自由之路》一起看效果更好。' },
  { postIdx: 1, userIdx: 0, content: '4800的ETH确实有点高，但如果你不急用钱的话拿着也行，ETH长期还是看涨的。' },
  { postIdx: 1, userIdx: 5, content: '我3600被套的，现在心态已经很好了，反正也不指望短期解套😂' },
  { postIdx: 1, userIdx: 9, content: '建议设个止损位，如果跌破2800就先出来观望。不要让小亏变成大亏。' },
  { postIdx: 3, userIdx: 10, content: '62%胜率配1.8盈亏比已经很不错了！能分享一下回测代码吗？' },
  { postIdx: 3, userIdx: 8, content: 'Have you tried adding volume filter? It usually improves win rate by 5-8%.' },
  { postIdx: 5, userIdx: 9, content: '老哥你这是第几次全仓梭哈了😂 SOL确实强，但仓位管理很重要啊' },
  { postIdx: 5, userIdx: 1, content: '我也被SOL套过，不过后来真的涨回来了。信仰！' },
  { postIdx: 6, userIdx: 14, content: 'Good catch. Last time this wallet moved, ETH dropped 8% within 48h.' },
  { postIdx: 6, userIdx: 2, content: 'Could also be an OTC deal though. Not all exchange deposits lead to selling.' },
  { postIdx: 7, userIdx: 11, content: '第三条最重要！多少人赚了15%不走，结果回到起点甚至亏损。' },
  { postIdx: 9, userIdx: 5, content: '兄弟，20倍杠杆确实太高了。建议先从5倍开始练，慢慢加。' },
  { postIdx: 9, userIdx: 18, content: 'I feel you bro. Try reducing leverage to 5-10x max. Your account will thank you.' },
  { postIdx: 9, userIdx: 7, content: '合约不是不适合你，是风险管理没做好。先学会止损再上杠杆。' },
  { postIdx: 10, userIdx: 3, content: '网格交易确实稳，就是需要耐心。请问你用的是哪个平台的网格？' },
  { postIdx: 10, userIdx: 17, content: '月收益3-5%已经很好了，比大部分追涨杀跌的人强多了。' },
  { postIdx: 12, userIdx: 8, content: 'MACD+布林带的组合我也在用，不过我会加一个成交量确认。' },
  { postIdx: 14, userIdx: 16, content: '500万市值的AI项目能分享一下名字吗？我也在找早期项目。' },
  { postIdx: 14, userIdx: 6, content: '又是AI+DePIN...这赛道已经很卷了，要找真正有壁垒的项目。' },
  { postIdx: 17, userIdx: 9, content: 'The key is knowing when to take profits. Most people ride leverage gains back to zero.' },
  { postIdx: 17, userIdx: 0, content: '25x杠杆也太刺激了吧，心脏得够强才行' },
  { postIdx: 18, userIdx: 0, content: '《海龟交易法则》确实经典，趋势跟踪的理念适用于所有市场。' },
  { postIdx: 18, userIdx: 14, content: 'Great book. The position sizing chapter alone is worth the read.' },
  { postIdx: 22, userIdx: 0, content: '判断底部最好的方法是看链上数据，特别是交易所存量变化。不要猜，看数据。' },
  { postIdx: 22, userIdx: 15, content: '分批建仓！不要一次性买入。跌到92K买1/3，88K再买1/3，留1/3等更低的位置。' },
  { postIdx: 23, userIdx: 0, content: '能主动止损就已经超过90%的散户了，加油继续进步！' },
  { postIdx: 23, userIdx: 11, content: '止损是最基本也是最难的事情。恭喜你迈出了这一步👏' },
  { postIdx: 25, userIdx: 1, content: '哈哈哈每次都说最后一次，然后下次还是忍不住梭哈😂' },
  { postIdx: 25, userIdx: 18, content: 'Bro this is me every single time 💀' },
  { postIdx: 26, userIdx: 12, content: '身体健康真的比什么都重要。我现在设了11点强制关电脑的闹钟。' },
  { postIdx: 27, userIdx: 16, content: 'DCA is the way. No stress, no timing the market, just consistent buying.' },
  { postIdx: 33, userIdx: 7, content: '3个屏幕确实是标配，不过我觉得2个也够了，第三个容易分心。' },
  { postIdx: 33, userIdx: 12, content: '人体工学椅才是最值得投资的装备，比任何策略都重要😂' },
  { postIdx: 36, userIdx: 3, content: '参数调整很有道理，加密市场波动大，默认参数确实不够用。' },
  { postIdx: 38, userIdx: 15, content: '长期持仓到底部清算确实很痛。市场永远不缺机会，保住本金最重要。' },
  { postIdx: 39, userIdx: 17, content: '从0.1%涨到0.1%看着不多，但频繁交易的人一年手续费能到几万U。' },
  { postIdx: 42, userIdx: 0, content: '过度拟合是量化新手最容易犯的错误。样本外测试一定要做。' },
  { postIdx: 42, userIdx: 8, content: 'Agreed. If it looks too good to be true in backtest, it probably is.' },
  { postIdx: 44, userIdx: 14, content: 'Airdrop farming is getting more competitive. Early is everything.' },
  { postIdx: 46, userIdx: 8, content: 'Multi-timeframe analysis is the way to go. Single timeframe signals are unreliable.' },
  { postIdx: 47, userIdx: 5, content: '我也被套在105K附近🥲 不过比特币信仰者应该不怕，拿着就好' },
  { postIdx: 47, userIdx: 16, content: '别慌，10万回调到96K很正常。长期看10万就是地板价。' },
  { postIdx: 49, userIdx: 7, content: '推荐！之前盯盘吃薯片，肚子越来越大，换了坚果好多了。' },
  { postIdx: 49, userIdx: 17, content: '绿茶代替咖啡这个好建议，咖啡喝多了晚上睡不着更容易焦虑。' },
];

// ─── Main ───
async function main() {
  console.log('🚀 Starting cold-start seed...\n');

  // 1. Create auth users
  console.log('📦 Creating 20 auth users...');
  const userIds = [];
  for (let i = 0; i < USERS.length; i++) {
    const u = USERS[i];
    try {
      const res = await api('POST', '/auth/v1/admin/users', {
        email: u.email,
        password: 'ArenaTest2026!',
        email_confirm: true,
        user_metadata: { handle: u.handle, email_verified: true },
      });
      userIds.push(res.id);
      console.log(`  ✅ ${u.handle} (${res.id})`);
    } catch (e) {
      // User might already exist; try to find them
      if (e.message.includes('already been registered')) {
        const list = await api('GET', `/auth/v1/admin/users?page=1&per_page=50`);
        const existing = list.users.find(x => x.email === u.email);
        if (existing) {
          userIds.push(existing.id);
          console.log(`  ⏩ ${u.handle} already exists (${existing.id})`);
        } else {
          throw e;
        }
      } else {
        throw e;
      }
    }
  }

  // 2. Upsert user_profiles (trigger may have created them, but update bio/handle)
  console.log('\n📝 Upserting user profiles...');
  for (let i = 0; i < USERS.length; i++) {
    const u = USERS[i];
    try {
      await fetch(`${SB_URL}/rest/v1/user_profiles?id=eq.${userIds[i]}`, {
        method: 'PATCH',
        headers: { ...headers, Prefer: 'return=minimal' },
        body: JSON.stringify({ handle: u.handle, bio: u.bio, email: u.email }),
      });
    } catch (e) {
      console.warn(`  ⚠️ Profile update failed for ${u.handle}: ${e.message}`);
    }
  }
  console.log('  ✅ Profiles updated');

  // 3. Join groups (each user joins 2-3 random groups)
  console.log('\n👥 Joining groups...');
  const memberships = [];
  for (let i = 0; i < userIds.length; i++) {
    const numGroups = 2 + Math.floor(Math.random() * 2); // 2-3
    const shuffled = [...GROUP_IDS].sort(() => Math.random() - 0.5);
    for (let j = 0; j < numGroups; j++) {
      memberships.push({ group_id: shuffled[j], user_id: userIds[i], role: 'member' });
    }
  }
  // Also ensure users are members of groups they'll post in
  for (const post of POSTS) {
    const uid = userIds[post.userIdx];
    const gid = GROUP_IDS[post.groupIdx];
    if (!memberships.find(m => m.user_id === uid && m.group_id === gid)) {
      memberships.push({ group_id: gid, user_id: uid, role: 'member' });
    }
  }
  // Deduplicate
  const uniqueMembers = [...new Map(memberships.map(m => [`${m.user_id}-${m.group_id}`, m])).values()];
  
  // Insert in batches, ignoring conflicts
  for (let i = 0; i < uniqueMembers.length; i += 20) {
    const batch = uniqueMembers.slice(i, i + 20);
    try {
      await fetch(`${SB_URL}/rest/v1/group_members`, {
        method: 'POST',
        headers: { ...headers, Prefer: 'return=minimal,resolution=ignore-duplicates' },
        body: JSON.stringify(batch),
      });
    } catch (e) {
      console.warn(`  ⚠️ Some memberships failed: ${e.message}`);
    }
  }
  console.log(`  ✅ ${uniqueMembers.length} memberships created`);

  // Update member counts
  const groupMemberCounts = {};
  for (const m of uniqueMembers) {
    groupMemberCounts[m.group_id] = (groupMemberCounts[m.group_id] || 0) + 1;
  }

  // 4. Create posts
  console.log('\n📝 Creating posts...');
  const postIds = [];
  const baseDateMs = Date.now() - 7 * 24 * 60 * 60 * 1000; // posts spread over last 7 days
  for (let i = 0; i < POSTS.length; i++) {
    const p = POSTS[i];
    const createdAt = new Date(baseDateMs + (i / POSTS.length) * 7 * 24 * 60 * 60 * 1000).toISOString();
    const postData = {
      title: p.title,
      content: p.content,
      author_id: userIds[p.userIdx],
      author_handle: USERS[p.userIdx].handle,
      group_id: GROUP_IDS[p.groupIdx],
      like_count: Math.floor(Math.random() * 20),
      view_count: 10 + Math.floor(Math.random() * 200),
      created_at: createdAt,
    };
    try {
      const res = await api('POST', '/rest/v1/posts', postData);
      postIds.push(Array.isArray(res) ? res[0].id : res.id);
    } catch (e) {
      console.warn(`  ⚠️ Post ${i} failed: ${e.message}`);
      postIds.push(null);
    }
  }
  console.log(`  ✅ ${postIds.filter(Boolean).length} posts created`);

  // 5. Create comments
  console.log('\n💬 Creating comments...');
  let commentCount = 0;
  for (const c of COMMENTS) {
    const postId = postIds[c.postIdx];
    if (!postId) continue;
    const commentData = {
      post_id: postId,
      author_id: userIds[c.userIdx],
      user_id: userIds[c.userIdx],
      author_handle: USERS[c.userIdx].handle,
      content: c.content,
    };
    try {
      await api('POST', '/rest/v1/comments', commentData);
      commentCount++;
    } catch (e) {
      console.warn(`  ⚠️ Comment failed: ${e.message}`);
    }
  }
  console.log(`  ✅ ${commentCount} comments created`);

  // 6. Create follows (each user follows 2-3 others)
  console.log('\n🔗 Creating follows...');
  const follows = [];
  for (let i = 0; i < userIds.length; i++) {
    const numFollows = 2 + Math.floor(Math.random() * 2);
    const others = userIds.filter((_, j) => j !== i).sort(() => Math.random() - 0.5);
    for (let j = 0; j < numFollows; j++) {
      follows.push({ follower_id: userIds[i], following_id: others[j] });
    }
  }
  const uniqueFollows = [...new Map(follows.map(f => [`${f.follower_id}-${f.following_id}`, f])).values()];
  
  for (let i = 0; i < uniqueFollows.length; i += 20) {
    const batch = uniqueFollows.slice(i, i + 20);
    try {
      await fetch(`${SB_URL}/rest/v1/user_follows`, {
        method: 'POST',
        headers: { ...headers, Prefer: 'return=minimal,resolution=ignore-duplicates' },
        body: JSON.stringify(batch),
      });
    } catch (e) {
      console.warn(`  ⚠️ Some follows failed: ${e.message}`);
    }
  }
  console.log(`  ✅ ${uniqueFollows.length} follow relationships created`);

  console.log('\n🎉 Cold-start seed complete!');
  console.log(`   Users: ${userIds.length}`);
  console.log(`   Group memberships: ${uniqueMembers.length}`);
  console.log(`   Posts: ${postIds.filter(Boolean).length}`);
  console.log(`   Comments: ${commentCount}`);
  console.log(`   Follows: ${uniqueFollows.length}`);
}

main().catch(e => { console.error('❌ Fatal error:', e); process.exit(1); });
