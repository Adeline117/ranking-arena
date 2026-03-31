/**
 * One-time seed script (manual use only, NOT cron-scheduled).
 *
 * NOT in vercel.json crons — run once manually to bootstrap the social feed.
 *   curl -X POST https://www.arenafi.org/api/cron/seed-social-posts \
 *     -H "Authorization: Bearer $CRON_SECRET"
 *
 * Idempotent: checks for existing seed posts before inserting.
 */

import { NextRequest, NextResponse } from 'next/server'
import { env } from '@/lib/env'
import { getSupabaseAdmin } from '@/lib/supabase/server'

export const dynamic = 'force-dynamic'
export const maxDuration = 30

const SYSTEM_USER_ID = '00000000-0000-0000-0000-000000000001'
const SYSTEM_HANDLE = 'arena_bot'

const SEED_POSTS = [
  {
    title: 'Welcome to Arena Social! 🎉',
    content: `**Arena Social is back and better than ever!**

We've revamped the community feed with new features:

• **Daily Market Pulse** — Automated daily summaries with BTC/ETH prices and top performer highlights
• **Hot Score v4** — Smarter ranking algorithm that surfaces quality content
• **Bull/Bear Polls** — Share your market outlook on every post
• **Bilingual Support** — Full English and Chinese support

Start a conversation — share your trading insights, ask questions, or discuss market trends. The best posts rise to the top!

---

**欢迎回到 Arena 社区！**

我们带来了全新的社区功能：

• **每日市场脉搏** — 自动生成的每日摘要，包含 BTC/ETH 价格和顶级交易员亮点
• **热度算法 v4** — 更智能的排序算法，优质内容优先展示
• **多空投票** — 在每条帖子上分享你的市场看法
• **双语支持** — 完整的中英文支持

开始讨论吧 — 分享你的交易见解、提出问题或讨论市场趋势！`,
    hot_score: 80,
  },
  {
    title: 'How to Use Arena Rankings Effectively',
    content: `**Quick Guide: Getting the Most from Arena Rankings / 快速指南：如何高效使用 Arena 排行榜**

🏆 **Arena Score** combines ROI (60%) and absolute PnL (40%) with confidence adjustments. Higher score = better risk-adjusted performance.

📊 **Period Filters**: Switch between 7D, 30D, and 90D to see short-term alpha vs long-term consistency.

🔍 **Pro Tips / 使用技巧**:
1. Compare traders across exchanges — the composite ranking normalizes performance across 27+ platforms
2. Check the 90D rankings for consistent performers, not just lucky streaks
3. Use the trader detail page to see equity curves and drawdown metrics
4. Follow traders to get notifications when their ranking changes

📈 **Overall Composite Score** weights: 90D (70%) + 30D (25%) + 7D (5%) — designed to reward sustained performance.

---

💡 综合评分权重：90天 (70%) + 30天 (25%) + 7天 (5%) — 旨在奖励持续稳定的表现而非短期运气。`,
    hot_score: 60,
  },
  {
    title: '34,000+ Traders Across 28 Exchanges — The Data Behind Arena',
    content: `**Ever wonder how Arena tracks so many traders? Here's a peek behind the curtain.**

We aggregate data from **28+ exchanges** including Binance, Bybit, OKX, Bitget, Hyperliquid, GMX, dYdX, and more.

📊 **By the numbers / 数据概览**:
• 34,000+ unique traders tracked
• 42 automated cron jobs refreshing data every 3-6 hours
• CEX + DEX coverage — centralized and decentralized exchanges
• Bot detection — automated traders are flagged with a ⚡ badge

🔄 **Data Pipeline**:
Every trader's ROI, PnL, win rate, and trade count are fetched, normalized, and scored using our Arena Score formula. The leaderboard updates every 30 minutes.

🌐 **New Exchanges**: We recently added eToro (3.4M+ traders), Drift, and Bitfinex. More coming soon!

What exchange would you like us to add next? Drop a comment below! 👇

---

你希望我们接入哪个新交易所？在下方评论告诉我们！`,
    hot_score: 55,
  },
]

export async function POST(request: NextRequest) {
  const authHeader = request.headers.get('authorization')
  const cronSecret = env.CRON_SECRET
  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  try {
    const supabase = getSupabaseAdmin()

    // Ensure system user exists
    await supabase
      .from('user_profiles')
      .upsert({
        id: SYSTEM_USER_ID,
        handle: SYSTEM_HANDLE,
        display_name: 'Arena Bot',
        avatar_url: null,
        bio: 'Automated market analysis by Arena',
      }, { onConflict: 'id' })

    // Check if seed posts already exist
    const { data: existing } = await supabase
      .from('posts')
      .select('title')
      .eq('author_id', SYSTEM_USER_ID)
      .in('title', SEED_POSTS.map(p => p.title))

    const existingTitles = new Set((existing || []).map(p => p.title))
    const toInsert = SEED_POSTS.filter(p => !existingTitles.has(p.title))

    if (toInsert.length === 0) {
      return NextResponse.json({ ok: true, inserted: 0, message: 'Seed posts already exist' })
    }

    // Insert with staggered timestamps so they don't all show the same time
    const now = Date.now()
    const results = []

    for (let i = 0; i < toInsert.length; i++) {
      const post = toInsert[i]
      // Stagger by 2 hours each so they appear at different times
      const createdAt = new Date(now - i * 2 * 60 * 60 * 1000).toISOString()

      const { data, error } = await supabase
        .from('posts')
        .insert({
          title: post.title,
          content: post.content,
          author_id: SYSTEM_USER_ID,
          author_handle: SYSTEM_HANDLE,
          poll_enabled: false,
          hot_score: post.hot_score,
          created_at: createdAt,
        })
        .select('id')
        .single()

      if (error) {
        results.push({ title: post.title, error: error.message })
      } else {
        results.push({ title: post.title, id: data.id })
      }
    }

    return NextResponse.json({ ok: true, inserted: results.filter(r => !('error' in r)).length, results })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}

export async function GET(request: NextRequest) {
  return POST(request)
}
