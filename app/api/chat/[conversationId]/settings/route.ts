/**
 * Chat Conversation Settings API
 * GET /api/chat/[conversationId]/settings - Get current settings
 * PATCH /api/chat/[conversationId]/settings - Update settings
 *
 * Manages per-user conversation settings: remark, mute, pin, block, clear history.
 * Only conversation members can access/modify settings.
 */

import { NextRequest, NextResponse } from 'next/server'
import { getAuthUser, getSupabaseAdmin } from '@/lib/supabase/server'
import { logger } from '@/lib/logger'

export const dynamic = 'force-dynamic'

type SettingsBody = {
  remark?: string | null
  is_muted?: boolean
  is_pinned?: boolean
  is_blocked?: boolean
  cleared_before?: string | null // ISO timestamp
}

async function verifyMembership(supabase: ReturnType<typeof getSupabaseAdmin>, conversationId: string, userId: string) {
  const { data: conversation, error } = await supabase
    .from('conversations')
    .select('id, user1_id, user2_id')
    .eq('id', conversationId)
    .maybeSingle()

  if (error || !conversation) {
    return { valid: false, status: 404, message: 'Conversation not found' }
  }

  if (conversation.user1_id !== userId && conversation.user2_id !== userId) {
    return { valid: false, status: 403, message: 'No permission to access this conversation' }
  }

  return { valid: true, conversation }
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ conversationId: string }> }
) {
  try {
    const user = await getAuthUser(request)
    if (!user) {
      return NextResponse.json({ error: '未授权' }, { status: 401 })
    }

    const resolvedParams = params instanceof Promise ? await params : params
    const conversationId = resolvedParams.conversationId
    const supabase = getSupabaseAdmin()

    const membership = await verifyMembership(supabase, conversationId, user.id)
    if (!membership.valid) {
      return NextResponse.json(
        { error: membership.message },
        { status: membership.status }
      )
    }

    // Get or create member settings
    const { data: settings } = await supabase
      .from('conversation_members')
      .select('remark, is_muted, is_pinned, is_blocked, cleared_before, updated_at')
      .eq('conversation_id', conversationId)
      .eq('user_id', user.id)
      .maybeSingle()

    return NextResponse.json({
      settings: settings || {
        remark: null,
        is_muted: false,
        is_pinned: false,
        is_blocked: false,
        cleared_before: null,
        updated_at: null,
      }
    })
  } catch (error: unknown) {
    logger.apiError('/api/chat/[conversationId]/settings', error, { method: 'GET' })
    return NextResponse.json({ error: '服务器错误' }, { status: 500 })
  }
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ conversationId: string }> }
) {
  try {
    const user = await getAuthUser(request)
    if (!user) {
      return NextResponse.json({ error: '未授权' }, { status: 401 })
    }

    const resolvedParams = params instanceof Promise ? await params : params
    const conversationId = resolvedParams.conversationId
    const supabase = getSupabaseAdmin()

    const membership = await verifyMembership(supabase, conversationId, user.id)
    if (!membership.valid) {
      return NextResponse.json(
        { error: membership.message },
        { status: membership.status }
      )
    }

    const body: SettingsBody = await request.json()

    // Validate remark length
    if (body.remark !== undefined && body.remark !== null && body.remark.length > 50) {
      return NextResponse.json({ error: '备注名最多50个字符' }, { status: 400 })
    }

    // Build update object with only provided fields
    const updateData: Record<string, unknown> = {}
    if ('remark' in body) updateData.remark = body.remark || null
    if ('is_muted' in body) updateData.is_muted = Boolean(body.is_muted)
    if ('is_pinned' in body) updateData.is_pinned = Boolean(body.is_pinned)
    if ('is_blocked' in body) updateData.is_blocked = Boolean(body.is_blocked)
    if ('cleared_before' in body) updateData.cleared_before = body.cleared_before

    if (Object.keys(updateData).length === 0) {
      return NextResponse.json({ error: '没有可更新的字段' }, { status: 400 })
    }

    // Upsert: create if not exists, update if exists
    const { data: existing } = await supabase
      .from('conversation_members')
      .select('id')
      .eq('conversation_id', conversationId)
      .eq('user_id', user.id)
      .maybeSingle()

    let result
    if (existing) {
      // Update existing record
      const { data, error } = await supabase
        .from('conversation_members')
        .update(updateData)
        .eq('conversation_id', conversationId)
        .eq('user_id', user.id)
        .select('remark, is_muted, is_pinned, is_blocked, cleared_before, updated_at')
        .single()

      if (error) {
        logger.dbError('update-chat-settings', error, { conversationId })
        return NextResponse.json({ error: '更新设置失败' }, { status: 500 })
      }
      result = data
    } else {
      // Insert new record
      const insertData = {
        conversation_id: conversationId,
        user_id: user.id,
        remark: null,
        is_muted: false,
        is_pinned: false,
        is_blocked: false,
        cleared_before: null,
        ...updateData,
      }

      const { data, error } = await supabase
        .from('conversation_members')
        .insert(insertData)
        .select('remark, is_muted, is_pinned, is_blocked, cleared_before, updated_at')
        .single()

      if (error) {
        logger.dbError('insert-chat-settings', error, { conversationId })
        return NextResponse.json({ error: '保存设置失败' }, { status: 500 })
      }
      result = data
    }

    return NextResponse.json({ settings: result })
  } catch (error: unknown) {
    logger.apiError('/api/chat/[conversationId]/settings', error, { method: 'PATCH' })
    return NextResponse.json({ error: '服务器错误' }, { status: 500 })
  }
}
