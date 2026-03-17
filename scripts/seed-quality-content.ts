/**
 * Seed Quality Content — Generate realistic, varied, high-quality posts and comments.
 *
 * Usage:
 *   npx tsx scripts/seed-quality-content.ts --dry-run     # Preview without writing
 *   npx tsx scripts/seed-quality-content.ts --execute      # Write to DB
 *   npx tsx scripts/seed-quality-content.ts --cleanup      # Delete all seed comments, then re-seed
 *
 * This replaces the old low-effort comments ("确实", "fr", "6") with
 * substantive, context-aware replies that read like a real trading community.
 */

import { createClient } from '@supabase/supabase-js'
import * as dotenv from 'dotenv'
dotenv.config({ path: '.env.local' })

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } }
)

const mode = process.argv[2] || '--dry-run'

// ─── Seed User Handles ───
const SEED_HANDLES = [
  'whale88', 'defichad', 'shanzhai', 'ta_ren', 'macro_t', 'btconly',
  'moyu_t', 'levup', 'dushu_t', 'jiucai_og', 'diamondh', 'quant_w',
  'boduan', 'suoha', 'onchain_k', 'jpegflip', 'alpha_sr', 'baocang',
  'botrunner', 'yangsheng', 'cexwatcher', 'quant_dev', 'setupguy',
  'tradersz', 'readntrade', '0xalt',
]

// ─── Quality Post Templates ───
// Each has: content (supports {btcPrice}, {ethPrice}, {topTrader}), tags, language
const POST_TEMPLATES = [
  // Trading journal / P&L posts
  { content: 'Opened a 5x long $ETH at $2,180 — thesis: ETH/BTC ratio bottomed on weekly, funding is negative, and the merge narrative is coming back with Pectra upgrade. Target $2,600, stop at $2,050. Risk/reward about 3:1.', lang: 'en' },
  { content: '今天的交易复盘：\n\n做多 SOL 在 $89 进场，$94 出场。逻辑是 Solana DEX 交易量连续三天创新高 + 大户在链上加仓。止损设在 $86 下方（4H 支撑位）。盈利 +5.6%，仓位 10% 资金。\n\n关键教训：进场时机还是太早了，应该等 4H 收线确认再进。', lang: 'zh' },
  { content: 'Week 12 P&L recap:\n\n- Mon: +$420 (BTC long scalp)\n- Tue: -$180 (ETH short stopped out)\n- Wed: flat (no setup)\n- Thu: +$890 (SOL breakout trade)\n- Fri: +$340 (BTC range trade)\n\nNet: +$1,470 (+2.9% portfolio)\n\nBiggest lesson: Wednesday discipline — no setup = no trade. That\'s the hardest skill.', lang: 'en' },
  { content: '爆仓记录：\n\n$BTC 空单 10x 杠杆，入场 73,200，爆仓价 74,800。结果一根 15 分钟 K 线直接拉到 75,100。亏损 $2,400。\n\n反思：\n1. 杠杆太高（应该 3-5x）\n2. 没设止损（致命错误）\n3. 逆势做空强势币种\n\n这种错误不能再犯第二次了。', lang: 'zh' },

  // Market analysis
  { content: 'BTC on-chain analysis thread:\n\n1. Exchange outflows hit 3-month high — accumulation signal\n2. Long-term holder supply at ATH (68%)\n3. Funding rates neutral across all exchanges\n4. Open interest climbing but not overheated\n\nConclusion: positioning for a leg up, but timing is uncertain. I\'m 60% long with tight stops below $71k.', lang: 'en' },
  { content: '链上数据分析：\n\nHyperliquid 过去 7 天的数据很有意思：\n- 日均交易量 $8.2B（比上月 +35%）\n- 新开户数增长 22%\n- 大户（>$100k）的持仓比例从 45% 升到 52%\n\n解读：机构资金正在从 CEX 转向链上衍生品。Arena 排行榜上 Hyperliquid 的 top trader 平均 ROI 也是最高的，不是偶然。', lang: 'zh' },
  { content: 'Unpopular opinion: Most traders focus too much on entry and not enough on position sizing.\n\nLook at the top 10 on Arena — average win rate is only 40-50%. They don\'t win more often, they just win BIGGER when they\'re right.\n\nThe real edge is:\n1. Cut losses fast (avg loss < 2%)\n2. Let winners run (avg win > 5%)\n3. Size positions by conviction, not emotion\n\nWin rate is vanity. Expectancy is sanity.', lang: 'en' },
  { content: '给新人的几个建议（踩过的坑）：\n\n1. 不要在推特上跟单。Arena 排行榜至少数据是真的。\n2. 胜率 50% 以下也能赚钱，关键是盈亏比 > 2:1\n3. 永远不要满仓。最多用 30% 资金开仓。\n4. 回撤 20% 就停手，先休息一天。\n5. 写交易日记比看 100 条分析有用。\n\n这些道理说起来简单，做到很难。共勉。', lang: 'zh' },

  // Platform commentary
  { content: 'Comparing Arena Score methodology across exchanges:\n\nNoticed that Binance traders tend to have lower Arena Scores than Hyperliquid traders with similar ROI. After looking into it, the reason is clear: Arena Score factors in max drawdown, and CEX traders generally use lower leverage → smaller drawdowns → higher MDD scores.\n\nBut Hyperliquid traders take bigger bets → higher ROI → compensates for worse MDD.\n\nNeither is "better" — just different risk profiles. The 90D composite score helps normalize this.', lang: 'en' },
  { content: '刚仔细看了 Arena 的 Score 算法文档：\n\n- Return Score (60分): 用 tanh 函数压缩 ROI，避免极端值主导\n- Profit Score (40分): 基于绝对 PnL，大资金量有优势\n- 置信度乘数: 交易次数太少会被降权\n\n这个设计比单纯看 ROI 排名合理多了。有些人 ROI 10000% 但只做了 2 笔交易，风险极高。Arena Score 会把这种人降到很低。', lang: 'zh' },

  // Casual / community posts
  { content: 'Just discovered that the #1 trader on GMX leaderboard has a 65% win rate with an avg holding time of 16 hours. Classic swing trader approach. Meanwhile most people are scalping with 35% win rate and wondering why they lose money.', lang: 'en' },
  { content: '昨晚 ETH 拉盘到 $2,247 的时候我在睡觉。\n\n醒来看到账户 +$800，比任何闹钟都好使。\n\n持仓过夜有风险，但这次逻辑是对的：ETH 在 $2,100 附近形成了明显的双底，加上 gas 费降到历史低位说明 layer2 分流了大量交易。做多的逻辑站得住。', lang: 'zh' },
  { content: 'Funded $500 into a fresh account to test a new strategy:\n- Only trade BTC and ETH\n- Max 3x leverage\n- Only enter on 4H close above/below key levels\n- Target: double the account in 90 days\n\nWill track progress on Arena. Current score: 0. Let\'s see where this goes.', lang: 'en' },
]

// ─── Quality Comment Templates ───
// Keyed by post topic detection, each an array of substantive comments
const COMMENT_POOLS = {
  // When post is about P&L / trade journal
  pnl: [
    'Good risk management — 10% position size is reasonable. What\'s your max drawdown tolerance before you cut the trade?',
    '盈亏比不错。你平时用什么确认入场信号？我一般等 MACD 和 RSI 同时确认才进。',
    'The stop placement makes sense. One thing I\'d add: consider trailing your stop once you\'re 2R in profit.',
    '这个交易逻辑清晰。不过我个人觉得 SOL 现在走势受 BTC 影响太大，单独看 SOL 基本面可能不够。',
    'Nice journal. Keeping track like this is underrated. Most people just look at final P&L and miss the process.',
    '爆仓总结写得很真实。杠杆管理确实是新手最容易犯的错。10x 基本等于赌博。',
    'I had a similar setup but chickened out at $91. Watching you take profit at $94 hurts lol. Conviction matters.',
    '周复盘很有价值。周三不交易的决定是最好的交易。纪律比技术分析重要 10 倍。',
  ],
  // When post is about market analysis
  analysis: [
    'The exchange outflow data is compelling, but I\'d want to see funding rates stay neutral for at least another week before going heavier.',
    'Hyperliquid 数据确实在爆发。不过要注意一个因素：他们最近空投预期带来了大量刷量交易，实际有效交易量可能没那么高。',
    'Good analysis but I disagree on one point: OI climbing + neutral funding usually means smart money is hedging, not positioning for a pump.',
    '链上数据分析得不错。补充一个观察：大户持仓比例上升的同时，散户资金在流出。这种背离通常是牛市前的信号。',
    'I track similar metrics. One thing you\'re missing: stablecoin supply on exchanges. That\'s been declining, which is bearish short-term liquidity.',
    '同意整体判断。但 $71k 止损是不是太紧了？ BTC 日内波动经常 3%，很容易被扫。建议看周线支撑。',
  ],
  // When post is about strategy / advice
  strategy: [
    'Position sizing is the most underrated skill. I use Kelly Criterion modified — never bet more than half-Kelly. Slower growth but way fewer blowups.',
    '写交易日记 +1。我用 Notion 记录每笔交易的入场逻辑、情绪状态和结果。回顾时发现 80% 的亏损都是情绪化交易。',
    'The win rate vs expectancy point is spot on. Paul Tudor Jones has a ~30% win rate. His edge is position sizing and cutting losses fast.',
    '回撤 20% 停手这个规则太重要了。我之前连亏的时候越亏越想扳回来，结果一周亏了 40%。现在严格执行冷静期。',
    'I\'d add one more: always know your max risk per trade BEFORE entering. If you can\'t define it, don\'t take the trade.',
    '这些建议都很实在。我想加一条：不要同时开太多仓位。最多 3 个仓位，这样每个都能认真管理。',
  ],
  // When post is about Arena / platform
  platform: [
    'The tanh compression for Arena Score is smart — it prevents a single 50,000% ROI trade from dominating the leaderboard.',
    'Arena Score 的设计确实比其他平台好。大部分跟单平台只看 ROI，完全忽略了风险指标。',
    'Interesting comparison. I noticed Drift traders tend to score well on the 30D window because they trade more frequently.',
    '90D 权重 70% 是对的。短期运气成分太大，至少看 3 个月才能判断一个 trader 的真实水平。',
    'One thing I appreciate about Arena is the max drawdown in the score. Forces you to trade responsibly, not just YOLO.',
    '建议加一个 Sharpe Ratio 的排序选项。Arena Score 综合排名很好，但有时候我想专门找低波动高收益的 trader。',
  ],
  // Generic but still substantive
  general: [
    'Been following this for a while. The key insight here is that consistency beats big wins in the long run.',
    '说得对。市场永远有机会，但你的资金只有一份。保住本金是第一原则。',
    'This is the kind of content that makes Arena\'s community valuable. Real trades, real analysis, not just memes.',
    '我之前在 Bybit 做了类似操作，结果完全相反。市场真的很humbling。',
    'Solid reasoning. I\'m taking a similar but smaller position. Risk management first, alpha second.',
    '分享一个观察：Arena 排行榜前 50 的交易员，平均持仓时间都超过 4 小时。频繁交易的人排名普遍不高。',
    'Good point. I\'d also look at the volume profile — if there\'s a high volume node at this level, it\'s more likely to act as support.',
    '这波行情确实值得关注。但我更在意的是 ETH 的表现——如果 ETH/BTC ratio 不跟上，说明资金还是在 BTC 单边。',
  ],
}

function pickRandom<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]
}

function pickN<T>(arr: T[], n: number): T[] {
  const shuffled = [...arr].sort(() => Math.random() - 0.5)
  return shuffled.slice(0, n)
}

function detectTopic(content: string): keyof typeof COMMENT_POOLS {
  const lower = content.toLowerCase()
  if (/p&l|pnl|profit|loss|亏|赚|盈|爆仓|止损|stop|entry|exit|复盘|recap/i.test(lower)) return 'pnl'
  if (/analysis|on.chain|funding|open interest|链上|分析|outflow|数据|volume/i.test(lower)) return 'analysis'
  if (/strategy|advice|建议|position.siz|risk.manage|新人|lesson|tip|kelly|discipline/i.test(lower)) return 'strategy'
  if (/arena|score|leaderboard|排行榜|排名|tanh|composite|methodology/i.test(lower)) return 'platform'
  return 'general'
}

async function main() {
  console.log(`Mode: ${mode}\n`)

  // Get seed user IDs
  const { data: users } = await supabase
    .from('user_profiles')
    .select('id, handle')
    .in('handle', SEED_HANDLES)

  if (!users?.length) {
    console.error('No seed users found!')
    return
  }
  const userMap = new Map(users.map(u => [u.handle, u.id]))
  console.log(`Found ${users.length} seed users\n`)

  if (mode === '--cleanup') {
    console.log('Cleaning up old low-quality comments...')
    // Delete comments shorter than 15 chars from seed users
    const seedUserIds = users.map(u => u.id)
    const { data: shortComments } = await supabase
      .from('comments')
      .select('id, content')
      .in('user_id', seedUserIds)
      .limit(2000)

    const toDelete = shortComments?.filter(c => (c.content || '').length < 20) || []
    console.log(`  Found ${toDelete.length} low-quality comments to delete`)

    if (toDelete.length > 0) {
      const batchSize = 100
      for (let i = 0; i < toDelete.length; i += batchSize) {
        const batch = toDelete.slice(i, i + batchSize).map(c => c.id)
        await supabase.from('comments').delete().in('id', batch)
      }
      console.log(`  Deleted ${toDelete.length} comments`)
    }

    // Update comment_count on affected posts
    const { data: allPosts } = await supabase
      .from('posts')
      .select('id')
      .limit(2000)

    for (const post of (allPosts || [])) {
      const { count } = await supabase
        .from('comments')
        .select('*', { count: 'exact', head: true })
        .eq('post_id', post.id)
      await supabase
        .from('posts')
        .update({ comment_count: count || 0 })
        .eq('id', post.id)
    }
    console.log('  Updated comment_count on all posts\n')
  }

  // ─── Generate new quality posts ───
  const newPosts: Array<{ title: string; content: string; author_handle: string; author_id: string }> = []
  const templatesToUse = pickN(POST_TEMPLATES, 8) // 8 new posts

  for (const tpl of templatesToUse) {
    const author = pickRandom(SEED_HANDLES)
    const authorId = userMap.get(author)
    if (!authorId) continue

    // Generate title from first sentence
    const firstLine = tpl.content.split('\n')[0].slice(0, 60)
    const title = firstLine.length > 50 ? firstLine.slice(0, 50) + '...' : firstLine

    newPosts.push({
      title,
      content: tpl.content,
      author_handle: author,
      author_id: authorId,
    })
  }

  console.log(`=== New Posts (${newPosts.length}) ===`)
  for (const p of newPosts) {
    console.log(`  @${p.author_handle}: ${p.title}`)
  }

  // ─── Generate quality comments for existing posts ───
  const { data: existingPosts } = await supabase
    .from('posts')
    .select('id, content, title, comment_count, author_handle')
    .order('created_at', { ascending: false })
    .limit(50)

  type NewComment = { post_id: string; content: string; user_id: string; author_handle: string }
  const newComments: NewComment[] = []

  for (const post of (existingPosts || [])) {
    const postContent = (post.title || '') + ' ' + (post.content || '')
    const topic = detectTopic(postContent)
    const pool = [...COMMENT_POOLS[topic], ...COMMENT_POOLS.general]

    // Add 2-4 quality comments per post (skip if already has many)
    const numComments = (post.comment_count || 0) > 5 ? 1 : Math.floor(Math.random() * 3) + 2
    const selectedComments = pickN(pool, numComments)

    for (const commentText of selectedComments) {
      // Pick a commenter different from post author
      const commenter = pickRandom(SEED_HANDLES.filter(h => h !== post.author_handle))
      const commenterId = userMap.get(commenter)
      if (!commenterId) continue

      newComments.push({
        post_id: post.id,
        content: commentText,
        user_id: commenterId,
        author_handle: commenter,
      })
    }
  }

  console.log(`\n=== New Comments (${newComments.length}) ===`)
  const sampleComments = newComments.slice(0, 10)
  for (const c of sampleComments) {
    console.log(`  @${c.author_handle}: ${c.content.slice(0, 80)}...`)
  }
  if (newComments.length > 10) console.log(`  ... and ${newComments.length - 10} more`)

  // ─── Execute ───
  if (mode === '--execute' || mode === '--cleanup') {
    console.log('\n--- Writing to database ---')

    // Insert posts
    const now = Date.now()
    let postCount = 0
    for (let i = 0; i < newPosts.length; i++) {
      const p = newPosts[i]
      const createdAt = new Date(now - i * 3600000 * (2 + Math.random())).toISOString()
      const { error } = await supabase.from('posts').insert({
        title: p.title,
        content: p.content,
        author_id: p.author_id,
        author_handle: p.author_handle,
        created_at: createdAt,
        poll_enabled: false,
        hot_score: 20 + Math.floor(Math.random() * 30),
      })
      if (!error) postCount++
      else console.log(`  Post error: ${error.message}`)
    }
    console.log(`  Inserted ${postCount} posts`)

    // Insert comments (batched)
    let commentCount = 0
    for (let i = 0; i < newComments.length; i += 50) {
      const batch = newComments.slice(i, i + 50).map((c, j) => ({
        post_id: c.post_id,
        content: c.content,
        user_id: c.user_id,
        created_at: new Date(now - (i + j) * 120000 - Math.random() * 300000).toISOString(),
      }))
      const { error } = await supabase.from('comments').insert(batch)
      if (!error) commentCount += batch.length
      else console.log(`  Comment batch error: ${error.message}`)
    }
    console.log(`  Inserted ${commentCount} comments`)

    // Update comment_count on affected posts
    const affectedPostIds = [...new Set(newComments.map(c => c.post_id))]
    for (const pid of affectedPostIds) {
      const { count } = await supabase
        .from('comments')
        .select('*', { count: 'exact', head: true })
        .eq('post_id', pid)
      await supabase.from('posts').update({ comment_count: count || 0 }).eq('id', pid)
    }
    console.log(`  Updated comment_count on ${affectedPostIds.length} posts`)

    console.log('\nDone!')
  } else {
    console.log('\n--- Dry run. Use --execute or --cleanup to write. ---')
  }
}

main().catch(console.error)
