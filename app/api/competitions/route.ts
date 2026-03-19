/**
 * GET /api/competitions - List competitions with pagination
 * POST /api/competitions - Create a new competition (auth required)
 */

import { NextResponse } from 'next/server'
import { withPublic, withAuth } from '@/lib/api/middleware'
import { getSupabaseAdmin } from '@/lib/supabase/server'

// GET: List competitions
export const GET = withPublic(
  async ({ request }) => {
    const { searchParams } = new URL(request.url)
    const status = searchParams.get('status') || 'active' // upcoming, active, completed
    const limit = Math.min(parseInt(searchParams.get('limit') || '20'), 50)
    const offset = parseInt(searchParams.get('offset') || '0')

    const supabase = getSupabaseAdmin()

    const [dataResult, countResult] = await Promise.all([
      supabase
        .from('competitions')
        .select('*, competition_entries(count)')
        .eq('status', status)
        .order('start_at', { ascending: status === 'upcoming' })
        .range(offset, offset + limit - 1),
      supabase
        .from('competitions')
        .select('id', { count: 'exact', head: true })
        .eq('status', status),
    ])

    if (dataResult.error) {
      // Table may not exist yet in this environment — return empty list gracefully
      const isMissingTable =
        dataResult.error.code === '42P01' ||
        dataResult.error.message?.includes('does not exist')
      if (isMissingTable) {
        return NextResponse.json({
          success: true,
          data: {
            competitions: [],
            pagination: { limit, offset, total: 0, has_more: false },
          },
        })
      }
      return NextResponse.json(
        { success: false, error: 'Failed to fetch competitions' },
        { status: 500 }
      )
    }

    // Transform count from nested array
    const competitions = (dataResult.data || []).map((comp) => ({
      ...comp,
      participant_count: Array.isArray(comp.competition_entries)
        ? comp.competition_entries[0]?.count ?? 0
        : 0,
      competition_entries: undefined,
    }))

    return NextResponse.json({
      success: true,
      data: {
        competitions,
        pagination: {
          limit,
          offset,
          total: countResult.count || 0,
          has_more: (offset + limit) < (countResult.count || 0),
        },
      },
    })
  },
  { name: 'competitions-list' }
)

// POST: Create competition
export const POST = withAuth(
  async ({ user, request }) => {
    const body = await request.json()
    const { title, description, metric, start_at, end_at, max_participants, entry_fee_cents, prize_pool_cents, rules } = body

    // Validate required fields
    if (!title || typeof title !== 'string' || title.trim().length === 0) {
      return NextResponse.json({ success: false, error: 'Title is required' }, { status: 400 })
    }
    if (title.trim().length > 100) {
      return NextResponse.json({ success: false, error: 'Title cannot exceed 100 characters' }, { status: 400 })
    }
    if (!start_at || !end_at) {
      return NextResponse.json({ success: false, error: 'Start and end dates are required' }, { status: 400 })
    }

    const startDate = new Date(start_at)
    const endDate = new Date(end_at)

    if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
      return NextResponse.json({ success: false, error: 'Invalid date format' }, { status: 400 })
    }
    if (endDate <= startDate) {
      return NextResponse.json({ success: false, error: 'End date must be after start date' }, { status: 400 })
    }

    const validMetrics = ['roi', 'pnl', 'sharpe', 'max_drawdown']
    const finalMetric = validMetrics.includes(metric) ? metric : 'roi'

    const supabase = getSupabaseAdmin()

    const { data: competition, error } = await supabase
      .from('competitions')
      .insert({
        title: title.trim(),
        description: description?.trim() || null,
        creator_id: user.id,
        metric: finalMetric,
        start_at: startDate.toISOString(),
        end_at: endDate.toISOString(),
        entry_fee_cents: entry_fee_cents || 0,
        max_participants: max_participants || 100,
        prize_pool_cents: prize_pool_cents || 0,
        rules: rules || {},
        status: startDate <= new Date() ? 'active' : 'upcoming',
      })
      .select()
      .single()

    if (error) {
      return NextResponse.json({ success: false, error: 'Failed to create competition' }, { status: 500 })
    }

    return NextResponse.json({ success: true, data: competition })
  },
  { rateLimit: 'write', name: 'competitions-create', skipCsrf: true }
)
