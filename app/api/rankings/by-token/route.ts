/**
 * Generation-bound token rankings API.
 *
 * Every response is tied to one atomically published token-MV generation.
 * Callers may pin `generation` while paging; a stale pin receives 409 instead
 * of silently mixing rows from different publications.
 */

import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { getSupabaseAdmin } from '@/lib/api'
import { logger } from '@/lib/logger'
import { RateLimitPresets, checkRateLimit } from '@/lib/utils/rate-limit'
import { isValidTokenSymbol } from '@/lib/utils/token-symbol'
import {
  TOKEN_RANKING_MAX_GENERATION,
  TOKEN_RANKING_MAX_OFFSET,
  TOKEN_RANKING_API_TIMEOUT_MS,
  TokenRankingReadError,
  getPopularTokenRankingSnapshot,
  getTokenTraderRankingSnapshot,
} from '@/lib/rankings/token-ranking-snapshot'

export const runtime = 'nodejs'

const NO_STORE_HEADERS = {
  'Cache-Control': 'private, no-store, max-age=0, must-revalidate',
} as const
const UNPUBLISHED_RETRY_AFTER_SECONDS = 60 * 60
const SUPPORTED_QUERY_KEYS = new Set(['action', 'generation', 'limit', 'offset', 'period', 'token'])
const POPULAR_QUERY_KEYS = new Set(['action', 'generation'])

const generationSchema = z
  .string()
  .max(16)
  .regex(/^[1-9]\d*$/)
  .refine((value) => {
    try {
      const parsed = BigInt(value)
      return parsed <= BigInt(TOKEN_RANKING_MAX_GENERATION) && String(parsed) === value
    } catch {
      return false
    }
  })
  .optional()

function canonicalIntegerQuery(defaultValue: number, minimum: number, maximum: number) {
  return z
    .string()
    .regex(/^(0|[1-9]\d*)$/)
    .transform(Number)
    .refine((value) => Number.isSafeInteger(value) && value >= minimum && value <= maximum)
    .optional()
    .transform((value) => value ?? defaultValue)
}

const querySchema = z.object({
  token: z
    .string()
    .min(1)
    .max(10)
    .transform((value) => value.toUpperCase())
    .refine(isValidTokenSymbol, 'Unsupported crypto token symbol'),
  period: z
    .string()
    .transform((value) => value.toUpperCase())
    .pipe(z.enum(['7D', '30D', '90D']))
    .default('90D'),
  limit: canonicalIntegerQuery(50, 1, 200),
  offset: canonicalIntegerQuery(0, 0, TOKEN_RANKING_MAX_OFFSET),
  generation: generationSchema,
})

function jsonResponse(
  body: unknown,
  status = 200,
  extraHeaders: Record<string, string> = {}
): NextResponse {
  return NextResponse.json(body, {
    status,
    headers: { ...NO_STORE_HEADERS, ...extraHeaders },
  })
}

function invalidParameters(details?: unknown): NextResponse {
  return jsonResponse(
    {
      error: 'Invalid parameters',
      code: 'TOKEN_RANKING_INVALID_REQUEST',
      ...(details === undefined ? {} : { details }),
    },
    400
  )
}

function validateQueryKeys(searchParams: URLSearchParams, allowed: ReadonlySet<string>): boolean {
  for (const key of new Set(searchParams.keys())) {
    if (!allowed.has(key) || searchParams.getAll(key).length !== 1) return false
  }
  return true
}

function errorResponse(error: unknown): NextResponse {
  if (!(error instanceof TokenRankingReadError)) {
    logger.error(
      '[by-token] unexpected token ranking read failure',
      {},
      error instanceof Error ? error : new Error(String(error))
    )
    return jsonResponse(
      { error: 'Token rankings are temporarily unavailable', code: 'TOKEN_RANKING_UNAVAILABLE' },
      503
    )
  }

  const logContext = {
    kind: error.kind,
    databaseCode: error.databaseCode,
    details: error.details,
    currentGeneration: error.currentGeneration,
  }

  switch (error.kind) {
    case 'invalid_input':
      return invalidParameters()
    case 'generation_changed':
      return jsonResponse(
        {
          error: 'Token ranking generation changed',
          code: 'TOKEN_RANKING_GENERATION_CHANGED',
          ...(error.currentGeneration ? { current_generation: error.currentGeneration } : {}),
        },
        409
      )
    case 'not_published':
      logger.warn('[by-token] token ranking is not published', logContext)
      return jsonResponse(
        {
          error: 'Token rankings are withheld while verified authority snapshots are rebuilt',
          code: 'TOKEN_RANKING_NOT_PUBLISHED',
        },
        503,
        { 'Retry-After': String(UNPUBLISHED_RETRY_AFTER_SECONDS) }
      )
    case 'publication_busy':
      logger.warn('[by-token] token ranking publication moved repeatedly', logContext)
      return jsonResponse(
        {
          error: 'Token ranking publication is changing; retry shortly',
          code: 'TOKEN_RANKING_PUBLICATION_BUSY',
          ...(error.currentGeneration ? { current_generation: error.currentGeneration } : {}),
        },
        503,
        { 'Retry-After': '1' }
      )
    case 'contract':
      logger.error('[by-token] token ranking contract violation', logContext)
      return jsonResponse(
        {
          error: 'Token ranking publication contract is unavailable',
          code: 'TOKEN_RANKING_CONTRACT_INVALID',
        },
        502
      )
    case 'database': {
      logger.error('[by-token] token ranking database read failed', logContext)
      const timedOut = error.databaseCode === '57014'
      return jsonResponse(
        {
          error: timedOut
            ? 'Token ranking request timed out'
            : 'Token rankings are temporarily unavailable',
          code: timedOut ? 'TOKEN_RANKING_TIMEOUT' : 'TOKEN_RANKING_UNAVAILABLE',
        },
        timedOut ? 504 : 503,
        { 'Retry-After': '1' }
      )
    }
  }
}

async function handlePopularTokens(generation: string | undefined): Promise<NextResponse> {
  try {
    const result = await getPopularTokenRankingSnapshot(
      getSupabaseAdmin(),
      { generation },
      { signal: AbortSignal.timeout(TOKEN_RANKING_API_TIMEOUT_MS) }
    )
    return jsonResponse(result)
  } catch (error) {
    return errorResponse(error)
  }
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const rateLimited = await checkRateLimit(request, RateLimitPresets.read)
  if (rateLimited) return rateLimited

  const searchParams = request.nextUrl.searchParams
  const action = searchParams.get('action')

  if (action !== null && action !== 'popular-tokens') return invalidParameters()

  if (action === 'popular-tokens') {
    if (!validateQueryKeys(searchParams, POPULAR_QUERY_KEYS)) return invalidParameters()
    const parsedGeneration = generationSchema.safeParse(searchParams.get('generation') ?? undefined)
    if (!parsedGeneration.success) {
      return invalidParameters(parsedGeneration.error.flatten())
    }
    return handlePopularTokens(parsedGeneration.data)
  }

  if (!validateQueryKeys(searchParams, SUPPORTED_QUERY_KEYS)) return invalidParameters()
  const parsed = querySchema.safeParse(Object.fromEntries(searchParams))
  if (!parsed.success) return invalidParameters(parsed.error.flatten())

  try {
    const result = await getTokenTraderRankingSnapshot(getSupabaseAdmin(), parsed.data, {
      signal: AbortSignal.timeout(TOKEN_RANKING_API_TIMEOUT_MS),
    })
    return jsonResponse(result)
  } catch (error) {
    return errorResponse(error)
  }
}
