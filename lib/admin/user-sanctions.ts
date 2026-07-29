import type { SupabaseClient } from '@supabase/supabase-js'

export type AdminUserSanctionAction = 'ban' | 'unban'
export type AdminUserSanctionStatus =
  | 'applied'
  | 'already_banned'
  | 'not_banned'
  | 'not_found'
  | 'target_deleted'

export type AdminUserSanctionResult = {
  applied: boolean
  result_action: AdminUserSanctionAction
  status: AdminUserSanctionStatus
  result_target_id: string
  target_handle: string | null
}

export type AdminUserSanctionFailure = 'forbidden' | 'validation' | 'conflict' | 'database'

export class AdminUserSanctionError extends Error {
  constructor(
    public readonly kind: AdminUserSanctionFailure,
    public readonly databaseCode?: string
  ) {
    super(`Administrator user sanction failed: ${kind}`)
    this.name = 'AdminUserSanctionError'
  }
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const RESULT_KEYS = [
  'applied',
  'result_action',
  'result_target_id',
  'status',
  'target_handle',
] as const

function fail(kind: AdminUserSanctionFailure, databaseCode?: string): never {
  throw new AdminUserSanctionError(kind, databaseCode)
}

function parseResult(
  value: unknown,
  expected: { action: AdminUserSanctionAction; targetId: string }
): AdminUserSanctionResult | null {
  if (!Array.isArray(value) || value.length !== 1) return null
  const row = value[0]
  if (!row || typeof row !== 'object' || Array.isArray(row)) return null

  const candidate = row as Record<string, unknown>
  const keys = Object.keys(candidate).sort()
  const validStatus = [
    'applied',
    'already_banned',
    'not_banned',
    'not_found',
    'target_deleted',
  ].includes(candidate.status as string)

  if (
    keys.length !== RESULT_KEYS.length ||
    !RESULT_KEYS.every((key, index) => keys[index] === key) ||
    typeof candidate.applied !== 'boolean' ||
    candidate.result_action !== expected.action ||
    candidate.result_target_id !== expected.targetId ||
    !validStatus ||
    (candidate.target_handle !== null && typeof candidate.target_handle !== 'string')
  ) {
    return null
  }

  if (
    (candidate.applied && candidate.status !== 'applied') ||
    (!candidate.applied && candidate.status === 'applied') ||
    (candidate.status === 'not_found'
      ? candidate.target_handle !== null
      : typeof candidate.target_handle !== 'string')
  ) {
    return null
  }

  return candidate as AdminUserSanctionResult
}

export async function setAdminUserSanctionAtomic(
  supabase: SupabaseClient,
  input: {
    actorId: string
    targetId: string
    action: AdminUserSanctionAction
    reason?: string | null
  }
): Promise<AdminUserSanctionResult> {
  if (
    !UUID_PATTERN.test(input.actorId) ||
    !UUID_PATTERN.test(input.targetId) ||
    !['ban', 'unban'].includes(input.action) ||
    (input.reason !== null && input.reason !== undefined && typeof input.reason !== 'string') ||
    (typeof input.reason === 'string' && input.reason.trim().length > 1000)
  ) {
    fail('validation')
  }

  const expected = {
    action: input.action,
    targetId: input.targetId.toLowerCase(),
  }
  const { data, error } = await supabase.rpc('set_admin_user_sanction_atomic', {
    p_actor_id: input.actorId.toLowerCase(),
    p_target_id: expected.targetId,
    p_action: expected.action,
    p_reason: typeof input.reason === 'string' ? input.reason : null,
  })

  if (error) {
    if (error.code === '42501') fail('forbidden', error.code)
    if (error.code === '22023') fail('validation', error.code)
    if (error.code === '40001' || error.code === '40P01' || error.code === '55P03') {
      fail('conflict', error.code)
    }
    fail('database', error.code)
  }

  const result = parseResult(data, expected)
  if (!result) fail('database')
  return result
}
