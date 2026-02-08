import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdmin } from '@/lib/admin/auth'

// Bayesian average: weighted_score = (v/(v+m)) * R + (m/(v+m)) * C
// m = minimum votes threshold
const MIN_VOTES_THRESHOLD = 5

// Account age weight
function getAccountWeight(createdAt: string, postCount: number): number {
  const daysSinceRegistration = (Date.now() - new Date(createdAt).getTime()) / (1000 * 60 * 60 * 24)
  let weight = 1.0
  if (daysSinceRegistration < 7) weight = 0.3
  else if (daysSinceRegistration < 30) weight = 0.7

  if (postCount > 10) weight += 0.2

  return Math.min(weight, 1.2) // cap at 1.2
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    const supabase = getSupabaseAdmin()

    // Get all ratings with user info
    const { data: ratings, error } = await supabase
      .from('book_ratings')
      .select(`
        id, rating, review, status, created_at, updated_at,
        user_id,
        users!book_ratings_user_id_fkey ( id, nickname, avatar_url, created_at )
      `)
      .eq('library_item_id', id)
      .order('created_at', { ascending: false })

    if (error) {
      return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
    }

    // Filter to only 'read' ratings for scoring
    const readRatings = (ratings || []).filter((r: any) => r.status === 'read' && r.rating != null)

    // Get user post counts for weighting
    const userIds = readRatings.map((r: any) => r.user_id)
    const postCounts: Record<string, number> = {}
    if (userIds.length > 0) {
      const { data: posts } = await supabase
        .from('posts')
        .select('user_id')
        .in('user_id', userIds)
      if (posts) {
        for (const p of posts) {
          postCounts[p.user_id] = (postCounts[p.user_id] || 0) + 1
        }
      }
    }

    // Calculate weighted average R (with account weights)
    let weightedSum = 0
    let weightTotal = 0
    for (const r of readRatings) {
      const userCreatedAt = (r as any).users?.created_at || r.created_at
      const pc = postCounts[r.user_id] || 0
      const w = getAccountWeight(userCreatedAt, pc)
      weightedSum += (r.rating as number) * w
      weightTotal += w
    }
    const R = weightTotal > 0 ? weightedSum / weightTotal : 0

    // Get global average C
    const { data: globalStats } = await supabase
      .from('library_items')
      .select('rating')
      .not('rating', 'is', null)
      .gt('rating_count', 0)

    let C = 3.0 // default fallback
    if (globalStats && globalStats.length > 0) {
      const sum = globalStats.reduce((acc: number, item: any) => acc + (Number(item.rating) || 0), 0)
      C = sum / globalStats.length
    }

    // Bayesian weighted score
    const v = readRatings.length
    const m = MIN_VOTES_THRESHOLD
    const weighted_score = v > 0
      ? (v / (v + m)) * R + (m / (v + m)) * C
      : 0

    // Distribution
    const distribution: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 }
    for (const r of readRatings) {
      if (r.rating) distribution[r.rating as number] = (distribution[r.rating as number] || 0) + 1
    }

    // Simple average
    const average = v > 0 ? readRatings.reduce((s: number, r: any) => s + r.rating, 0) / v : 0

    return NextResponse.json({
      ratings: (ratings || []).map((r: any) => ({
        ...r,
        users: r.users ? { id: r.users.id, nickname: r.users.nickname, avatar_url: r.users.avatar_url } : null,
      })),
      average: Math.round(average * 100) / 100,
      weighted_score: Math.round(weighted_score * 100) / 100,
      count: v,
      distribution,
    })
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 })
  }
}
