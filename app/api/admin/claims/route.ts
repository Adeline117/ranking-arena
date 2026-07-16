/**
 * Admin Claims API
 * GET /api/admin/claims - List all trader claims with user info
 */

import { NextResponse } from 'next/server'
import { withAdminAuth } from '@/lib/api/with-admin-auth'
import { ApiError } from '@/lib/api/errors'
import { parseLimit, parseOffset } from '@/lib/utils/safe-parse'

export const dynamic = 'force-dynamic'

const CLAIM_STATUS_FILTERS = [
  'all',
  'reviewable',
  'pending',
  'reviewing',
  'verified',
  'rejected',
] as const

type ClaimStatusFilter = (typeof CLAIM_STATUS_FILTERS)[number]

function parseStatusFilter(value: string | null): ClaimStatusFilter {
  const status = value || 'all'
  if ((CLAIM_STATUS_FILTERS as readonly string[]).includes(status)) {
    return status as ClaimStatusFilter
  }
  throw ApiError.validation('Invalid claim status filter')
}

export const GET = withAdminAuth(
  async ({ supabase, request }) => {
    const { searchParams } = new URL(request.url)
    const status = parseStatusFilter(searchParams.get('status'))
    // Keep the legacy default of 200 until every caller opts into pagination.
    const limit = parseLimit(searchParams.get('limit'), 200, 200)
    const offset = parseOffset(searchParams.get('offset'))

    let claimsQuery = supabase.from('trader_claims').select(
      `
          id, user_id, trader_id, source, handle,
          verification_method, verification_data,
          status, reject_reason, reviewed_by, reviewed_at, verified_at,
          created_at, updated_at
        `,
      { count: 'exact' }
    )

    if (status === 'reviewable') {
      claimsQuery = claimsQuery.in('status', ['pending', 'reviewing'])
    } else if (status !== 'all') {
      claimsQuery = claimsQuery.eq('status', status)
    }

    const oldestFirst = status === 'reviewable' || status === 'pending' || status === 'reviewing'
    const {
      data: claims,
      count,
      error,
    } = await claimsQuery
      .order('created_at', { ascending: oldestFirst })
      .order('id', { ascending: oldestFirst })
      .range(offset, offset + limit - 1)

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    // Fetch user emails for display
    const userIds = [...new Set((claims || []).map((c) => c.user_id))]
    let userEmails: Record<string, string> = {}

    if (userIds.length > 0) {
      const { data: profiles } = await supabase
        .from('user_profiles')
        .select('id, email, handle')
        .in('id', userIds)

      if (profiles) {
        userEmails = Object.fromEntries(profiles.map((p) => [p.id, p.email || p.handle || p.id]))
      }
    }

    const enriched = (claims || []).map((c) => ({
      ...c,
      user_email: userEmails[c.user_id] || c.user_id,
    }))

    return NextResponse.json({
      success: true,
      data: {
        claims: enriched,
        total: count ?? 0,
        limit,
        offset,
        has_more: offset + enriched.length < (count ?? 0),
        status,
      },
    })
  },
  { name: 'admin-claims' }
)
