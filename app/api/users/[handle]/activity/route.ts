import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import type { SupabaseClient } from '@supabase/supabase-js'

export type ActivityItem = {
  id: string
  type: 'post' | 'book_rating' | 'follow_trader' | 'join_group'
  timestamp: string
  data: Record<string, unknown>
}

/**
 * GET /api/users/[handle]/activity
 * Aggregated recent activity feed for a user profile
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ handle: string }> }
) {
  try {
    const { handle } = await params
    const supabase = getSupabaseAdmin() as SupabaseClient
    const limit = Math.min(Number(req.nextUrl.searchParams.get('limit') || 20), 50)

    // Resolve user
    const { data: profile } = await supabase
      .from('user_profiles')
      .select('id, handle')
      .eq('handle', decodeURIComponent(handle))
      .maybeSingle()

    if (!profile) {
      return NextResponse.json({ activities: [] })
    }

    // Parallel fetch recent activities from multiple sources
    const [postsRes, ratingsRes, traderFollowsRes, groupJoinsRes] = await Promise.all([
      // Recent posts
      supabase
        .from('posts')
        .select('id, title, created_at, group_id, groups(name, name_en)')
        .eq('author_id', profile.id)
        .is('deleted_at', null)
        .order('created_at', { ascending: false })
        .limit(limit),

      // Recent book ratings
      supabase
        .from('book_ratings')
        .select('id, status, rating, updated_at, library_item_id, library_items(title, author)')
        .eq('user_id', profile.id)
        .order('updated_at', { ascending: false })
        .limit(limit),

      // Recent trader follows
      supabase
        .from('trader_follows')
        .select('id, created_at, trader_id, traders(handle, display_name)')
        .eq('user_id', profile.id)
        .order('created_at', { ascending: false })
        .limit(limit),

      // Recent group joins
      supabase
        .from('group_members')
        .select('id, joined_at, group_id, groups(name, name_en)')
        .eq('user_id', profile.id)
        .order('joined_at', { ascending: false })
        .limit(limit),
    ])

    const activities: ActivityItem[] = []

    // Posts
    for (const p of postsRes.data || []) {
      activities.push({
        id: `post-${p.id}`,
        type: 'post',
        timestamp: p.created_at,
        data: { postId: p.id, title: p.title, group: (p as Record<string, unknown>).groups },
      })
    }

    // Book ratings
    for (const r of ratingsRes.data || []) {
      activities.push({
        id: `book-${r.id}`,
        type: 'book_rating',
        timestamp: r.updated_at,
        data: {
          itemId: r.library_item_id,
          status: r.status,
          rating: r.rating,
          book: (r as Record<string, unknown>).library_items,
        },
      })
    }

    // Trader follows
    for (const f of traderFollowsRes.data || []) {
      activities.push({
        id: `follow-${f.id}`,
        type: 'follow_trader',
        timestamp: f.created_at,
        data: { traderId: f.trader_id, trader: (f as Record<string, unknown>).traders },
      })
    }

    // Group joins
    for (const g of groupJoinsRes.data || []) {
      activities.push({
        id: `group-${g.id}`,
        type: 'join_group',
        timestamp: g.joined_at,
        data: { groupId: g.group_id, group: (g as Record<string, unknown>).groups },
      })
    }

    // Sort by timestamp descending, take limit
    activities.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())

    return NextResponse.json({ activities: activities.slice(0, limit) })
  } catch (e: unknown) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e), activities: [] },
      { status: 500 }
    )
  }
}
