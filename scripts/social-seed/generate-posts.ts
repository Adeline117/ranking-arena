/**
 * Auto-generate natural social posts using KOL style training data
 *
 * Usage: npx tsx scripts/social-seed/generate-posts.ts [count]
 *
 * Reads real market data + leaderboard data, then generates posts
 * in the style of 100+ crypto KOLs (stored in kol-style-training.json).
 *
 * Time distribution:
 *   - Posts spread across past 7 days, 3-5 per day
 *   - Chinese posts: UTC 10:00-16:00 (Beijing evening 18:00-00:00)
 *   - English posts: UTC 14:00-06:00 (US hours)
 *   - Weekend posts slightly fewer
 *   - Market volatility (24h change > 5%) -> more posts that day
 *
 * Comments:
 *   - 30%+ reference post content specifically
 *   - Some disagree, some ask follow-up questions
 *   - Commenters always differ from post author
 */

import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'fs'
import { join } from 'path'

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
const supabase = createClient(supabaseUrl, supabaseKey)

// Load training data
const trainingData = JSON.parse(
  readFileSync(join(__dirname, 'kol-style-training.json'), 'utf-8')
)

const pick = <T>(arr: T[]): T => arr[Math.floor(Math.random() * arr.length)]
const randInt = (min: number, max: number) => min + Math.floor(Math.random() * (max - min + 1))
const weightedPick = <T>(arr: T[], weights: number[]): T => {
  const total = weights.reduce((a, b) => a + b, 0)
  let r = Math.random() * total
  for (let i = 0; i < arr.length; i++) {
    r -= weights[i]
    if (r <= 0) return arr[i]
  }
  return arr[arr.length - 1]
}

interface MarketData {
  btcPrice: number
  ethPrice: number
  solPrice: number
  btc24h: number
  eth24h: number
  sol24h: number
  isVolatile: boolean
}

interface TraderData {
  name: string
  platform: string
  roi: number
  winRate: number
  score: number
}

interface AggregateStats {
  totalTraders: number
  profitPct: number
  topPct: number
  avgWinRate: number
  platformCount: number
  lowestWRWithHighScore: number
}

async function getAggregateStats(): Promise<AggregateStats> {
  const [
    { count: total },
    { count: profitable },
    { count: score80 },
  ] = await Promise.all([
    supabase.from('leaderboard_ranks').select('*', { count: 'exact', head: true }),
    supabase.from('leaderboard_ranks').select('*', { count: 'exact', head: true }).gt('pnl', 0),
    supabase.from('leaderboard_ranks').select('*', { count: 'exact', head: true }).gte('arena_score', 80),
  ])
  const totalTraders = total || 39000
  const profitPct = Math.round(((profitable || 0) / totalTraders) * 100)
  const topPct = Math.round(((score80 || 0) / totalTraders) * 100)

  // Get lowest win rate with high score
  const { data: lowWR } = await supabase
    .from('leaderboard_ranks')
    .select('win_rate')
    .gte('arena_score', 90)
    .order('win_rate', { ascending: true })
    .limit(1)
    .maybeSingle()

  // Count distinct platforms
  const { data: platforms } = await supabase
    .from('leaderboard_ranks')
    .select('source')
  const uniquePlatforms = new Set((platforms || []).map(p => p.source))

  return {
    totalTraders,
    profitPct,
    topPct,
    avgWinRate: randInt(38, 52),
    platformCount: uniquePlatforms.size || 27,
    lowestWRWithHighScore: Math.round(Number(lowWR?.win_rate || 18)),
  }
}

async function getMarketData(): Promise<MarketData> {
  try {
    const res = await fetch(
      'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum,solana&vs_currencies=usd&include_24hr_change=true'
    )
    const d = await res.json()
    const btc24h = Math.round((d.bitcoin?.usd_24h_change || 0) * 10) / 10
    const eth24h = Math.round((d.ethereum?.usd_24h_change || 0) * 10) / 10
    const sol24h = Math.round((d.solana?.usd_24h_change || 0) * 10) / 10
    const isVolatile = Math.abs(btc24h) > 5 || Math.abs(eth24h) > 5 || Math.abs(sol24h) > 5
    return {
      btcPrice: d.bitcoin?.usd || 73000,
      ethPrice: d.ethereum?.usd || 2200,
      solPrice: d.solana?.usd || 93,
      btc24h, eth24h, sol24h,
      isVolatile,
    }
  } catch {
    return { btcPrice: 73000, ethPrice: 2200, solPrice: 93, btc24h: 0, eth24h: 0, sol24h: 0, isVolatile: false }
  }
}

async function getLeaderboardData(): Promise<TraderData[]> {
  const { data } = await supabase
    .from('leaderboard_ranks')
    .select('handle, source, arena_score, roi, win_rate')
    .eq('season_id', 'current')
    .order('arena_score', { ascending: false })
    .limit(30)

  if (!data?.length) {
    // fallback: try without season filter
    const { data: d2 } = await supabase
      .from('leaderboard_ranks')
      .select('handle, source, arena_score, roi, win_rate')
      .order('arena_score', { ascending: false })
      .limit(30)
    return (d2 || []).map(mapTrader)
  }
  return data.map(mapTrader)
}

function mapTrader(t: Record<string, unknown>): TraderData {
  const roi = Number(t.roi ?? 0)
  return {
    name: String(t.handle || 'unknown'),
    platform: String(t.source || 'unknown'),
    roi: Math.round(roi > 10 ? roi : roi * 100), // handle both ratio and pct
    winRate: Math.round(Number(t.win_rate ?? 0)),
    score: Math.round(Number(t.arena_score ?? 0)),
  }
}

function formatPrice(price: number): string {
  if (price >= 1000) return Math.round(price / 1000) + 'k'
  return String(Math.round(price))
}

// --- Time distribution ---

interface DaySlot {
  date: Date // day start (UTC 0:00)
  dayOfWeek: number // 0=Sun..6=Sat
  isWeekend: boolean
  postCount: number
}

function buildDaySlots(totalPosts: number, isVolatile: boolean): DaySlot[] {
  const now = new Date()
  const slots: DaySlot[] = []
  for (let d = 0; d < 7; d++) {
    const date = new Date(now)
    date.setUTCDate(date.getUTCDate() - d)
    date.setUTCHours(0, 0, 0, 0)
    const dayOfWeek = date.getUTCDay()
    const isWeekend = dayOfWeek === 0 || dayOfWeek === 6
    slots.push({ date, dayOfWeek, isWeekend, postCount: 0 })
  }

  // Distribute posts: weekday=base, weekend=0.6*base, volatile day gets 1.5x
  const baseWeight = 1
  const weights = slots.map(s => {
    let w = s.isWeekend ? baseWeight * 0.6 : baseWeight
    // today (d=0) gets volatility bonus
    if (s.date.toDateString() === now.toDateString() && isVolatile) w *= 1.5
    return w
  })
  const totalWeight = weights.reduce((a, b) => a + b, 0)

  let remaining = totalPosts
  for (let i = 0; i < slots.length; i++) {
    const share = Math.round((weights[i] / totalWeight) * totalPosts)
    slots[i].postCount = Math.min(share, remaining)
    remaining -= slots[i].postCount
  }
  // distribute remainder
  while (remaining > 0) {
    const idx = randInt(0, slots.length - 1)
    slots[idx].postCount++
    remaining--
  }

  return slots
}

function randomTimeForDay(day: Date, lang: 'zh' | 'en'): Date {
  // Chinese posts: UTC 10:00-16:00 (Beijing 18:00-00:00)
  // English posts: UTC 14:00-06:00 (US daytime/evening)
  const ts = new Date(day)
  if (lang === 'zh') {
    const hour = 10 + Math.random() * 6 // 10-16 UTC
    ts.setUTCHours(Math.floor(hour), randInt(0, 59), randInt(0, 59))
  } else {
    // US hours: 14:00-23:59 or 00:00-06:00
    const roll = Math.random()
    if (roll < 0.7) {
      // 14-24 UTC (US morning-evening)
      const hour = 14 + Math.random() * 10
      ts.setUTCHours(Math.floor(hour), randInt(0, 59), randInt(0, 59))
    } else {
      // 0-6 UTC (US late night)
      const hour = Math.random() * 6
      ts.setUTCHours(Math.floor(hour), randInt(0, 59), randInt(0, 59))
    }
  }
  // Don't generate future timestamps
  if (ts.getTime() > Date.now()) {
    ts.setTime(Date.now() - randInt(60, 3600) * 1000)
  }
  return ts
}

// --- Post generation ---

function generatePost(market: MarketData, traders: TraderData[], stats: AggregateStats): { content: string; lang: 'en' | 'zh' } {
  const templates = trainingData.post_templates
  const category = pick(Object.keys(templates)) as string
  const template = pick((templates as Record<string, string[]>)[category]) as string
  const trader = traders.length ? pick(traders) : { name: 'unknown', platform: 'binance', roi: 42, winRate: 55, score: 70 }
  // Pick a second trader for versus posts
  const trader2 = traders.length > 1 ? pick(traders.filter(t => t.platform !== trader.platform)) : trader
  const coin = pick(['$BTC', '$ETH', '$SOL'])
  const coinPrice = coin === '$BTC' ? market.btcPrice : coin === '$ETH' ? market.ethPrice : market.solPrice
  const coin24h = coin === '$BTC' ? market.btc24h : coin === '$ETH' ? market.eth24h : market.sol24h
  const direction = coin24h > 0 ? '涨' : '跌'
  const platform = trader.platform !== 'unknown' ? trader.platform : pick(['binance', 'hyperliquid', 'okx', 'bybit', 'bitget', 'gmx', 'drift'])

  // Determine language
  const isZh = /[\u4e00-\u9fff]/.test(template)
  const lang = isZh ? 'zh' as const : 'en' as const

  // Fill template with real data
  const pnlStr = trader.roi > 100 ? String(Math.round(trader.roi * 100)) : String(randInt(500, 50000))
  const scoreComment = pick(['not bad', 'pain', 'improving', '还行', '太菜了', '有进步'])
  let content = template
    .replace(/\{price\}/g, formatPrice(coinPrice))
    .replace(/\{coin\}/g, coin)
    .replace(/\{direction\}/g, direction)
    .replace(/\{comment\}/g, pick(['等方向', 'patient', '不动了', 'looking good']))
    .replace(/\{target\}/g, formatPrice(coinPrice * 1.05))
    .replace(/\{amount\}/g, String(randInt(100, 800)))
    .replace(/\{entry\}/g, String(Math.round(coinPrice * (1 - Math.random() * 0.03))))
    .replace(/\{exit\}/g, String(Math.round(coinPrice * (1 + Math.random() * 0.03))))
    .replace(/\{period\}/g, pick(['7', '30', '90']))
    .replace(/\{roi\}/g, String(trader.roi))
    .replace(/\{wr\}/g, String(trader.winRate || randInt(30, 70)))
    .replace(/\{traderName\}/g, trader.name)
    .replace(/\{pnl\}/g, pnlStr)
    .replace(/\{score\}/g, String(trader.score))
    .replace(/\{totalTraders\}/g, String(stats.totalTraders))
    .replace(/\{profitPct\}/g, String(stats.profitPct))
    .replace(/\{lossPct\}/g, String(100 - stats.profitPct))
    .replace(/\{topPct\}/g, String(stats.topPct))
    .replace(/\{avgWR\}/g, String(stats.avgWinRate))
    .replace(/\{platformCount\}/g, String(stats.platformCount))
    .replace(/\{lowWR\}/g, String(stats.lowestWRWithHighScore))
    .replace(/\{platform1\}/g, trader.platform)
    .replace(/\{platform2\}/g, trader2.platform)
    .replace(/\{roi1\}/g, String(trader.roi))
    .replace(/\{roi2\}/g, String(trader2.roi))
    .replace(/\{rank\}/g, String(randInt(3, 25)))
    .replace(/\{score1\}/g, String(randInt(25, 50)))
    .replace(/\{score2\}/g, String(randInt(30, 55)))
    .replace(/\{scoreComment\}/g, scoreComment)
    .replace(/\{platform\}/g, platform)
    .replace(/\{feature\}/g, pick(['claim', 'watchlist', 'compare', 'filter']))

  return { content, lang }
}

// --- Comment generation ---

type CommentType = 'generic' | 'content_ref' | 'disagree' | 'question'

function generateComment(postContent: string, postLang: 'en' | 'zh', traders: TraderData[]): string {
  // Decide comment type with weighted distribution
  // 30%+ content-referencing, 15% disagree, 15% question, 40% generic
  const types: CommentType[] = ['generic', 'content_ref', 'disagree', 'question']
  const weights = [40, 30, 15, 15]
  const ctype = weightedPick(types, weights)

  const c = postContent.toLowerCase()
  const isZh = /[\u4e00-\u9fff]/.test(postContent)

  switch (ctype) {
    case 'content_ref':
      return generateContentRefComment(postContent, isZh, traders)
    case 'disagree':
      return generateDisagreeComment(postContent, isZh)
    case 'question':
      return generateQuestionComment(postContent, isZh)
    default:
      return generateGenericComment(postContent, isZh)
  }
}

function generateContentRefComment(post: string, isZh: boolean, traders: TraderData[]): string {
  const c = post.toLowerCase()

  // Extract specific references from the post
  const coinMatch = c.match(/\$?(btc|eth|sol)/i)
  const roiMatch = post.match(/(\d+)%?\s*(roi|收益)/i) || post.match(/(roi|收益)\s*(\d+)/i)
  const platformMatch = c.match(/(binance|bybit|okx|bitget|hyperliquid|gmx|drift|mexc)/i)
  const priceMatch = post.match(/(\d+k)/i)

  if (coinMatch) {
    const coin = coinMatch[1].toUpperCase()
    if (isZh) {
      return pick([
        `${coin}这波行情确实猛`,
        `${coin}还能追吗`,
        `${coin}我也在看 等回调`,
        `${coin}我重仓了`,
        `${coin}最近波动太大了`,
      ])
    }
    return pick([
      `${coin} looking good ngl`,
      `been watching ${coin} too`,
      `${coin} has more room imo`,
      `${coin} overextended here`,
      `my ${coin} bag appreciates this`,
    ])
  }

  if (platformMatch) {
    const plat = platformMatch[1].toLowerCase()
    if (isZh) {
      return pick([
        `${plat}上确实有猛人`,
        `${plat}排行榜看过了 真离谱`,
        `${plat}的数据更新挺快`,
      ])
    }
    return pick([
      `${plat} leaderboard is wild rn`,
      `been tracking ${plat} too`,
      `${plat} has some insane traders`,
    ])
  }

  if (roiMatch) {
    if (isZh) {
      return pick([
        '这个roi真的假的',
        '收益太猛了',
        '怎么做到的 求带',
      ])
    }
    return pick([
      'that roi is insane',
      'how tho',
      'need that kind of returns',
    ])
  }

  if (priceMatch) {
    if (isZh) {
      return pick([
        `${priceMatch[1]}这个位置很关键`,
        `到${priceMatch[1]}了?`,
        `${priceMatch[1]}附近压力很大`,
      ])
    }
    return pick([
      `${priceMatch[1]} is the level to watch`,
      `we touching ${priceMatch[1]}?`,
      `${priceMatch[1]} resistance gonna be tough`,
    ])
  }

  // Fallback: reference the general vibe
  if (isZh) {
    return pick(['说的有道理', '确实是这样', '我也这么觉得', '说到点子上了'])
  }
  return pick(['this is the take', 'nailed it', 'exactly what i was thinking', 'solid point'])
}

function generateDisagreeComment(post: string, isZh: boolean): string {
  if (isZh) {
    return pick([
      '不一定吧',
      '我觉得反了',
      '别太乐观了',
      'risky imo',
      '这个逻辑有问题',
      '再看看吧 别急',
      '不太同意',
      '小心被套',
      '上次也这么说 结果呢',
    ])
  }
  return pick([
    'idk about that',
    'risky imo',
    'disagree but ok',
    'careful with that',
    'not so sure about this one',
    'could go either way tbh',
    'last time people said this...',
    'hope you have a stop loss',
    'gonna age badly imo',
  ])
}

function generateQuestionComment(post: string, isZh: boolean): string {
  const c = post.toLowerCase()
  const coinMatch = c.match(/\$?(btc|eth|sol)/i)
  const platformMatch = c.match(/(binance|bybit|okx|bitget|hyperliquid|gmx|drift|mexc)/i)

  if (isZh) {
    const qs = [
      '哪个交易所的',
      '什么时候进的',
      '仓位多大',
      '止损在哪',
      '能说说逻辑吗',
      '链接有吗',
    ]
    if (platformMatch) qs.push(`${platformMatch[1]}怎么看排行榜`)
    if (coinMatch) qs.push(`${coinMatch[1].toUpperCase()}目标价多少`)
    return pick(qs)
  }

  const qs = [
    'which trader?',
    'link?',
    'what exchange?',
    'entry price?',
    'whats your target',
    'how long you holding',
    'what timeframe',
  ]
  if (platformMatch) qs.push(`how do you find traders on ${platformMatch[1]}?`)
  if (coinMatch) qs.push(`what's your ${coinMatch[1].toUpperCase()} target?`)
  return pick(qs)
}

function generateGenericComment(post: string, isZh: boolean): string {
  const templates = trainingData.comment_templates
  const c = post.toLowerCase()

  let pool: string[] = []
  if (c.includes('btc') || c.includes('eth') || c.includes('sol') || /\d+k/.test(c)) {
    pool.push(...templates.price_comment)
  }
  if (c.includes('short') || c.includes('空') || c.includes('loss') || c.includes('爆')) {
    pool.push(...templates.empathy)
  }
  if (c.includes('?') || c.includes('吗') || c.includes('how')) {
    pool.push(...templates.question_response)
  }
  // Always add general
  if (isZh) {
    pool.push(...templates.agreement, ...templates.surprise, ...templates.humor)
  } else {
    pool.push(...templates.agreement, ...templates.surprise)
  }

  return pick(pool)
}

// --- Main ---

async function main() {
  const count = parseInt(process.argv[2] || '10')
  console.log(`Generating ${count} posts...`)

  const [market, traders, stats] = await Promise.all([getMarketData(), getLeaderboardData(), getAggregateStats()])
  console.log(`Market: BTC $${market.btcPrice} (${market.btc24h}%) ETH $${market.ethPrice} (${market.eth24h}%) SOL $${market.solPrice} (${market.sol24h}%)`)
  console.log(`Volatile: ${market.isVolatile}`)
  console.log(`Traders: ${traders.length} loaded | Total: ${stats.totalTraders} | Profitable: ${stats.profitPct}% | Score 80+: ${stats.topPct}%`)
  if (traders.length > 0) {
    console.log(`  Top 3: ${traders.slice(0, 3).map(t => `${t.name} (${t.platform}, ${t.roi}% ROI, score ${t.score})`).join(', ')}`)
  }

  // Get seed users
  const { data: users } = await supabase
    .from('user_profiles')
    .select('id, handle, avatar_url')
    .not('handle', 'in', '(Arena,system,test,Adeline,broosbook,Jingwen)')

  if (!users?.length) {
    console.error('No seed users found')
    return
  }
  console.log(`Seed users: ${users.length}`)

  // Build time slots across 7 days
  const daySlots = buildDaySlots(count, market.isVolatile)
  console.log(`\nDay distribution:`)
  daySlots.forEach(s => {
    const dayName = s.date.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' })
    console.log(`  ${dayName}${s.isWeekend ? ' (weekend)' : ''}: ${s.postCount} posts`)
  })

  let postsAdded = 0
  let commentsAdded = 0

  for (const slot of daySlots) {
    for (let p = 0; p < slot.postCount; p++) {
      const { content, lang } = generatePost(market, traders, stats)
      const user = pick(users)
      const ts = randomTimeForDay(slot.date, lang)

      const { error } = await supabase.from('posts').insert({
        author_id: user.id,
        author_handle: user.handle,
        author_avatar_url: user.avatar_url,
        title: '',
        content,
        status: 'active',
        hot_score: randInt(15, 55),
        like_count: randInt(1, 20),
        created_at: ts.toISOString(),
      })

      if (error) {
        console.log(`ERR post: ${error.message}`)
        continue
      }
      postsAdded++

      // Get the post id
      const { data: newPost } = await supabase
        .from('posts')
        .select('id')
        .eq('author_id', user.id)
        .order('created_at', { ascending: false })
        .limit(1)
        .single()

      if (!newPost) continue

      // Add 2-4 comments (from different users)
      const numComments = randInt(2, 4)
      const otherUsers = users.filter(u => u.id !== user.id)
      if (otherUsers.length === 0) continue

      // Track which users already commented on this post
      const usedCommenters = new Set<string>()

      for (let j = 0; j < numComments; j++) {
        // Pick a commenter not yet used on this post
        const available = otherUsers.filter(u => !usedCommenters.has(u.id))
        if (available.length === 0) break
        const commenter = pick(available)
        usedCommenters.add(commenter.id)

        const comment = generateComment(content, lang, traders)
        const offsetMs = (0.2 + Math.random() * 12) * 3600000
        const cd = new Date(Math.min(ts.getTime() + offsetMs, Date.now()))

        const { error: cErr } = await supabase.from('comments').insert({
          post_id: newPost.id,
          user_id: commenter.id,
          author_id: commenter.id,
          author_handle: commenter.handle,
          content: comment,
          created_at: cd.toISOString(),
        })

        if (!cErr) commentsAdded++
      }

      // Update comment count
      const { count: cmtCount } = await supabase
        .from('comments')
        .select('*', { count: 'exact', head: true })
        .eq('post_id', newPost.id)
      await supabase.from('posts').update({ comment_count: cmtCount || 0 }).eq('id', newPost.id)

      const timeStr = ts.toISOString().replace('T', ' ').slice(0, 16)
      console.log(`  [${timeStr}] @${user.handle} (${lang}): ${content.slice(0, 60)}...`)
    }
  }

  console.log(`\nDone: ${postsAdded} posts, ${commentsAdded} comments added`)
}

main().catch(console.error)
