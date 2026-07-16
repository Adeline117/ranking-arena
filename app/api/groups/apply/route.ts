import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withAuth } from '@/lib/api/middleware'
import { logger } from '@/lib/logger'
import { socialFeatureGuard } from '@/lib/features'
import { PRO_FREE_PROMO } from '@/lib/types/premium'

const normalizedText = (maximum: number, minimum = 0, trim = true) =>
  z
    .string()
    .transform((value) => (trim ? value.trim() : value).normalize('NFC'))
    .refine((value) => Array.from(value).length >= minimum && Array.from(value).length <= maximum)

const localizedRoleNameSchema = z
  .object({
    zh: normalizedText(50).optional(),
    en: normalizedText(50).optional(),
  })
  .strict()

const groupApplicationInputSchema = z
  .object({
    operation_id: z.string().uuid(),
    name: normalizedText(50, 1),
    name_en: normalizedText(50).nullable().optional(),
    description: normalizedText(500).nullable().optional(),
    description_en: normalizedText(500).nullable().optional(),
    avatar_url: normalizedText(2048).nullable().optional(),
    role_names: z
      .object({
        admin: localizedRoleNameSchema.optional(),
        member: localizedRoleNameSchema.optional(),
      })
      .strict()
      .nullable()
      .optional(),
    rules_json: z
      .array(
        z
          .object({
            zh: normalizedText(2000, 0, false),
            en: normalizedText(2000, 0, false),
          })
          .strict()
      )
      .max(100)
      .nullable()
      .optional(),
    rules: normalizedText(10000).nullable().optional(),
    is_premium_only: z.boolean().optional().default(false),
  })
  .strict()

const submitGroupApplicationResultSchema = z.discriminatedUnion('status', [
  z
    .object({
      status: z.literal('submitted'),
      application_id: z.string().uuid(),
      created_at: z.string().datetime({ offset: true }),
      operation_id: z.string().uuid(),
      applied: z.boolean(),
    })
    .strict(),
  ...(
    [
      'invalid',
      'account_inactive',
      'pro_required',
      'pending_exists',
      'name_taken',
      'operation_conflict',
    ] as const
  ).map((status) => z.object({ status: z.literal(status) }).strict()),
])

type SubmitGroupApplicationResult = z.infer<typeof submitGroupApplicationResultSchema>

const defaultRoleNames = {
  admin: { zh: '管理员', en: 'Admin' },
  member: { zh: '成员', en: 'Member' },
}

function emptyToNull(value: string | null | undefined): string | null {
  return value || null
}

function submitFailureResponse(result: SubmitGroupApplicationResult): NextResponse {
  switch (result.status) {
    case 'invalid':
      return NextResponse.json({ error: 'Invalid group application' }, { status: 400 })
    case 'account_inactive':
      return NextResponse.json({ error: 'Your account is not active' }, { status: 403 })
    case 'pro_required':
      return NextResponse.json(
        { error: 'Only Pro members can create exclusive groups' },
        { status: 403 }
      )
    case 'pending_exists':
      return NextResponse.json(
        { error: 'You already have a pending group application' },
        { status: 409 }
      )
    case 'name_taken':
      return NextResponse.json({ error: 'This group name is already taken' }, { status: 409 })
    case 'operation_conflict':
      return NextResponse.json(
        { error: 'Operation id conflicts with another request' },
        { status: 409 }
      )
    default:
      return NextResponse.json({ error: 'Failed to submit application' }, { status: 500 })
  }
}

export const POST = withAuth(
  async ({ user, supabase, request }) => {
    const guard = socialFeatureGuard()
    if (guard) return guard

    let rawBody: unknown
    try {
      rawBody = await request.json()
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }

    const parsedBody = groupApplicationInputSchema.safeParse(rawBody)
    if (!parsedBody.success) {
      return NextResponse.json({ error: 'Invalid group application' }, { status: 400 })
    }

    const input = parsedBody.data
    const normalizedName = input.name.normalize('NFC')
    const finalRoleNames = input.role_names
      ? {
          admin: { ...defaultRoleNames.admin, ...input.role_names.admin },
          member: { ...defaultRoleNames.member, ...input.role_names.member },
        }
      : defaultRoleNames

    const { data, error } = await supabase.rpc('submit_group_application_atomic', {
      p_actor_id: user.id,
      p_name: normalizedName,
      p_name_en: emptyToNull(input.name_en),
      p_description: emptyToNull(input.description),
      p_description_en: emptyToNull(input.description_en),
      p_avatar_url: emptyToNull(input.avatar_url),
      p_role_names: finalRoleNames,
      p_rules_json: input.rules_json ?? null,
      p_rules: emptyToNull(input.rules),
      p_is_premium_only: input.is_premium_only,
      p_promo_unlocked: PRO_FREE_PROMO,
      p_operation_id: input.operation_id,
    })

    if (error) {
      logger.dbError('submit-group-application-atomic', error, {
        userId: user.id,
        groupName: normalizedName,
      })
      return NextResponse.json({ error: 'Failed to submit application' }, { status: 500 })
    }

    const parsedResult = submitGroupApplicationResultSchema.safeParse(data)
    if (!parsedResult.success) {
      logger.error('Atomic group application submission returned an invalid result', {
        userId: user.id,
        groupName: normalizedName,
      })
      return NextResponse.json({ error: 'Failed to submit application' }, { status: 500 })
    }

    const result = parsedResult.data
    if (result.status !== 'submitted') return submitFailureResponse(result)
    if (result.operation_id !== input.operation_id) {
      logger.error('Atomic group application submission returned the wrong operation id', {
        userId: user.id,
        groupName: normalizedName,
      })
      return NextResponse.json({ error: 'Failed to submit application' }, { status: 500 })
    }

    return NextResponse.json({
      success: true,
      message: 'Application submitted, awaiting admin review',
      operation_id: result.operation_id,
      application: {
        id: result.application_id,
        applicant_id: user.id,
        name: normalizedName,
        name_en: emptyToNull(input.name_en),
        description: emptyToNull(input.description),
        description_en: emptyToNull(input.description_en),
        avatar_url: emptyToNull(input.avatar_url),
        role_names: finalRoleNames,
        rules_json: input.rules_json ?? null,
        rules: emptyToNull(input.rules),
        is_premium_only: input.is_premium_only,
        status: 'pending',
        created_at: result.created_at,
      },
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
      .select('id, name, status, reject_reason, group_id, created_at')
      .eq('applicant_id', user.id)
      .order('created_at', { ascending: false })

    if (error) {
      logger.dbError('fetch-group-applications', error, { userId: user.id })
      return NextResponse.json({ error: 'Failed to fetch application list' }, { status: 500 })
    }

    const safeApplications = (applications || []).map((application) => ({
      id: application.id,
      name: application.name,
      status: application.status,
      reject_reason: application.reject_reason,
      group_id: application.group_id,
      created_at: application.created_at,
    }))

    return NextResponse.json({ applications: safeApplications })
  },
  { name: 'groups-apply-get', rateLimit: 'read' }
)
