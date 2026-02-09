/**
 * 交易员账号关联管理
 * POST /api/traders/link - 关联交易员账号
 * GET /api/traders/link - 获取已关联的交易员账号列表
 * DELETE /api/traders/link - 取消关联交易员账号
 */

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import logger from '@/lib/logger'

function getSupabaseAdmin() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
  return createClient(url, serviceKey, {
    auth: { persistSession: false },
  })
}

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
  try {
    const user = await getUser(req)
    if (!user) {
      return NextResponse.json({ error: '未授权' }, { status: 401 })
    }

    const body = await req.json()
    const { traderId, source, handle } = body

    if (!traderId || !source) {
      return NextResponse.json(
        { error: '缺少必要参数：traderId, source' },
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
          error: '请先绑定对应交易所账号',
          needConnect: true,
          message: '请先在设置页面绑定您的交易所账号，然后才能关联交易员身份。',
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
          { error: '该交易员账号已被关联' },
          { status: 409 }
        )
      }
      logger.error('[trader-link] Insert error:', insertError)
      return NextResponse.json(
        { error: '关联失败' },
        { status: 500 }
      )
    }

    return NextResponse.json({ success: true, link })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : '未知错误'
    logger.error('[trader-link] POST error:', message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

/**
 * GET - 获取已关联的交易员账号列表
 */
export async function GET(req: NextRequest) {
  try {
    const user = await getUser(req)
    if (!user) {
      return NextResponse.json({ error: '未授权' }, { status: 401 })
    }

    const adminSupabase = getSupabaseAdmin()

    const { data: links, error } = await adminSupabase
      .from('trader_links')
      .select('*')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false })

    if (error) {
      logger.error('[trader-link] GET error:', error)
      return NextResponse.json({ error: '获取失败' }, { status: 500 })
    }

    return NextResponse.json({ links: links || [] })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : '未知错误'
    logger.error('[trader-link] GET error:', message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

/**
 * DELETE - 取消关联交易员账号
 */
export async function DELETE(req: NextRequest) {
  try {
    const user = await getUser(req)
    if (!user) {
      return NextResponse.json({ error: '未授权' }, { status: 401 })
    }

    const { searchParams } = new URL(req.url)
    const linkId = searchParams.get('id')

    if (!linkId) {
      return NextResponse.json(
        { error: '缺少参数：id' },
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
      return NextResponse.json({ error: '无权操作' }, { status: 403 })
    }

    const { error: deleteError } = await adminSupabase
      .from('trader_links')
      .delete()
      .eq('id', linkId)
      .eq('user_id', user.id)

    if (deleteError) {
      logger.error('[trader-link] DELETE error:', deleteError)
      return NextResponse.json({ error: '取消关联失败' }, { status: 500 })
    }

    return NextResponse.json({ success: true })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : '未知错误'
    logger.error('[trader-link] DELETE error:', message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
