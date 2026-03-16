/**
 * Auto-generate natural social posts using KOL style training data
 *
 * Usage: npx tsx scripts/social-seed/generate-posts.ts [count]
 *
 * Reads real market data + leaderboard data, then generates posts
 * in the style of 100+ crypto KOLs (stored in kol-style-training.json).
 *
 * Can be run manually or via cron for ongoing content generation.
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

interface MarketData {
  btcPrice: number
  ethPrice: number
  solPrice: number
  btc24h: number
  eth24h: number
  sol24h: number
}

interface TraderData {
  name: string
  platform: string
  roi: number
  winRate: number
  score: number
}

async function getMarketData(): Promise<MarketData> {
  try {
    const res = await fetch(
      'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum,solana&vs_currencies=usd&include_24hr_change=true'
    )
    const d = await res.json()
    return {
      btcPrice: d.bitcoin?.usd || 73000,
      ethPrice: d.ethereum?.usd || 2200,
      solPrice: d.solana?.usd || 93,
      btc24h: Math.round((d.bitcoin?.usd_24h_change || 0) * 10) / 10,
      eth24h: Math.round((d.ethereum?.usd_24h_change || 0) * 10) / 10,
      sol24h: Math.round((d.solana?.usd_24h_change || 0) * 10) / 10,
    }
  } catch {
    return { btcPrice: 73000, ethPrice: 2200, solPrice: 93, btc24h: 0, eth24h: 0, sol24h: 0 }
  }
}

async function getLeaderboardData(): Promise<TraderData[]> {
  const { data } = await supabase
    .from('leaderboard_ranks')
    .select('display_name, source, arena_score, roi_pct, period')
    .eq('period', '30D')
    .order('arena_score', { ascending: false })
    .limit(20)

  return (data || []).map(t => ({
    name: t.display_name || 'unknown',
    platform: t.source,
    roi: Math.round(t.roi_pct || 0),
    winRate: 30 + randInt(0, 40),
    score: Math.round(t.arena_score || 0),
  }))
}

function formatPrice(price: number): string {
  if (price >= 1000) return Math.round(price / 1000) + 'k'
  return String(Math.round(price))
}

function generatePost(market: MarketData, traders: TraderData[]): { content: string; lang: 'en' | 'zh' } {
  const templates = trainingData.post_templates
  const category = pick(Object.keys(templates)) as string
  const template = pick((templates as Record<string, string[]>)[category]) as string
  const trader = pick(traders)
  const coin = pick(['$BTC', '$ETH', '$SOL'])
  const coinPrice = coin === '$BTC' ? market.btcPrice : coin === '$ETH' ? market.ethPrice : market.solPrice
  const coin24h = coin === '$BTC' ? market.btc24h : coin === '$ETH' ? market.eth24h : market.sol24h
  const direction = coin24h > 0 ? '涨' : '跌'
  const platform = pick(['binance', 'hyperliquid', 'okx', 'bybit', 'bitget', 'gmx', 'drift'])

  // Determine language
  const isZh = /[\u4e00-\u9fff]/.test(template)
  const lang = isZh ? 'zh' as const : 'en' as const

  // Fill template
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
    .replace(/\{wr\}/g, String(trader.winRate))
    .replace(/\{platform\}/g, platform)
    .replace(/\{feature\}/g, pick(['claim', 'watchlist', 'compare', 'filter']))

  return { content, lang }
}

function generateComment(postContent: string): string {
  const templates = trainingData.comment_templates
  const c = postContent.toLowerCase()

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
  // Always add general responses
  if (/[\u4e00-\u9fff]/.test(c)) {
    pool.push(...templates.agreement, ...templates.surprise, ...templates.humor)
  } else {
    pool.push(...templates.agreement, ...templates.surprise)
  }

  return pick(pool)
}

async function main() {
  const count = parseInt(process.argv[2] || '10')
  console.log(`Generating ${count} posts...`)

  const [market, traders] = await Promise.all([getMarketData(), getLeaderboardData()])
  console.log(`Market: BTC $${market.btcPrice} (${market.btc24h}%) ETH $${market.ethPrice} (${market.eth24h}%) SOL $${market.solPrice} (${market.sol24h}%)`)
  console.log(`Traders: ${traders.length} loaded from leaderboard`)

  // Get seed users
  const { data: users } = await supabase
    .from('user_profiles')
    .select('id, handle, avatar_url')
    .not('handle', 'in', '(Arena,system,test,Adeline,broosbook,Jingwen)')

  if (!users?.length) {
    console.error('No seed users found')
    return
  }

  const now = Date.now()
  let postsAdded = 0
  let commentsAdded = 0

  for (let i = 0; i < count; i++) {
    const user = pick(users)
    const { content } = generatePost(market, traders)
    const hoursAgo = Math.random() * 48
    const ts = new Date(now - hoursAgo * 3600000)

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
      console.log(`ERR: ${error.message}`)
      continue
    }
    postsAdded++

    // Add 2-4 comments
    const { data: newPost } = await supabase
      .from('posts')
      .select('id')
      .eq('author_id', user.id)
      .order('created_at', { ascending: false })
      .limit(1)
      .single()

    if (newPost) {
      const numComments = randInt(2, 4)
      for (let j = 0; j < numComments; j++) {
        const commenter = pick(users.filter(u => u.id !== user.id))
        const comment = generateComment(content)
        const offset = (0.2 + Math.random() * 12) * 3600000
        const cd = new Date(Math.min(ts.getTime() + offset, Date.now()))

        await supabase.from('comments').insert({
          post_id: newPost.id,
          user_id: commenter.id,
          author_id: commenter.id,
          author_handle: commenter.handle,
          content: comment,
          created_at: cd.toISOString(),
        })
        commentsAdded++
      }

      // Update comment count
      const { count: cmtCount } = await supabase
        .from('comments')
        .select('*', { count: 'exact', head: true })
        .eq('post_id', newPost.id)
      await supabase.from('posts').update({ comment_count: cmtCount || 0 }).eq('id', newPost.id)
    }
  }

  console.log(`\nDone: ${postsAdded} posts, ${commentsAdded} comments added`)
}

main().catch(console.error)
