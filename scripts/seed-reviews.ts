/**
 * 种子评价内容生成脚本
 * 为热门交易员生成初始评价，解决冷启动问题
 * 
 * 使用方式: npx tsx scripts/seed-reviews.ts
 * 
 * 注意：
 * - 生成的评价会标记为 system_generated
 * - 可以随时通过清理脚本删除这些评价
 * - 评价内容基于交易员实际数据生成，保持合理性
 */

import { createClient } from '@supabase/supabase-js'

// 环境变量
const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('请设置 SUPABASE_URL 和 SUPABASE_SERVICE_ROLE_KEY 环境变量')
  process.exit(1)
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)

// ============================================
// 评价模板
// ============================================

interface ReviewTemplate {
  overall_rating: number
  stability_rating: number
  drawdown_rating: number
  would_recommend: boolean | null
  templates: string[]
  follow_duration_range: [number, number]
  profit_loss_range: [number, number]
}

const REVIEW_TEMPLATES: Record<string, ReviewTemplate> = {
  excellent: {
    overall_rating: 5,
    stability_rating: 5,
    drawdown_rating: 5,
    would_recommend: true,
    templates: [
      '跟了一段时间，整体非常稳定，回撤控制得很好。强烈推荐！',
      '这个交易员真的很稳，收益曲线很平滑，睡觉都安心。',
      '跟单体验很好，收益稳定，回撤小，值得长期跟。',
      '非常专业的交易员，风控做得很到位。',
      '跟了几个月了，一直很稳，推荐给大家。',
    ],
    follow_duration_range: [30, 180],
    profit_loss_range: [15, 50],
  },
  good: {
    overall_rating: 4,
    stability_rating: 4,
    drawdown_rating: 4,
    would_recommend: true,
    templates: [
      '整体还不错，有一定回撤但在可接受范围内。',
      '跟单了一段时间，收益还可以，偶尔有波动。',
      '交易风格比较稳健，适合长期跟单。',
      '表现不错，但需要有一定风险承受能力。',
      '综合来看值得跟，但要做好风控。',
    ],
    follow_duration_range: [14, 90],
    profit_loss_range: [5, 25],
  },
  average: {
    overall_rating: 3,
    stability_rating: 3,
    drawdown_rating: 3,
    would_recommend: null,
    templates: [
      '表现中规中矩，需要继续观察。',
      '有盈有亏，整体持平，不好评价。',
      '跟了一段时间，感觉一般，可能还需要观望。',
      '收益波动比较大，需要谨慎。',
      '还在观察中，目前没有明显优势。',
    ],
    follow_duration_range: [7, 60],
    profit_loss_range: [-10, 10],
  },
  poor: {
    overall_rating: 2,
    stability_rating: 2,
    drawdown_rating: 2,
    would_recommend: false,
    templates: [
      '回撤比较大，风险控制一般。',
      '跟了一段时间亏了不少，不太推荐。',
      '波动太大，心脏受不了。',
      '建议小仓位试试，别投太多。',
      '数据和实际体验有差距，谨慎跟单。',
    ],
    follow_duration_range: [3, 30],
    profit_loss_range: [-25, -5],
  },
}

// ============================================
// 工具函数
// ============================================

function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min
}

function randomFloat(min: number, max: number, decimals: number = 1): number {
  const value = Math.random() * (max - min) + min
  return parseFloat(value.toFixed(decimals))
}

function randomChoice<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]
}

function shuffleArray<T>(arr: T[]): T[] {
  const shuffled = [...arr]
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]
  }
  return shuffled
}

// ============================================
// 根据交易员数据选择合适的评价模板
// ============================================

function selectTemplateForTrader(traderData: {
  roi: number
  max_drawdown: number | null
  win_rate: number | null
}): ReviewTemplate {
  const { roi, max_drawdown, win_rate } = traderData
  
  // 根据 ROI 和回撤综合判断
  const drawdown = max_drawdown ?? 15
  
  if (roi > 100 && drawdown < 15) {
    return REVIEW_TEMPLATES.excellent
  } else if (roi > 50 && drawdown < 25) {
    return REVIEW_TEMPLATES.good
  } else if (roi > 0 && drawdown < 40) {
    return REVIEW_TEMPLATES.average
  } else {
    return REVIEW_TEMPLATES.poor
  }
}

// ============================================
// 生成单条评价
// ============================================

interface GeneratedReview {
  trader_id: string
  source: string
  user_id: string
  overall_rating: number
  stability_rating: number
  drawdown_rating: number
  review_text: string
  follow_duration_days: number
  profit_loss_percent: number
  would_recommend: boolean | null
  verified: boolean
  system_generated: boolean
  created_at: string
}

function generateReview(
  traderId: string,
  source: string,
  systemUserId: string,
  template: ReviewTemplate,
  createdAt: Date
): GeneratedReview {
  const [minDays, maxDays] = template.follow_duration_range
  const [minPL, maxPL] = template.profit_loss_range
  
  return {
    trader_id: traderId,
    source,
    user_id: systemUserId,
    overall_rating: template.overall_rating,
    stability_rating: template.stability_rating,
    drawdown_rating: template.drawdown_rating,
    review_text: randomChoice(template.templates),
    follow_duration_days: randomInt(minDays, maxDays),
    profit_loss_percent: randomFloat(minPL, maxPL),
    would_recommend: template.would_recommend,
    verified: false,
    system_generated: true,  // 标记为系统生成
    created_at: createdAt.toISOString(),
  }
}

// ============================================
// 主函数
// ============================================

async function main() {
  console.log('🌱 开始生成种子评价...\n')
  
  // 1. 获取或创建系统用户
  const systemUserIds: string[] = []
  
  // 尝试获取已有的系统用户
  const { data: existingUsers } = await supabase
    .from('user_profiles')
    .select('user_id')
    .like('handle', 'arena_user_%')
    .limit(10)
  
  if (existingUsers && existingUsers.length >= 5) {
    systemUserIds.push(...existingUsers.map(u => u.user_id))
    console.log(`✅ 找到 ${systemUserIds.length} 个系统用户`)
  } else {
    console.log('⚠️ 系统用户不足，请先通过 Supabase 控制台创建测试用户')
    console.log('   提示: 创建几个 handle 为 arena_user_1, arena_user_2 等的用户')
    return
  }
  
  // 2. 获取热门交易员（Top 100）
  const { data: traders, error: tradersError } = await supabase
    .from('trader_snapshots')
    .select('source_trader_id, source, roi, max_drawdown, win_rate')
    .order('followers', { ascending: false })
    .limit(100)
  
  if (tradersError || !traders) {
    console.error('获取交易员列表失败:', tradersError)
    return
  }
  
  console.log(`📊 获取到 ${traders.length} 个热门交易员\n`)
  
  // 3. 检查已有评价
  const traderKeys = traders.map(t => `${t.source_trader_id}:${t.source}`)
  const { data: existingReviews } = await supabase
    .from('trader_reviews')
    .select('trader_id, source')
    .in('trader_id', traders.map(t => t.source_trader_id))
  
  const existingSet = new Set(
    existingReviews?.map(r => `${r.trader_id}:${r.source}`) || []
  )
  
  // 4. 为每个交易员生成 3-7 条评价
  const reviewsToInsert: GeneratedReview[] = []
  let skipped = 0
  
  for (const trader of traders) {
    const key = `${trader.source_trader_id}:${trader.source}`
    
    // 跳过已有评价的交易员
    if (existingSet.has(key)) {
      skipped++
      continue
    }
    
    const template = selectTemplateForTrader({
      roi: trader.roi || 0,
      max_drawdown: trader.max_drawdown,
      win_rate: trader.win_rate,
    })
    
    // 生成 3-7 条评价
    const numReviews = randomInt(3, 7)
    const shuffledUsers = shuffleArray(systemUserIds)
    
    for (let i = 0; i < numReviews && i < shuffledUsers.length; i++) {
      // 随机生成过去 1-90 天的创建时间
      const daysAgo = randomInt(1, 90)
      const createdAt = new Date()
      createdAt.setDate(createdAt.getDate() - daysAgo)
      
      // 添加一些随机性：不同用户可能给不同评分
      let adjustedTemplate = template
      if (Math.random() > 0.7) {
        // 30% 概率使用相邻的评分模板
        const templateKeys = Object.keys(REVIEW_TEMPLATES)
        const currentIndex = templateKeys.indexOf(
          Object.keys(REVIEW_TEMPLATES).find(
            k => REVIEW_TEMPLATES[k] === template
          ) || 'average'
        )
        const newIndex = Math.max(0, Math.min(templateKeys.length - 1, 
          currentIndex + (Math.random() > 0.5 ? 1 : -1)
        ))
        adjustedTemplate = REVIEW_TEMPLATES[templateKeys[newIndex]]
      }
      
      reviewsToInsert.push(
        generateReview(
          trader.source_trader_id,
          trader.source,
          shuffledUsers[i],
          adjustedTemplate,
          createdAt
        )
      )
    }
  }
  
  console.log(`📝 准备插入 ${reviewsToInsert.length} 条评价`)
  console.log(`⏭️ 跳过 ${skipped} 个已有评价的交易员\n`)
  
  if (reviewsToInsert.length === 0) {
    console.log('✅ 所有交易员都已有评价，无需生成')
    return
  }
  
  // 5. 批量插入
  const BATCH_SIZE = 50
  let inserted = 0
  
  for (let i = 0; i < reviewsToInsert.length; i += BATCH_SIZE) {
    const batch = reviewsToInsert.slice(i, i + BATCH_SIZE)
    
    const { error: insertError } = await supabase
      .from('trader_reviews')
      .insert(batch)
    
    if (insertError) {
      console.error(`批次 ${i / BATCH_SIZE + 1} 插入失败:`, insertError)
    } else {
      inserted += batch.length
      console.log(`✅ 已插入 ${inserted}/${reviewsToInsert.length}`)
    }
  }
  
  console.log(`\n🎉 种子评价生成完成！共插入 ${inserted} 条评价`)
}

// ============================================
// 清理脚本
// ============================================

async function cleanupSeedReviews() {
  console.log('🧹 开始清理系统生成的评价...\n')
  
  const { data, error } = await supabase
    .from('trader_reviews')
    .delete()
    .eq('system_generated', true)
    .select('id')
  
  if (error) {
    console.error('清理失败:', error)
    return
  }
  
  console.log(`✅ 已删除 ${data?.length || 0} 条系统生成的评价`)
}

// 根据命令行参数决定执行哪个函数
const args = process.argv.slice(2)
if (args.includes('--cleanup')) {
  cleanupSeedReviews()
} else {
  main()
}
