/**
 * Seed script: Populates DB with test users, groups, posts, comments, and social interactions.
 * Creates a realistic community environment for development/testing.
 *
 * Run: npx tsx scripts/seed-community.ts
 *
 * Requires env vars:
 *   NEXT_PUBLIC_SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 */

import { createClient, SupabaseClient } from '@supabase/supabase-js'

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('Missing env vars: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY')
  process.exit(1)
}

const supabase: SupabaseClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
})

// ─── User Definitions ────────────────────────────────────────────────────────

interface UserDef {
  email: string
  password: string
  handle: string
  bio: string
  lang: 'zh' | 'en'
}

const USERS: UserDef[] = [
  // Chinese users
  { email: 'grid01@test.com', password: 'grid0123', handle: '网格大师', bio: '网格交易15年，专注量化策略与系统化交易。波动即收益，纪律即利润。', lang: 'zh' },
  { email: 'futures02@test.com', password: 'futures02', handle: '合约老手', bio: '合约交易8年老兵，经历过314、519、FTX。活着就是胜利，风控大于一切。', lang: 'zh' },
  { email: 'swing03@test.com', password: 'swing0303', handle: '波段猎人', bio: '不追高不抄底，只做确定性波段。4H级别为主，日线确认方向。', lang: 'zh' },
  { email: 'chain04@test.com', password: 'chain0404', handle: '链上侦探', bio: '链上数据分析师，追踪巨鲸动向。Nansen/Arkham/Dune重度用户。数据不会说谎。', lang: 'zh' },
  { email: 'bag05@test.com', password: 'bag05050', handle: '被套小王子', bio: '专业被套30年，从A股套到币圈。还在坚持，因为装死是我唯一的策略。', lang: 'zh' },
  { email: 'noob06@test.com', password: 'noob06060', handle: '韭菜日记', bio: '入圈3个月的小白，正在努力学习中。求大佬们带带我，保证不乱梭哈（大概）。', lang: 'zh' },
  { email: 'allin07@test.com', password: 'allin0707', handle: '梭哈勇士', bio: '要么财富自由，要么从头再来。人生苦短，何不梭哈？⚡ 高杠杆爱好者。', lang: 'zh' },
  { email: 'dip08@test.com', password: 'dip080808', handle: '抄底达人', bio: '每次抄底都在半山腰，但我依然乐观。价值投资，长线持有，定投永不止。', lang: 'zh' },
  { email: 'slacker09@test.com', password: 'slack0909', handle: '摸鱼队长', bio: '白天上班摸鱼看K线，晚上回家复盘到凌晨。老板不知道我的副业比主业赚得多。', lang: 'zh' },
  { email: 'health10@test.com', password: 'health1010', handle: '养生交易员', bio: '交易先养生，亏钱不亏命。每天冥想20分钟，止损不止损看心情。佛系交易，顺其自然。', lang: 'zh' },
  // English users
  { email: 'btcmax11@test.com', password: 'btcmax1111', handle: 'BTCMaxi', bio: 'Bitcoin is the only real money. Everything else is noise. HODL since 2017. Stack sats, stay humble.', lang: 'en' },
  { email: 'defi12@test.com', password: 'defi121212', handle: 'DeFiFarmer', bio: 'Yield farming across 15 chains. If the APY is under 20% I am not interested. DeFi is the future of finance.', lang: 'en' },
  { email: 'altcoin13@test.com', password: 'altcoin1313', handle: 'AltHunter', bio: 'Deep-diving altcoins before they pump. 500+ projects researched. My portfolio is a graveyard of 100x dreams.', lang: 'en' },
  { email: 'flexer14@test.com', password: 'flexer1414', handle: 'GainzKing', bio: 'Up 340% this year and counting. No secrets, just discipline and bigger balls than most. PnL screenshots daily.', lang: 'en' },
  { email: 'rant15@test.com', password: 'rant151515', handle: 'ExchangeRanter', bio: 'Reviewing every exchange so you do not have to. If your platform sucks, I will tell you exactly why. No paid promos.', lang: 'en' },
  { email: 'coder16@test.com', password: 'coder1616', handle: 'QuantCoder', bio: 'Building trading bots since 2019. Python, Rust, low-latency infra. If you are not automating, you are donating.', lang: 'en' },
  { email: 'books17@test.com', password: 'books1717', handle: 'BookTrader', bio: 'Read 200+ trading books. Market Wizards changed my life. Currently studying behavioral economics.', lang: 'en' },
  { email: 'desk18@test.com', password: 'desk181818', handle: 'DeskSetupPro', bio: '6-monitor setup, Herman Miller chair, mechanical keyboard. Your trading station is your cockpit. Optimize everything.', lang: 'en' },
]

// ─── Group Definitions ───────────────────────────────────────────────────────

interface GroupDef {
  name: string
  name_en: string
  description: string
  description_en: string
  creatorHandle: string
}

const GROUPS: GroupDef[] = [
  { name: '被套互助会', name_en: 'Bag Holders Anonymous', description: '被套不可怕，可怕的是一个人扛。在这里分享你的被套经历，互相取暖，共同解套。', description_en: 'Getting bagged is not scary. Being alone is. Share your bag-holding stories here.', creatorHandle: '被套小王子' },
  { name: '韭菜成长日记', name_en: 'Noob Growth Diary', description: '新手交流区，没有嘲笑只有鼓励。提问不丢人，不学才丢人。', description_en: 'Newbie-friendly zone. No stupid questions, only stupid trades.', creatorHandle: '韭菜日记' },
  { name: '梭哈艺术家', name_en: 'All-In Artists', description: '分享你的梭哈故事，不管是暴富还是归零。胆大心细，梭哈有道。', description_en: 'Share your all-in stories. Fortune favors the bold (sometimes).', creatorHandle: '梭哈勇士' },
  { name: '抄底抄在半山腰', name_en: 'Buying the Dip Too Early', description: '以为是底部结果只是半山腰？欢迎加入，这里全是同路人。', description_en: 'Thought it was the bottom? Welcome to the club.', creatorHandle: '抄底达人' },
  { name: '上班摸鱼交易', name_en: 'Trading While Working', description: '老板以为你在加班，其实你在看K线。摸鱼交易员的秘密基地。', description_en: 'Your boss thinks you are working. You are actually trading.', creatorHandle: '摸鱼队长' },
  { name: '晒单区', name_en: 'Flex Zone', description: 'Show your PnL. Gains, losses, liquidations — all welcome. No fake screenshots.', description_en: 'Show your PnL. Gains, losses, liquidations — all welcome.', creatorHandle: 'GainzKing' },
  { name: '交易所吐槽大会', name_en: 'Exchange Rant Zone', description: '交易所又出bug了？手续费太高？提币太慢？来这里尽情吐槽。', description_en: 'Exchange bugs, high fees, slow withdrawals. Rant here.', creatorHandle: 'ExchangeRanter' },
  { name: '交易员养生堂', name_en: 'Trader Wellness', description: '交易员的身心健康同样重要。分享你的养生秘诀、运动习惯、心理调节方法。', description_en: 'Trading wellness matters. Share health tips, exercise routines, mental health strategies.', creatorHandle: '养生交易员' },
  { name: '网格交易爱好者', name_en: 'Grid Trading Enthusiasts', description: '网格交易策略讨论、参数分享、回测结果交流。用数学打败市场。', description_en: 'Grid trading strategies, parameter sharing, and backtesting results.', creatorHandle: '网格大师' },
  { name: '合约交易研习社', name_en: 'Futures Trading Academy', description: '合约交易技术分析、仓位管理、风控策略深度讨论。新手慎入，建议先学习再实操。', description_en: 'Futures trading TA, position sizing, risk management. Not for beginners.', creatorHandle: '合约老手' },
  { name: '波段交易者', name_en: 'Swing Traders', description: '4H-日线级别波段交易讨论。不做日内噪音，只抓大趋势中的波段机会。', description_en: '4H to daily swing trading. Ignore the noise, catch the waves.', creatorHandle: '波段猎人' },
  { name: '链上数据分析', name_en: 'On-Chain Analytics', description: '链上数据挖掘、巨鲸追踪、Smart Money分析。用数据说话，让链上透明。', description_en: 'On-chain data mining, whale tracking, smart money analysis.', creatorHandle: '链上侦探' },
  { name: '交易书籍推荐', name_en: 'Trading Books Club', description: 'Share and discuss the best trading books. From technical analysis to trading psychology.', description_en: 'Share and discuss the best trading books.', creatorHandle: 'BookTrader' },
  { name: '山寨币猎人', name_en: 'Altcoin Hunters', description: 'Deep research on low-cap gems. Share your finds, DD, and exit strategies. DYOR always.', description_en: 'Deep research on low-cap gems. DYOR always.', creatorHandle: 'AltHunter' },
  { name: '比特币信仰者', name_en: 'Bitcoin Maximalists', description: 'Bitcoin is the signal. Everything else is noise. Long-term conviction, short-term patience.', description_en: 'Bitcoin is the signal. Everything else is noise.', creatorHandle: 'BTCMaxi' },
  { name: 'DeFi农民', name_en: 'DeFi Farmers', description: 'Yield farming strategies, protocol reviews, risk assessment. Farm smart, not hard.', description_en: 'Yield farming strategies, protocol reviews, risk assessment.', creatorHandle: 'DeFiFarmer' },
  { name: '技术指标研究', name_en: 'Technical Indicators Research', description: '技术指标的正确用法与误区。RSI、MACD、布林带、成交量分析深度研讨。', description_en: 'Proper use of technical indicators. RSI, MACD, Bollinger Bands, volume analysis.', creatorHandle: '波段猎人' },
  { name: '交易员的桌面', name_en: "Trader's Desk Setup", description: 'Show off your trading setup! Monitors, chairs, keyboards, lighting. Optimize your workspace.', description_en: 'Show off your trading setup! Monitors, chairs, keyboards, lighting.', creatorHandle: 'DeskSetupPro' },
  { name: '量化编程交流', name_en: 'Quant Programming', description: 'Trading bot development, backtesting frameworks, API integration. Python, Rust, TypeScript welcome.', description_en: 'Trading bot development, backtesting, API integration.', creatorHandle: 'QuantCoder' },
  { name: '交易心理学', name_en: 'Trading Psychology', description: '交易心理、情绪管理、纪律执行。市场最难的不是技术，而是战胜自己。', description_en: 'Trading psychology, emotional management, discipline execution.', creatorHandle: '合约老手' },
]

// ─── Content Templates ───────────────────────────────────────────────────────

interface PostTemplate {
  title: string
  content: string
  type: 'long' | 'short' | 'poll' | 'mention' | 'image'
  pollEnabled?: boolean
  images?: string[]
  mentionHandles?: string[]
}

// Posts per group, indexed by group position (0-19)
const GROUP_POSTS: Record<number, PostTemplate[]> = {
  0: [ // 被套互助会
    { type: 'long', title: '被套ETH从4800到现在的心路历程', content: '2021年11月，我在ETH 4800的时候重仓买入，当时觉得ETH要冲10000。结果经历了整整一年的下跌，一度跌到880。\n\n中间无数次想割肉，但每次都告诉自己再等等。现在回头看，如果当初设了止损就不会这么痛苦了。\n\n分享几点教训：\n1. 永远不要在暴涨后追高\n2. 止损不是认输，是保命\n3. 仓位管理比方向判断更重要\n4. 被套后不要加仓摊薄，除非你有充分理由\n\n现在我已经学会了分批建仓、严格止损。虽然晚了点，但总比不学好。各位被套的兄弟们，挺住！' },
    { type: 'short', title: '今日被套清单', content: 'SOL -23%，AVAX -31%，LINK -15%。\n没事，我已经麻了。装死是最好的策略。' },
    { type: 'poll', title: '你被套最久的币是？', content: '好奇大家都被什么币套住了最久，来投票看看。', pollEnabled: true },
    { type: 'mention', title: '学到了', content: '看了 @合约老手 说的仓位管理方法，试了一个月确实有效。虽然还是被套着，但至少新仓位没有再被深套了。推荐大家去看看他的分享。', mentionHandles: ['合约老手'] },
  ],
  1: [ // 韭菜成长日记
    { type: 'long', title: '新手入圈一个月总结', content: '入圈一个月了，说说我的感受和教训：\n\n第一周：听朋友说BTC要涨，冲了5000块进去，确实涨了10%，以为自己是天才。\n第二周：开始玩合约，20倍杠杆做多，第一单赚了2000，觉得这也太简单了。\n第三周：继续加杠杆，50倍做空被爆了，5000块一晚上没了。\n第四周：冷静下来，开始系统学习K线、仓位管理、风控。\n\n总结：\n- 新手千万别碰合约\n- 先学习再投钱\n- 不要被一两次运气冲昏头脑\n- 本金安全是第一位的' },
    { type: 'short', title: '请问什么是K线？', content: '刚开始学习，看到大家说的K线图完全看不懂，红的是涨还是绿的是涨？有没有入门教程推荐？' },
    { type: 'mention', title: '谢谢大佬指导', content: '@波段猎人 推荐的那本《日本蜡烛图技术》我看了一半了，确实比网上的教程清楚多了。还有 @BookTrader 推荐的reading list也很有用！', mentionHandles: ['波段猎人', 'BookTrader'] },
    { type: 'poll', title: '新手第一笔交易赚了还是亏了？', content: '入圈后的第一笔交易，你是赚了还是亏了？（很多人第一次都赚了，然后被市场教育...）', pollEnabled: true },
  ],
  2: [ // 梭哈艺术家
    { type: 'long', title: '我是如何用1000U梭哈到10万U的', content: '去年3月，BTC跌到16000的时候，所有人都在恐慌。但我看到了机会。\n\n我把仅剩的1000U全部梭哈BTC现货，当时真的是孤注一掷。后来BTC从16000涨到73000，我的1000U变成了4500U。\n\n然后我用4500U开了10倍ETH多单，ETH从1600涨到4000，这波赚了大概6万U。\n\n最后一波是SOL，从20梭到200，翻了10倍。\n\n总结：\n- 梭哈需要极强的conviction\n- 只在极端恐慌时梭哈\n- 梭哈后要有耐心持有\n- 这种操作成功率很低，不建议模仿\n\n⚠️ 声明：这是幸存者偏差，大部分梭哈都归零了。理性投资！' },
    { type: 'short', title: '今天又梭哈了', content: '刚才看到一个新Meme币，忍不住梭了500U进去。要么翻10倍要么归零，赌一把！🎰\n\n更新：已经跌了60%了，经典。' },
    { type: 'image', title: '梭哈前 vs 梭哈后', content: '左边是梭哈前的我，信心满满。右边是梭哈后的我，麻木不仁。\n\n你们说，我下次还梭不梭？', images: ['https://picsum.photos/800/400?random=1'] },
    { type: 'poll', title: '你梭哈过最大的一笔是多少？', content: '匿名投票，不用害羞。梭哈是一种艺术（一种毁灭的艺术）。', pollEnabled: true },
  ],
  3: [ // 抄底抄在半山腰
    { type: 'long', title: '完美抄底指南（反面教材）', content: '我的抄底历史回顾：\n\n2022年5月 - LUNA跌到$10的时候抄底，觉得太便宜了 → 归零\n2022年6月 - BTC跌到25000抄底 → 继续跌到16000\n2022年11月 - FTT跌到$5抄底 → 归零\n2023年3月 - SVB暴雷后抄USDC → 好吧这次确实抄对了\n\n教训：\n1. 跌了50%可能还会再跌50%\n2. 价格便宜不等于有价值\n3. 不要接飞刀\n4. 等趋势确认再入场\n5. 分批建仓，不要一把梭\n\n现在的策略：只在周线级别支撑位附近分批买入，每次不超过总仓位10%。' },
    { type: 'short', title: '又抄底了，又在半山腰', content: '昨天看到BTC跌了5%，觉得是机会，结果今天又跌了8%。\n每次都这样，我是不是应该反着来？我买的时候大家快跑？😂' },
    { type: 'mention', title: '听了建议等确认', content: '这次听了 @波段猎人 的建议，没有急着抄底，等4H级别走出双底形态才入场。结果真的比之前抄的位置好多了！\n@链上侦探 的巨鲸数据也帮了大忙，看到大户在增持才敢跟进。', mentionHandles: ['波段猎人', '链上侦探'] },
  ],
  4: [ // 上班摸鱼交易
    { type: 'long', title: '上班摸鱼看盘的10个技巧', content: '作为一个每天上班8小时的社畜交易员，分享一些我的摸鱼看盘技巧：\n\n1. 用深色主题的交易软件，远处看像在写代码\n2. 把K线图缩小，混在Excel表格中间\n3. 手机开画中画，K线挂在角落\n4. 设好价格提醒，不用一直盯盘\n5. 利用午休时间做分析和复盘\n6. 把交易策略写在"工作笔记"里\n7. 使用网格/定投等自动策略减少看盘时间\n8. 大会议期间挂好止损止盈\n9. 带两个显示器，一个工作一个行情\n10. 最重要：工作还是要做好的，不要因小失大\n\n说真的，如果工作做不好被开除了，连交易本金都没有了。平衡很重要！' },
    { type: 'short', title: '今天差点被老板发现了', content: '老板突然走过来的时候我正在看BTC 1分钟K线，紧急alt+tab切到PPT。老板问我为什么脸这么红... 因为我刚亏了500U啊！！' },
    { type: 'image', title: '我的工位摸鱼设置', content: '分享一下我的工位布局。左屏工作，右屏行情（老板一般不看右边的屏幕）。这个角度只有我能看到TradingView。', images: ['https://picsum.photos/800/600?random=2'] },
    { type: 'poll', title: '你上班摸鱼交易被发现过吗？', content: '匿名投票，说实话你到底有没有被发现过？', pollEnabled: true },
    { type: 'mention', title: '推荐价格提醒', content: '@QuantCoder 之前分享的那个自定义价格提醒脚本真好用，不用一直盯盘了，关键价位到了自动通知。上班终于可以安心摸鱼了。', mentionHandles: ['QuantCoder'] },
  ],
  5: [ // 晒单区
    { type: 'image', title: 'This week: +$12,400 on ETH longs', content: 'Caught the bounce perfectly. Entered at $2,180, took profits at $2,640. Three trades, three wins.\n\nKey setup: 4H bullish divergence on RSI + volume confirmation + bouncing off 200MA. Classic textbook trade.', images: ['https://picsum.photos/800/500?random=3'] },
    { type: 'short', title: 'New ATH on my portfolio 🎯', content: 'Portfolio hit $245K today. Started with $8K in 2021. No leverage on spot, just patience and compound growth.\n\nProof is in the screenshots. Stay humble, stay stacking.' },
    { type: 'image', title: '爆仓晒单：一夜归零', content: '是的，你没看错。50倍杠杆做空BTC，结果一根针插上去直接爆仓。亏了3.2万U。\n发这个不是为了秀，是为了警醒大家：高杠杆就是赌博。', images: ['https://picsum.photos/800/400?random=4'] },
    { type: 'mention', title: 'Thanks for the setup @BTCMaxi', content: 'That BTC pullback to $58K that @BTCMaxi called? I entered with 3x leverage, just closed at $67K. +$8,200 realized.\n\n@AltHunter your SOL call was solid too, caught a nice 20% move.', mentionHandles: ['BTCMaxi', 'AltHunter'] },
  ],
  6: [ // 交易所吐槽大会
    { type: 'long', title: 'Binance just froze my withdrawal for 72 hours', content: 'Tried to withdraw 2.5 BTC yesterday. Got hit with a "security review" that is now 72 hours and counting.\n\nNo explanation, no timeline, just "please wait." Support tickets get automated responses.\n\nThis is MY money. If centralized exchanges can freeze your funds at will with zero accountability, what is even the point?\n\nHas anyone else experienced this recently? Any tips for escalating?\n\nUpdate: After posting this on Twitter and tagging their CEO, it got resolved in 4 hours. Funny how that works.' },
    { type: 'short', title: 'Bybit app crashed during the pump 🙄', content: 'BTC pumped 5% in 10 minutes and the Bybit app just... stopped working. Could not close my position, could not set stops. Classic.\n\nBy the time it came back I was in profit but seriously, fix your infrastructure.' },
    { type: 'poll', title: 'Worst exchange experience?', content: 'Which exchange has given you the worst experience? Frozen funds, crashes during volatility, suspicious liquidations...', pollEnabled: true },
    { type: 'mention', title: 'MEXC fee comparison is insane', content: 'Did the math on fees after @GainzKing pointed it out. Trading $100K monthly volume:\n- Binance: ~$100/month\n- OKX: ~$80/month\n- MEXC: ~$150/month (maker fees are higher)\n- Bybit: ~$90/month\n\nSwitching to OKX for now.', mentionHandles: ['GainzKing'] },
  ],
  7: [ // 交易员养生堂
    { type: 'long', title: '交易员必看：久坐对身体的危害及应对', content: '作为交易员，我们每天坐在屏幕前8-16小时，这对身体的伤害是巨大的：\n\n❌ 久坐的危害：\n- 颈椎病、腰椎间盘突出\n- 眼睛干涩、视力下降\n- 血液循环不畅\n- 肥胖和代谢综合征\n- 心理压力累积\n\n✅ 我的应对方案：\n1. 每小时站起来活动5分钟\n2. 使用升降桌，站坐交替\n3. 每天散步30分钟\n4. 20-20-20护眼法则（每20分钟看20英尺外20秒）\n5. 每周3次力量训练\n6. 冥想10分钟管理交易压力\n7. 保证7-8小时睡眠\n\n记住：身体是革命的本钱。健康没了，赚再多钱也没意义。' },
    { type: 'short', title: '今天冥想了吗？', content: '连续冥想30天，发现自己的交易纪律明显提升了。以前总是冲动开单，现在能冷静等待入场信号了。推荐Headspace app。' },
    { type: 'poll', title: '你每天运动多长时间？', content: '交易员群体的运动习惯调查。别告诉我你的运动只有手指点鼠标...', pollEnabled: true },
    { type: 'mention', title: '护眼设置推荐', content: '@DeskSetupPro 上次推荐的显示器蓝光过滤器确实有效，晚上盯盘眼睛没那么酸了。另外 @摸鱼队长 说的每小时站立提醒也很实用。', mentionHandles: ['DeskSetupPro', '摸鱼队长'] },
  ],
  8: [ // 网格交易爱好者
    { type: 'long', title: '网格交易参数优化：BTC/USDT实盘分享', content: '分享一下我跑了3个月的BTC网格参数和收益：\n\n📊 参数设置：\n- 交易对：BTC/USDT\n- 价格范围：$55,000 - $75,000\n- 网格数量：50格\n- 每格投入：$200\n- 总投入：$10,000\n\n📈 3个月收益：\n- 网格利润：$1,240 (12.4%)\n- 年化约：49.6%\n- 最大浮亏：-$800 (8%)\n- 总成交次数：342次\n\n💡 优化要点：\n1. 价格范围要覆盖主要波动区间\n2. 网格密度影响成交频率\n3. 震荡行情网格表现最好\n4. 单边下跌时要手动暂停\n5. 手续费要计入成本（选maker费率低的交易所）\n\n适合不想盯盘、追求稳定收益的朋友。', mentionHandles: [] },
    { type: 'short', title: '震荡行情网格起飞', content: '最近BTC在$60K-$68K之间反复震荡，我的网格疯狂成交。这一周光网格利润就有$340，比上班工资还高😂' },
    { type: 'mention', title: '回测工具推荐', content: '感谢 @QuantCoder 推荐的backtrader框架，我用它回测了不同网格参数的历史表现，找到了最优解。\n\n结论：50格比100格效率更高（考虑手续费），价格范围覆盖±20%是最优的。', mentionHandles: ['QuantCoder'] },
    { type: 'poll', title: '你的网格年化收益率是多少？', content: '长期运行网格的朋友来分享一下年化收益率。', pollEnabled: true },
  ],
  9: [ // 合约交易研习社
    { type: 'long', title: '合约交易的仓位管理：凯利公式实战应用', content: '很多人做合约亏钱不是因为方向错，而是仓位太大。今天分享凯利公式在合约交易中的应用：\n\n📐 凯利公式：f = (bp - q) / b\n- f = 最优仓位比例\n- b = 赔率（盈亏比）\n- p = 胜率\n- q = 1 - p（败率）\n\n📊 实例：\n假设你的策略胜率60%，盈亏比2:1\nf = (2×0.6 - 0.4) / 2 = 0.4\n\n理论上应该用40%仓位，但实际中建议用1/4凯利值（10%），因为：\n1. 真实胜率可能被高估\n2. 黑天鹅事件\n3. 心理承受能力\n4. 连续亏损的概率\n\n⚠️ 关键原则：\n- 单笔亏损不超过总资金的2%\n- 总持仓不超过总资金的30%\n- 相关性高的品种算一个仓位\n- 浮盈加仓用确认后的利润\n\n这套方法让我从频繁爆仓变成了稳定盈利。', mentionHandles: [] },
    { type: 'short', title: '提醒：今晚有CPI数据', content: '今晚8:30 CPI数据公布，预期值7.1%。建议：\n- 减少仓位\n- 设好止损\n- 不要在数据前开新仓\n- 等波动结束再操作\n\n每次都有人在数据公布时被针，别做那个人。' },
    { type: 'poll', title: '你用多少倍杠杆？', content: '做合约的朋友，你常用的杠杆倍数是多少？', pollEnabled: true },
    { type: 'mention', title: '感谢避坑', content: '上周 @合约老手 提醒大家CPI前减仓，我听了建议从10x降到3x。结果数据出来后一根大阴线，如果满仓10x就爆了。\n\n@养生交易员 说的"轻仓好睡觉"真的有道理。', mentionHandles: ['合约老手', '养生交易员'] },
  ],
  10: [ // 波段交易者
    { type: 'long', title: '波段交易系统分享：4H级别双均线策略', content: '分享一个我用了2年的波段交易系统，适合4H级别：\n\n📊 入场规则：\n1. 日线趋势向上（MA20 > MA60）\n2. 4H价格回踩MA20附近\n3. 出现阳线反转K线\n4. RSI在40-50区间\n5. 成交量有所放大\n\n🎯 出场规则：\n- 止损：入场K线低点下方1%\n- 止盈1：1:2盈亏比位置（减仓50%）\n- 止盈2：4H MA20跌破（剩余全出）\n\n📈 2年回测数据（BTC）：\n- 总交易次数：86次\n- 胜率：58%\n- 平均盈亏比：2.3\n- 最大连续亏损：5次\n- 年化收益：约120%\n- 最大回撤：18%\n\n⚠️ 注意：\n- 只在趋势明确时使用\n- 震荡行情暂停交易\n- 严格执行止损\n- 不要追高入场' },
    { type: 'short', title: 'ETH 4H级别背离做空机会', content: 'ETH 4H级别顶背离形成，RSI从75回落。如果跌破$2,580可以做空，目标$2,420，止损$2,650。\n\n仅供参考，DYOR。' },
    { type: 'image', title: '本周波段交易复盘', content: '本周做了3笔波段：\n1. BTC多：+4.2%✅\n2. SOL多：+8.7%✅\n3. ETH空：-2.1%❌（止损出局）\n\n总体盈利+10.8%，符合策略预期。截图附上。', images: ['https://picsum.photos/800/500?random=5'] },
  ],
  11: [ // 链上数据分析
    { type: 'long', title: '巨鲸追踪报告：本周大户异动分析', content: '本周链上数据异动总结：\n\n🐳 BTC巨鲸动向：\n- 持有1000+BTC地址增加12个\n- 交易所BTC余额减少15,000枚（看涨信号）\n- 长期持有者（1年+）占比创新高73%\n\n🔍 ETH生态：\n- Uniswap V3 TVL增长8%\n- 新地址创建速度加快（日均12万）\n- Gas费维持低位，平均15 gwei\n\n📊 稳定币流向：\n- USDT链上转账量增加30%\n- 交易所USDC余额增加$2B（资金入场）\n- Tether新增印了$1B\n\n💡 总结：\n资金在持续流入，大户在囤货，散户在观望。历史上这种模式通常出现在大涨之前。但要注意宏观风险。\n\n数据来源：Glassnode, Nansen, Dune Analytics' },
    { type: 'short', title: '警告：某巨鲸刚转入交易所5000 BTC', content: '刚监控到一个已知的大户地址往Coinbase转入了5000 BTC。上次他这么做的时候BTC跌了12%。\n\n密切关注后续动作。可能是卖出信号。' },
    { type: 'mention', title: 'Dune dashboard分享', content: '做了一个追踪Smart Money的Dune dashboard，包含巨鲸地址的实时仓位变化、交易所流入流出、和历史pattern对比。\n\n@QuantCoder 帮忙优化了SQL查询性能，现在刷新速度快了3倍。\n@BTCMaxi 之前问的BTC长期持有者数据也加进去了。', mentionHandles: ['QuantCoder', 'BTCMaxi'] },
  ],
  12: [ // 交易书籍推荐
    { type: 'long', title: 'Top 10 trading books that actually changed my approach', content: 'After reading 200+ books on trading and markets, here are the 10 that genuinely changed how I trade:\n\n1. "Market Wizards" by Jack Schwager — Real interviews with top traders. Shows there is no single right way.\n\n2. "Trading in the Zone" by Mark Douglas — Trading psychology masterpiece. Fixed my revenge trading.\n\n3. "Reminiscences of a Stock Operator" — Timeless lessons from 100 years ago still apply.\n\n4. "The New Market Wizards" — More great interviews, especially the chapter on risk management.\n\n5. "Technical Analysis of the Financial Markets" by Murphy — The bible of TA.\n\n6. "Thinking, Fast and Slow" by Kahneman — Understanding your cognitive biases.\n\n7. "Antifragile" by Taleb — How to benefit from chaos and black swans.\n\n8. "The Alchemy of Finance" by Soros — Reflexivity theory changed my macro view.\n\n9. "Quantitative Trading" by Ernie Chan — Great intro to quant strategies.\n\n10. "The Man Who Solved the Market" — Jim Simons story. Inspiring and humbling.\n\nStart with #1 and #2. They will save you years of mistakes.' },
    { type: 'short', title: 'Currently reading: "Fooled by Randomness"', content: 'Halfway through Taleb\'s first book. The chapter on survivorship bias hit hard. Makes you question every "successful trader" story.\n\nHighly recommend for anyone who thinks they have an edge.' },
    { type: 'poll', title: 'Best trading book for beginners?', content: 'If you could recommend only ONE book to a complete beginner, which would it be?', pollEnabled: true },
  ],
  13: [ // 山寨币猎人
    { type: 'long', title: 'Altcoin research framework: How I find 10x gems', content: 'My systematic approach to finding undervalued altcoins:\n\n📋 Stage 1 - Screening:\n- Market cap $5M-$50M (enough liquidity, room to grow)\n- Active GitHub commits (last 30 days)\n- Growing social following (not bought)\n- Listed on at least 2 reputable exchanges\n\n📊 Stage 2 - Fundamental Analysis:\n- Token economics (supply schedule, inflation, utility)\n- Team background (LinkedIn, previous projects)\n- Competitive advantage vs similar projects\n- Revenue model and treasury runway\n\n🔍 Stage 3 - On-Chain Metrics:\n- Holder distribution (no >10% wallets except team)\n- Transaction volume trend\n- DEX liquidity depth\n- Smart money accumulation signals\n\n📈 Stage 4 - Technical Entry:\n- Wait for accumulation pattern (Wyckoff)\n- Enter on breakout with volume\n- Position size: 2-5% of portfolio\n- Stop loss: -20% from entry\n- Take profits: 3x, 5x, 10x in thirds\n\n⚠️ Survival rule: Assume 7 out of 10 picks will fail. Size accordingly.' },
    { type: 'short', title: 'New gem alert: $XYZ protocol', content: 'Found an interesting L2 project with $8M mcap. Active dev team, real TVL growth, institutional interest.\n\nNot shilling, just sharing research. DYOR. Will post full analysis this weekend.' },
    { type: 'mention', title: 'On-chain data confirming accumulation', content: 'Ran the numbers on that project I mentioned last week. @链上侦探 helped verify:\n- Whale wallets increased 40% in 2 weeks\n- Exchange outflow accelerating\n- No large insider sells\n\nLooks like smart money is accumulating. @DeFiFarmer any insights on their staking mechanism?', mentionHandles: ['链上侦探', 'DeFiFarmer'] },
  ],
  14: [ // 比特币信仰者
    { type: 'long', title: 'Why Bitcoin is the only crypto that matters', content: 'Unpopular opinion (in altcoin circles): Bitcoin is the only cryptocurrency with real staying power.\n\nHere is why:\n\n1. **True decentralization** — No CEO, no foundation with a treasury to dump on you. 20,000+ nodes worldwide.\n\n2. **Fixed supply** — 21 million. Forever. No governance vote can inflate it.\n\n3. **Lindy effect** — 15 years of unbroken operation. Every day it survives makes it more likely to survive another.\n\n4. **Network effects** — Most liquidity, most infrastructure, most institutional adoption.\n\n5. **Simplicity** — Does one thing perfectly: stores value without trust.\n\nEvery altcoin is either:\n- Trying to be a better Bitcoin (they are not)\n- Trying to do something else (then they are not money)\n- A security pretending to be decentralized\n\nI hold 100% BTC. No alts. Sleep like a baby.\n\nNot financial advice. But seriously, have fun staying poor with your governance tokens.' },
    { type: 'short', title: 'Another day, another altcoin rug 🤷', content: 'That hyped AI token everyone was shilling last month? Down 94% and team went silent.\n\nMeanwhile BTC is up 2% today. Boring? Yes. Reliable? Also yes.\n\nTick tock, next block.' },
    { type: 'poll', title: 'What % of your portfolio is BTC?', content: 'Honest answers only. No judgment (okay maybe a little judgment if it is under 50%).', pollEnabled: true },
  ],
  15: [ // DeFi农民
    { type: 'long', title: 'Yield farming strategy: Sustainable 25%+ APY', content: 'Most yield farming tutorials show you unsustainable 1000% APY farms that die in a week. Here is how I consistently earn 25-40% APY with reasonable risk:\n\n🌾 Strategy 1: Blue-chip LP + Incentives\n- Provide ETH/USDC liquidity on Uniswap V3\n- Concentrate liquidity in ±10% range\n- Collect trading fees + farm UNI rewards\n- Rebalance weekly\n- APY: ~25-35%\n\n🌾 Strategy 2: Recursive Lending\n- Deposit ETH on Aave\n- Borrow stablecoins at low rate\n- Deposit stables on Compound\n- Net APY after borrowing cost: ~15-20%\n- Risk: liquidation if ETH drops fast\n\n🌾 Strategy 3: LST Arbitrage\n- Hold stETH (Lido) for staking yield\n- Provide stETH/ETH liquidity on Curve\n- Earn staking + LP + CRV rewards\n- APY: ~30-40%\n\n⚠️ Risk management:\n- Never put >20% in one protocol\n- Check smart contract audits\n- Monitor health ratios hourly\n- Have exit plan for each position\n- Account for impermanent loss' },
    { type: 'short', title: 'New Arbitrum farm looks promising', content: 'Found a new yield farm on Arbitrum. ETH/USDC pool with 45% APY. Protocol is forked from Uniswap V3, audited by Trail of Bits.\n\nPutting in $5K to test. Will report back in a week.' },
    { type: 'mention', title: 'Smart contract risk assessment', content: 'Before aping into that new farm, @QuantCoder helped me review the contract:\n- No mint functions accessible by owner ✅\n- Timelock on admin functions ✅\n- But... emergency withdraw has no delay ⚠️\n\nProceeding with small position. @AltHunter what is your take on their tokenomics?', mentionHandles: ['QuantCoder', 'AltHunter'] },
  ],
  16: [ // 技术指标研究
    { type: 'long', title: 'RSI的正确用法：不只是超买超卖', content: 'RSI（相对强弱指标）是最常用的技术指标之一，但90%的人用错了。\n\n❌ 常见错误用法：\n- RSI > 70就做空\n- RSI < 30就做多\n- 这种用法在趋势行情中会让你反复止损\n\n✅ 正确用法：\n\n1. **趋势确认**\n- 上升趋势中，RSI在40-80之间波动\n- 下降趋势中，RSI在20-60之间波动\n- 突破50线确认趋势方向\n\n2. **背离信号**（最有价值的用法）\n- 看涨背离：价格新低，RSI不新低 → 做多信号\n- 看跌背离：价格新高，RSI不新高 → 做空信号\n- 隐藏背离确认趋势延续\n\n3. **Failure Swing**\n- RSI跌破30后回升，再次回测不破30 → 强烈做多信号\n\n4. **多周期共振**\n- 日线RSI方向 + 4H RSI入场时机\n- 大周期定方向，小周期找入场\n\n配合均线和成交量使用效果更佳。单独使用任何指标都不够可靠。' },
    { type: 'short', title: 'MACD金叉但不敢追', content: 'BTC日线MACD刚金叉，但位置偏高。上次在这个位置金叉后涨了3%就开始回落。\n等MACD回到零轴附近再金叉比较安全。' },
    { type: 'poll', title: '你最常用的技术指标是？', content: '每个人都有自己的核心指标组合，你最依赖哪个？', pollEnabled: true },
  ],
  17: [ // 交易员的桌面
    { type: 'long', title: 'Ultimate trading desk setup guide 2024', content: 'After 5 years of optimizing my trading workspace, here is my current setup and why:\n\n🖥️ Monitors:\n- Main: LG 34" ultrawide (charts)\n- Secondary: Dell 27" 4K (order books + news)\n- Vertical: 24" rotated (watchlists + alerts)\n- Total: 3 monitors on dual arm mount\n\n💺 Chair:\n- Herman Miller Aeron (size B)\n- Worth every penny for 12+ hour days\n- Proper lumbar support prevents back pain\n\n⌨️ Input:\n- Keychron Q1 mechanical (tactile switches)\n- Logitech MX Master 3S mouse\n- Stream Deck for hotkeys (buy/sell/screenshot)\n\n💡 Environment:\n- LED bias lighting behind monitors (reduces eye strain)\n- Standing desk converter (sit/stand every hour)\n- Blue light glasses for evening sessions\n- White noise machine for focus\n\n🔌 Tech:\n- MacBook Pro M3 Max (primary)\n- NUC mini PC (backup/redundancy)\n- UPS battery backup (never lose connection mid-trade)\n- Dual internet (fiber + 5G backup)\n\nTotal investment: ~$8,000\nROI: Priceless (health + productivity + edge)' },
    { type: 'image', title: 'Clean desk, clean mind 🧹', content: 'Just reorganized my trading corner. Cable management took 3 hours but worth it. No distractions, just screens and focus.\n\nThe plant is new — supposedly reduces stress. We will see if my PnL agrees.', images: ['https://picsum.photos/800/600?random=6'] },
    { type: 'short', title: 'Best investment: standing desk', content: 'Switched to a sit-stand desk 6 months ago. My back pain is gone, I am more alert during sessions, and I stopped falling asleep during Asian session.\n\nFlexiSpot E7 if anyone asks. Under $500.' },
    { type: 'poll', title: 'How many monitors do you trade with?', content: 'Quick survey — how many screens in your trading setup?', pollEnabled: true },
  ],
  18: [ // 量化编程交流
    { type: 'long', title: 'Building a crypto trading bot with Python: Architecture guide', content: 'Sharing the architecture of my Python trading bot that has been running live for 18 months:\n\n🏗️ Architecture:\n```\n├── core/\n│   ├── strategy.py    # Signal generation\n│   ├── execution.py   # Order management\n│   ├── risk.py        # Position sizing\n│   └── data.py        # Market data feed\n├── strategies/\n│   ├── momentum.py\n│   ├── mean_revert.py\n│   └── grid.py\n├── exchange/\n│   ├── binance.py\n│   └── bybit.py\n└── utils/\n    ├── logger.py\n    └── notifier.py\n```\n\n🔑 Key principles:\n1. **Separation of concerns** — Strategy logic never touches exchange API directly\n2. **Event-driven** — Everything is async, reacts to price updates\n3. **Risk first** — Risk module has veto power over any trade\n4. **Redundancy** — Heartbeat monitoring, auto-restart on crash\n5. **Paper trading mode** — Test without real money\n\n📊 Performance:\n- Sharpe ratio: 2.1\n- Max drawdown: 8%\n- Win rate: 62%\n- Avg holding time: 4.2 hours\n- Annual return: ~85%\n\nHappy to answer questions about specific components.' },
    { type: 'short', title: 'Rust vs Python for trading bots', content: 'Finally rewrote my execution engine in Rust. Latency went from 15ms to 0.3ms.\n\nFor signal generation, Python is still fine. But if you are doing anything latency-sensitive (arb, market making), Rust is the way.' },
    { type: 'mention', title: 'Backtesting framework comparison', content: 'Tested 4 frameworks for crypto backtesting:\n- Backtrader: Python, feature-rich but slow\n- Zipline: Python, designed for stocks, crypto support weak\n- Jesse: Python, crypto-native, best DX\n- Custom Rust: Fast but maintenance heavy\n\nGoing with Jesse for prototyping, Rust for production. @网格大师 this might help with your grid optimization project.', mentionHandles: ['网格大师'] },
    { type: 'poll', title: 'What language for your trading bot?', content: 'What programming language are you using (or planning to use) for automated trading?', pollEnabled: true },
  ],
  19: [ // 交易心理学
    { type: 'long', title: '克服报复性交易：我的5步方法', content: '报复性交易可能是交易员最大的敌人之一。亏了钱后想马上赚回来，结果越亏越多。\n\n我曾经一天之内因为报复性交易把3万U亏到只剩2000U。那之后我开发了一套系统来控制自己：\n\n🧠 5步控制法：\n\n1. **设定日亏损上限**\n- 日亏损达到总资金3%就强制停止交易\n- 物理离开电脑，去散步\n\n2. **亏损后冷静期**\n- 连续2笔亏损后，休息30分钟\n- 这30分钟不看行情\n\n3. **交易日记**\n- 每笔交易记录情绪状态\n- 回顾时找出情绪化交易的模式\n\n4. **仓位自动降低**\n- 亏损后下一笔仓位自动减半\n- 连赢3笔后才能恢复正常仓位\n\n5. **问自己3个问题**\n- 这笔交易符合我的策略吗？\n- 如果我刚刚没有亏钱，我还会做这笔交易吗？\n- 这是交易还是赌博？\n\n实施这套方法后，我的月度亏损减少了70%。交易最难的不是技术，而是管理自己的情绪。' },
    { type: 'short', title: '今天强制自己不开单', content: '心情烦躁的时候就不要交易。今天因为生活中的事情情绪很差，所以主动关掉了交易软件。\n\n以前不懂这个道理，心情不好的时候乱开单，亏了更烦躁，恶性循环。' },
    { type: 'poll', title: '你会报复性交易吗？', content: '亏钱后你会忍不住想马上赚回来吗？不用不好意思，大部分人都有这个问题。', pollEnabled: true },
    { type: 'mention', title: '推荐一个管理情绪的方法', content: '最近尝试了 @养生交易员 推荐的冥想方法，每天交易前冥想10分钟。\n\n一个月下来，我的报复性交易次数从每周3-4次降到了每周不到1次。真的有效！\n\n@BookTrader 那本《Trading in the Zone》也帮了很大的忙，推荐还没看过的朋友读一读。', mentionHandles: ['养生交易员', 'BookTrader'] },
  ],
}

// ─── Comment Templates ───────────────────────────────────────────────────────

const COMMENT_TEMPLATES = {
  supportive_zh: [
    '太有共鸣了，我也是这样！',
    '感谢分享，学到很多',
    '收藏了，之后慢慢看',
    '写得很好，希望多出这样的内容',
    '终于有人说实话了',
    '同意，这个思路很清晰',
    '好文章，转发给朋友看了',
    '干货满满，感谢楼主',
  ],
  critical_zh: [
    '有不同看法，我觉得风险被低估了',
    '这个策略在单边行情中不适用吧？',
    '回测数据有过拟合的嫌疑',
    '建议加上风控的部分，光讲赚钱不讲风险不完整',
    '不太同意这个结论，数据样本太小了',
    '理论上可以，实操中有很多你没提到的问题',
  ],
  humorous_zh: [
    '看完这个帖子，我决定明天就梭哈（开玩笑的）',
    '笑死了，我就是那个在半山腰抄底的人😂',
    '这个帖子我截图了，等你翻车了来对线',
    '我已经装死了，别@我',
    '居然不是广告？难得',
    '好家伙，你这是在说我吗？',
  ],
  supportive_en: [
    'This is exactly what I needed to read today',
    'Great analysis, thanks for sharing',
    'Saved for future reference',
    'Solid advice, been doing this for a while and can confirm',
    'Underrated post, more people need to see this',
    'Finally some quality content on here',
    'Bookmarked. This is gold.',
  ],
  critical_en: [
    'Interesting take but I disagree on the risk assessment',
    'This works in bull markets but what about bear?',
    'Sample size is too small to draw conclusions',
    'Survivorship bias much?',
    'Need more data to back this up',
    'Works until it does not. What is your drawdown plan?',
  ],
  humorous_en: [
    'Instructions unclear, bought the top again',
    'Sir this is a Wendy\'s',
    'Narrator: he did not, in fact, take profits',
    'My wife is going to kill me when she sees this',
    'cope and seethe detected',
    'least delusional crypto trader',
  ],
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min
}

function pickRandom<T>(arr: T[], count: number): T[] {
  const shuffled = [...arr].sort(() => Math.random() - 0.5)
  return shuffled.slice(0, Math.min(count, arr.length))
}

function pickOne<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]
}

function randomDate(daysAgo: number): string {
  const date = new Date()
  date.setDate(date.getDate() - randomInt(1, daysAgo))
  date.setHours(randomInt(6, 23), randomInt(0, 59), randomInt(0, 59))
  return date.toISOString()
}

// ─── Main Seed Function ──────────────────────────────────────────────────────

async function seed() {
  console.log('=== Community Seed Script ===\n')

  // ── Step 1: Clean existing data ──────────────────────────────────────────
  console.log('[1/9] Cleaning existing data...')
  // Order matters due to foreign keys
  const cleanTables = [
    'comment_likes',
    'comments',
    'post_votes',
    'post_likes',
    'post_bookmarks',
    'posts',
    'group_members',
    'groups',
    'user_follows',
    'notifications',
  ]
  for (const table of cleanTables) {
    const { error } = await supabase.from(table).delete().neq('id', '00000000-0000-0000-0000-000000000000')
    if (error && !error.message.includes('column') && !error.message.includes('does not exist')) {
      // Some tables use composite PK, try alternative
      if (table === 'post_likes' || table === 'comment_likes') {
        await supabase.from(table).delete().gte('created_at', '1970-01-01')
      } else {
        console.warn(`  Warning cleaning ${table}: ${error.message}`)
      }
    }
  }

  // Delete test auth users
  const { data: existingUsers } = await supabase.auth.admin.listUsers({ perPage: 1000 })
  const testEmails = USERS.map(u => u.email)
  for (const user of existingUsers?.users || []) {
    if (testEmails.includes(user.email || '')) {
      await supabase.auth.admin.deleteUser(user.id)
    }
  }
  console.log('  Done.\n')

  // ── Step 2: Create auth users ────────────────────────────────────────────
  console.log('[2/9] Creating 18 test users...')
  const userIds: Map<string, string> = new Map() // handle → user_id

  for (const u of USERS) {
    const { data, error } = await supabase.auth.admin.createUser({
      email: u.email,
      password: u.password,
      email_confirm: true,
      user_metadata: { handle: u.handle },
    })
    if (error) {
      console.error(`  Failed to create ${u.email}: ${error.message}`)
      continue
    }
    userIds.set(u.handle, data.user.id)
    console.log(`  Created: ${u.handle} (${u.email})`)
  }
  console.log(`  Total: ${userIds.size} users\n`)

  // ── Step 3: Update user profiles ─────────────────────────────────────────
  console.log('[3/9] Updating user profiles...')
  for (const u of USERS) {
    const userId = userIds.get(u.handle)
    if (!userId) continue
    const avatarUrl = `https://api.dicebear.com/7.x/avataaars/svg?seed=${encodeURIComponent(u.handle)}`
    await supabase.from('user_profiles').upsert({
      id: userId,
      handle: u.handle,
      bio: u.bio,
      avatar_url: avatarUrl,
      email: u.email,
    })
  }
  console.log('  Done.\n')

  // ── Step 4: Create groups ────────────────────────────────────────────────
  console.log('[4/9] Creating 20 groups...')
  const groupIds: string[] = []

  for (const g of GROUPS) {
    const creatorId = userIds.get(g.creatorHandle)
    if (!creatorId) {
      console.warn(`  Skipping group "${g.name}" — creator ${g.creatorHandle} not found`)
      continue
    }

    const { data, error } = await supabase
      .from('groups')
      .insert({
        name: g.name,
        name_en: g.name_en,
        description: g.description,
        description_en: g.description_en,
        created_by: creatorId,
        member_count: 0,
      })
      .select('id')
      .single()

    if (error) {
      console.error(`  Failed to create group "${g.name}": ${error.message}`)
      continue
    }
    groupIds.push(data.id)
    console.log(`  Created: ${g.name}`)
  }
  console.log(`  Total: ${groupIds.length} groups\n`)

  // ── Step 5: Add group members ────────────────────────────────────────────
  console.log('[5/9] Adding group members...')
  const allHandles = Array.from(userIds.keys())
  let totalMembers = 0

  for (let i = 0; i < GROUPS.length && i < groupIds.length; i++) {
    const groupId = groupIds[i]
    const creatorId = userIds.get(GROUPS[i].creatorHandle)!
    const memberCount = randomInt(6, 12)

    // Add creator as owner
    await supabase.from('group_members').insert({
      group_id: groupId,
      user_id: creatorId,
      role: 'owner',
    })

    // Add random members
    const otherHandles = allHandles.filter(h => h !== GROUPS[i].creatorHandle)
    const memberHandles = pickRandom(otherHandles, memberCount - 1)

    for (const handle of memberHandles) {
      const memberId = userIds.get(handle)!
      await supabase.from('group_members').insert({
        group_id: groupId,
        user_id: memberId,
        role: 'member',
      })
    }

    // Update member count
    await supabase.from('groups').update({ member_count: memberCount }).eq('id', groupId)
    totalMembers += memberCount
  }
  console.log(`  Total memberships: ${totalMembers}\n`)

  // ── Step 6: Create posts ─────────────────────────────────────────────────
  console.log('[6/9] Creating posts...')
  const postRecords: Array<{ id: string; groupIdx: number; postIdx: number; authorHandle: string }> = []

  for (let groupIdx = 0; groupIdx < groupIds.length; groupIdx++) {
    const groupId = groupIds[groupIdx]
    const groupDef = GROUPS[groupIdx]
    const templates = GROUP_POSTS[groupIdx] || []

    // Get group members for realistic authoring
    const { data: members } = await supabase
      .from('group_members')
      .select('user_id')
      .eq('group_id', groupId)

    const memberUserIds = members?.map(m => m.user_id) || []
    const memberHandles = allHandles.filter(h => {
      const uid = userIds.get(h)
      return uid && memberUserIds.includes(uid)
    })

    for (let postIdx = 0; postIdx < templates.length; postIdx++) {
      const tmpl = templates[postIdx]

      // Choose author: first post by creator, others by random members
      let authorHandle: string
      if (postIdx === 0) {
        authorHandle = groupDef.creatorHandle
      } else {
        authorHandle = memberHandles.length > 0 ? pickOne(memberHandles) : groupDef.creatorHandle
      }
      const authorId = userIds.get(authorHandle)!

      const postData: Record<string, unknown> = {
        title: tmpl.title,
        content: tmpl.content,
        author_id: authorId,
        author_handle: authorHandle,
        group_id: groupId,
        poll_enabled: tmpl.pollEnabled || false,
        images: tmpl.images || null,
        created_at: randomDate(30),
      }

      // Set poll counts for poll posts
      if (tmpl.pollEnabled) {
        postData.poll_bull = randomInt(3, 25)
        postData.poll_bear = randomInt(2, 20)
        postData.poll_wait = randomInt(1, 15)
      }

      const { data, error } = await supabase
        .from('posts')
        .insert(postData)
        .select('id')
        .single()

      if (error) {
        console.error(`  Failed post in group ${groupIdx}: ${error.message}`)
        continue
      }

      postRecords.push({ id: data.id, groupIdx, postIdx, authorHandle })
    }
  }
  console.log(`  Total: ${postRecords.length} posts\n`)

  // ── Step 7: Create comments ──────────────────────────────────────────────
  console.log('[7/9] Creating comments...')
  let totalComments = 0

  for (const post of postRecords) {
    const numComments = randomInt(2, 5)
    const groupId = groupIds[post.groupIdx]

    // Get group members for comment authors
    const { data: members } = await supabase
      .from('group_members')
      .select('user_id')
      .eq('group_id', groupId)

    const memberUserIds = members?.map(m => m.user_id) || []
    const commentableHandles = allHandles.filter(h => {
      const uid = userIds.get(h)
      return uid && memberUserIds.includes(uid) && h !== post.authorHandle
    })

    if (commentableHandles.length === 0) continue

    const commentIds: string[] = []

    for (let c = 0; c < numComments; c++) {
      const commentAuthor = pickOne(commentableHandles)
      const commentAuthorId = userIds.get(commentAuthor)!
      const isZh = USERS.find(u => u.handle === commentAuthor)?.lang === 'zh'

      // Pick comment content based on language and randomness
      let content: string
      const r = Math.random()
      if (r < 0.5) {
        content = pickOne(isZh ? COMMENT_TEMPLATES.supportive_zh : COMMENT_TEMPLATES.supportive_en)
      } else if (r < 0.8) {
        content = pickOne(isZh ? COMMENT_TEMPLATES.critical_zh : COMMENT_TEMPLATES.critical_en)
      } else {
        content = pickOne(isZh ? COMMENT_TEMPLATES.humorous_zh : COMMENT_TEMPLATES.humorous_en)
      }

      // Sometimes add @mention to comment
      if (Math.random() < 0.2) {
        const mentionTarget = pickOne(allHandles.filter(h => h !== commentAuthor))
        content += ` @${mentionTarget}`
      }

      // Sometimes make it a reply to a previous comment
      const parentId = commentIds.length > 0 && Math.random() < 0.3
        ? pickOne(commentIds)
        : null

      const { data, error } = await supabase
        .from('comments')
        .insert({
          post_id: post.id,
          user_id: commentAuthorId,
          author_handle: commentAuthor,
          content,
          parent_id: parentId,
          created_at: randomDate(28),
        })
        .select('id')
        .single()

      if (error) continue
      commentIds.push(data.id)
      totalComments++
    }

    // Update post comment_count
    await supabase.from('posts').update({ comment_count: commentIds.length }).eq('id', post.id)
  }
  console.log(`  Total: ${totalComments} comments\n`)

  // ── Step 8: Create likes, bookmarks, follows ─────────────────────────────
  console.log('[8/9] Creating social interactions...')
  let totalLikes = 0
  let totalBookmarks = 0
  let totalFollows = 0

  // Likes: each post gets 2-10 random likes
  for (const post of postRecords) {
    const likeCount = randomInt(2, 10)
    const likers = pickRandom(Array.from(userIds.values()), likeCount)

    for (const likerId of likers) {
      const { error } = await supabase.from('post_likes').insert({
        user_id: likerId,
        post_id: post.id,
      })
      if (!error) totalLikes++
    }
    // Update post like_count
    await supabase.from('posts').update({ like_count: likeCount }).eq('id', post.id)
  }

  // Bookmarks: ~30% of posts get 1-3 bookmarks
  for (const post of postRecords) {
    if (Math.random() > 0.3) continue
    const bookmarkCount = randomInt(1, 3)
    const bookmarkers = pickRandom(Array.from(userIds.values()), bookmarkCount)

    for (const userId of bookmarkers) {
      const { error } = await supabase.from('post_bookmarks').insert({
        user_id: userId,
        post_id: post.id,
      })
      if (!error) totalBookmarks++
    }
  }

  // Follows: create 30-50 follow relationships
  const allUserIds = Array.from(userIds.values())
  const followCount = randomInt(30, 50)
  const followPairs = new Set<string>()

  for (let i = 0; i < followCount; i++) {
    const follower = pickOne(allUserIds)
    const following = pickOne(allUserIds.filter(id => id !== follower))
    const pairKey = `${follower}-${following}`

    if (followPairs.has(pairKey)) continue
    followPairs.add(pairKey)

    const { error } = await supabase.from('user_follows').insert({
      follower_id: follower,
      following_id: following,
    })
    if (!error) totalFollows++
  }

  // Poll votes for poll posts
  let totalPollVotes = 0
  for (const post of postRecords) {
    const tmpl = GROUP_POSTS[post.groupIdx]?.[post.postIdx]
    if (!tmpl?.pollEnabled) continue

    const voterCount = randomInt(5, 15)
    const voters = pickRandom(allUserIds, voterCount)
    const choices: Array<'bull' | 'bear' | 'wait'> = ['bull', 'bear', 'wait']

    for (const voterId of voters) {
      const choice = pickOne(choices)
      const { error } = await supabase.from('post_votes').insert({
        post_id: post.id,
        user_id: voterId,
        choice,
      })
      if (!error) totalPollVotes++
    }
  }

  console.log(`  Likes: ${totalLikes}`)
  console.log(`  Bookmarks: ${totalBookmarks}`)
  console.log(`  Follows: ${totalFollows}`)
  console.log(`  Poll votes: ${totalPollVotes}\n`)

  // ── Step 9: Print summary ────────────────────────────────────────────────
  console.log('[9/9] Seed complete!\n')
  console.log('=== Summary ===')
  console.log(`  Users: ${userIds.size}`)
  console.log(`  Groups: ${groupIds.length}`)
  console.log(`  Posts: ${postRecords.length}`)
  console.log(`  Comments: ${totalComments}`)
  console.log(`  Likes: ${totalLikes}`)
  console.log(`  Bookmarks: ${totalBookmarks}`)
  console.log(`  Follows: ${totalFollows}`)
  console.log(`  Poll votes: ${totalPollVotes}`)

  console.log('\n=== Test Credentials ===')
  console.log('─'.repeat(60))
  console.log(`${'Email'.padEnd(25)} ${'Password'.padEnd(14)} Handle`)
  console.log('─'.repeat(60))
  for (const u of USERS) {
    console.log(`${u.email.padEnd(25)} ${u.password.padEnd(14)} ${u.handle}`)
  }
  console.log('─'.repeat(60))
}

seed().catch((err) => {
  console.error('Seed failed:', err)
  process.exit(1)
})
