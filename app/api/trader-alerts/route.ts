/**
 * Trader movement alert configuration API.
 *
 * Reads remain private and Pro-gated. Writes cross authenticated atomic RPCs
 * so exact trader/source identity, the 50-row cap, and mutation acknowledgement
 * are decided in one database transaction.
 */

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withAuth } from '@/lib/api/middleware'
import { createLogger } from '@/lib/utils/logger'
import { hasCurrentGlobalProEntitlement } from '@/lib/premium/server-entitlement'
import { createUserScopedServerClient } from '@/lib/supabase/user-scoped-server'

export const runtime = 'nodejs'

const logger = createLogger('trader-alerts')
const ALERT_LIMIT = 50
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/

const TraderIdSchema = z
  .string()
  .trim()
  .min(1, 'trader_id is required')
  .max(512)
  .refine((value) => !CONTROL_CHARACTER_PATTERN.test(value))
const SourceSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .refine((value) => !CONTROL_CHARACTER_PATTERN.test(value))

const TraderAlertSchema = z
  .object({
    id: z.string().regex(UUID_PATTERN).optional(),
    trader_id: TraderIdSchema,
    source: SourceSchema.optional().nullable(),
    alert_roi_change: z.boolean().optional().default(true),
    roi_change_threshold: z.number().finite().min(0).max(100).optional().default(10),
    alert_drawdown: z.boolean().optional().default(true),
    drawdown_threshold: z.number().finite().min(0).max(100).optional().default(20),
    alert_pnl_change: z.boolean().optional().default(false),
    pnl_change_threshold: z
      .number()
      .finite()
      .min(0)
      .max(1_000_000_000_000_000)
      .optional()
      .default(5000),
    alert_score_change: z.boolean().optional().default(true),
    score_change_threshold: z.number().finite().min(0).max(100).optional().default(5),
    alert_rank_change: z.boolean().optional().default(false),
    rank_change_threshold: z.number().int().min(0).max(1_000_000).optional().default(5),
    one_time: z.boolean().optional().default(false),
    enabled: z.boolean().optional().default(true),
  })
  .strict()

type TraderAlertInput = z.infer<typeof TraderAlertSchema>

const STORED_ALERT_KEYS = [
  'id',
  'trader_id',
  'source',
  'alert_roi_change',
  'roi_change_threshold',
  'alert_drawdown',
  'drawdown_threshold',
  'alert_pnl_change',
  'pnl_change_threshold',
  'alert_score_change',
  'score_change_threshold',
  'alert_rank_change',
  'rank_change_threshold',
  'one_time',
  'enabled',
  'created_at',
] as const

const RPC_ALERT_KEYS = [...STORED_ALERT_KEYS, 'user_id', 'updated_at'] as const

type TraderAlertRecord = {
  id: string
  user_id?: string
  trader_id: string
  source: string | null
  alert_roi_change: boolean
  roi_change_threshold: number
  alert_drawdown: boolean
  drawdown_threshold: number
  alert_pnl_change: boolean
  pnl_change_threshold: number
  alert_score_change: boolean
  score_change_threshold: number
  alert_rank_change: boolean
  rank_change_threshold: number
  one_time: boolean
  enabled: boolean
  created_at: string
  updated_at?: string
}

type UpsertAck =
  | { status: 'invalid' }
  | { status: 'account_inactive' }
  | { status: 'forbidden' }
  | { status: 'conflict' }
  | { status: 'limit_reached'; currentCount: number; limit: number }
  | {
      status: 'created' | 'updated'
      userId: string
      currentCount: number
      limit: number
      alert: TraderAlertRecord & { user_id: string; updated_at: string }
    }

type DeleteAck =
  | { status: 'invalid' }
  | { status: 'account_inactive' }
  | {
      status: 'deleted' | 'not_found'
      userId: string
      alertId: string | null
      traderId: string | null
      source: string | null
      deletedCount: 0 | 1
      currentCount: number
      limit: number
    }

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value)
  return actual.length === expected.length && expected.every((key) => actual.includes(key))
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value)
}

function isSource(value: unknown): value is string | null {
  return (
    value === null ||
    (typeof value === 'string' &&
      value.length >= 1 &&
      value.length <= 64 &&
      value === value.trim() &&
      !CONTROL_CHARACTER_PATTERN.test(value))
  )
}

function isTraderId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length >= 1 &&
    value.length <= 512 &&
    value === value.trim() &&
    !CONTROL_CHARACTER_PATTERN.test(value)
  )
}

function isDate(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value))
}

function isNumberInRange(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max
}

function booleanOrNull(value: unknown): value is boolean | null {
  return value === null || typeof value === 'boolean'
}

function numberOrNullInRange(value: unknown, min: number, max: number): value is number | null {
  return value === null || isNumberInRange(value, min, max)
}

function parseStoredAlert(value: unknown): TraderAlertRecord | null {
  if (!isRecord(value) || !hasExactKeys(value, STORED_ALERT_KEYS)) return null
  if (
    !isUuid(value.id) ||
    !isTraderId(value.trader_id) ||
    !isSource(value.source) ||
    !booleanOrNull(value.alert_roi_change) ||
    !numberOrNullInRange(value.roi_change_threshold, 0, 100) ||
    !booleanOrNull(value.alert_drawdown) ||
    !numberOrNullInRange(value.drawdown_threshold, 0, 100) ||
    !booleanOrNull(value.alert_pnl_change) ||
    !numberOrNullInRange(value.pnl_change_threshold, 0, 1_000_000_000_000_000) ||
    !booleanOrNull(value.alert_score_change) ||
    !numberOrNullInRange(value.score_change_threshold, 0, 100) ||
    !booleanOrNull(value.alert_rank_change) ||
    !numberOrNullInRange(value.rank_change_threshold, 0, 1_000_000) ||
    (value.rank_change_threshold !== null && !Number.isSafeInteger(value.rank_change_threshold)) ||
    !booleanOrNull(value.one_time) ||
    typeof value.enabled !== 'boolean' ||
    !isDate(value.created_at)
  ) {
    return null
  }

  return {
    id: value.id,
    trader_id: value.trader_id,
    source: value.source,
    alert_roi_change: value.alert_roi_change ?? true,
    roi_change_threshold: value.roi_change_threshold ?? 10,
    alert_drawdown: value.alert_drawdown ?? true,
    drawdown_threshold: value.drawdown_threshold ?? 20,
    alert_pnl_change: value.alert_pnl_change ?? false,
    pnl_change_threshold: value.pnl_change_threshold ?? 5000,
    alert_score_change: value.alert_score_change ?? true,
    score_change_threshold: value.score_change_threshold ?? 5,
    alert_rank_change: value.alert_rank_change ?? false,
    rank_change_threshold: value.rank_change_threshold ?? 5,
    one_time: value.one_time ?? false,
    enabled: value.enabled,
    created_at: value.created_at,
  }
}

function parseRpcAlert(value: unknown):
  | (TraderAlertRecord & {
      user_id: string
      updated_at: string
    })
  | null {
  if (!isRecord(value) || !hasExactKeys(value, RPC_ALERT_KEYS)) return null
  const storedProjection: Record<string, unknown> = {}
  for (const key of STORED_ALERT_KEYS) storedProjection[key] = value[key]
  const alert = parseStoredAlert(storedProjection)
  if (
    !alert ||
    !isUuid(value.user_id) ||
    !isDate(value.updated_at) ||
    Object.values({
      alert_roi_change: value.alert_roi_change,
      alert_drawdown: value.alert_drawdown,
      alert_pnl_change: value.alert_pnl_change,
      alert_score_change: value.alert_score_change,
      alert_rank_change: value.alert_rank_change,
      one_time: value.one_time,
      enabled: value.enabled,
    }).some((field) => typeof field !== 'boolean') ||
    !isNumberInRange(value.roi_change_threshold, 0, 100) ||
    !isNumberInRange(value.drawdown_threshold, 0, 100) ||
    !isNumberInRange(value.pnl_change_threshold, 0, 1_000_000_000_000_000) ||
    !isNumberInRange(value.score_change_threshold, 0, 100) ||
    !Number.isSafeInteger(value.rank_change_threshold) ||
    Number(value.rank_change_threshold) < 0 ||
    Number(value.rank_change_threshold) > 1_000_000
  ) {
    return null
  }
  return { ...alert, user_id: value.user_id, updated_at: value.updated_at }
}

function parseUpsertAck(value: unknown): UpsertAck | null {
  if (!isRecord(value)) return null
  if (
    hasExactKeys(value, ['status']) &&
    (value.status === 'invalid' ||
      value.status === 'account_inactive' ||
      value.status === 'forbidden' ||
      value.status === 'conflict')
  ) {
    return { status: value.status }
  }
  if (
    hasExactKeys(value, ['status', 'current_count', 'limit']) &&
    value.status === 'limit_reached' &&
    Number.isSafeInteger(value.current_count) &&
    Number(value.current_count) >= ALERT_LIMIT &&
    value.limit === ALERT_LIMIT
  ) {
    return {
      status: 'limit_reached',
      currentCount: Number(value.current_count),
      limit: ALERT_LIMIT,
    }
  }
  if (
    !hasExactKeys(value, ['status', 'user_id', 'current_count', 'limit', 'alert']) ||
    (value.status !== 'created' && value.status !== 'updated') ||
    !isUuid(value.user_id) ||
    !Number.isSafeInteger(value.current_count) ||
    Number(value.current_count) < 1 ||
    Number(value.current_count) > ALERT_LIMIT ||
    value.limit !== ALERT_LIMIT
  ) {
    return null
  }
  const alert = parseRpcAlert(value.alert)
  if (!alert) return null
  return {
    status: value.status,
    userId: value.user_id,
    currentCount: Number(value.current_count),
    limit: ALERT_LIMIT,
    alert,
  }
}

function alertMatchesInput(alert: TraderAlertRecord, input: TraderAlertInput): boolean {
  return (
    alert.trader_id === input.trader_id &&
    alert.source === (input.source ?? null) &&
    alert.alert_roi_change === input.alert_roi_change &&
    alert.roi_change_threshold === input.roi_change_threshold &&
    alert.alert_drawdown === input.alert_drawdown &&
    alert.drawdown_threshold === input.drawdown_threshold &&
    alert.alert_pnl_change === input.alert_pnl_change &&
    alert.pnl_change_threshold === input.pnl_change_threshold &&
    alert.alert_score_change === input.alert_score_change &&
    alert.score_change_threshold === input.score_change_threshold &&
    alert.alert_rank_change === input.alert_rank_change &&
    alert.rank_change_threshold === input.rank_change_threshold &&
    alert.one_time === input.one_time &&
    alert.enabled === input.enabled
  )
}

function parseDeleteAck(value: unknown): DeleteAck | null {
  if (!isRecord(value)) return null
  if (
    hasExactKeys(value, ['status']) &&
    (value.status === 'invalid' || value.status === 'account_inactive')
  ) {
    return { status: value.status }
  }
  if (
    !hasExactKeys(value, [
      'status',
      'user_id',
      'alert_id',
      'trader_id',
      'source',
      'deleted_count',
      'current_count',
      'limit',
    ]) ||
    (value.status !== 'deleted' && value.status !== 'not_found') ||
    !isUuid(value.user_id) ||
    (value.alert_id !== null && !isUuid(value.alert_id)) ||
    (value.trader_id !== null && !isTraderId(value.trader_id)) ||
    !isSource(value.source) ||
    (value.deleted_count !== 0 && value.deleted_count !== 1) ||
    !Number.isSafeInteger(value.current_count) ||
    Number(value.current_count) < 0 ||
    Number(value.current_count) > ALERT_LIMIT ||
    value.limit !== ALERT_LIMIT ||
    (value.status === 'deleted' && value.deleted_count !== 1) ||
    (value.status === 'not_found' && value.deleted_count !== 0)
  ) {
    return null
  }
  return {
    status: value.status,
    userId: value.user_id,
    alertId: value.alert_id,
    traderId: value.trader_id,
    source: value.source,
    deletedCount: value.deleted_count,
    currentCount: Number(value.current_count),
    limit: ALERT_LIMIT,
  }
}

function isAuthorityUnavailable(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false
  return (
    ['PGRST202', 'PGRST205', '42883', '42P01'].includes(error.code ?? '') ||
    Boolean(error.message?.includes('Could not find the function')) ||
    Boolean(error.message?.includes('Could not find the table'))
  )
}

function errorResponse(message: string, status: number): NextResponse {
  return NextResponse.json(
    { success: false, error: message },
    { status, headers: { 'Cache-Control': 'private, no-store' } }
  )
}

function authorityUnavailable(): NextResponse {
  return errorResponse('Trader alerts are temporarily unavailable', 503)
}

function internalError(): NextResponse {
  return errorResponse('Internal server error', 500)
}

async function requireCurrentPro(
  supabase: Parameters<typeof hasCurrentGlobalProEntitlement>[0],
  userId: string
): Promise<NextResponse | null> {
  try {
    if (!(await hasCurrentGlobalProEntitlement(supabase, userId))) {
      return errorResponse('Pro membership required', 403)
    }
    return null
  } catch (error) {
    logger.error('Unable to verify trader-alert entitlement', { error, userId })
    return authorityUnavailable()
  }
}

/** GET - list one exact trader/source configuration or all owned configs. */
export const GET = withAuth(
  async ({ user, supabase, request }) => {
    const entitlementError = await requireCurrentPro(supabase, user.id)
    if (entitlementError) return entitlementError

    const { searchParams } = new URL(request.url)
    const rawTraderId = searchParams.get('trader_id')
    const hasSource = searchParams.has('source')
    const rawSource = searchParams.get('source')
    if (!rawTraderId && hasSource) return errorResponse('trader_id is required with source', 400)

    let traderId: string | null = null
    let source: string | null = null
    if (rawTraderId !== null) {
      const parsedTraderId = TraderIdSchema.safeParse(rawTraderId)
      if (!parsedTraderId.success) return errorResponse('Invalid trader_id', 400)
      traderId = parsedTraderId.data
      if (hasSource) {
        const parsedSource = SourceSchema.safeParse(rawSource)
        if (!parsedSource.success) return errorResponse('Invalid source', 400)
        source = parsedSource.data
      }
    }

    let query = supabase
      .from('trader_alerts')
      .select(STORED_ALERT_KEYS.join(', '))
      .eq('user_id', user.id)
      .order('created_at', { ascending: false })
      .limit(ALERT_LIMIT)

    if (traderId) {
      query = query.eq('trader_id', traderId)
      query = source ? query.eq('source', source) : query.is('source', null)
    }

    const { data, error } = await query
    if (error) {
      logger.error('Trader-alert query failed', { error, userId: user.id })
      return authorityUnavailable()
    }
    if (!Array.isArray(data)) {
      logger.error('Trader-alert query returned an invalid list', { userId: user.id })
      return authorityUnavailable()
    }

    const alerts = data.map(parseStoredAlert)
    if (alerts.some((alert) => alert === null)) {
      logger.error('Trader-alert query returned an invalid row', { userId: user.id })
      return authorityUnavailable()
    }
    return { alerts }
  },
  { name: 'get-trader-alerts', rateLimit: 'authenticated' }
)

/** POST - atomically create or update one exact trader/source configuration. */
export const POST = withAuth(
  async ({ user, request }) => {
    let body: unknown
    try {
      body = await request.json()
    } catch {
      return errorResponse('Invalid JSON body', 400)
    }
    const parsed = TraderAlertSchema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json(
        { success: false, error: 'Invalid input', details: parsed.error.flatten() },
        { status: 400, headers: { 'Cache-Control': 'private, no-store' } }
      )
    }
    const config = parsed.data
    const expectedSource = config.source ?? null

    let rpcResult
    try {
      const userSupabase = createUserScopedServerClient(request)
      rpcResult = await userSupabase.rpc('upsert_trader_alert_atomic', {
        p_trader_id: config.trader_id,
        p_source: expectedSource,
        p_expected_alert_id: config.id ?? null,
        p_alert_roi_change: config.alert_roi_change,
        p_roi_change_threshold: config.roi_change_threshold,
        p_alert_drawdown: config.alert_drawdown,
        p_drawdown_threshold: config.drawdown_threshold,
        p_alert_pnl_change: config.alert_pnl_change,
        p_pnl_change_threshold: config.pnl_change_threshold,
        p_alert_score_change: config.alert_score_change,
        p_score_change_threshold: config.score_change_threshold,
        p_alert_rank_change: config.alert_rank_change,
        p_rank_change_threshold: config.rank_change_threshold,
        p_one_time: config.one_time,
        p_enabled: config.enabled,
      })
    } catch (error) {
      logger.error('Trader-alert RPC request failed', { error, userId: user.id })
      return authorityUnavailable()
    }

    if (rpcResult.error) {
      if (isAuthorityUnavailable(rpcResult.error)) return authorityUnavailable()
      logger.error('Atomic trader-alert upsert failed', {
        error: rpcResult.error,
        userId: user.id,
      })
      return internalError()
    }

    const ack = parseUpsertAck(rpcResult.data)
    if (!ack) {
      logger.error('Atomic trader-alert upsert returned an invalid acknowledgement', {
        userId: user.id,
      })
      return internalError()
    }
    if (ack.status === 'forbidden' || ack.status === 'account_inactive') {
      return errorResponse('Pro membership required', 403)
    }
    if (ack.status === 'conflict') {
      return errorResponse('Alert configuration changed. Reload and retry.', 409)
    }
    if (ack.status === 'invalid') {
      logger.error('Atomic trader-alert policy rejected validated input', { userId: user.id })
      return internalError()
    }
    if (ack.status === 'limit_reached') {
      return errorResponse('Maximum 50 alerts. Delete some first.', 400)
    }
    if (
      ack.userId !== user.id ||
      ack.alert.user_id !== user.id ||
      !alertMatchesInput(ack.alert, config) ||
      (config.id !== undefined && ack.alert.id !== config.id)
    ) {
      logger.error('Atomic trader-alert upsert acknowledgement changed identity', {
        status: ack.status,
        userId: user.id,
      })
      return internalError()
    }

    return { alert: ack.alert, created: ack.status === 'created' }
  },
  { name: 'post-trader-alerts', rateLimit: 'authenticated' }
)

/** DELETE - delete by one owned UUID or one exact trader+source identity. */
export const DELETE = withAuth(
  async ({ user, request }) => {
    const { searchParams } = new URL(request.url)
    const rawAlertId = searchParams.get('id')
    const rawTraderId = searchParams.get('trader_id')
    const rawSource = searchParams.get('source')
    const hasAlertId = searchParams.has('id')
    const hasTraderId = searchParams.has('trader_id')

    if (hasAlertId === hasTraderId || (hasAlertId && rawSource !== null)) {
      return errorResponse('Provide exactly one alert id or trader identity', 400)
    }

    let alertId: string | null = null
    let traderId: string | null = null
    let source: string | null = null
    if (hasAlertId) {
      if (!isUuid(rawAlertId)) return errorResponse('Invalid alert id', 400)
      alertId = rawAlertId
    } else if (hasTraderId) {
      const parsedTraderId = TraderIdSchema.safeParse(rawTraderId)
      if (!parsedTraderId.success) return errorResponse('Invalid trader_id', 400)
      traderId = parsedTraderId.data
      if (rawSource !== null) {
        const parsedSource = SourceSchema.safeParse(rawSource)
        if (!parsedSource.success) return errorResponse('Invalid source', 400)
        source = parsedSource.data
      }
    }

    let rpcResult
    try {
      const userSupabase = createUserScopedServerClient(request)
      rpcResult = await userSupabase.rpc('delete_trader_alert_atomic', {
        p_alert_id: alertId,
        p_trader_id: traderId,
        p_source: source,
      })
    } catch (error) {
      logger.error('Trader-alert delete RPC request failed', { error, userId: user.id })
      return authorityUnavailable()
    }

    if (rpcResult.error) {
      if (isAuthorityUnavailable(rpcResult.error)) return authorityUnavailable()
      logger.error('Atomic trader-alert delete failed', {
        error: rpcResult.error,
        userId: user.id,
      })
      return internalError()
    }

    const ack = parseDeleteAck(rpcResult.data)
    if (!ack) {
      logger.error('Atomic trader-alert delete returned an invalid acknowledgement', {
        userId: user.id,
      })
      return internalError()
    }
    if (ack.status === 'account_inactive') return errorResponse('Account is inactive', 403)
    if (ack.status === 'invalid') {
      logger.error('Atomic trader-alert delete rejected validated input', { userId: user.id })
      return internalError()
    }

    const identityMatches = alertId
      ? ack.alertId === alertId &&
        (ack.status === 'deleted' || (ack.traderId === null && ack.source === null))
      : ack.traderId === traderId && ack.source === source
    if (ack.userId !== user.id || !identityMatches) {
      logger.error('Atomic trader-alert delete acknowledgement changed identity', {
        status: ack.status,
        userId: user.id,
      })
      return internalError()
    }
    if (ack.status === 'not_found') return errorResponse('Alert not found', 404)

    return {
      deleted: true,
      id: ack.alertId,
      trader_id: ack.traderId,
      source: ack.source,
    }
  },
  { name: 'delete-trader-alerts', rateLimit: 'authenticated' }
)
