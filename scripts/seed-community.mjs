#!/usr/bin/env node
/**
 * Seed community with realistic trading discussion posts and comments.
 * Creates 20 high-quality posts across various trading topics with 2-5 comments each.
 *
 * Usage:
 *   node scripts/seed-community.mjs              # dry run
 *   node scripts/seed-community.mjs --apply       # insert into DB
 *   node scripts/seed-community.mjs --apply --cleanup  # delete seeded posts first
 */

import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

const sb = createClient(SUPABASE_URL, SUPABASE_KEY)

const args = process.argv.slice(2)
const DRY_RUN = !args.includes('--apply')
const CLEANUP = args.includes('--cleanup')

// Seed user handles (must exist in user_profiles already from seed-community.ts)
const HANDLES = {
  grid: '网格大师',
  futures: '合约老手',
  swing: '波段猎人',
  chain: '链上侦探',
  bag: '被套小王子',
  noob: '韭菜日记',
  allin: '梭哈勇士',
  dip: '抄底达人',
  slacker: '摸鱼队长',
  health: '养生交易员',
  btc: 'BTCMaxi',
  defi: 'DeFiFarmer',
  alt: 'AltHunter',
  gains: 'GainzKing',
  rant: 'ExchangeRanter',
  quant: 'QuantCoder',
  book: 'BookTrader',
  desk: 'DeskSetupPro',
}

// ─── Posts ────────────────────────────────────────────────────────────────────

const POSTS = [
  // 1. 技术分析 - 中文
  {
    author: 'swing',
    title: '分享一个我用了三年的波段入场方法',
    content: `之前一直有人问我怎么判断入场点，今天整理一下我的方法。

核心逻辑很简单：4H级别EMA21和EMA55的交叉配合成交量确认。不是说金叉就买、死叉就卖那么粗暴，关键在于过滤假信号。

我的过滤条件：
1. 交叉发生时，价格必须在日线EMA200上方（多头环境）
2. 交叉那根K线的成交量必须大于前10根的均量
3. RSI不能超买（我设70）

回测了BTC从2020到现在的数据，胜率大概62%，盈亏比1.8左右。不算特别高，但重点是回撤可控，最大回撤没超过15%。

有几个坑要注意：
- 横盘震荡的时候会被反复打脸，所以我加了个ADX过滤，ADX低于20的时候不开仓
- 别贪，到了第一目标位先减半仓，剩下的用移动止损

大家有什么好的入场方法也可以分享一下，互相学习。`,
    comments: [
      { author: 'futures', content: '这个方法在合约上也能用，我之前试过类似的，不过我用的是1H级别。4H确实信号更稳，但是经常错过快速行情。你一般是挂限价单还是突破进？' },
      { author: 'noob', content: '小白问一下，EMA21和EMA55是什么意思啊？我现在还在看教程阶段，很多指标都不太懂...' },
      { author: 'swing', content: '回楼上，EMA就是指数移动平均线，21和55是周期数。你可以先从理解均线开始，B站搜"均线入门"有很多不错的教程。不着急，慢慢来。' },
      { author: 'quant', content: 'Nice framework. I backtested a similar EMA crossover system on ETH and SOL — works okay on ETH but SOL is too choppy. Have you tried adding a volatility filter like Bollinger Band width?' },
    ],
  },

  // 2. 风险管理
  {
    author: 'futures',
    title: '经历了三次爆仓之后，我终于理解了什么叫风险管理',
    content: `说出来不怕丢人，去年我爆了三次仓，总共亏了大概12万U。

第一次：Luna崩盘的时候抄底，10x杠杆，觉得不可能跌到0。结果你们都知道了。
第二次：FTX暴雷后，做多BTC，20x，以为利空出尽。结果又跌了20%。
第三次：今年初的时候，做空ETH，5x，觉得merge后会跌。结果被轧空了。

每次的共同点：仓位太重，止损太远（或者根本没设止损）。

现在我的规则：
- 单笔亏损不超过总资金2%，算好仓位再开
- 止损下了就不动，绝对不移止损
- 最多同时持有3个仓位
- 盈利20%以上才考虑加仓，而且加仓量不超过初始仓位的一半

说真的，这些道理谁都知道，但真正做到需要交很多学费。希望能帮到还没爆过仓的朋友。`,
    comments: [
      { author: 'bag', content: '感同身受。我虽然没爆仓但被套了半年的ETH，现在终于解套了。回头看当时就是仓位太重，全仓在3800买的...' },
      { author: 'allin', content: '2%也太保守了吧，那得什么时候才能翻身啊。我一般10%-15%止损，不然根本赚不到大钱。' },
      { author: 'futures', content: '兄弟，你这个想法我之前也有，但你算一下：亏50%需要涨100%才能回本。控制风险不是保守，是活得久。市场永远有机会，但前提是你还有子弹。' },
      { author: 'health', content: '完全同意。我之前也是重仓选手，后来胃出了毛病才意识到交易跟身体健康是一回事——急不来。现在每天冥想15分钟，交易心态好了很多。' },
      { author: 'book', content: 'This is basically what Van Tharp talks about in "Trade Your Way to Financial Freedom" — position sizing is THE most important factor. Highly recommend that book if you haven\'t read it.' },
    ],
  },

  // 3. 交易心理 - 英文
  {
    author: 'book',
    title: 'The one mindset shift that made me profitable',
    content: `I traded for 2.5 years before becoming consistently profitable. Tried every indicator, every strategy, every timeframe. Nothing worked until I changed ONE thing: I stopped trying to be right.

Sounds weird, but hear me out. When you focus on being "right" about the market direction, you:
- Hold losers too long (can't admit you're wrong)
- Cut winners too early (want to lock in being "right")
- Overtrade (need to prove yourself after a loss)

When I switched to thinking in probabilities, everything changed. I don't care if THIS trade wins. I care if my SYSTEM wins over 100 trades. 

The practical shift was simple: I started keeping a trade journal. Every single trade, I write down:
1. Why I entered
2. Where my stop is and why
3. My R:R target
4. How I FEEL (this one's important)

After 3 months of journaling, patterns emerged. I noticed I always revenge-traded after 2pm when I was tired. I noticed I sized up after winning streaks. I noticed I skipped setups when I was "bored" of the market.

Fixing those behavioral patterns did more than any new indicator ever could.

Anyone else journal their trades? Curious what insights you've found.`,
    comments: [
      { author: 'health', content: '交易日记真的很重要！我用Notion记了一年多了，最大的发现是我在周一和周五的胜率明显低于其他三天。可能跟情绪有关，周一刚开始工作，周五想着周末。' },
      { author: 'gains', content: 'Journaling is cool but honestly? My biggest mindset shift was accepting that I\'m going to miss most moves and that\'s FINE. FOMO used to wreck me. Now I just wait for MY setup.' },
      { author: 'noob', content: 'Started journaling last week thanks to this sub! Only 5 entries so far but I already see that I always enter too early. Working on patience.' },
    ],
  },

  // 4. 平台对比
  {
    author: 'rant',
    title: 'Honest comparison: Binance vs OKX vs Bybit for copy trading in 2025',
    content: `I've been testing copy trading on all three platforms for 6 months. Here's my brutally honest take:

**Binance Copy Trading**
- Largest pool of traders to copy
- Data is the most transparent (you can see full history)
- BUT: the top traders have too many copiers, slippage is real
- Fees: standard, nothing special
- UI: decent but cluttered

**OKX Copy Trading**
- Better filtering tools (you can filter by max drawdown, which is huge)
- Smaller but higher quality trader pool
- The "smart portfolio" feature is actually useful
- BUT: some traders game the stats by opening tiny positions
- Fees: competitive

**Bybit Copy Trading**
- Best UI hands down, very clean
- Good for beginners
- BUT: trader pool is the smallest
- Some traders disappear (account goes inactive)
- Pro plan is worth it if you're serious

My recommendation:
- Beginners → Bybit (simplest)
- Data nerds → OKX (best filters)  
- Want the most options → Binance (largest pool)

The dirty secret none of them tell you: most copy trading returns look great until you factor in slippage. The trader's reported PnL and YOUR actual PnL can differ by 5-15%. Always check your actual fills.

What's your experience been?`,
    comments: [
      { author: 'quant', content: 'The slippage point is critical. I wrote a script to compare the leader\'s entries vs my copied entries on Binance — average slippage was 0.3% per trade, which compounds fast. That\'s why I switched to building my own bots.' },
      { author: 'grid', content: '说到跟单，我觉得最大的问题是大部分"明星交易员"都是靠运气好上的榜。你去看他们连续3个月以上的数据，很多就没那么好看了。还不如自己学网格交易，稳定多了。' },
      { author: 'desk', content: 'I use Bybit for copy trading on one of my secondary monitors. The UI is genuinely nice. But I agree the pool is too small — ended up running out of good traders to follow after a month.' },
      { author: 'slacker', content: '我在班上偷偷跟单用的OKX，界面还行，主要是手机端体验比较好，领导在背后走过也看不太出来是在炒币 😂' },
    ],
  },

  // 5. 链上分析
  {
    author: 'chain',
    title: '分享几个免费的链上数据工具，不比Nansen差',
    content: `很多人觉得链上分析需要花大钱买Nansen之类的工具，其实免费工具也很强。我常用的几个：

**1. Dune Analytics (dune.com)**
完全免费，社区写的dashboard质量很高。我关注的几个：
- @hildobby 的 ETH staking dashboard
- DEX volume tracking dashboard
- Stablecoin flow dashboard

**2. DefiLlama (defillama.com)**
TVL数据的标准，但很多人不知道它还有：
- Yields页面可以看各链各协议的收益率
- Stablecoin页面可以看资金流入流出
- Raises页面可以追踪融资

**3. Arkham Intelligence (platform.arkhamintel.io)**
巨鲸追踪神器，免费版就够用了。我用它追踪了几个聪明钱地址，他们大规模买入ETH的时候往往是波段底部。

**4. Token Terminal (tokenterminal.com)**
协议基本面数据，可以看收入、费用、P/E ratio这些传统金融指标应用到DeFi上。

**5. Glassnode Studio (免费版)**
BTC链上指标的天花板。MVRV、SOPR、Exchange Flow这些指标免费版都能看。

建议大家至少关注两个指标：
- 交易所净流入/流出：大量流出通常意味着积累
- 稳定币总量变化：资金面的领先指标

有什么其他好用的工具欢迎补充！`,
    comments: [
      { author: 'defi', content: 'DeFi Llama is goated. I use their yield optimizer to find the best farms across chains. Pro tip: sort by "audited" and filter out anything under 30 days old. Saved me from a few rugs.' },
      { author: 'noob', content: '太好了，先收藏了！请问用这些工具需要什么基础知识吗？我现在连K线都还没完全看懂...' },
      { author: 'chain', content: '回楼上：建议先看懂基本的K线和成交量，然后从DefiLlama开始用，它最直观。Dune需要一点SQL基础，但你可以直接用别人写好的dashboard。不用着急全学，一个一个来。' },
      { author: 'btc', content: 'Glassnode is the only one you need for Bitcoin. All other chains are just noise. Check the Long Term Holder supply — when it starts declining, bull market is getting heated.' },
    ],
  },

  // 6. 网格交易
  {
    author: 'grid',
    title: '网格交易参数设置分享：BTC震荡行情下的实战配置',
    content: `最近BTC在92k-105k区间震荡了快一个月了，这种行情最适合网格。分享一下我当前跑的配置：

交易对：BTC/USDT
区间：90,000 - 108,000
网格数：60
每格投入：约50U
总投入：约3,000U

一个月下来收益率大概4.2%，年化50%左右。不算暴利但胜在稳定。

几个经验：
1. 网格数不是越多越好。太密的话手续费会吃掉大部分利润。我一般用价格区间除以200作为单格间距。
2. 一定要设止损。如果跌破区间下限太多，网格变成被动持仓，不如直接止损重新开。
3. 可以同时开一个大区间的网格（保底）和一个小区间的网格（高频），互相配合。
4. 别在单边行情里跑网格，会被教做人。我用ADX>25判断趋势，趋势强的时候就暂停网格。

大家目前跑网格的收益怎么样？`,
    comments: [
      { author: 'quant', content: 'I automated grid trading with a custom Python bot. The key insight most people miss: dynamic grid spacing based on volatility (ATR). Wide grids when vol is high, tight grids when it\'s low. My annualized went from ~35% to ~55% after this change.' },
      { author: 'slacker', content: '我在Pionex上跑的网格，配置跟你差不多，但收益没这么高，可能跟手续费有关。Pionex优势是不用盯盘，设好了就忘了，特别适合我这种上班族。' },
      { author: 'allin', content: '4.2%一个月？？这还不如我一天的收益（虽然有时候一天亏更多）。不过话说回来网格确实稳，适合不想冒险的人。' },
    ],
  },

  // 7. DeFi收益
  {
    author: 'defi',
    title: 'My current DeFi yield strategy — 25% APY with moderate risk',
    content: `Sharing my current setup since a few people asked. This is what I'm running in Feb 2025:

**Core position (60% of DeFi allocation):**
- ETH staked via Lido → stETH
- stETH deposited into Aave v3 as collateral
- Borrow USDC at ~3.5%
- USDC into a stablecoin LP on Curve (currently ~8%)
- Net yield: ~7-8% on the ETH portion after borrow cost

**Satellite positions (30%):**
- GMX GLP on Arbitrum: ~15-20% APY in ETH+USDC
- Pendle PT-stETH: locked in ~5.5% fixed yield on ETH (good for risk-off portion)

**Degen bucket (10%):**
- Rotating between new Aerodrome pools on Base
- Currently in a WETH/cbETH pool: ~40% APY but impermanent loss risk

Total blended APY: roughly 22-28% depending on the week.

Risk factors I monitor:
1. Lido depeg risk (hasn't happened significantly but worth watching)
2. Aave liquidation — I keep health factor above 2.0, never let it drop below 1.5
3. Smart contract risk — I only use protocols with 12+ months track record and multiple audits
4. Curve pool depth — if TVL drops below $5M I exit

This isn't financial advice, DYOR. But happy to answer questions about any of these.`,
    comments: [
      { author: 'chain', content: '补充一个：做这种嵌套策略（staking→借贷→LP）一定要关注gas成本。Layer1上面rebalance一次可能就要50U的gas，吃掉好几天收益。建议尽量在L2上操作。' },
      { author: 'btc', content: 'All this complexity for 25% APY... meanwhile BTC just sitting there doing 150% per year without any smart contract risk. Keep it simple.' },
      { author: 'defi', content: 'BTC doesn\'t yield anything sitting in a wallet though. And 150% is price appreciation, not yield — huge difference. I\'m farming yield ON TOP of my ETH price exposure. Apples and oranges.' },
      { author: 'noob', content: '看完这帖感觉自己还是太菜了... 请问入门DeFi farming有什么推荐的学习路径吗？' },
      { author: 'defi', content: 'Start with just staking ETH on Lido — one click, easy to understand. Then learn how Aave works (deposit/borrow). Don\'t jump into complex strategies until you understand each piece individually. Took me 6 months to get comfortable.' },
    ],
  },

  // 8. 被套心态
  {
    author: 'bag',
    title: '被套500天的SOL终于解套了，分享几点感悟',
    content: `2023年7月买的SOL，均价22U，买完就跌到17。后来一路拿着，中间最低跌到8块多，真的以为要归零了。

今天看了一眼账户，不知不觉SOL已经250了，翻了10倍不止。但说实话这个过程一点都不爽：

1. 心态的煎熬比亏钱更难受。被套的时候每天都在想要不要割肉，特别是FTX暴雷那段时间。最后没割是因为金额不大，亏完也认了。

2. 我之所以没卖，不是因为我有信仰或者看好，纯粹是因为懒。说白了就是装死策略。事后来看这居然是最好的策略。

3. 但装死不等于放弃思考。中间我一直在关注Solana生态的发展，看到Marinade、Jito这些协议起来，心里有点底了。

4. 如果同样的钱我用来做合约，大概率早就爆了。现货被套至少不会归零（大部分情况下）。

5. 最重要的教训：买入之前想好最坏情况。如果这笔钱全亏了你能接受，那就买。如果不能接受，仓位太重了。

现在的问题是：250的SOL我该不该卖？说实话我也不知道 😂`,
    comments: [
      { author: 'allin', content: '兄弟你这运气太好了，当时8块的SOL我抄底了但是20块就卖了... 如果拿到现在翻30倍。但是没办法，当时谁知道呢。' },
      { author: 'dip', content: '我也被套过SOL，不过我25买的100就卖了，少赚了一大截。你说的对，有时候装死确实是最好的策略，前提是仓位不重。' },
      { author: 'health', content: '500天的心理煎熬不是一般人能扛住的。建议大家被套的时候多运动、多社交，别天天盯盘。你看OP不盯盘反而赚最多。' },
    ],
  },

  // 9. 量化交易
  {
    author: 'quant',
    title: 'Building a trading bot that actually works — lessons from 2 years of failures',
    content: `Most trading bots lose money. I know because I built about 15 before finding one that's consistently profitable. Here's what I learned:

**Things that DON'T work (despite what YouTube tells you):**
- Simple MA crossover bots: Work in backtests, die in live due to slippage and fees
- Sentiment analysis bots (scraping Twitter): Too noisy, by the time you parse it the move is done
- Grid bots in trending markets: They print money in ranges but destroy capital in trends
- Any bot that doesn't account for fees and slippage in backtesting

**What actually works (for me):**

1. **Mean reversion on funding rates**: When perpetual funding goes extremely positive (>0.1%), I short. When extremely negative (<-0.05%), I long. This has a 67% win rate across 2 years of data. The edge is small but consistent.

2. **Cross-exchange arbitrage**: Not as dead as people say, but you need to be fast. I use Rust for the execution layer. Typical profit per trade is 0.02-0.05% but at high volume it adds up.

3. **Orderbook imbalance**: When bid depth is >3x ask depth at a key level, there's a slight edge going long (and vice versa). This one's my newest strategy, still testing.

**Tech stack:**
- Data: PostgreSQL + TimescaleDB for tick data
- Backtesting: Python (vectorbt)
- Live execution: Rust (tokio async runtime)
- Monitoring: Grafana dashboards

The unsexy truth: my profitable bot makes about 0.5% per day on average. That's ~180% per year compounded, which sounds amazing until you realize it took 2 years and probably 1000 hours of development to get here. The real alpha is in the WORK, not the strategy.

Happy to discuss technical details if anyone's interested.`,
    comments: [
      { author: 'grid', content: '关于网格在趋势行情里亏钱这点，完全同意。我之前也踩过这个坑。后来加了趋势过滤器，ADX>25的时候自动暂停，效果好很多。你有没有试过在网格的基础上加trend following的逻辑？' },
      { author: 'gains', content: '0.5% a day is honestly incredible if it\'s consistent. Most traders would kill for that. How\'s the max drawdown looking?' },
      { author: 'quant', content: 'Max drawdown has been about 8% over 2 years. Worst month was -3.2%. It\'s boring but that\'s the point — excitement in trading usually means you\'re doing something wrong.' },
      { author: 'desk', content: 'What\'s your monitoring setup like? I\'m running a simple bot on a VPS but I always worry about downtime. Do you use any alerting?' },
      { author: 'quant', content: 'Grafana + PagerDuty for alerts. I have checks for: bot heartbeat (every 30s), position size limits, daily PnL limits (auto-shutdown if >2% loss), and exchange API health. Overkill? Maybe. But it\'s saved me twice.' },
    ],
  },

  // 10. 新手提问
  {
    author: 'noob',
    title: '入圈三个月，说说我走过的弯路',
    content: `三个月前完全不懂加密货币就冲进来了，现在回头看真的踩了很多坑。写出来希望能帮到跟我一样的新手。

**第一个坑：FOMO追高**
刚进来的时候看到某币涨了200%，立马买入。结果第二天就跌了30%。后来才知道"买在别人恐惧时，卖在别人贪婪时"这句话的意思。

**第二个坑：信了推特KOL**
有个大V说某山寨币要涨10倍，我信了买了3000U。现在剩300U。教训：KOL推的币很可能是他要出货的币。

**第三个坑：不设止损**
以为止损是给胆小鬼用的。结果一笔交易亏了40%才想起来止损。现在每笔交易开仓前先设止损，不设就不开。

**第四个坑：频繁换策略**
学了均线就用均线，看了RSI就换RSI，听说MACD好用又去学MACD。三个月用了十几种策略，没有一个用超过两周的。现在决定老老实实学一种，用三个月再说。

**目前的计划：**
1. 只做BTC和ETH，不碰山寨
2. 用4H级别的EMA交叉（从波段猎人那学的）
3. 每笔止损2%
4. 写交易日记

虽然还在亏，但至少亏得比以前少了 😅`,
    comments: [
      { author: 'futures', content: '你才三个月就有这个认知已经很不错了。我当年花了一年多才明白这些。坚持你的计划，不要急，时间会证明的。' },
      { author: 'bag', content: '关于KOL那点太真实了。我也被坑过，花了几千U买了"百倍币"，现在都不好意思打开那个钱包看了。' },
      { author: 'swing', content: '很高兴我的方法对你有帮助！一个小建议：刚开始用的时候资金量要小，先跑三个月看看胜率和盈亏比，确认方法适合你再慢慢加仓位。' },
      { author: 'book', content: 'You\'re doing better than 90% of people who enter crypto. The fact that you\'re self-aware about your mistakes puts you ahead. Highly recommend reading "Trading in the Zone" by Mark Douglas — it\'ll help with the FOMO and discipline issues.' },
    ],
  },

  // 11. 养生交易
  {
    author: 'health',
    title: '为什么我说交易员必须运动？聊聊身体和收益的关系',
    content: `可能有人觉得这个话题跟交易没关系，但请听我说完。

去年我连续三个月每天坐在电脑前12小时以上盯盘。结果：
- 颈椎出了问题，经常头痛
- 睡眠质量极差，半夜醒来看行情
- 体重涨了15斤
- 最关键的：这三个月是我交易表现最差的三个月

后来开始每天运动30分钟（跑步或游泳），效果：
- 两周后睡眠改善，白天注意力更集中
- 一个月后焦虑明显减少，不再频繁查看手机
- 两个月后交易决策质量提升，冲动交易几乎消失

我的解释是：运动提高了我的情绪调节能力。交易本质上是一个情绪管理游戏。你再好的策略，在焦虑、疲劳的状态下执行都会走样。

现在我的日程：
- 早上6:30起床，运动30分钟
- 8:00-12:00交易时段（最专注的4小时）
- 下午复盘，不开新仓
- 晚上10:30前必须睡觉，不看盘

收益大概提升了30%，更重要的是心情好了很多。

各位交易员，别忘了照顾好自己的身体。身体是最大的本金。`,
    comments: [
      { author: 'slacker', content: '说得对但做不到啊... 白天上班晚上盯盘，哪有时间运动。不过确实最近颈椎也不太好，可能得想办法挤出时间了。' },
      { author: 'desk', content: 'Completely agree. I invested in a standing desk and a walking treadmill under my desk. Game changer. I walk slowly while watching charts — 10k steps per day without leaving my trading station.' },
      { author: 'futures', content: '我之前也是半夜起来看盘，后来发现：美国时段的行情你大部分时候拿着过夜也没关系，重要的是仓位管理不是盯盘。现在设好止盈止损就睡觉了。' },
    ],
  },

  // 12. 吐槽交易所
  {
    author: 'rant',
    title: 'Bybit just changed their fee structure AGAIN — here\'s what it means for you',
    content: `Bybit updated their maker/taker fee tiers effective Feb 1. Quick breakdown:

**What changed:**
- VIP1 threshold raised from $5M to $10M monthly volume
- Regular users: maker fee stays 0.02%, taker fee goes from 0.055% to 0.06%
- Pro tier discount reduced from 30% to 20%

**Why it matters:**
For a trader doing $100K monthly volume (which isn't that much), the taker fee increase costs an extra $5/month. Not huge. But for active traders doing $1M+, that's $50+ more per month.

**The real issue:**
This is the 3rd fee change in 8 months. Exchanges keep adjusting fees upward while advertising "lowest fees." It's death by a thousand cuts.

**My advice:**
- Use limit orders whenever possible (maker fees are always lower)
- If you're on Bybit, check if you qualify for VIP — the thresholds changed
- Consider using multiple exchanges and routing orders to whoever has the best rate
- Always factor fees into your strategy backtest — a lot of "profitable" strategies become unprofitable after fees

Anyone else tired of exchanges constantly changing fee structures without proper notice? At least Binance has been relatively stable on this front.`,
    comments: [
      { author: 'quant', content: 'I built fee comparison into my bot. It checks real-time fee tiers across 4 exchanges and routes to the cheapest one. Saves about 15-20% on total fees. Worth the engineering effort if you trade frequently.' },
      { author: 'grid', content: '对网格交易来说手续费特别重要，因为交易次数多。0.01%的差异在几百次交易后就很明显了。我选平台第一看的就是maker fee。' },
      { author: 'slacker', content: '刚看了一下我Bybit的账单，上个月光手续费就花了200多U... 突然觉得自己是在给交易所打工。' },
    ],
  },

  // 13. 山寨币研究
  {
    author: 'alt',
    title: 'How I research altcoins — my due diligence checklist',
    content: `People always ask how I find good altcoins before they pump. Truth is, I don't find them all — I find maybe 1 in 20 that actually works out. But having a systematic approach helps me avoid the 19 that don't.

My checklist:

**1. Team (30% of my decision)**
- Are founders doxxed? Anonymous teams = higher risk
- What's their background? Previous projects?
- Check LinkedIn, not just Twitter. Twitter clout ≠ competence
- How active is the GitHub? I literally check commit frequency

**2. Tokenomics (25%)**
- What % is allocated to team/VCs? Over 30% is a red flag
- Vesting schedule? If a big unlock is coming, wait
- Fully diluted valuation vs current market cap ratio
- Inflation rate — is the supply increasing?

**3. Product-market fit (25%)**
- Is there an actual product or just a whitepaper?
- Real users or just airdrop farmers?
- Revenue? (Token Terminal is great for this)
- What problem does this solve that competitors don't?

**4. Market/narrative (20%)**
- Does it fit a current narrative? (AI, RWA, DePin, etc.)
- Who's invested? Follow the smart money (Paradigm, a16z, etc.)
- Community size and quality (avoid paid Telegram shill groups)

**Instant red flags that make me skip:**
- "100x potential" in the marketing
- Telegram group full of bots
- Can't explain what the project does in one sentence
- Massive marketing budget with no product
- Team buys lambos before product launch

This approach won't find you the next DOGE (memecoins are pure gambling), but it'll help you find quality projects with real upside potential.`,
    comments: [
      { author: 'chain', content: 'Good framework. I\'d add one thing: check the on-chain data. If the top 10 wallets hold >50% of supply, it\'s a whale playground and you\'re exit liquidity. Tools like Bubblemaps make this easy to visualize.' },
      { author: 'btc', content: 'Or you could just buy Bitcoin and not worry about any of this. 99% of altcoins go to zero over a long enough timeline. But hey, your money your choice.' },
      { author: 'noob', content: '这个checklist太有用了，收藏了！之前买山寨币都是看推特推荐，完全没做过这种research。以后一定先做DD再买。' },
      { author: 'defi', content: 'The GitHub activity check is underrated. I check the repos of every DeFi protocol I farm on. If there hasn\'t been a commit in 3 months, I\'m pulling my funds. Dead code = dead protocol eventually.' },
    ],
  },

  // 14. 摸鱼交易
  {
    author: 'slacker',
    title: '上班摸鱼看盘的正确姿势（不要被老板发现）',
    content: `在座的各位应该有不少跟我一样白天上班、偷偷交易的吧？分享一些实用技巧：

**1. 手机操作为主**
设好几个常用的限价单模板，到价位了手机上两秒钟就能下单。别用电脑看盘，屏幕太大容易被发现。

**2. 设好提醒不用盯盘**
TradingView的价格提醒是神器。设好关键价位，到了才看，不需要一直开着K线图。

**3. 选择流动性好的时段**
亚洲盘（上午9-11点）其实不是最好的交易时段。如果你上班时间是9-6，建议在午休和下午4-5点关注一下，欧洲盘刚开。

**4. 不要在工作时间做高频交易**
注意力被分散的情况下做交易亏钱概率很高。上班时间最多调整一下止损止盈，别开新仓。

**5. 用一个单独的手机**
如果条件允许，用一个单独的手机来交易，公司手机和私人手机分开。万一需要给别人看手机不会尴尬。

当然了最好的情况还是有一天全职交易... 不过在那之前先保住工资吧 😄

声明：我绝对没有在上班时间写这个帖子（心虚）。`,
    comments: [
      { author: 'health', content: '其实我建议反过来——上班好好上班，下班后看盘。分心交易的决策质量很差，还影响工作。两头都耽误不划算。' },
      { author: 'gains', content: 'Bro just quit your job and trade full time. Life is too short to look at charts on a tiny phone screen. (Not financial advice but also kind of financial advice)' },
      { author: 'slacker', content: '回楼上：没那个实力就没那个胆子 😂 等我账户翻到50万U再说吧' },
      { author: 'bag', content: '笑死，我之前在公司厕所里看盘看到腿麻。后来领导问我为什么每天上厕所这么久，我说肠胃不好...' },
      { author: 'desk', content: 'If you MUST trade during work, at least get a privacy screen protector for your phone. The viewing angle thing really works. My colleague next to me has no idea I check charts 20 times a day.' },
    ],
  },

  // 15. BTC信仰
  {
    author: 'btc',
    title: 'Unpopular opinion: if you\'re diversified in crypto, you\'re doing it wrong',
    content: `I know this is going to trigger some people but I genuinely believe this:

If you hold more than 2-3 cryptos, you're not "diversified" — you're just confused.

Here's why:

**1. Crypto is already a risky asset class**
When stocks crash, most crypto crashes harder. When BTC crashes, altcoins crash 2-3x harder. Your "diversified" portfolio of 10 altcoins is actually just leveraged BTC exposure with extra steps.

**2. BTC dominance in drawdowns**
In every major crash, capital flows from alts to BTC. BTC fell 50% in 2022. Most alts fell 80-95%. Your "diversification" didn't protect you.

**3. Time cost of research**
Every altcoin you hold requires ongoing research — team changes, tokenomics updates, protocol risks, governance drama. For 10 coins, that's a full-time job. Or you could just hold BTC and spend your time doing literally anything else.

**4. The Lindy effect**
BTC has survived 15+ years, multiple 80% crashes, China bans, exchange collapses. Every altcoin that existed in 2017 and is still relevant today can be counted on one hand.

My allocation: 95% BTC, 5% ETH (because I need it for gas sometimes).

Don't @ me with your altcoin bags. I've heard it all before.`,
    comments: [
      { author: 'alt', content: 'Respect the conviction but hard disagree. ETH had a better Sharpe ratio than BTC in 3 out of the last 5 years. SOL did 10x in 2024 while BTC did 2x. Concentration ≠ wisdom. But you do you.' },
      { author: 'defi', content: 'So you\'re just going to ignore the entire DeFi ecosystem generating real yield? BTC sitting in a cold wallet generates 0% APY. My ETH position generates 8-25% depending on the strategy. Returns aren\'t just about price.' },
      { author: 'bag', content: '说实话我现在也越来越偏向多持BTC了。之前那些山寨币亏的钱如果全买BTC的话现在资产至少多50%。' },
      { author: 'grid', content: '从网格交易的角度来说，BTC的流动性最好，滑点最小，最适合量化策略。这点我同意。但ETH和SOL的波动率更高，网格收益也更高，所以我三个都跑。' },
    ],
  },

  // 16. 梭哈故事
  {
    author: 'allin',
    title: '2024年梭哈三次的故事，两次财富密码一次差点归零',
    content: `先说明：我的做法不值得模仿。但既然都过去了，记录一下给大家看个乐。

**第一次：梭哈PEPE，本金3万U → 12万U**
2024年3月，PEPE开始从低点拉升，我觉得meme season要来了，全仓买入。拿了两周，涨了4倍。这波操作给了我巨大的信心（后来想想其实是巨大的错觉）。

**第二次：梭哈ETH ETF预期，本金12万U → 28万U**
5月份ETF通过前两周，我把所有资金全压ETH。当时很多人不看好，觉得SEC不会批。但我赌的是市场预期差——即使不批，ETH也不会跌太多；如果批了，会大涨。最后批了，两天涨了25%。

**第三次：梭哈某AI概念币，28万U → 4万U**
这次是教训。年底看到AI+Crypto叙事很火，听了一个"内部消息"全仓进了一个AI概念币。结果项目方rug pull，币价归零。还好是现货不是合约，还剩一点本金。

**总结：**
- 两次成功让我赚了25万U
- 一次失败让我亏了24万U
- 最终结果：折腾了一年，赚了1万U
- 如果我当初把3万U买BTC拿着不动，现在大概值9万U

所以你看，即使梭哈赢了两次，最终收益可能还不如老老实实持有。但我知道下次有好机会我还是会梭... 人就是这样，控制不住自己。`,
    comments: [
      { author: 'futures', content: '兄弟，这个故事就是教科书级的赌徒谬误。你把运气当成了能力，导致第三次加大了赌注。如果第三次也用小仓位去赌，至少不会这么惨。' },
      { author: 'health', content: '"控制不住自己"这五个字就是问题所在。建议读一下《思考，快与慢》，了解一下你大脑里的系统1和系统2。你的梭哈冲动就是系统1在控制你。' },
      { author: 'dip', content: '看完你的故事我突然觉得我每次只亏10%-20%好像也不算太惨了... 至少我还在场上。' },
    ],
  },

  // 17. 设备配置
  {
    author: 'desk',
    title: 'My trading desk setup — 2025 edition',
    content: `Updated my trading station recently, figured I'd share for anyone looking to upgrade their setup:

**Monitors:**
- Main: LG 40" ultrawide 5K (charts, this is the money-maker)
- Secondary: 2x Dell 27" 4K vertical (order books, news feeds)
- Tablet: iPad Pro with TradingView mobile (for when I walk around)

**Computer:**
- Mac Studio M4 Max — overkill for trading but I also code
- 64GB RAM (running multiple TradingView instances + Python backtests)

**Peripherals:**
- Keyboard: Keychron Q1 with silent switches (no click noise during late night sessions)
- Mouse: Logitech MX Master 3S
- Webcam: none needed lol, this isn't a streaming setup

**Chair:**
- Herman Miller Aeron Remastered — your back will thank you
- Standing desk converter: Uplift V2 (alternate sitting/standing every hour)

**Software:**
- TradingView Premium (multi-chart layouts are essential)
- Bookmap (for orderbook heatmaps)
- Custom Python dashboards on Streamlit
- Notion for trade journaling

**Network:**
- Dual ISP with automatic failover (can't lose connection during a trade)
- Wired ethernet only, no WiFi for the trading machine

Total investment: roughly $12K. Sounds like a lot but it's a business expense. A surgeon doesn't use cheap tools, and neither should a trader.

Before anyone asks — no, a fancy setup won't make you profitable. But once you ARE profitable, the right tools make a real difference in execution speed and comfort.`,
    comments: [
      { author: 'slacker', content: '我的交易设备：公司电脑偷偷开的一个小窗口 + 桌子下面的iPhone。差距太大了哈哈哈' },
      { author: 'quant', content: 'Good setup. One thing I\'d add: a separate machine (even a cheap mini PC) dedicated to running bots. You don\'t want your trading bot competing for resources with your browser tabs. I use an Intel NUC specifically for this.' },
      { author: 'gains', content: 'No Lambo poster on the wall? Disappointing. But seriously, the dual ISP thing is smart. I lost $3K once because my internet dropped during a volatile move and my stop didn\'t trigger on the exchange side.' },
    ],
  },

  // 18. 交易日记分享
  {
    author: 'gains',
    title: 'February PnL so far: +$47K. Breaking down my best and worst trades',
    content: `First week of Feb has been solid. Here's the breakdown:

**Best trade: Long BTC at 91.2K, closed at 104K (+14%)**
- Entry reason: Weekly RSI oversold + massive spot buying on Coinbase
- Position size: 15% of portfolio, 3x leverage
- Held for 4 days
- What went right: Patience. I had the setup identified for a week before entry triggered.

**Second best: Short ETH/BTC ratio**
- Thesis: ETH underperforming BTC trend continuing
- Entered at 0.034, currently at 0.031
- Still open, target 0.028

**Worst trade: Long SOL at $248, stopped out at $232 (-6.4%)**
- Entry was based on breakout from descending wedge
- The breakout was a fakeout, got stopped out within 2 hours
- Loss was manageable because position size was small (5% portfolio, no leverage)

**What I'm watching next week:**
- BTC holding above 100K = continuation setup
- ETH still looks weak relative to BTC
- AI token sector might be setting up for rotation

Monthly target: $100K. Aggressive but achievable if the market cooperates.

Not posting this to flex — I've had plenty of red months too. The point is to show that even in a good month, you still have losing trades. It's the net result that matters.`,
    comments: [
      { author: 'futures', content: '你的仓位管理很好，最好的trade 15%仓位3x，最差的5%仓位无杠杆。这就是为什么能赚钱——好机会下重注，不确定的轻仓。大部分人反过来。' },
      { author: 'noob', content: 'This is really helpful to see! I always assumed profitable traders never lose. Seeing your SOL loss and how you managed it is more educational than the winning trades honestly.' },
      { author: 'alt', content: 'Nice call on the ETH/BTC ratio trade. I\'ve been looking at the same setup. The 0.028 target makes sense from a historical support perspective. Might tail this one.' },
    ],
  },

  // 19. 抄底策略
  {
    author: 'dip',
    title: '我的定投+抄底混合策略，三年年化35%',
    content: `先说结论：定投是最适合大部分人的策略，但如果你能判断一些极端情况，加入择时元素可以提升收益。

我的做法：

**基础仓位（70%资金）：周定投**
- 每周固定买入BTC和ETH（7:3比例）
- 不管价格，雷打不动每周一买
- 这部分三年的年化大概25%，跟BTC差不多

**抄底仓位（30%资金）：极端恐惧时加仓**
- 当Fear & Greed指数低于20时，开始每天加倍买入
- 低于10时（极度恐惧），用剩余全部资金买入
- 这个策略三年触发了4次：2022年6月（Luna后）、2022年11月（FTX后）、2023年8月、2024年8月

**为什么有效：**
- 定投保证了不错过大趋势
- 恐惧指数极低时往往是底部区域（不一定是最低点，但大概率是低估区域）
- 两者结合比单纯定投多了10%左右的年化收益

**注意事项：**
1. 绝对不要用杠杆定投，现货就好
2. 只投你亏完也能接受的钱
3. 至少坚持两年以上才能看到效果
4. 恐惧指数不是万能的，有时候恐惧之后还有更恐惧

三年下来本金加收益大概翻了2.5倍。不如那些杠杆高手，但我晚上能睡得着。`,
    comments: [
      { author: 'btc', content: 'DCA into BTC is the way. This is basically what I do except I don\'t bother with ETH. The fear index bottom-buying is smart though — simple but effective.' },
      { author: 'allin', content: '三年才2.5倍，你要是2024年3月梭哈PEPE两周就4倍了... 但是吧你说得对，你的方法更稳，适合大部分人。我的方法只适合亡命徒。' },
      { author: 'health', content: '这种策略最大的好处是心态好。定投的人不需要天天盯盘，不焦虑，睡眠好。从身心健康的角度这可能是最佳策略。' },
      { author: 'noob', content: '我决定了，从下周开始定投BTC！先每周100U，养成习惯。谢谢分享！' },
    ],
  },

  // 20. 交易书籍
  {
    author: 'book',
    title: 'Top 5 trading books that aren\'t "Trading in the Zone" or "Market Wizards"',
    content: `Everyone recommends the same 3-4 books. Here are 5 that don't get mentioned enough but completely changed my trading:

**1. "Thinking in Bets" by Annie Duke**
Former poker pro applies decision theory to uncertain outcomes. The key insight: you can make the right decision and still lose money. Judge your process, not your outcomes. This book cured my results-oriented thinking.

**2. "The Art and Science of Technical Analysis" by Adam Grimes**
This is THE definitive TA book. It's dense and academic, but it actually has statistical evidence for which patterns work and which don't. Spoiler: most don't work as reliably as gurus claim.

**3. "Fooled by Randomness" by Nassim Taleb**
Not a trading book per se, but essential reading. Teaches you to recognize when you're confusing luck with skill. After reading this, you'll look at every "trading guru" differently.

**4. "Best Loser Wins" by Tom Hougaard**
Relatively new book by a spread bettor. His take on trading psychology is refreshingly honest and practical. The title says it all — the best trader is the one who loses best.

**5. "Quantitative Trading" by Ernest Chan**
If you're interested in systematic trading, start here. Very accessible for a quant book. Covers backtesting methodology, common pitfalls, and how to evaluate strategies properly.

**Honorable mentions:**
- "Reminiscences of a Stock Operator" (classic, timeless)
- "Flash Boys" (understanding market microstructure)
- "The Zurich Axioms" (short, contrarian, thought-provoking)

What are your hidden gem trading books?`,
    comments: [
      { author: 'quant', content: 'Ernest Chan\'s book is what got me into quant trading. His follow-up "Algorithmic Trading" is even better. Also recommend "Advances in Financial Machine Learning" by Marcos López de Prado if you\'re into ML-based strategies.' },
      { author: 'health', content: '推荐一本日本作者写的《投资中最简单的事》，虽然是讲股票的但思路完全适用于加密货币。特别是关于"少即是多"的理念。' },
      { author: 'noob', content: 'Saving this list! Currently reading "Trading in the Zone" (just started). Will add these to my queue. Any suggestion for which one to read after TitZ?' },
      { author: 'book', content: 'After Trading in the Zone, go with "Thinking in Bets." It builds on similar ideas about probabilistic thinking but from a different angle. Then "Best Loser Wins" for the practical psychology stuff.' },
    ],
  },
]

// ─── Helpers ─────────────────────────────────────────────────────────────────

// Map handle → user_id from DB
async function getUserMap() {
  const handles = Object.values(HANDLES)
  const { data, error } = await sb
    .from('user_profiles')
    .select('id, handle')
    .in('handle', handles)

  if (error) throw new Error(`Failed to fetch users: ${error.message}`)
  const map = {}
  for (const u of (data || [])) map[u.handle] = u.id
  return map
}

function randomDate(daysAgo = 30) {
  const now = Date.now()
  const offset = Math.random() * daysAgo * 24 * 60 * 60 * 1000
  return new Date(now - offset).toISOString()
}

function commentDate(postDate, index) {
  const base = new Date(postDate).getTime()
  // Comments come 1-48 hours after post
  const offset = (index + 1) * (1 + Math.random() * 12) * 60 * 60 * 1000
  return new Date(base + offset).toISOString()
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`=== Seed Community Posts ===`)
  console.log(`Mode: ${DRY_RUN ? 'DRY RUN (use --apply to insert)' : 'APPLY'}`)
  console.log(`Posts: ${POSTS.length}`)
  console.log(`Comments: ${POSTS.reduce((s, p) => s + p.comments.length, 0)}\n`)

  if (DRY_RUN) {
    for (const post of POSTS) {
      const authorHandle = HANDLES[post.author]
      console.log(`📝 [${authorHandle}] ${post.title}`)
      for (const c of post.comments) {
        console.log(`   💬 [${HANDLES[c.author]}] ${c.content.substring(0, 60)}...`)
      }
    }
    console.log(`\nDry run complete. Use --apply to insert into DB.`)
    return
  }

  // Get user IDs
  const userMap = await getUserMap()
  console.log(`Found ${Object.keys(userMap).length} seed users in DB`)

  const missingHandles = Object.values(HANDLES).filter(h => !userMap[h])
  if (missingHandles.length > 0) {
    console.warn(`⚠ Missing users: ${missingHandles.join(', ')}`)
    console.warn('Run seed-community.ts first to create users.')
  }

  if (CLEANUP) {
    // Delete posts by seed users
    const seedUserIds = Object.values(userMap)
    console.log('Cleaning up existing seed posts...')
    const { count } = await sb
      .from('posts')
      .delete({ count: 'exact' })
      .in('author_id', seedUserIds)
    console.log(`Deleted ${count || 0} existing seed posts`)
  }

  let postsCreated = 0
  let commentsCreated = 0

  for (const post of POSTS) {
    const authorHandle = HANDLES[post.author]
    const authorId = userMap[authorHandle]
    if (!authorId) {
      console.warn(`⚠ Skipping post by ${authorHandle} (user not found)`)
      continue
    }

    const postDate = randomDate(30)
    const commentCount = post.comments.length
    const likeCount = Math.floor(Math.random() * 50) + 5
    const viewCount = likeCount * (5 + Math.floor(Math.random() * 20))

    const { data: insertedPost, error } = await sb
      .from('posts')
      .insert({
        title: post.title,
        content: post.content,
        author_id: authorId,
        author_handle: authorHandle,
        comment_count: commentCount,
        like_count: likeCount,
        view_count: viewCount,
        created_at: postDate,
        updated_at: postDate,
      })
      .select('id')
      .single()

    if (error) {
      console.error(`✗ Failed to create post "${post.title}": ${error.message}`)
      continue
    }

    console.log(`✓ Created: "${post.title}" (${commentCount} comments)`)
    postsCreated++

    // Insert comments
    for (let i = 0; i < post.comments.length; i++) {
      const c = post.comments[i]
      const cAuthorHandle = HANDLES[c.author]
      const cAuthorId = userMap[cAuthorHandle]
      if (!cAuthorId) continue

      const cDate = commentDate(postDate, i)
      const cLikes = Math.floor(Math.random() * 15)

      const { error: cErr } = await sb
        .from('comments')
        .insert({
          post_id: insertedPost.id,
          author_id: cAuthorId,
          author_handle: cAuthorHandle,
          content: c.content,
          like_count: cLikes,
          created_at: cDate,
          updated_at: cDate,
        })

      if (cErr) {
        console.error(`  ✗ Comment failed: ${cErr.message}`)
      } else {
        commentsCreated++
      }
    }
  }

  console.log(`\n=== Done ===`)
  console.log(`Posts created: ${postsCreated}`)
  console.log(`Comments created: ${commentsCreated}`)
}

main().catch(e => { console.error(e); process.exit(1) })
