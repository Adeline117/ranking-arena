import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdmin } from '@/lib/admin/auth'
import { z } from 'zod'
import { checkRateLimit, RateLimitPresets } from '@/lib/utils/rate-limit'

const RateSchema = z.object({
  rating: z.number().int().min(1).max(5),
  review: z.string().max(500).optional().nullable(),
  item_type: z.enum(['institution', 'tool']),
})

// GET: Retrieve ratings for a directory item
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const rateLimitResp = await checkRateLimit(req, RateLimitPresets.read)
  if (rateLimitResp) return rateLimitResp

  try {
    const { id } = await params
    const itemType = req.nextUrl.searchParams.get('item_type')
    if (!itemType || !['institution', 'tool'].includes(itemType)) {
      return NextResponse.json({ error: 'item_type must be institution or tool' }, { status: 400 })
    }

    const supabase = getSupabaseAdmin()

    const { data: ratings, error } = await supabase
      .from('directory_ratings')
      .select(`
        id, rating, review, created_at, updated_at,
        user_id,
        user_profiles ( id, nickname, avatar_url )
      `)
      .eq('item_type', itemType)
      .eq('item_id', id)
      .order('created_at', { ascending: false })

    if (error) {
      return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
    }

    interface RatingRow {
      id: string
      rating: number
      review: string | null
      created_at: string
      updated_at: string | null
      user_id: string
      user_profiles: { id: string; nickname: string | null; avatar_url: string | null } | null
    }

    const typedRatings = (ratings || []) as unknown as RatingRow[]
    const count = typedRatings.length

    // Distribution
    const distribution: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 }
    let sum = 0
    for (const r of typedRatings) {
      distribution[r.rating] = (distribution[r.rating] || 0) + 1
      sum += r.rating
    }

    const avg = count > 0 ? Math.round((sum / count) * 100) / 100 : 0

    // Check if current user has rated (via auth header)
    let userRating: number | null = null
    const authHeader = req.headers.get('authorization')
    if (authHeader?.startsWith('Bearer ')) {
      const { data: { user } } = await supabase.auth.getUser(authHeader.substring(7))
      if (user) {
        const found = typedRatings.find(r => r.user_id === user.id)
        if (found) userRating = found.rating
      }
    }

    return NextResponse.json({
      ratings: typedRatings.map(r => ({
        id: r.id,
        rating: r.rating,
        review: r.review,
        created_at: r.created_at,
        user: r.user_profiles ? { id: r.user_profiles.id, nickname: r.user_profiles.nickname } : null,
      })),
      summary: { avg, count, distribution },
      userRating,
    })
  } catch {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

// POST: Submit or update a rating (requires auth)
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const rateLimitResp = await checkRateLimit(req, RateLimitPresets.write)
  if (rateLimitResp) return rateLimitResp

  try {
    const { id } = await params
    const authHeader = req.headers.get('authorization')
    if (!authHeader?.startsWith('Bearer ')) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const supabase = getSupabaseAdmin()
    const { data: { user }, error: authError } = await supabase.auth.getUser(authHeader.substring(7))
    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const body = await req.json()
    const parsed = RateSchema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json({ error: 'Invalid input', details: parsed.error.flatten() }, { status: 400 })
    }

    const { rating, review, item_type } = parsed.data

    // Verify item exists
    const table = item_type === 'institution' ? 'institutions' : 'tools'
    const { data: item, error: itemError } = await supabase
      .from(table)
      .select('id')
      .eq('id', id)
      .maybeSingle()

    if (itemError || !item) {
      return NextResponse.json({ error: 'Item not found' }, { status: 404 })
    }

    // Upsert rating
    const { error: upsertError } = await supabase
      .from('directory_ratings')
      .upsert({
        user_id: user.id,
        item_type,
        item_id: id,
        rating,
        review: review || null,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'user_id,item_type,item_id' })

    if (upsertError) {
      return NextResponse.json({ error: upsertError.message }, { status: 500 })
    }

    // Read back the updated avg from the parent table (trigger already fired)
    const { data: updated } = await supabase
      .from(table)
      .select('avg_rating, rating_count')
      .eq('id', id)
      .single()

    return NextResponse.json({
      success: true,
      avg_rating: updated?.avg_rating ?? 0,
      rating_count: updated?.rating_count ?? 0,
    })
  } catch {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
