/**
 * Replace seed posts with realistic crypto KOL-style content.
 * Run: NEXT_PUBLIC_SUPABASE_URL=https://iknktzifjdyujdccyhsv.supabase.co SUPABASE_SERVICE_ROLE_KEY=<key> npx tsx scripts/seed-realistic-posts.ts
 */

import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || ''

if (!SUPABASE_SERVICE_KEY) {
  console.error('Missing SUPABASE_SERVICE_ROLE_KEY')
  process.exit(1)
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
})

// Map new handle names used in posts → actual DB handles
const HANDLE_MAP: Record<string, string> = {
  'CryptoWhale': 'crypto_whale_88',
  '0xQuant': '量化小王子',
  'MacroFomo': 'macro_trader_x',
  'AltGems猎手': '山寨币猎人',
  'Degen_Chad': 'leverage_king',
  'OnChainAlpha': 'OnChainSleuth',
  'GridMaster网格': 'grid_bot_guru',
  '波段老王': '波段王者',
  'AlphaSeeker': 'AlphaSeeker_',
  'BookTrader_': '读书炒币两不误',
  '佛系交易员': '币圈养生达人',
  'BTCMaxi₿': 'SatoshiDisciple',
  'DiamondHands💎': 'diamond_hands_69',
  '韭菜翻身记': '币圈老韭菜',
  'CEX_Rater': 'ExchangeRanter',
  'NFT_Degen': 'NFT_Flipper',
  'TA_Master技术流': '技术分析狂人',
  '梭哈战神': '梭哈战神',
  '爆仓日记本': '合约爆仓日记',
}

// ─── Realistic crypto KOL posts ──────────────────────────────────────────────
interface PostDef {
  handle: string
  title: string
  content: string
  like_count: number
  comment_count: number
  view_count: number
  hot_score: number
  hoursAgo: number // hours before now
  poll_enabled?: boolean
  poll_bull?: number
  poll_bear?: number
  poll_wait?: number
}

const POSTS: PostDef[] = [
  // ── Trading Analysis ──
  {
    handle: 'CryptoWhale', title: '$BTC 突破98k，空头大清洗', hoursAgo: 2,
    content: '$BTC 突破98k了，空头要被清算了 🔥\n\n链上数据显示 $97k-$99k 区间有超过 $800M 的空单待清算。一旦突破99k，会触发连环爆仓。\n\n我的判断：短期目标 $102k，如果放量突破就直奔 $110k。\n\n仓位：现货70%满仓，合约3x做多，止损 $95.5k\n\n[sticker:bullish]',
    like_count: 234, comment_count: 67, view_count: 4521, hot_score: 89,
  },
  {
    handle: '波段老王', title: 'ETH 4H级别看涨背离确认', hoursAgo: 5,
    content: 'ETH 4H RSI底背离已经确认了，价格新低但RSI没有新低。\n\n入场计划：\n- 入场：$2,620 附近\n- 止损：$2,550（-2.7%）\n- 目标1：$2,780（+6%）\n- 目标2：$2,920（+11%）\n\n盈亏比 2.2:1，符合我的交易系统。轻仓试单，突破确认后加仓。',
    like_count: 87, comment_count: 23, view_count: 1876, hot_score: 62,
  },
  {
    handle: 'TA_Master技术流', title: 'SOL日线三角形收敛，变盘在即', hoursAgo: 8,
    content: '$SOL 日线已经在三角形里收敛了两周了，成交量持续萎缩。\n\n根据经验，这种形态突破方向跟随大趋势的概率更高（目前BTC趋势向上）。\n\n关键位置：\n- 上破 $195 → 目标 $230\n- 下破 $175 → 回踩 $155\n\n我偏向看多，但等突破确认再入场。不猜方向，跟随市场。',
    like_count: 56, comment_count: 18, view_count: 1204, hot_score: 45,
  },
  {
    handle: 'MacroFomo', title: 'Fed tonight - brace for volatility', hoursAgo: 12,
    content: 'FOMC meeting tonight at 2pm ET. Market pricing in 25bps cut at 92% probability.\n\nMy playbook:\n- If dovish surprise (50bps): risk-on rally, BTC targets $105k\n- If hawkish hold: dump to $90k support, buy the dip\n- If as expected: sell the news, short-term pullback then continuation\n\nReduced leverage to 2x. Cash is a position too.\n\nRemember: don\'t trade the news, trade the reaction. [sticker:careful]',
    like_count: 178, comment_count: 45, view_count: 3890, hot_score: 78,
  },

  // ── PnL Sharing ──
  {
    handle: 'Degen_Chad', title: '今天做多ETH赚了8个点，收工', hoursAgo: 3,
    content: '今天做多ETH赚了8个点，止盈出场 💰\n\n入场 $2,580，出场 $2,786。10x杠杆，本金 $5,000，利润 $4,000。\n\n思路很简单：4H支撑位+放量阳线确认入场，目标前高阻力位。\n\n今天运气好，但不贪。收工去健身了。\n\n[sticker:mooning]',
    like_count: 312, comment_count: 89, view_count: 6234, hot_score: 95,
  },
  {
    handle: 'AlphaSeeker', title: 'Short $DOGE from $0.18, closed at $0.14 ✅', hoursAgo: 18,
    content: 'Called this short 3 days ago when everyone was bullish on DOGE. \n\nEntry: $0.182\nExit: $0.141\nPnL: +22.5% (5x leverage = +112%)\n\nThe setup was textbook: bearish divergence on daily, whale wallets dumping on Nansen, and meme coins always mean-revert after hype cycles.\n\nContrarian trades are the best trades. 🎯',
    like_count: 145, comment_count: 34, view_count: 2876, hot_score: 71,
  },
  {
    handle: 'GridMaster网格', title: '本周网格收益：$1,840', hoursAgo: 25,
    content: '震荡行情就是网格的天堂 🤖\n\n本周BTC在 $95k-$99k 之间反复横跳，我的网格疯狂成交。\n\n参数：\n- 区间：$93,000 - $101,000\n- 格数：80格\n- 单格投入：$150\n\n7天收益：$1,840（年化约78%）\n成交次数：127次\n\n比上班赚得多系列 😂',
    like_count: 98, comment_count: 31, view_count: 2103, hot_score: 58,
  },

  // ── Market Commentary ──
  {
    handle: 'CryptoWhale', title: '链上巨鲸又在囤货了', hoursAgo: 15,
    content: '过去48小时链上数据：\n\n🐳 持有1000+ BTC的地址净增8个\n📉 交易所BTC余额减少12,000枚\n💰 Tether新增印了 $2B USDT\n📊 Coinbase premium转正（美国机构在买）\n\n每次看到这种pattern，接下来2-4周都会有一波大行情。\n\n上次出现类似信号是去年10月，之后BTC从 $27k涨到 $73k。\n\n不是说一定会涨，但概率在我们这边。 [sticker:bullish]',
    like_count: 267, comment_count: 72, view_count: 5678, hot_score: 88,
  },
  {
    handle: 'BTCMaxi₿', title: 'BTC ETF inflows just hit $1.2B in one day', hoursAgo: 20,
    content: 'BlackRock\'s IBIT alone took in $780M yesterday. Total spot BTC ETF inflows: $1.2B.\n\nTo put this in perspective: miners produce ~450 BTC/day ($44M). ETFs are absorbing 27x daily supply.\n\nThis is not retail FOMO. This is institutional allocation. Pension funds, sovereign wealth funds, family offices.\n\nWe are witnessing a supply shock in slow motion. And most people still don\'t understand what\'s happening.\n\nTick tock. 🕐',
    like_count: 389, comment_count: 95, view_count: 8234, hot_score: 96,
  },
  {
    handle: 'OnChainAlpha', title: '警告：某大户刚转入币安8000 ETH', hoursAgo: 7,
    content: '⚠️ 刚监控到一个标记为"Smart Money"的地址往币安转入了 8,000 ETH（约 $21M）。\n\n这个地址的历史操作：\n- 2024/01: 转入交易所后ETH跌了15%\n- 2024/05: 转入交易所后ETH跌了8%\n- 2024/11: 这次没卖，ETH涨了20%\n\n不一定是卖出信号，但值得关注。我已经把ETH仓位的止损收紧到 $2,580。',
    like_count: 156, comment_count: 43, view_count: 3456, hot_score: 73,
  },
  {
    handle: 'MacroFomo', title: 'CPI came in hot - here\'s what it means for crypto', hoursAgo: 28,
    content: 'CPI 3.1% vs 2.9% expected. Core CPI 3.3% vs 3.1% expected. Both hotter than expected.\n\nImmediate reaction: BTC dumped 4% to $94k. Classic knee-jerk.\n\nBut here\'s the thing - the market already priced in rate cuts. A hot CPI means:\n1. Rate cuts delayed → short-term bearish\n2. But inflation = hard assets narrative → mid-term bullish for BTC\n3. Dollar might strengthen → watch DXY\n\nI\'m buying this dip at $93-94k. If $92k breaks, I\'m out.\n\nRemember: the best trades feel the most uncomfortable.',
    like_count: 201, comment_count: 56, view_count: 4567, hot_score: 82,
  },

  // ── Meme / Casual ──
  {
    handle: '爆仓日记本', title: '又被清算了，这市场太疯了', hoursAgo: 4,
    content: '又被清算了 😭\n\n50倍做空BTC，入场 $97,200，清算价 $99,100。结果一根15分钟的大阳线直接插上去把我带走了。\n\n亏了 $2,300。这个月第三次爆仓了。\n\n我知道大家要说什么："降杠杆""设止损""别逆势"。我都懂，但手就是管不住。\n\n明天重新开始... 大概。',
    like_count: 423, comment_count: 156, view_count: 9876, hot_score: 98,
  },
  {
    handle: 'NFT_Degen', title: '买了个新memecoin，已经跌了80%', hoursAgo: 10,
    content: '昨天看到推特上有人喊单一个新的猫猫币，FOMO了，冲了 $500 进去。\n\n结果今天醒来一看... 跌了80% 🤡\n\n合约地址一查，dev钱包持有30%的供应量。经典Rug。\n\n我什么时候才能学会不冲土狗啊？\n\n算了，就当交学费了。$500买了个教训。\n\n[sticker:rekt]',
    like_count: 267, comment_count: 89, view_count: 5432, hot_score: 85,
  },
  {
    handle: '韭菜翻身记', title: '从亏损80%到回本的300天', hoursAgo: 32,
    content: '去年这个时候我的账户亏了80%，只剩 $4,000。\n\n今天，我终于回本了 💪\n\n这300天我做了什么：\n1. 彻底放弃合约，只做现货\n2. 每笔交易不超过总仓位5%\n3. 严格止损，亏2%就跑\n4. 不看推特喊单，自己做分析\n5. 每天写交易日记\n\n最重要的改变：从"赚钱思维"变成"不亏钱思维"。\n\n送给还在亏损的朋友：活着就有希望，先学会不亏，再学赚钱。',
    like_count: 567, comment_count: 178, view_count: 12345, hot_score: 99,
  },
  {
    handle: 'DiamondHands💎', title: 'I\'ve been holding since $16k and I\'m not selling', hoursAgo: 36,
    content: 'Bought BTC at $16,800 during the FTX crash. Everyone called me crazy.\n\nNow it\'s $98k. 5.8x return. And I\'m. Not. Selling.\n\nWhy? Because I didn\'t buy BTC to make dollars. I bought BTC to leave dollars.\n\nMy time horizon is 10+ years. $100k is just the beginning.\n\nTo everyone who sold at $30k, $50k, $70k - I don\'t blame you. Taking profits is smart. But conviction is smarter.\n\n💎🙌 HODL gang where you at?',
    like_count: 445, comment_count: 134, view_count: 8765, hot_score: 93,
  },
  {
    handle: '梭哈战神', title: '全仓SOL，不成功便成仁', hoursAgo: 14,
    content: '刚把所有仓位换成了 $SOL 现货。\n\n理由：\n- Solana生态TVL创新高\n- 新的MEV机器人带来大量链上活动\n- Firedancer客户端即将上线\n- 机构开始申请SOL ETF\n\n目标价：$300\n止损：$160（心理止损，到了再说）\n\n这波如果做对了，今年就提前退休。做错了... 那就继续上班呗 😂\n\n[sticker:yolo]',
    like_count: 189, comment_count: 67, view_count: 3456, hot_score: 76,
  },
  {
    handle: '佛系交易员', title: '冥想完再看盘，心态稳多了', hoursAgo: 22,
    content: '最近开始每天早上冥想20分钟再开始交易。\n\n效果出乎意料：\n- 不再冲动开单了\n- 能更冷静地执行止损\n- 不会因为一笔亏损就心态崩溃\n- 晚上睡眠质量也变好了\n\n推荐 Headspace 的"Focus"系列，专门为需要高度集中注意力的人设计的。\n\n交易赚钱的前提是活得够久。身心健康 > 短期利润。',
    like_count: 134, comment_count: 45, view_count: 2345, hot_score: 63,
  },
  {
    handle: '0xQuant', title: '我的量化策略上周跑赢了BTC 12%', hoursAgo: 40,
    content: '上周策略表现：\n\n📊 策略收益：+18.3%\n📊 BTC同期：+6.1%\n📊 Alpha：+12.2%\n📊 最大回撤：-3.2%\n📊 夏普比率：3.4\n\n核心逻辑：多因子动量+均值回归切换。在趋势明显时追动量，在震荡时做均值回归。\n\n用 Python + CCXT 跑在 AWS 上，延迟约 50ms。\n\n不开源，但可以分享思路。有兴趣的可以在评论区讨论。',
    like_count: 203, comment_count: 78, view_count: 4567, hot_score: 81,
  },
  {
    handle: 'CEX_Rater', title: 'OKX vs Binance vs Bybit: 2026 fee comparison', hoursAgo: 48,
    content: 'Updated fee comparison for spot + futures trading:\n\n🟡 Binance:\n- Spot: 0.1% / 0.1% (maker/taker)\n- Futures: 0.02% / 0.05%\n- Withdrawal: Varies, generally fast\n- Rating: 8/10\n\n🔵 OKX:\n- Spot: 0.08% / 0.1%\n- Futures: 0.02% / 0.05%\n- Withdrawal: Fast, good multi-chain support\n- Rating: 8.5/10\n\n🟣 Bybit:\n- Spot: 0.1% / 0.1%\n- Futures: 0.02% / 0.055%\n- Withdrawal: Sometimes slow during high volume\n- Rating: 7.5/10\n\nVerdict: OKX slightly edges out for active traders due to lower spot maker fees. Binance still has the deepest liquidity.\n\nFull review with screenshots on my profile.',
    like_count: 178, comment_count: 56, view_count: 5678, hot_score: 74,
  },
  {
    handle: 'AltGems猎手', title: '下一个百倍币可能在AI赛道', hoursAgo: 55,
    content: '最近在研究AI+Crypto赛道，发现几个有意思的项目：\n\n1. 去中心化GPU算力市场 - 需求真实且增长快\n2. AI Agent框架 - 让AI自主执行链上操作\n3. 数据标注协议 - 用代币激励众包数据标注\n\n这些项目市值都在 $10M-$50M 之间，团队背景不错，有实际产品。\n\n不喊单，不推荐具体代币。只是分享赛道观察。\n\nDYOR永远是第一原则。上轮牛市的"百倍币"有90%现在已经归零了。\n\n[sticker:dyor]',
    like_count: 156, comment_count: 45, view_count: 3456, hot_score: 68,
  },
  {
    handle: 'BookTrader_', title: '最近在读《Antifragile》，对交易的启发很大', hoursAgo: 60,
    content: 'Taleb的《Antifragile》核心观点：有些东西不仅不怕波动，反而从波动中获益。\n\n应用到交易中：\n\n1. 杠铃策略：90%资金放在极安全的资产（BTC现货），10%放在高风险高回报的机会（早期项目）\n\n2. 小亏大赚：频繁小额止损没关系，关键是抓住少数几次大行情\n\n3. 拥抱不确定性：不要试图预测市场，要构建在任何情况下都能存活的组合\n\n这本书改变了我对风险的理解。强烈推荐。📚',
    like_count: 112, comment_count: 34, view_count: 2345, hot_score: 55,
  },
  {
    handle: 'Degen_Chad', title: 'LMAO 刚才100x做多BTC差点爆仓', hoursAgo: 6,
    content: '100倍杠杆做多BTC，入场 $97,800。\n\n清算价 $96,800。\n\n最低跌到了 $96,850... 离清算只差 $50 😱\n\n然后V型反转直接拉到 $98,500。\n\n利润：+$3,500\n心脏负担：-10年寿命\n\n值得吗？当然值得（不是）\n\n[sticker:sweating]',
    like_count: 356, comment_count: 123, view_count: 7654, hot_score: 92,
  },
  {
    handle: 'OnChainAlpha', title: 'Smart Money在大量买入这个L2', hoursAgo: 30,
    content: 'Nansen标记的Smart Money地址过去一周的操作：\n\n📈 大量买入：\n- 某L2代币：+$15M 净流入\n- ETH：+$32M 净流入\n- LINK：+$8M 净流入\n\n📉 大量卖出：\n- DOGE：-$12M 净流出\n- SHIB：-$6M 净流出\n\n趋势很明显：聪明钱在从meme币转向基础设施。\n\n跟着聪明钱走不一定赚钱，但至少方向不会太离谱。',
    like_count: 189, comment_count: 56, view_count: 4321, hot_score: 77,
  },
  {
    handle: '波段老王', title: '复盘本周3笔交易：2赢1亏', hoursAgo: 45,
    content: '本周波段交易复盘：\n\n✅ Trade 1: BTC多\n入场 $94,200 → 出场 $97,800\n盈利 +3.8%\n依据：日线MA20支撑+4H放量\n\n✅ Trade 2: SOL多\n入场 $178 → 出场 $195\n盈利 +9.6%\n依据：突破下降趋势线+量价配合\n\n❌ Trade 3: ETH空\n入场 $2,680 → 止损 $2,730\n亏损 -1.9%\n反思：逆大趋势做空，不该做\n\n本周总收益：+11.5%\n胜率：66%\n盈亏比：2.8\n\n关键教训：永远不要逆势交易，哪怕技术面看起来很诱人。',
    like_count: 167, comment_count: 45, view_count: 3456, hot_score: 72,
  },
  {
    handle: 'BTCMaxi₿', title: 'Another day, another shitcoin rug 🤷‍♂️', hoursAgo: 52,
    content: 'That "revolutionary AI blockchain" everyone was hyping last week? \n\nTeam just drained the liquidity pool. $4.2M gone. Token down 99%.\n\nMeanwhile BTC is still here. Still producing blocks every 10 minutes. No CEO to rug you. No VC unlock to dump on you.\n\n15 years of uptime. Zero hacks. Truly decentralized.\n\nBut sure, go chase your 1000x memecoins. Have fun staying poor.\n\nBitcoin fixes this. 🧡',
    like_count: 234, comment_count: 89, view_count: 5678, hot_score: 84,
  },
  {
    handle: 'TA_Master技术流', title: 'BTC周线出现看涨吞没，大级别信号', hoursAgo: 70,
    content: '$BTC 周线刚走完一根看涨吞没形态 📊\n\n上周大阴线完全被本周大阳线吞没，配合成交量放大40%。\n\n这个形态在周线级别出现的历史：\n- 2020/03: 出现后涨了 550%\n- 2021/07: 出现后涨了 75%\n- 2023/01: 出现后涨了 180%\n- 2024/09: 出现后涨了 60%\n\n不是说一定会大涨，但历史胜率很高。\n\n我的操作：现货继续持有，合约小仓位做多，止损放在吞没形态低点下方。\n\n[sticker:bullish]',
    like_count: 289, comment_count: 78, view_count: 6543, hot_score: 90,
  },
  {
    handle: '爆仓日记本', title: '给新手的忠告：远离合约', hoursAgo: 75,
    content: '爆仓37次的人给你们的忠告：\n\n如果你是新手，求你了，别碰合约。\n\n我入圈两年，合约亏了 $45,000。如果这些钱全买BTC现货，现在早就翻倍了。\n\n合约的问题不是方向判断，是：\n1. 杠杆让小波动变成致命打击\n2. 24小时市场让你无法睡觉\n3. 爆仓的恐惧让你做出错误决策\n4. 赢了想赢更多，输了想翻本\n\n现在我80%仓位是BTC/ETH现货，20%做低杠杆波段。\n\n活着比赚钱重要。先活下来，再说其他的。',
    like_count: 478, comment_count: 167, view_count: 11234, hot_score: 97,
  },
  {
    handle: 'MacroFomo', title: 'US debt just hit $36T - bullish for BTC', hoursAgo: 80,
    content: 'US national debt just crossed $36 trillion. Let that sink in.\n\n$36,000,000,000,000.\n\nAt current trajectory, debt-to-GDP will hit 150% by 2030. There are only two ways out:\n1. Default (won\'t happen)\n2. Inflate the debt away (already happening)\n\nThis is THE macro case for Bitcoin. A fixed-supply asset in a world of infinite money printing.\n\nEvery central bank in the world is quietly studying Bitcoin. Some are already accumulating.\n\nThe question isn\'t whether BTC will hit $500k. It\'s when.',
    like_count: 312, comment_count: 89, view_count: 7654, hot_score: 87,
  },
  {
    handle: 'NFT_Degen', title: '这波meme season我总结了个规律', hoursAgo: 38,
    content: '经历了3轮meme season，总结出几个规律：\n\n1. 第一波：原创meme涨100-1000x（你抓不住）\n2. 第二波：仿盘meme涨10-50x（大部分人在这进场）\n3. 第三波：垃圾仿盘涨2-5x然后归零（散户接盘）\n4. 最后：所有meme都跌90%+\n\n现在我们在第几波？我觉得在第二波末期。\n\n策略：只玩市值前5的meme，快进快出，不过夜。亏了就跑，赚了也跑。\n\nMeme币的本质是PVP，别假装是价值投资 😂',
    like_count: 234, comment_count: 78, view_count: 5432, hot_score: 83,
  },
  {
    handle: 'AlphaSeeker', title: 'Funding rate极端正，小心回调', hoursAgo: 9,
    content: 'BTC永续合约的funding rate已经到了 0.08%/8h，年化约87%。\n\nHistorically, when funding stays above 0.05% for more than 3 days, we get a correction within a week (73% of the time).\n\nI\'m not calling a top. But I am:\n- Taking 30% profits on longs\n- Moving stops to breakeven\n- Not opening new longs until funding normalizes\n\nGreed is good. But managing greed is better.\n\nData > feelings. Always.',
    like_count: 178, comment_count: 45, view_count: 3876, hot_score: 75,
  },
  {
    handle: 'GridMaster网格', title: '网格 vs 定投：哪个更适合新手？', hoursAgo: 58,
    content: '经常有人问我网格和定投选哪个，分享一下我的看法：\n\n📊 定投（DCA）：\n- 优点：简单，不用判断时机\n- 缺点：牛市顶部也在买\n- 适合：完全不想管的人\n- 预期年化：跟随标的涨幅\n\n📊 网格交易：\n- 优点：震荡行情有超额收益\n- 缺点：需要设置参数，单边行情表现差\n- 适合：愿意花一点时间的人\n- 预期年化：标的涨幅 + 网格利润\n\n我的建议：\n- 60%仓位定投BTC/ETH（长期）\n- 30%仓位跑网格（赚波动）\n- 10%现金等极端机会\n\n两者结合效果最好。',
    like_count: 145, comment_count: 56, view_count: 3210, hot_score: 66,
  },
  {
    handle: '0xQuant', title: 'Backtested 50 strategies - here\'s what actually works', hoursAgo: 85,
    content: 'Spent 6 months backtesting 50 different strategies across 3 years of crypto data. Results:\n\n✅ What works:\n- Trend following (momentum) — Sharpe 1.8\n- Mean reversion on 1H timeframe — Sharpe 1.5\n- Funding rate arbitrage — Sharpe 2.1\n- Grid trading in ranges — Sharpe 1.6\n\n❌ What doesn\'t:\n- RSI overbought/oversold alone — Sharpe 0.3\n- Moving average crossovers — Sharpe 0.7\n- Pattern recognition (H&S, triangles) — Sharpe 0.4\n- Sentiment analysis from Twitter — Sharpe 0.2\n\n🔑 Key insight: Simple strategies with good risk management beat complex strategies with poor risk management. Every. Single. Time.\n\nThe edge is not in the signal. It\'s in the execution.',
    like_count: 289, comment_count: 98, view_count: 6789, hot_score: 91,
  },
  {
    handle: '佛系交易员', title: '为什么我不再看1分钟K线了', hoursAgo: 42,
    content: '以前我盯1分钟K线，一天看200次手机。结果：\n- 频繁交易，手续费吃掉利润\n- 情绪波动剧烈\n- 失眠、焦虑、脾气暴躁\n- 收益反而不好\n\n现在我只看日线和4H：\n- 每天看2-3次就够\n- 一个月交易3-5次\n- 心态稳如老狗\n- 收益反而更好了\n\n越少交易，越赚钱。这个道理很反直觉，但数据不会骗人。\n\n我的月度交易数从40+降到了5次以内，但月均收益从-2%变成了+8%。\n\n少即是多。🧘',
    like_count: 234, comment_count: 67, view_count: 4567, hot_score: 79,
  },
  {
    handle: 'CEX_Rater', title: '昨天Binance又宕机了，受够了', hoursAgo: 16,
    content: 'BTC从 $98k急跌到 $95k的时候，Binance APP直接卡死了。\n\n无法下单、无法平仓、无法设止损。整整3分钟。\n\n3分钟在正常生活中不算什么，但在100倍杠杆的世界里，3分钟可以让你破产。\n\n这已经是今年第5次在关键时刻宕机了。\n\n我的建议：\n1. 不要把所有资金放在一个交易所\n2. 永远提前设好止损\n3. 准备一个备用交易所账户\n4. 关键时刻用API而不是APP\n\n你的钱，你的责任。不要依赖任何中心化平台。',
    like_count: 312, comment_count: 123, view_count: 7890, hot_score: 88,
  },
  {
    handle: 'DiamondHands💎', title: 'DCA into BTC every week since 2022 - results', hoursAgo: 90,
    content: 'Started DCA-ing $200/week into BTC in January 2022. Here are the results after 2 years:\n\n💰 Total invested: $20,800\n💰 Current value: $61,200\n💰 Return: +194%\n💰 Average buy price: ~$32,400\n\nThe best part? I bought through:\n- The Luna crash\n- The FTX collapse\n- The banking crisis\n- Every dip and pump\n\nI never tried to time the market. I just kept buying. Every. Single. Week.\n\nDCA is boring. DCA is unfashionable. DCA works.\n\n[sticker:diamond_hands]',
    like_count: 456, comment_count: 134, view_count: 9876, hot_score: 94,
  },
  {
    handle: '韭菜翻身记', title: '今天终于会画趋势线了，感动', hoursAgo: 50,
    content: '学了3个月，今天终于能自己画趋势线并且判断支撑阻力了 😭\n\n虽然对老手来说这是最基础的东西，但对我这个从零开始的小白来说，真的是很大的进步。\n\n目前学习路径：\n✅ K线基础\n✅ 支撑阻力\n✅ 趋势线\n⬜ 均线系统\n⬜ 成交量分析\n⬜ RSI/MACD\n⬜ 仓位管理\n\n还有很长的路要走，但至少方向是对的。\n\n给同样在学习的朋友：不要急，慢慢来。交易是一辈子的事。',
    like_count: 189, comment_count: 67, view_count: 3456, hot_score: 70,
  },
]

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log('=== Realistic Crypto KOL Posts Seed Script ===\n')

  // Step 1: Get existing seed users
  console.log('[1/4] Fetching existing users...')
  const { data: users, error: usersErr } = await supabase.from('user_profiles').select('id, handle')
  if (usersErr) { console.error(usersErr); process.exit(1) }

  const handleToId = new Map<string, string>()
  for (const u of users || []) {
    handleToId.set(u.handle, u.id)
  }
  console.log(`  Found ${handleToId.size} users`)

  // Step 2: Build post handle → user ID mapping
  console.log('\n[2/4] Building handle mapping...')
  // Map post handles (KOL-style) to actual DB user IDs via HANDLE_MAP
  const postHandleToId = new Map<string, string>()
  for (const [postHandle, dbHandle] of Object.entries(HANDLE_MAP)) {
    const userId = handleToId.get(dbHandle)
    if (userId) {
      postHandleToId.set(postHandle, userId)
      console.log(`  ${postHandle} → ${dbHandle} (${userId.slice(0,8)})`)
    } else {
      console.log(`  Warning: ${dbHandle} not found in DB`)
    }
  }
  
  // Step 3: Delete all existing posts
  console.log('\n[3/4] Deleting existing posts and related data...')
  
  // Delete in order of dependencies
  for (const table of ['comment_likes', 'comments', 'post_votes', 'post_likes', 'post_bookmarks']) {
    const { error } = await supabase.from(table).delete().gte('created_at', '1970-01-01')
    if (error) console.log(`  Warning (${table}): ${error.message}`)
    else console.log(`  Cleared ${table}`)
  }
  
  const { error: delPostsErr, count } = await supabase.from('posts').delete().neq('id', '00000000-0000-0000-0000-000000000000')
  if (delPostsErr) console.log(`  Warning (posts): ${delPostsErr.message}`)
  else console.log(`  Deleted posts`)

  // Step 4: Insert new posts
  console.log('\n[4/4] Creating realistic posts...')
  let created = 0

  for (const post of POSTS) {
    const authorId = postHandleToId.get(post.handle)
    if (!authorId) {
      console.log(`  Skip: ${post.handle} not found`)
      continue
    }

    const dbHandle = HANDLE_MAP[post.handle] || post.handle
    const createdAt = new Date(Date.now() - post.hoursAgo * 3600 * 1000).toISOString()

    const { error } = await supabase.from('posts').insert({
      author_id: authorId,
      author_handle: dbHandle,
      title: post.title,
      content: post.content,
      group_id: null,
      status: 'active',
      like_count: post.like_count,
      comment_count: post.comment_count,
      view_count: post.view_count,
      hot_score: post.hot_score,
      created_at: createdAt,
      updated_at: createdAt,
      poll_enabled: post.poll_enabled || false,
      poll_bull: post.poll_bull || 0,
      poll_bear: post.poll_bear || 0,
      poll_wait: post.poll_wait || 0,
    })

    if (error) {
      console.log(`  Error: ${post.title.slice(0, 40)} - ${error.message}`)
    } else {
      console.log(`  ✅ ${post.handle}: ${post.title.slice(0, 50)}`)
      created++
    }
  }

  console.log(`\n=== Done! Created ${created}/${POSTS.length} posts ===`)
}

main().catch(console.error)
