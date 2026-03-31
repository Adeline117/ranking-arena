/**
 * Admin Claims API
 * GET /api/admin/claims - List all trader claims with user info
 */

import { NextResponse } from 'next/server'
import { withAdminAuth } from '@/lib/api/with-admin-auth'

export const dynamic = 'force-dynamic'

export const GET = withAdminAuth(
  async ({ supabase }) => {
    const { data: claims, error } = await supabase
      .from('trader_claims')
      .select(`
        id, user_id, trader_id, source, handle,
        verification_method, verification_data,
        status, reject_reason, reviewed_by, reviewed_at, verified_at,
        created_at, updated_at
      `)
      .order('created_at', { ascending: false })
      .limit(200)

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    // Fetch user emails for display
    const userIds = [...new Set((claims || []).map(c => c.user_id))]
    let userEmails: Record<string, string> = {}

    if (userIds.length > 0) {
      const { data: profiles } = await supabase
        .from('user_profiles')
        .select('id, email, handle')
        .in('id', userIds)

      if (profiles) {
        userEmails = Object.fromEntries(
          profiles.map(p => [p.id, p.email || p.handle || p.id])
        )
      }
    }

    const enriched = (claims || []).map(c => ({
      ...c,
      user_email: userEmails[c.user_id] || c.user_id,
    }))

    return NextResponse.json({
      success: true,
      data: {
        claims: enriched,
        total: enriched.length,
      },
    })
  },
  { name: 'admin-claims' }
)
