/**
 * 交易员账号关联管理
 * POST /api/traders/link - 关联交易员账号
 * GET /api/traders/link - 获取已关联的交易员账号列表
 * DELETE /api/traders/link - 取消关联交易员账号
 */

import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import logger from '@/lib/logger'
import { checkRateLimit, RateLimitPresets } from '@/lib/utils/rate-limit'

async function getUser(req: NextRequest) {
  const authHeader = req.headers.get('authorization')
  if (!authHeader) return null

  const token = authHeader.replace('Bearer ', '')
  const adminSupabase = getSupabaseAdmin()
  const { data: { user }, error } = await adminSupabase.auth.getUser(token)
  if (error || !user) return null
  return user
}

/**
 * POST - 关联交易员账号
 */
export async function POST(req: NextRequest) {
  const rateLimitResp = await checkRateLimit(req, RateLimitPresets.write)
  if (rateLimitResp) return rateLimitResp

  try {
    const user = await getUser(req)
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const body = await req.json()
    const { traderId, source, handle } = body

    if (!traderId || !source) {
      return NextResponse.json(
        { error: 'Missing required parameters: traderId, source' },
        { status: 400 }
      )
    }

    const adminSupabase = getSupabaseAdmin()

    // Check if user has a verified exchange connection for this source
    const exchangeKey = source.split('_')[0] // e.g. 'binance_futures' -> 'binance'
    const { data: connection } = await adminSupabase
      .from('user_exchange_connections')
      .select('id')
      .eq('user_id', user.id)
      .eq('exchange', exchangeKey)
      .eq('is_active', true)
      .maybeSingle()

    if (!connection) {
      return NextResponse.json(
        {
          error: 'Please connect the corresponding exchange account first',
          needConnect: true,
          message: 'Please connect your exchange account in settings before linking trader identity.',
        },
        { status: 400 }
      )
    }

    // Insert the trader link
    const { data: link, error: insertError } = await adminSupabase
      .from('trader_links')
      .insert({
        user_id: user.id,
        trader_id: traderId,
        source,
        handle: handle || null,
        verified_at: new Date().toISOString(),
      })
      .select()
      .single()

    if (insertError) {
      if (insertError.code === '23505') {
        return NextResponse.json(
          { error: 'This trader account is already linked' },
          { status: 409 }
        )
      }
      logger.error('[trader-link] Insert error:', insertError)
      return NextResponse.json(
        { error: 'Link failed' },
        { status: 500 }
      )
    }

    return NextResponse.json({ success: true, link })
  } catch (error: unknown) {
    logger.error('[trader-link] POST error:', error instanceof Error ? error.message : String(error))
    // SECURITY: Do not leak internal error details to client
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

/**
 * GET - 获取已关联的交易员账号列表
 */
export async function GET(req: NextRequest) {
  try {
    const user = await getUser(req)
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const adminSupabase = getSupabaseAdmin()

    const { data: links, error } = await adminSupabase
      .from('trader_links')
      .select('id, user_id, trader_id, source, handle, verified_at, created_at')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false })

    if (error) {
      logger.error('[trader-link] GET error:', error)
      return NextResponse.json({ error: 'Fetch failed' }, { status: 500 })
    }

    return NextResponse.json({ links: links || [] })
  } catch (error: unknown) {
    logger.error('[trader-link] GET error:', error instanceof Error ? error.message : String(error))
    // SECURITY: Do not leak internal error details to client
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

/**
 * DELETE - 取消关联交易员账号
 */
export async function DELETE(req: NextRequest) {
  const rateLimitResp = await checkRateLimit(req, RateLimitPresets.write)
  if (rateLimitResp) return rateLimitResp

  try {
    const user = await getUser(req)
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { searchParams } = new URL(req.url)
    const linkId = searchParams.get('id')

    if (!linkId) {
      return NextResponse.json(
        { error: 'Missing parameter: id' },
        { status: 400 }
      )
    }

    const adminSupabase = getSupabaseAdmin()

    // Verify ownership before deleting
    const { data: existing } = await adminSupabase
      .from('trader_links')
      .select('user_id')
      .eq('id', linkId)
      .single()

    if (!existing || existing.user_id !== user.id) {
      return NextResponse.json({ error: 'Permission denied' }, { status: 403 })
    }

    const { error: deleteError } = await adminSupabase
      .from('trader_links')
      .delete()
      .eq('id', linkId)
      .eq('user_id', user.id)

    if (deleteError) {
      logger.error('[trader-link] DELETE error:', deleteError)
      return NextResponse.json({ error: 'Failed to unlink' }, { status: 500 })
    }

    return NextResponse.json({ success: true })
  } catch (error: unknown) {
    logger.error('[trader-link] DELETE error:', error instanceof Error ? error.message : String(error))
    // SECURITY: Do not leak internal error details to client
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
