import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdmin } from '@/lib/admin/auth'
import { z } from 'zod'
import { checkRateLimit, RateLimitPresets } from '@/lib/utils/rate-limit'

const StatusSchema = z.object({
  status: z.enum(['want_to_read', 'reading', 'read']),
})

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
    const parsed = StatusSchema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json({ error: 'Invalid status', details: parsed.error.flatten() }, { status: 400 })
    }

    const { status } = parsed.data

    // Upsert - if switching to want_to_read, clear rating
    const upsertData: { user_id: string; library_item_id: string; status: string; updated_at: string; rating?: null } = {
      user_id: user.id,
      library_item_id: id,
      status,
      updated_at: new Date().toISOString(),
    }

    if (status === 'want_to_read') {
      upsertData.rating = null
    }

    const { error } = await supabase
      .from('book_ratings')
      .upsert(upsertData, { onConflict: 'user_id,library_item_id' })

    if (error) {
      return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
    }

    return NextResponse.json({ success: true, status })
  } catch (e: unknown) {
    return NextResponse.json({ error: (e instanceof Error ? e.message : String(e)) }, { status: 500 })
  }
}
