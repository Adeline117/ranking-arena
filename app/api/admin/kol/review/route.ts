import { NextResponse } from 'next/server'
import { getSupabaseAdmin, verifyAdmin } from '@/lib/admin/auth'

export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
  try {
    const supabase = getSupabaseAdmin()
    const admin = await verifyAdmin(supabase, req.headers.get('authorization'))
    if (!admin) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const { searchParams } = new URL(req.url)
    const status = searchParams.get('status') || 'pending'

    const { data, error } = await supabase
      .from('kol_applications')
      .select('*, user:user_id(id, email, raw_user_meta_data)')
      .eq('status', status)
      .order('created_at', { ascending: false })

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    return NextResponse.json({ data })
  } catch (_err) {
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}

export async function POST(req: Request) {
  try {
    const supabase = getSupabaseAdmin()
    const admin = await verifyAdmin(supabase, req.headers.get('authorization'))
    if (!admin) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const { applicationId, action, reviewer_notes } = await req.json()

    if (!applicationId || !['approved', 'rejected'].includes(action)) {
      return NextResponse.json({ error: 'Invalid parameters' }, { status: 400 })
    }

    // Get application
    const { data: app, error: fetchErr } = await supabase
      .from('kol_applications')
      .select('*')
      .eq('id', applicationId)
      .single()

    if (fetchErr || !app) {
      return NextResponse.json({ error: 'Application not found' }, { status: 404 })
    }

    // Update application status
    const { error: updateErr } = await supabase
      .from('kol_applications')
      .update({
        status: action,
        reviewer_notes: reviewer_notes || null,
        reviewed_at: new Date().toISOString(),
        reviewed_by: admin.id,
      })
      .eq('id', applicationId)

    if (updateErr) {
      return NextResponse.json({ error: updateErr.message }, { status: 500 })
    }

    // If approved, update user profile
    if (action === 'approved') {
      await supabase
        .from('user_profiles')
        .update({
          kol_tier: app.tier,
          is_verified: true,
          verified_at: new Date().toISOString(),
        })
        .eq('id', app.user_id)
    }

    return NextResponse.json({ success: true })
  } catch (_err) {
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}
