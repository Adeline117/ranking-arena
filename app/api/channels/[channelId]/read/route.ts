/**
 * Mark channel as read API
 * POST: upsert the caller's last_read_at for this channel so group unread state works.
 * Table channel_message_reads(channel_id, user_id, last_read_at) already exists (00065).
 */

import { NextRequest, NextResponse } from 'next/server'
import { getAuthUser, getSupabaseAdmin } from '@/lib/supabase/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { checkRateLimit, RateLimitPresets } from '@/lib/utils/rate-limit'
import { createLogger } from '@/lib/utils/logger'
import { socialFeatureGuard } from '@/lib/features'

const logger = createLogger('api:channels:channelId:read')

export const dynamic = 'force-dynamic'

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ channelId: string }> }
) {
  const guard = socialFeatureGuard()
  if (guard) return guard

  const rateLimitResp = await checkRateLimit(request, RateLimitPresets.write)
  if (rateLimitResp) return rateLimitResp

  try {
    const user = await getAuthUser(request)
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const { channelId } = await params
    if (!channelId) return NextResponse.json({ error: 'Missing channelId' }, { status: 400 })

    const supabase = getSupabaseAdmin() as SupabaseClient

    // Caller must be a member of the channel.
    const { data: membership } = await supabase
      .from('channel_members')
      .select('channel_id')
      .eq('channel_id', channelId)
      .eq('user_id', user.id)
      .maybeSingle()

    if (!membership) return NextResponse.json({ error: 'Not a member' }, { status: 403 })

    const { error } = await supabase
      .from('channel_message_reads')
      .upsert(
        { channel_id: channelId, user_id: user.id, last_read_at: new Date().toISOString() },
        { onConflict: 'channel_id,user_id' }
      )

    if (error) {
      logger.error('Mark channel read failed', { error: error.message })
      return NextResponse.json({ error: 'Failed to mark as read' }, { status: 500 })
    }

    return NextResponse.json({ success: true })
  } catch (e) {
    logger.error('Channel read error', { error: e instanceof Error ? e.message : String(e) })
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }
}
