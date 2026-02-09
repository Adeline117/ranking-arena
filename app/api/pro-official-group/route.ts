/**
 * Pro 会员官方群 API
 * 自动加入/查询官方群
 */

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { verifyAuth } from '@/lib/api/auth'
import { hasFeatureAccess } from '@/lib/premium'
import { createLogger } from '@/lib/utils/logger'

// 服务端 Supabase 客户端（延迟初始化以避免构建时错误）
function getSupabase() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) {
    throw new Error('Supabase 环境变量未配置')
  }
  return createClient(url, key)
}

const logger = createLogger('pro-official-group')

// 群主邮箱
const OWNER_EMAIL = 'adelinewen1107@outlook.com'
const MAX_MEMBERS_PER_GROUP = 500

/**
 * GET - 获取当前用户的官方群信息
 */
export async function GET(request: NextRequest) {
  try {
    // 验证用户
    const authResult = await verifyAuth(request)
    if ('error' in authResult) {
      return NextResponse.json({ error: authResult.error }, { status: authResult.status })
    }
    
    const { user, tier } = authResult
    
    // 检查是否为 Pro 会员
    if (!hasFeatureAccess(tier, 'premium_groups')) {
      return NextResponse.json(
        { error: '此功能仅限 Pro 会员', code: 'PRO_REQUIRED' },
        { status: 403 }
      )
    }
    
    // 调用数据库函数获取用户的官方群信息
    const { data, error } = await getSupabase().rpc('get_user_pro_official_group', {
      p_user_id: user.id
    })
    
    if (error) {
      logger.error('获取群信息失败', { error, userId: user.id })
      return NextResponse.json({ error: '获取群信息失败' }, { status: 500 })
    }
    
    return NextResponse.json({
      success: true,
      data: data || null
    })
    
  } catch (error: unknown) {
    logger.error('GET error', { error })
    return NextResponse.json({ error: '服务器错误' }, { status: 500 })
  }
}

/**
 * POST - 加入官方群（成为 Pro 会员时调用）
 */
export async function POST(request: NextRequest) {
  try {
    // 验证用户
    const authResult = await verifyAuth(request)
    if ('error' in authResult) {
      return NextResponse.json({ error: authResult.error }, { status: authResult.status })
    }
    
    const { user, tier } = authResult
    
    // 检查是否为 Pro 会员
    if (!hasFeatureAccess(tier, 'premium_groups')) {
      return NextResponse.json(
        { error: '此功能仅限 Pro 会员', code: 'PRO_REQUIRED' },
        { status: 403 }
      )
    }
    
    // 调用数据库函数加入官方群
    const { data, error } = await getSupabase().rpc('join_pro_official_group', {
      p_user_id: user.id
    })
    
    if (error) {
      logger.error('加入群失败', { error })
      return NextResponse.json({ error: '加入群失败' }, { status: 500 })
    }
    
    if (data?.success) {
      // 发送欢迎消息通知
      if (data.message === 'joined') {
        await sendWelcomeNotification(user.id, data.group_id)
      }
      
      return NextResponse.json({
        success: true,
        message: data.message === 'joined' ? '已加入 Pro 会员官方群' : '你已经在 Pro 会员官方群中',
        group_id: data.group_id
      })
    } else {
      return NextResponse.json(
        { error: data?.message || '加入群失败' },
        { status: 500 }
      )
    }
    
  } catch (error: unknown) {
    logger.error('POST error', { error })
    return NextResponse.json({ error: '服务器错误' }, { status: 500 })
  }
}

/**
 * DELETE - 离开官方群（取消订阅时调用）
 */
export async function DELETE(request: NextRequest) {
  try {
    // 验证用户
    const authResult = await verifyAuth(request)
    if ('error' in authResult) {
      return NextResponse.json({ error: authResult.error }, { status: authResult.status })
    }
    
    const { user } = authResult
    
    // 调用数据库函数离开官方群
    const { data, error } = await getSupabase().rpc('leave_pro_official_group', {
      p_user_id: user.id
    })
    
    if (error) {
      logger.error('离开群失败', { error, userId: user.id })
      return NextResponse.json({ error: '离开群失败' }, { status: 500 })
    }
    
    return NextResponse.json({
      success: true,
      message: data ? '已离开 Pro 会员官方群' : '你不在 Pro 会员官方群中'
    })
    
  } catch (error: unknown) {
    logger.error('DELETE error', { error })
    return NextResponse.json({ error: '服务器错误' }, { status: 500 })
  }
}

/**
 * 服务端函数：自动加入官方群（供 webhook 调用）
 */
export async function joinProOfficialGroup(userId: string): Promise<{
  success: boolean
  message: string
  groupId?: string
}> {
  try {
    // 先检查函数是否存在，如果不存在则使用备用逻辑
    const { data, error } = await getSupabase().rpc('join_pro_official_group', {
      p_user_id: userId
    })
    
    if (error) {
      // 如果函数不存在，使用备用逻辑
      if (error.message.includes('function') || error.code === '42883') {
        return await joinProOfficialGroupFallback(userId)
      }
      logger.error('加入群失败', { error, userId })
      return { success: false, message: error.message }
    }
    
    if (data?.success) {
      // 发送欢迎消息通知
      if (data.message === 'joined' && data.group_id) {
        await sendWelcomeNotification(userId, data.group_id)
      }
      
      return {
        success: true,
        message: data.message === 'joined' ? 'joined' : 'already_member',
        groupId: data.group_id
      }
    }
    
    return { success: false, message: data?.message || 'unknown_error' }
    
  } catch (error: unknown) {
    logger.error('joinProOfficialGroup error', { error, userId })
    return { success: false, message: 'server_error' }
  }
}

/**
 * 备用逻辑：当数据库函数不存在时使用
 */
async function joinProOfficialGroupFallback(userId: string): Promise<{
  success: boolean
  message: string
  groupId?: string
}> {
  try {
    // 检查用户是否已在官方群
    const { data: existingMembership } = await getSupabase()
      .from('pro_official_group_members')
      .select('pro_group_id')
      .eq('user_id', userId)
      .single()
    
    if (existingMembership) {
      const { data: groupInfo } = await getSupabase()
        .from('pro_official_groups')
        .select('group_id')
        .eq('id', existingMembership.pro_group_id)
        .single()
      
      return {
        success: true,
        message: 'already_member',
        groupId: groupInfo?.group_id
      }
    }
    
    // 获取可用的群
    const { data: availableGroup } = await getSupabase()
      .from('pro_official_groups')
      .select('id, group_id')
      .eq('is_active', true)
      .lt('current_member_count', MAX_MEMBERS_PER_GROUP)
      .order('group_number', { ascending: true })
      .limit(1)
      .single()
    
    let proGroupId: string
    let groupId: string
    
    if (availableGroup) {
      proGroupId = availableGroup.id
      groupId = availableGroup.group_id
    } else {
      // 需要创建新群
      const result = await createNewProOfficialGroup()
      if (!result.success || !result.proGroupId || !result.groupId) {
        return { success: false, message: 'failed_to_create_group' }
      }
      proGroupId = result.proGroupId
      groupId = result.groupId
    }
    
    // 加入官方群记录
    const { error: memberError } = await getSupabase()
      .from('pro_official_group_members')
      .insert({ user_id: userId, pro_group_id: proGroupId })
    
    if (memberError) {
      logger.error('加入记录失败', { error: memberError, userId })
      return { success: false, message: memberError.message }
    }
    
    // 加入 group_members（使用 upsert 处理冲突）
    await getSupabase()
      .from('group_members')
      .upsert({ group_id: groupId, user_id: userId, role: 'member' }, {
        onConflict: 'group_id,user_id'
      })
    
    // 发送欢迎通知
    await sendWelcomeNotification(userId, groupId)
    
    return { success: true, message: 'joined', groupId }
    
  } catch (error: unknown) {
    logger.error('joinProOfficialGroupFallback error', { error, userId })
    return { success: false, message: 'server_error' }
  }
}

/**
 * 创建新的官方群
 */
async function createNewProOfficialGroup(): Promise<{
  success: boolean
  proGroupId?: string
  groupId?: string
}> {
  try {
    // 获取群主 ID
    const { data: owner } = await getSupabase()
      .from('user_profiles')
      .select('id')
      .eq('email', OWNER_EMAIL)
      .single()
    
    if (!owner) {
      logger.error('群主账号不存在', { email: OWNER_EMAIL })
      return { success: false }
    }
    
    // 获取下一个群序号
    const { data: maxNumber } = await getSupabase()
      .from('pro_official_groups')
      .select('group_number')
      .order('group_number', { ascending: false })
      .limit(1)
      .single()
    
    const nextNumber = (maxNumber?.group_number || 0) + 1
    
    // 创建群组
    const { data: newGroup, error: groupError } = await getSupabase()
      .from('groups')
      .insert({
        name: `Arena Pro 会员群 #${nextNumber}`,
        name_en: `ArenaFi Pro Member Group #${nextNumber}`,
        description: '欢迎加入 ArenaFi Pro 会员专属群！在这里可以与其他 Pro 会员交流心得、获取官方支持。有问题可以直接在群里提问，我们会尽快回复。',
        description_en: 'Welcome to the ArenaFi Pro Member exclusive group! Chat with other Pro members, share tips, and get official support.',
        created_by: owner.id,
        visibility: 'private',
        is_premium_only: true
      })
      .select('id')
      .single()
    
    if (groupError || !newGroup) {
      logger.error('创建群组失败', { error: groupError })
      return { success: false }
    }
    
    // 创建官方群配置
    const { data: proGroup, error: proGroupError } = await getSupabase()
      .from('pro_official_groups')
      .insert({
        group_id: newGroup.id,
        group_number: nextNumber
      })
      .select('id')
      .single()
    
    if (proGroupError || !proGroup) {
      logger.error('创建官方群配置失败', { error: proGroupError, groupId: newGroup.id })
      return { success: false }
    }
    
    // 将群主加入群成员
    await getSupabase()
      .from('group_members')
      .insert({ group_id: newGroup.id, user_id: owner.id, role: 'owner' })
    
    logger.info('创建新群成功', { groupNumber: nextNumber, groupId: newGroup.id })
    
    return {
      success: true,
      proGroupId: proGroup.id,
      groupId: newGroup.id
    }
    
  } catch (error: unknown) {
    logger.error('createNewProOfficialGroup error', { error })
    return { success: false }
  }
}

/**
 * 发送欢迎通知
 */
async function sendWelcomeNotification(userId: string, groupId: string) {
  try {
    await getSupabase()
      .from('notifications')
      .insert({
        user_id: userId,
        type: 'system',
        title: '欢迎加入 Pro 会员官方群',
        content: '你已自动加入 ArenaFi Pro 会员官方群！在这里可以与其他 Pro 会员交流，有问题可以直接在群里提问。',
        link: `/groups/${groupId}`,
        read: false
      })
  } catch (error: unknown) {
    logger.error('sendWelcomeNotification error', { error })
  }
}

/**
 * 服务端函数：离开官方群（供 webhook 调用）
 */
export async function leaveProOfficialGroup(userId: string): Promise<boolean> {
  try {
    const { data, error } = await getSupabase().rpc('leave_pro_official_group', {
      p_user_id: userId
    })
    
    if (error) {
      // 备用逻辑
      const { data: membership } = await getSupabase()
        .from('pro_official_group_members')
        .select('pro_group_id')
        .eq('user_id', userId)
        .single()
      
      if (!membership) return false
      
      const { data: proGroup } = await getSupabase()
        .from('pro_official_groups')
        .select('group_id')
        .eq('id', membership.pro_group_id)
        .single()
      
      if (proGroup) {
        await getSupabase()
          .from('group_members')
          .delete()
          .eq('group_id', proGroup.group_id)
          .eq('user_id', userId)
      }
      
      await getSupabase()
        .from('pro_official_group_members')
        .delete()
        .eq('user_id', userId)
      
      return true
    }
    
    return data === true
    
  } catch (error: unknown) {
    logger.error('leaveProOfficialGroup error', { error, userId })
    return false
  }
}
