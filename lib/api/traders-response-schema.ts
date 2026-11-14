/**
 * Zod output validation schemas for the traders API response.
 * Used in development mode to catch response shape drift early.
 */

import { z } from 'zod'
import { TradersListRowSchema } from '@/lib/contracts/core-api'

/**
 * Row shape = the core-api contract row (single source of truth shared with
 * the homepage mapper) plus the fields this route always emits. `roi` and
 * `arena_score` are nullable there: null is "unknown", which the route does
 * return — the former non-null copy reported drift on every dev request.
 */
export const traderOutputSchema = TradersListRowSchema.extend({
  source_type: z.string(),
  is_bot: z.boolean(),
  updated_at: z.string().nullable().optional(),
  is_stale: z.boolean().optional(),
  is_outlier: z.boolean().optional(),
  computed_at: z.string().nullable().optional(),
})

export const tradersResponseSchema = z.object({
  traders: z.array(traderOutputSchema),
  timeRange: z.string(),
  // A numeric count is emitted only when a query has an exact, view-native
  // authority. Public cohort pagination normally uses a lookahead row instead.
  totalCount: z.number().int().nonnegative().nullable(),
  totalCountIsExact: z.boolean(),
  rankingMode: z.string(),
  lastUpdated: z.string().nullable(),
  isStale: z.boolean(),
  dataAgeMinutes: z.number().nullable().optional(),
  source_freshness: z
    .array(
      z.object({
        source: z.string(),
        updated_at: z.string().nullable(),
        is_stale: z.boolean(),
        age_seconds: z.number().nullable(),
      })
    )
    .optional(),
  nextCursor: z.number().nullable(),
  hasMore: z.boolean(),
  page: z.number().optional(),
  limit: z.number(),
  availableSources: z.array(z.string()),
})

/**
 * Validate the traders API response shape in development mode.
 * No-op in production (zero overhead).
 */
export function validateTradersResponse(
  data: unknown,
  logger: { warn: (msg: string, ...args: unknown[]) => void }
): void {
  if (process.env.NODE_ENV !== 'development') return

  const parseResult = tradersResponseSchema.safeParse(data)
  if (!parseResult.success) {
    logger.warn('Traders API response schema drift detected:', parseResult.error.flatten())
  }
}
