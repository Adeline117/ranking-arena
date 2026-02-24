/**
 * Seed Sample Posts for Testing Recommendations
 *
 * Creates sample community posts to test the recommendation algorithm.
 * Run: npx tsx scripts/import/seed-sample-posts.mjs
 */

import 'dotenv/config'
import { sb } from './lib/index.mjs'

// Sample posts with different engagement levels
const samplePosts = [
  {
    content: 'BTC breaking resistance at 98k! This could be the start of a major move. Been tracking this level for weeks. 🚀',
    author_handle: 'crypto_analyst',
    like_count: 156,
    comment_count: 45,
    view_count: 2340,
    repost_count: 23,
  },
  {
    content: 'My trading strategy for 2026: Focus on ETH and L2s. The fundamentals are stronger than ever. Full analysis in thread 👇',
    author_handle: 'defi_whale',
    like_count: 89,
    comment_count: 32,
    view_count: 1560,
    repost_count: 15,
  },
  {
    content: 'Just closed a 42% gain on SOL perps. Entry was at the support, exit at Fibonacci extension. Patience pays. 📈',
    author_handle: 'swing_master',
    like_count: 234,
    comment_count: 67,
    view_count: 4500,
    repost_count: 45,
  },
  {
    content: 'Risk management tip: Never risk more than 2% of your portfolio on a single trade. This rule saved me during the crash.',
    author_handle: 'risk_analyst',
    like_count: 312,
    comment_count: 89,
    view_count: 6200,
    repost_count: 78,
  },
  {
    content: 'Hyperliquid volume just hit ATH. The decentralized perps narrative is real. Who else is trading on HL? 🔥',
    author_handle: 'dex_trader',
    like_count: 178,
    comment_count: 56,
    view_count: 3400,
    repost_count: 34,
  },
  {
    content: 'Market update: Funding rates are back to neutral after the squeeze. Good opportunity for fresh positions.',
    author_handle: 'funding_watcher',
    like_count: 67,
    comment_count: 21,
    view_count: 890,
    repost_count: 8,
  },
  {
    content: 'New to copy trading? Here are my top 5 traders to follow on Binance based on risk-adjusted returns. Thread 🧵',
    author_handle: 'copy_guru',
    like_count: 445,
    comment_count: 123,
    view_count: 8900,
    repost_count: 112,
  },
  {
    content: 'Altseason signals are appearing: BTC dominance dropping, ETH/BTC breaking out. Time to rotate? 🤔',
    author_handle: 'macro_trader',
    like_count: 198,
    comment_count: 78,
    view_count: 4100,
    repost_count: 41,
  },
  {
    content: 'Just released my monthly performance report: 28% ROI, 71% win rate, max DD 8.2%. Consistency is key.',
    author_handle: 'consistent_trader',
    like_count: 267,
    comment_count: 54,
    view_count: 3800,
    repost_count: 29,
  },
  {
    content: 'GMX v2 is impressive. Lower fees, better execution. Just moved my perp trading there. Gas on Arbitrum is negligible.',
    author_handle: 'gmx_fan',
    like_count: 134,
    comment_count: 41,
    view_count: 2100,
    repost_count: 17,
  },
  {
    content: 'Technical analysis basics: Support and resistance are just zones of liquidity. Stop looking for exact levels.',
    author_handle: 'ta_mentor',
    like_count: 189,
    comment_count: 62,
    view_count: 3200,
    repost_count: 38,
  },
  {
    content: 'Why I prefer perps over spot: Leverage allows smaller capital, funding can be profitable, no storage issues.',
    author_handle: 'perp_trader',
    like_count: 145,
    comment_count: 87,
    view_count: 2900,
    repost_count: 24,
  },
  {
    content: 'Market makers are accumulating. On-chain data shows whale wallets increasing BTC holdings for 3 weeks straight.',
    author_handle: 'onchain_analyst',
    like_count: 278,
    comment_count: 91,
    view_count: 5600,
    repost_count: 67,
  },
  {
    content: 'Lesson learned: Overtrading killed my returns last month. Quality > quantity. Taking only A+ setups now.',
    author_handle: 'reformed_trader',
    like_count: 423,
    comment_count: 134,
    view_count: 7800,
    repost_count: 89,
  },
  {
    content: 'Copy trading tip: Look for traders with at least 90 days of history. Short track records mean nothing.',
    author_handle: 'arena_veteran',
    like_count: 312,
    comment_count: 76,
    view_count: 4900,
    repost_count: 54,
  },
]

async function seedPosts() {
  console.log('🌱 Seeding sample posts for recommendation testing...\n')

  // Check if we already have posts
  const { count } = await sb
    .from('posts')
    .select('*', { count: 'exact', head: true })

  console.log(`📊 Current posts in database: ${count || 0}`)

  if (count >= 10) {
    console.log('ℹ️  Sufficient posts already exist. Skipping seed.')
    console.log('   Run with --force to add more posts anyway.')

    if (!process.argv.includes('--force')) {
      return
    }
    console.log('   --force flag detected, proceeding...')
  }

  let successCount = 0
  const now = new Date()

  for (let i = 0; i < samplePosts.length; i++) {
    const post = samplePosts[i]

    // Stagger creation times for realistic hot_score calculation
    const createdAt = new Date(now.getTime() - (i * 2 * 60 * 60 * 1000)) // 2 hours apart

    // Calculate hot_score using the same formula as the database
    const ageHours = (now.getTime() - createdAt.getTime()) / (1000 * 60 * 60)
    const hotScore =
      post.like_count * 3 +
      post.comment_count * 5 +
      post.repost_count * 2 +
      post.view_count * 0.1 -
      Math.log(ageHours + 2) * 2

    const { error } = await sb
      .from('posts')
      .insert({
        content: post.content,
        author_handle: post.author_handle,
        like_count: post.like_count,
        comment_count: post.comment_count,
        view_count: post.view_count,
        repost_count: post.repost_count,
        hot_score: Math.round(hotScore),
        created_at: createdAt.toISOString(),
      })

    if (error) {
      console.log(`❌ Failed to insert post by ${post.author_handle}: ${error.message}`)
    } else {
      successCount++
      console.log(`✅ Added post by ${post.author_handle} (hot_score: ${hotScore.toFixed(1)})`)
    }
  }

  console.log(`\n📊 Summary: ${successCount}/${samplePosts.length} posts seeded successfully`)

  // Verify recommendations work
  console.log('\n🔍 Testing recommendations API...')

  const { data: trending } = await sb
    .from('posts')
    .select('id, author_handle, hot_score, like_count')
    .order('hot_score', { ascending: false })
    .limit(5)

  if (trending && trending.length > 0) {
    console.log('\n📈 Top 5 trending posts:')
    trending.forEach((p, i) => {
      console.log(`   ${i + 1}. @${p.author_handle} (score: ${p.hot_score?.toFixed(1)}, likes: ${p.like_count})`)
    })
  }

  console.log('\n✅ Seeding complete!')
}

seedPosts().catch(console.error)
