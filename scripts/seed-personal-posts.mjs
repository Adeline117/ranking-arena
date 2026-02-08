#!/usr/bin/env node
/**
 * Seed personal feed posts (动态) for existing seed users.
 * These posts have group_id = NULL so they appear in the hot page / personal feed.
 *
 * Usage:
 *   node scripts/seed-personal-posts.mjs              # dry run
 *   node scripts/seed-personal-posts.mjs --apply       # insert into DB
 */

import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = 'https://iknktzifjdyujdccyhsv.supabase.co'
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imlrbmt0emlmamR5dWpkY2N5aHN2Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2NjU1MTU1MywiZXhwIjoyMDgyMTI3NTUzfQ.dBTyJ6tPY-eelVj4khLq31RuUg59Opcy5B48zOLLuGE'

const sb = createClient(SUPABASE_URL, SUPABASE_KEY)
const args = process.argv.slice(2)
const DRY_RUN = !args.includes('--apply')

const HANDLES = {
  grid: 'grid_bot_guru',
  futures: '合约爆仓日记',
  swing: '波段王者',
  chain: 'OnChainSleuth',
  bag: '币圈老韭菜',
  noob: '币圈老韭菜',
  allin: '梭哈战神',
  dip: 'diamond_hands_69',
  slacker: '摸鱼交易员',
  health: '币圈养生达人',
  btc: 'SatoshiDisciple',
  defi: 'DeFiHunter',
  alt: 'AltHunter',
  gains: 'GainzKing',
  rant: 'ExchangeRanter',
  quant: 'QuantCoder',
  book: 'BookTrader',
  desk: 'DeskSetupPro',
}

const POSTS = [
  {
    author: 'swing',
    title: '今天的BTC走势完美验证了我的波段模型',
    content: `4H EMA21上穿EMA55，配合放量突破，经典的多头信号。昨晚在97200附近入场，目标看102000。

止损设在95800，风险可控。这种信号今年出现了6次，5次都给了不错的利润。

做波段最重要的就是耐心等信号，不要追涨杀跌。 [sticker:bullish]`,
  },
  {
    author: 'futures',
    title: '合约实盘记录 02/06',
    content: `今天开了两笔：
1. BTC多单 97500进，98200出，+0.7%
2. ETH空单 2780进，2745出，+1.26%

总收益 +1.96%，仓位控制在总资金5%以内。

今天市场波动不大，适合小仓位高频操作。大行情来之前先保住本金。`,
  },
  {
    author: 'noob',
    title: '新手第一个月总结：亏了300U学到的教训',
    content: `入圈一个月了，说说我踩的坑：

1. FOMO追高买了一个土狗，跌了80%
2. 开合约不设止损，扛单到爆仓
3. 看到别人晒单就跟，完全没有自己的判断

虽然亏了300U，但是学到了很多。现在开始认真学技术分析，先从看K线开始。

大家有什么建议给新手的吗？🙏`,
  },
  {
    author: 'chain',
    title: '链上大户又开始囤BTC了',
    content: `刚刚监控到几个鲸鱼地址在过去24小时内从交易所提走了超过3000 BTC。

这种大规模提币通常意味着长期持有意图，是一个比较积极的信号。上次出现类似的链上数据是去年11月，之后BTC涨了30%。

当然，链上数据只是参考之一，不构成投资建议。但值得关注。 [sticker:bullish]`,
  },
  {
    author: 'bag',
    title: '终于解套了！！！持有SOL三个月',
    content: `去年11月在$260买的SOL，一路跌到$170都没割肉。今天终于回到成本价了！！

说实话中间有好几次想割的，特别是跌到$180的时候，心态差点崩了。但是我一直相信SOL的生态在发展，基本面没变。

这次教训就是：不要追高买入，要分批建仓。如果我是在$200-220之间分三次买的，心态会好很多。`,
  },
  {
    author: 'allin',
    title: '梭哈ETH，这次我赌对了 🚀',
    content: `上周在$2650全仓ETH，今天涨到$2800。浮盈5.6%。

虽然大家都说不要梭哈，但有时候你就是有那种直觉——市场情绪到了，技术面也支持。

当然我也做了最坏打算，止损设在$2500，如果跌到那里就认亏出局。不是无脑梭哈。

[sticker:mooning]`,
  },
  {
    author: 'dip',
    title: '又到了我最喜欢的抄底时间',
    content: `恐贪指数跌到25了，市场恐惧情绪浓厚。历史上每次恐贪指数低于25的时候，之后一个月BTC平均涨幅超过20%。

我已经开始分批建仓了：
- 第一笔：BTC $96000 买入 10%仓位 ✅
- 第二笔：如果跌到$93000 再买10%
- 第三笔：如果跌到$90000 加仓15%

别人恐惧我贪婪。当然前提是你要有闲钱，不要拿生活费来抄底。`,
  },
  {
    author: 'health',
    title: '交易员养生指南：如何在高压下保持健康',
    content: `做了三年全职交易员，身体差点废了。分享一下我的养生经验：

🧘 每天冥想15分钟 - 对控制交易情绪特别有帮助
🏃 每天至少运动30分钟 - 久坐看盘真的伤身
😴 严格11点前睡觉 - 熬夜看美盘得不偿失
🍵 戒了咖啡改喝茶 - 咖啡让我焦虑加重

自从开始注重健康，交易成绩反而变好了。心态稳了，不容易冲动交易。

身体是革命的本钱，别为了赚钱把身体搞坏了。`,
  },
  {
    author: 'btc',
    title: 'Bitcoin is the only investment you need',
    content: `I've been in crypto since 2017 and the lesson is simple: just stack sats.

Every alt season people get excited about the "next ETH killer" or some random DeFi token. A year later, 90% of them are dead. Meanwhile BTC keeps hitting new ATHs.

My strategy: DCA $500/week into BTC. No trading, no leverage, no stress. Up 340% since I started.

Stay humble, stack sats. [sticker:bullish]`,
  },
  {
    author: 'defi',
    title: 'Current DeFi yield farming opportunities',
    content: `Quick overview of what I'm farming right now:

1. Aave V3 (ETH) - Supplying USDC, ~4.2% APY. Safe and boring.
2. Pendle - PT-stETH, locked yield ~5.8% APY until June
3. Ethena USDe staking - ~12% APY but higher risk
4. GMX GLP on Arbitrum - ~15% APY in ETH+esGMX

Total portfolio allocation: 40% stables, 30% ETH-denominated, 30% higher risk.

Remember: if you can't explain where the yield comes from, you ARE the yield. DYOR always.`,
  },
  {
    author: 'alt',
    title: 'My top altcoin picks for Q1 2026',
    content: `After doing extensive research, here are my top picks:

1. **RENDER** - AI narrative is strong, real revenue, good tokenomics
2. **TIA** - Modular blockchain thesis still early
3. **PENDLE** - DeFi yield trading, actual product-market fit
4. **INJ** - Strong ecosystem growth in Asia

Allocation: 50% BTC, 20% ETH, 30% split across these alts.

NFA obviously. Do your own research. But I'm putting my money where my mouth is.`,
  },
  {
    author: 'gains',
    title: 'From $5k to $47k in 4 months - my journey',
    content: `Started with $5,000 last October. Current portfolio: $47,200. Here's how:

Week 1-4: Studied charts 8 hours a day. Paper traded only.
Month 2: Started real trading, small positions. Focused on BTC breakouts.
Month 3: Caught the SOL run from $180 to $260. This was the big one.
Month 4: Diversified into DeFi yields + swing trading.

Key learnings:
- Patience > everything. I missed 20 trades I wanted to take. Good.
- Size up slowly. I didn't use my full capital until month 3.
- Take profits. I sold 50% of my SOL at $240. Didn't catch the top but locked in gains.

[sticker:mooning]`,
  },
  {
    author: 'rant',
    title: '某交易所又出问题了，大家小心',
    content: `今天早上想提币，结果"系统维护"四个小时。每次行情大的时候就维护，这不是巧合吧？

而且手续费又偷偷涨了，之前maker 0.02%，现在变0.035%了。公告都没发。

建议大家：
1. 不要把所有资金放一个交易所
2. 大额资金用硬件钱包存
3. 定期提币，交易所只留交易需要的

Not your keys, not your coins. 这句话永远不过时。`,
  },
  {
    author: 'quant',
    title: 'Built a simple mean-reversion bot - sharing results',
    content: `Been running a mean-reversion bot on BTC/USDT for 2 weeks. Here are the stats:

- Strategy: Buy when price drops >2% below 1H VWAP, sell at VWAP
- Win rate: 71.4% (30/42 trades)
- Avg profit per trade: 0.34%
- Max drawdown: -1.8%
- Sharpe ratio: 2.1
- Total PnL: +8.7%

Running on a $10k account. Nothing fancy - just Python + CCXT + a VPS.

The edge is small but consistent. Works best in ranging markets. I pause it during high-volatility events.

Happy to share the general logic if people are interested. Not the exact code though 😄`,
  },
  {
    author: 'book',
    title: 'Book review: "Market Wizards" by Jack Schwager',
    content: `Just finished re-reading Market Wizards for the third time. Some timeless quotes:

"The market does not know you exist. You can do nothing to influence it." 

"Risk management is the most important thing to be well understood."

"The key to trading success is emotional discipline."

Every time I read this book, I pick up something new. If you haven't read it yet, stop trading and go read it first. Seriously.

Also recommend:
- Reminiscences of a Stock Operator
- Trading in the Zone
- The Black Swan

这几本书是交易员必读的，中文版翻译质量也不错。`,
  },
  {
    author: 'desk',
    title: '晒一下我的交易工位 💻',
    content: `最近升级了一下交易桌面：

- 三屏显示器：主屏看K线，副屏看订单簿和深度图，第三屏看Twitter和新闻
- 机械键盘：Cherry MX静音红轴，打字不吵
- 人体工学椅：Herman Miller Aeron，坐一天不累
- 站立升降桌：久坐不健康，每两小时站一会

总共花了大概两万块，但工欲善其事必先利其器。舒适的环境能让你保持更好的交易状态。

大家的交易工位是什么样的？`,
  },
  {
    author: 'slacker',
    title: '摸鱼的时候偷偷看了一眼盘，结果...',
    content: `上班摸鱼看了一眼BTC，发现跌了2%。手贱开了个多单，然后老板走过来了...

赶紧切回工作界面，等下班一看：止损了 😭

摸鱼交易的教训：
1. 不要在工作时间交易（认真的）
2. 如果非要看，设好止损止盈再说
3. 手机交易太容易冲动了

好了不说了，继续搬砖了。大家上班的时候也少看盘吧。`,
  },
  {
    author: 'grid',
    title: '网格交易一周报告：稳定收益2.3%',
    content: `这周的网格交易数据：

交易对：BTC/USDT
网格范围：$95,000 - $100,000
网格数量：50
投入资金：$20,000

本周成交：127笔
总收益：$460 (+2.3%)
年化收益：约120%

网格交易最适合震荡行情。这周BTC在96k-99k之间反复横跳，简直是网格的天堂。

缺点就是突破的时候很尴尬，要么踏空要么被套。所以我只用总资金的20%来做网格。`,
  },
  {
    author: 'futures',
    title: '给合约新手的忠告：先模拟盘练三个月',
    content: `看到越来越多新人直接上合约，真的很担心。

合约不是不能做，但你至少要：
1. 理解什么是维持保证金和强平价格
2. 会计算仓位大小（凯利公式了解一下）
3. 有一个经过回测的交易系统
4. 能控制自己的情绪

建议先在模拟盘（testnet）练习至少三个月。不要觉得浪费时间，实盘亏钱才是真的浪费。

我见过太多人一个月就把本金亏光了。合约是放大器，放大收益的同时也放大亏损和情绪。`,
  },
  {
    author: 'chain',
    title: 'Interesting on-chain data: stablecoin inflows surging',
    content: `USDT and USDC supply on exchanges has increased by $2.8B in the past week. This is the largest weekly inflow since November 2024.

What this means:
- Capital is flowing into crypto exchanges
- Buyers are loading up, potentially preparing for purchases
- Historical correlation: stablecoin inflows precede price rallies by 1-2 weeks

Also notable: ETH exchange reserves continue to drop, now at 2-year lows. Supply squeeze incoming?

Data sources: Glassnode, DefiLlama, CryptoQuant

Not financial advice, just sharing data. [sticker:bullish]`,
  },
  {
    author: 'noob',
    title: '求推荐：适合新手的交易所和钱包',
    content: `刚入圈，被各种交易所和钱包搞晕了。目前在纠结几个问题：

1. 交易所选哪个？看到推荐Binance和OKX的都有
2. 钱包用MetaMask还是其他的？
3. 买BTC的话需要先买USDT吗？
4. 什么是gas费？为什么转个账还要手续费？

感觉要学的东西好多啊，但又很怕错过行情。求各位前辈指点一下方向 🙏`,
  },
  {
    author: 'defi',
    title: 'PSA: Always check contract approvals',
    content: `Friendly reminder to regularly check and revoke your token approvals.

I just reviewed mine and found 23 unlimited approvals to random DeFi protocols I haven't used in months. Any one of these could drain my wallet if the contract gets compromised.

Tools to check:
- revoke.cash
- etherscan token approval checker
- rabby wallet (shows approvals natively)

Takes 5 minutes, could save your entire portfolio. Do it now.

Also: use a separate wallet for degen plays. Keep your main stack in a hardware wallet.`,
  },
  {
    author: 'alt',
    title: '为什么我开始关注AI+Crypto赛道',
    content: `AI和Crypto的结合可能是下一个大叙事。几个值得关注的方向：

1. **去中心化算力** - Render, Akash, io.net
2. **AI Agent经济** - 自主交易、自主管理资金的AI
3. **数据市场** - Ocean Protocol, The Graph
4. **AI辅助交易** - 用AI优化交易策略

现在还很早期，大部分项目可能会失败。但如果押对了，回报可能是100x级别的。

我的策略：小仓位（总资金5%以内）分散投几个龙头项目。亏了不心疼，涨了有惊喜。`,
  },
  {
    author: 'gains',
    title: 'Weekly PnL: +$3,200 📈',
    content: `This week's trades:

✅ BTC long: +$1,800 (caught the bounce at $96.5k)
✅ SOL long: +$900 (breakout above $210)
✅ ETH short: +$700 (rejection at $2,850)
❌ DOGE long: -$200 (stopped out)

Net: +$3,200 / +6.4% on portfolio

Best trade: The BTC long. Saw bullish divergence on 4H RSI + strong bid wall at $96.5k. Entered with tight stop, let it run.

Worst trade: DOGE. Shouldn't have traded it. Low conviction, just FOMO'd in.

Lesson: stick to your A-setups, skip the B and C ones. [sticker:mooning]`,
  },
  {
    author: 'health',
    title: '冥想对交易的帮助比你想象的大',
    content: `之前觉得冥想是玄学，但坚持了半年后，交易成绩明显提升了。

具体变化：
- 止损不再犹豫了。以前总想"再等等"，现在到了就走
- 不再报复性交易。亏了一笔后能冷静下来，不急着回本
- 能更客观地看待市场。不再被涨跌影响情绪

推荐的冥想方式：
1. Headspace app的基础课程（英文）
2. 潮汐app（中文）
3. 简单的呼吸冥想：4秒吸气，7秒屏气，8秒呼气

每天只要10-15分钟，坚持一个月就能感受到变化。试试看？`,
  },
  {
    author: 'grid',
    title: '用Python写了个网格交易回测工具',
    content: `花了一周时间写了个回测工具，可以测试不同参数下的网格交易表现。

功能：
- 自定义网格范围、数量、投入资金
- 支持等差和等比网格
- 自动计算收益率、最大回撤、夏普比率
- 生成可视化报告

回测了BTC过去一年的数据，发现：
- 等比网格比等差网格收益高15%左右
- 网格数量50-80个最优
- 范围太窄容易突破，太宽单格利润太低

代码放在GitHub了，有兴趣的可以私信我要链接。开源免费的。`,
  },
  {
    author: 'slacker',
    title: '发现一个看盘不被老板发现的技巧',
    content: `分享一个"实用"技巧（不是教唆大家摸鱼啊 😂）

把TradingView的配色改成跟IDE一样：
- 背景色改成深色
- K线颜色改成绿色和白色
- 字体用等宽字体

远看就像在写代码。亲测有效，老板走过来都没发现。

当然最好还是专心工作啦。设好挂单和止损，上班时间就不要看了。

...好吧我自己也做不到 🫠`,
  },
  {
    author: 'btc',
    title: 'The halving effect is real - historical analysis',
    content: `Every Bitcoin halving has preceded a major bull run:

- 2012 halving → BTC went from $12 to $1,100 (91x)
- 2016 halving → BTC went from $650 to $20,000 (30x)  
- 2020 halving → BTC went from $8,700 to $69,000 (8x)
- 2024 halving → We're currently at $97k, started at $64k...

The diminishing returns are clear, but even a 3-4x from the halving price would put us at $190k-$256k.

I'm not saying we'll definitely get there, but the pattern is hard to ignore. Stack sats and be patient.

Time in the market > timing the market.`,
  },
  {
    author: 'dip',
    title: '恐慌指数跌破20了，贪婪模式开启',
    content: `Crypto Fear & Greed Index刚刚跌到19，极度恐惧区域。

历史上每次恐贪指数低于20：
- 2022年6月（Luna后）：之后3个月涨40%
- 2022年11月（FTX后）：之后6个月涨90%
- 2024年8月：之后2个月涨35%

我已经开始执行抄底计划了。今天买入：
- BTC: 15%仓位 @ $96,200
- ETH: 10%仓位 @ $2,720

如果继续跌，我还有弹药。不怕跌，怕的是没钱买。 [sticker:bullish]`,
  },
  {
    author: 'quant',
    title: 'Backtesting pitfalls every algo trader should know',
    content: `After 2 years of algo trading, here are the mistakes that cost me the most:

1. **Overfitting** - My first bot had 15 parameters. Looked amazing in backtest, terrible live. Now I use max 3-4 parameters.

2. **Survivorship bias** - Only backtesting on coins that still exist. Include delisted tokens.

3. **Ignoring slippage & fees** - A strategy that makes 0.1% per trade becomes -0.05% after fees.

4. **Look-ahead bias** - Using data that wouldn't be available in real-time. Subtle but deadly.

5. **Not accounting for market regime changes** - A strategy that works in a bull market will blow up in a bear.

Rule of thumb: if your backtest looks too good to be true, it is.`,
  },
  {
    author: 'bag',
    title: '被套选手的自我修养：如何优雅地扛单',
    content: `作为一个经常被套的人（别笑），总结一些扛单的心得：

1. 先问自己：如果现在没有持仓，你会在这个价格买入吗？如果不会，就该止损了。

2. 不要频繁看账户。我把App通知关了，每天只看一次。

3. 利用被套的时间学习。与其焦虑不如看书学技术分析，下次争取不被套。

4. 如果决定扛，就要有计划：什么价格减仓，什么价格加仓，什么价格彻底割肉。

5. 永远不要all in。留有余地，被套也不至于影响生活。

共勉。被套不可怕，可怕的是没有计划地被套。`,
  },
  {
    author: 'allin',
    title: '这次我没梭哈，成长了',
    content: `以前的我看到BTC跌就忍不住全仓抄底，这次忍住了。

只买了20%仓位，剩下的等确认信号再加。虽然如果直接V反我会少赚一些，但至少不会像上次一样被套在半山腰。

交易这件事，最难的不是判断方向，而是管住自己的手。

立个flag：今年不再梭哈。如果做到了，年底请大家喝奶茶 🧋`,
  },
  {
    author: 'rant',
    title: 'Why do exchanges still go down during volatility?',
    content: `It's 2026 and exchanges STILL crash during high-volatility events. This is unacceptable.

Today's dump: BTC dropped 3% in 5 minutes. Tried to close my position on [redacted exchange]. Error 502. For 8 minutes.

By the time it came back, my unrealized PnL went from +$500 to -$300. Thanks.

Solutions:
1. Use limit orders instead of market orders
2. Set stop-losses in advance (don't rely on manual closing)
3. Keep accounts on 2-3 exchanges
4. Consider DEX perps (dYdX, GMX) as backup

This industry needs to do better. We're handling billions but can't keep servers up.`,
  },
  {
    author: 'desk',
    title: 'Monitor recommendation for crypto trading',
    content: `Got a lot of DMs after my desk post, so here's my monitor setup in detail:

**Main chart monitor:** LG 32UN880 (32" 4K IPS)
- Great color accuracy, good for long sessions
- USB-C connection, clean cable management

**Order book / data:** Dell U2723QE (27" 4K)  
- Portrait mode for depth charts
- Thin bezels for multi-monitor

**News / social:** Any decent 24" is fine

Tips:
- Get an arm mount, saves desk space
- Match resolution (all 4K or all 1440p) to avoid scaling issues
- IPS > VA for viewing angles when you have multiple screens
- Night mode / blue light filter is essential for late sessions

Total monitor budget: ~$1,500 for a solid 3-screen setup.`,
  },
  {
    author: 'swing',
    title: 'ETH/BTC ratio at historical low - opportunity?',
    content: `The ETH/BTC ratio just touched 0.028, the lowest since 2021. 

Historically, extreme low readings on this ratio have preceded major ETH outperformance periods. The mean-reversion trade here is compelling.

My plan:
- Converting 20% of my BTC position to ETH
- Target: ETH/BTC 0.04 (43% upside in ratio terms)
- Stop: ETH/BTC 0.024

This is a longer-term trade, probably 2-3 months. Not for everyone, but the risk/reward looks good to me.

What do you think? Is ETH cooked or just undervalued?`,
  },
]

function randomDate(daysAgo) {
  const now = new Date()
  const ms = now.getTime() - daysAgo * 24 * 60 * 60 * 1000
  return new Date(ms + Math.random() * daysAgo * 24 * 60 * 60 * 1000 * 0.8)
}

async function main() {
  // Fetch user IDs
  const handles = Object.values(HANDLES)
  const { data: users, error } = await sb
    .from('user_profiles')
    .select('id, handle')
    .in('handle', handles)

  if (error) { console.error('Failed to fetch users:', error); process.exit(1) }

  const userMap = {}
  for (const u of users) userMap[u.handle] = u.id
  console.log(`Found ${users.length}/${handles.length} seed users`)

  const missing = handles.filter(h => !userMap[h])
  if (missing.length) console.warn('Missing:', missing.join(', '))

  const rows = POSTS.map((p, i) => {
    const handle = HANDLES[p.author]
    const authorId = userMap[handle]
    if (!authorId) return null

    const createdAt = randomDate(5) // spread over last 5 days
    const hotScore = Math.floor(Math.random() * 80) + 20
    const likeCount = Math.floor(Math.random() * 25) + 2
    const viewCount = Math.floor(Math.random() * 300) + 50
    const commentCount = Math.floor(Math.random() * 10)

    return {
      group_id: null,
      author_id: authorId,
      author_handle: handle,
      title: p.title,
      content: p.content,
      status: 'active',
      created_at: createdAt.toISOString(),
      updated_at: createdAt.toISOString(),
      hot_score: hotScore,
      like_count: likeCount,
      view_count: viewCount,
      comment_count: commentCount,
      dislike_count: 0,
      poll_enabled: false,
      is_pinned: false,
    }
  }).filter(Boolean)

  console.log(`Prepared ${rows.length} personal feed posts`)

  if (DRY_RUN) {
    for (const r of rows) {
      console.log(`📝 [${r.author_handle}] ${r.title} (hot:${r.hot_score})`)
    }
    console.log('\nDry run. Use --apply to insert.')
    return
  }

  // Insert in batches of 10
  for (let i = 0; i < rows.length; i += 10) {
    const batch = rows.slice(i, i + 10)
    const { error: insertErr } = await sb.from('posts').insert(batch)
    if (insertErr) {
      console.error(`Insert error at batch ${i}:`, insertErr)
    } else {
      console.log(`✅ Inserted batch ${i / 10 + 1} (${batch.length} posts)`)
    }
  }

  // Verify
  const { count } = await sb
    .from('posts')
    .select('*', { count: 'exact', head: true })
    .is('group_id', null)
    .eq('status', 'active')

  console.log(`\n✅ Done! Total personal feed posts in DB: ${count}`)
}

main()
