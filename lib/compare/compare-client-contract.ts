import { z } from 'zod'
import { buildCompareApiUrl, compareAccountKey, type CompareAccountRef } from './identity'

export const COMPARE_REQUEST_TIMEOUT_MS = 15_000
export const FOLLOWING_REQUEST_TIMEOUT_MS = 15_000

const AccountSchema = z
  .object({
    id: z.string().min(1),
    source: z.string().min(1),
  })
  .strict()

const OptionalMetric = z.number().finite().optional()

const TraderCompareSchema = AccountSchema.extend({
  handle: z.string().min(1).nullable(),
  roi: z.number().finite(),
  roi_7d: OptionalMetric,
  roi_30d: OptionalMetric,
  pnl: OptionalMetric,
  max_drawdown: OptionalMetric,
  win_rate: OptionalMetric,
  trades_count: z.number().int().nonnegative().optional(),
  arena_score: OptionalMetric,
  return_score: OptionalMetric,
  drawdown_score: OptionalMetric,
  stability_score: OptionalMetric,
  profitability_score: OptionalMetric,
  risk_control_score: OptionalMetric,
  execution_score: OptionalMetric,
  avatar_url: z.string().min(1).optional(),
  followers: z.number().int().nonnegative().optional(),
  equity_curve: z
    .array(
      z
        .object({
          date: z.string().min(1),
          roi: z.number().finite(),
        })
        .strict()
    )
    .optional(),
}).strict()

const CompareDataSchema = z
  .object({
    traders: z.array(TraderCompareSchema).max(10),
    missingAccounts: z.array(AccountSchema).max(10),
    requestedIds: z.array(z.string().min(1)).max(10),
    requestedPlatforms: z.array(z.string().min(1)).max(10),
    requestedAccounts: z.array(AccountSchema).max(10),
    foundCount: z.number().int().nonnegative().max(10),
  })
  .strict()

const CompareEnvelopeSchema = z
  .object({
    success: z.literal(true),
    data: CompareDataSchema,
    meta: z.object({ timestamp: z.string().datetime() }).strict(),
  })
  .strict()

const FollowingItemSchema = z
  .object({
    id: z.string().min(1),
    identity_key: z.string().min(1),
    handle: z.string().min(1),
    type: z.enum(['trader', 'user']),
    avatar_url: z.string().min(1).optional(),
    bio: z.string().optional(),
    roi: OptionalMetric,
    roi_7d: OptionalMetric,
    roi_30d: OptionalMetric,
    pnl: OptionalMetric,
    win_rate: OptionalMetric,
    followers: z.number().int().nonnegative().optional(),
    source: z.string().min(1).nullable().optional(),
    platform: z.string().min(1).optional(),
    arena_score: OptionalMetric,
    followed_at: z.string().datetime().optional(),
  })
  .strict()

const FollowingResponseSchema = z
  .object({
    items: z.array(FollowingItemSchema),
    count: z.number().int().nonnegative(),
    traderCount: z.number().int().nonnegative(),
    userCount: z.number().int().nonnegative(),
  })
  .strict()

export type TraderCompareData = z.infer<typeof TraderCompareSchema>
export type FollowingItem = z.infer<typeof FollowingItemSchema>

export interface CompareLoadResult {
  traders: TraderCompareData[]
  missingAccounts: CompareAccountRef[]
}

export class CompareClientRequestError extends Error {
  readonly status: number | null

  constructor(message: string, status: number | null = null, options?: ErrorOptions) {
    super(message, options)
    this.name = 'CompareClientRequestError'
    this.status = status
  }
}

function sameAccounts(left: readonly CompareAccountRef[], right: readonly CompareAccountRef[]) {
  return (
    left.length === right.length &&
    left.every((account, index) => compareAccountKey(account) === compareAccountKey(right[index]))
  )
}

export function readCompareResponse(
  value: unknown,
  expectedAccounts: readonly CompareAccountRef[]
): CompareLoadResult | null {
  const parsed = CompareEnvelopeSchema.safeParse(value)
  if (!parsed.success) return null

  const data = parsed.data.data
  if (
    data.foundCount !== data.traders.length ||
    data.requestedIds.length !== expectedAccounts.length ||
    data.requestedPlatforms.length !== expectedAccounts.length ||
    !sameAccounts(data.requestedAccounts, expectedAccounts) ||
    !data.requestedIds.every((id, index) => id === expectedAccounts[index]?.id) ||
    !data.requestedPlatforms.every(
      (platform, index) => platform === expectedAccounts[index]?.source
    )
  ) {
    return null
  }

  const missingKeys = new Set(data.missingAccounts.map(compareAccountKey))
  const traderKeys = new Set(data.traders.map(compareAccountKey))
  if (
    missingKeys.size !== data.missingAccounts.length ||
    traderKeys.size !== data.traders.length ||
    data.traders.some((trader) => missingKeys.has(compareAccountKey(trader)))
  ) {
    return null
  }

  const expectedMissing = expectedAccounts.filter((account) =>
    missingKeys.has(compareAccountKey(account))
  )
  const expectedTraders = expectedAccounts.filter(
    (account) => !missingKeys.has(compareAccountKey(account))
  )
  if (
    !sameAccounts(data.missingAccounts, expectedMissing) ||
    !sameAccounts(data.traders, expectedTraders) ||
    data.foundCount + data.missingAccounts.length !== expectedAccounts.length
  ) {
    return null
  }

  return { traders: data.traders, missingAccounts: data.missingAccounts }
}

export function readFollowingResponse(value: unknown): FollowingItem[] | null {
  const parsed = FollowingResponseSchema.safeParse(value)
  if (!parsed.success) return null

  const { items, count, traderCount, userCount } = parsed.data
  if (
    count !== items.length ||
    traderCount !== items.filter((item) => item.type === 'trader').length ||
    userCount !== items.filter((item) => item.type === 'user').length ||
    traderCount + userCount !== count ||
    new Set(items.map((item) => item.identity_key)).size !== items.length
  ) {
    return null
  }

  for (const item of items) {
    if (item.type === 'user') {
      if (
        item.identity_key !== `user:${item.id}` ||
        item.source !== undefined ||
        item.platform !== undefined
      ) {
        return null
      }
      continue
    }

    if (item.source === null) {
      if (item.identity_key !== `trader:legacy-null:${item.id}` || item.platform !== undefined) {
        return null
      }
    } else if (
      typeof item.source !== 'string' ||
      item.platform !== item.source ||
      item.identity_key !== `trader:source:${item.source}:${item.id}`
    ) {
      return null
    }
  }

  return items
}

function responseErrorMessage(value: unknown, fallback: string): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fallback
  const raw = Reflect.get(value, 'error')
  if (typeof raw === 'string' && raw.length > 0) return raw
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const message = Reflect.get(raw, 'message')
    if (typeof message === 'string' && message.length > 0) return message
  }
  return fallback
}

async function fetchJsonWithinDeadline(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  label: string,
  callerSignal?: AbortSignal
): Promise<{ response: Response; body: unknown }> {
  if (callerSignal?.aborted) throw new CompareClientRequestError(`${label} cancelled`)

  const controller = new AbortController()
  let rejectInterruption: ((reason: Error) => void) | undefined
  const interruption = new Promise<never>((_resolve, reject) => {
    rejectInterruption = reject
  })
  const interrupt = (reason: Error) => {
    if (!controller.signal.aborted) controller.abort(reason)
    rejectInterruption?.(reason)
  }
  const onCallerAbort = () => interrupt(new CompareClientRequestError(`${label} cancelled`))
  callerSignal?.addEventListener('abort', onCallerAbort, { once: true })
  const timeout = setTimeout(
    () => interrupt(new CompareClientRequestError(`${label} timed out`)),
    timeoutMs
  )

  try {
    const response = await Promise.race([
      fetch(url, { ...init, cache: 'no-store', signal: controller.signal }),
      interruption,
    ])
    let body: unknown
    try {
      body = await Promise.race([response.json(), interruption])
    } catch (cause) {
      if (cause instanceof CompareClientRequestError) throw cause
      throw new CompareClientRequestError(`${label} returned malformed JSON`, response.status, {
        cause,
      })
    }
    return { response, body }
  } finally {
    clearTimeout(timeout)
    callerSignal?.removeEventListener('abort', onCallerAbort)
  }
}

export async function fetchCompareAccounts(
  accounts: readonly CompareAccountRef[],
  accessToken: string,
  callerSignal?: AbortSignal
): Promise<CompareLoadResult> {
  if (!accessToken || accounts.length === 0) {
    throw new CompareClientRequestError('Comparison request identity is missing')
  }
  const requestAccounts = accounts.map(({ id, source }) => ({ id, source }))
  const { response, body } = await fetchJsonWithinDeadline(
    buildCompareApiUrl(requestAccounts, { includeEquity: true }),
    {
      method: 'GET',
      credentials: 'include',
      headers: { Authorization: `Bearer ${accessToken}` },
    },
    COMPARE_REQUEST_TIMEOUT_MS,
    'Comparison request',
    callerSignal
  )
  if (!response.ok || response.status !== 200) {
    throw new CompareClientRequestError(
      responseErrorMessage(body, `Comparison API returned HTTP ${response.status}`),
      response.status
    )
  }
  const parsed = readCompareResponse(body, requestAccounts)
  if (!parsed) throw new CompareClientRequestError('Comparison API returned an invalid response')
  return parsed
}

export async function fetchFollowingItems(
  userId: string,
  accessToken: string,
  callerSignal?: AbortSignal
): Promise<FollowingItem[]> {
  if (!userId || !accessToken) {
    throw new CompareClientRequestError('Following request identity is missing')
  }
  const { response, body } = await fetchJsonWithinDeadline(
    `/api/following?userId=${encodeURIComponent(userId)}`,
    {
      method: 'GET',
      credentials: 'include',
      headers: { Authorization: `Bearer ${accessToken}` },
    },
    FOLLOWING_REQUEST_TIMEOUT_MS,
    'Following request',
    callerSignal
  )
  if (!response.ok || response.status !== 200) {
    throw new CompareClientRequestError(
      responseErrorMessage(body, `Following API returned HTTP ${response.status}`),
      response.status
    )
  }
  const parsed = readFollowingResponse(body)
  if (!parsed) throw new CompareClientRequestError('Following API returned an invalid response')
  return parsed
}
