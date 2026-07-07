import { NextResponse } from 'next/server'
import { withAuth } from '@/lib/api/middleware'
import { logger } from '@/lib/logger'
import { socialFeatureGuard } from '@/lib/features'
import { PRO_FREE_PROMO } from '@/lib/types/premium'

export const POST = withAuth(
  async ({ user, supabase, request }) => {
    const guard = socialFeatureGuard()
    if (guard) return guard

    // 解析请求体
    let body: Record<string, unknown>
    try {
      body = await request.json()
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }
    const {
      name,
      name_en,
      description,
      description_en,
      avatar_url,
      role_names,
      rules_json,
      rules,
      is_premium_only,
    } = body as {
      name?: string
      name_en?: string
      description?: string
      description_en?: string
      avatar_url?: string
      role_names?: { admin?: { zh?: string; en?: string }; member?: { zh?: string; en?: string } }
      rules_json?: unknown
      rules?: string
      is_premium_only?: boolean
    }

    // 验证必填字段
    if (!name || typeof name !== 'string' || name.trim().length === 0) {
      return NextResponse.json({ error: 'Group name cannot be empty' }, { status: 400 })
    }

    if (name.trim().length > 50) {
      return NextResponse.json({ error: 'Group name cannot exceed 50 characters' }, { status: 400 })
    }

    if (description && description.length > 500) {
      return NextResponse.json(
        { error: 'Group description cannot exceed 500 characters' },
        { status: 400 }
      )
    }

    // 如果要创建 Pro 专属小组，需要验证用户是 Pro 会员
    if (is_premium_only) {
      const { data: profile } = await supabase
        .from('user_profiles')
        .select('subscription_tier')
        .eq('id', user.id)
        .maybeSingle()

      const isPro =
        PRO_FREE_PROMO ||
        (profile as { subscription_tier?: string } | null)?.subscription_tier === 'pro'

      if (!isPro) {
        return NextResponse.json(
          { error: 'Only Pro members can create exclusive groups' },
          { status: 403 }
        )
      }
    }

    // 并行检查：待审核申请 + 小组名重复
    const [{ data: existingApplication }, { data: existingGroup }] = await Promise.all([
      supabase
        .from('group_applications')
        .select('id')
        .eq('applicant_id', user.id)
        .eq('status', 'pending')
        .maybeSingle(),
      supabase.from('groups').select('id').eq('name', name.trim()).maybeSingle(),
    ])

    if (existingApplication) {
      return NextResponse.json(
        { error: 'You already have a pending group application' },
        { status: 400 }
      )
    }

    if (existingGroup) {
      return NextResponse.json({ error: 'This group name is already taken' }, { status: 400 })
    }

    // 默认角色名称（admin 包含组长和管理员）
    const defaultRoleNames = {
      admin: { zh: '管理员', en: 'Admin' },
      member: { zh: '成员', en: 'Member' },
    }

    // 合并用户提供的角色名称
    const finalRoleNames = role_names
      ? {
          admin: { ...defaultRoleNames.admin, ...role_names.admin },
          member: { ...defaultRoleNames.member, ...role_names.member },
        }
      : defaultRoleNames

    // 创建 pending 申请 —— 真审核流：仅提交申请，不建群。
    // 建群 + 加组长成员的逻辑已搬到 approve/route.ts，由管理员批准时才执行。
    const { data: application, error: insertError } = await supabase
      .from('group_applications')
      .insert({
        applicant_id: user.id,
        name: name.trim(),
        name_en: name_en?.trim() || null,
        description: description?.trim() || null,
        description_en: description_en?.trim() || null,
        avatar_url: avatar_url || null,
        role_names: finalRoleNames,
        rules_json: rules_json || null,
        rules: rules?.trim() || null,
        is_premium_only: is_premium_only || false,
        status: 'pending',
      })
      .select()
      .single()

    if (insertError) {
      logger.dbError('create-group-application', insertError, { userId: user.id, groupName: name })
      return NextResponse.json({ error: 'Failed to submit application' }, { status: 500 })
    }

    return NextResponse.json({
      success: true,
      message: 'Application submitted, awaiting admin review',
      application,
    })
  },
  { name: 'groups-apply-post', rateLimit: 'write' }
)

// 获取当前用户的申请列表
export const GET = withAuth(
  async ({ user, supabase }) => {
    const guard = socialFeatureGuard()
    if (guard) return guard

    // 获取用户的所有申请（含 group_id：批准后前往小组的链接）
    const { data: applications, error } = await supabase
      .from('group_applications')
      .select(
        'id, applicant_id, name, name_en, description, description_en, avatar_url, role_names, rules_json, rules, is_premium_only, status, reject_reason, group_id, reviewed_at, reviewed_by, created_at'
      )
      .eq('applicant_id', user.id)
      .order('created_at', { ascending: false })

    if (error) {
      logger.dbError('fetch-group-applications', error, { userId: user.id })
      return NextResponse.json({ error: 'Failed to fetch application list' }, { status: 500 })
    }

    return NextResponse.json({ applications })
  },
  { name: 'groups-apply-get', rateLimit: 'read' }
)
