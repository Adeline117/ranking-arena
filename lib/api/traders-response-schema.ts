/**
 * Zod output validation schemas for the traders API response.
 * Used in development mode to catch response shape drift early.
 */

import { z } from 'zod'

export const traderOutputSchema = z.object({
  id: z.string(),
  handle: z.string().nullable(),
  roi: z.number(),
  pnl: z.number().nullable(),
  win_rate: z.number().nullable(),
  max_drawdown: z.number().nullable(),
  trades_count: z.number().nullable(),
  followers: z.number().nullable(),
  source: z.string(),
  source_type: z.string(),
  avatar_url: z.string().nullable(),
  arena_score: z.number(),
  rank: z.number(),
  profitability_score: z.number().nullable(),
  risk_control_score: z.number().nullable(),
  execution_score: z.number().nullable(),
  score_completeness: z.string().nullable(),
  trading_style: z.string().nullable(),
  avg_holding_hours: z.number().nullable(),
  style_confidence: z.number().nullable(),
  sharpe_ratio: z.number().nullable(),
  is_bot: z.boolean(),
  trader_type: z.string().nullable(),
})

export const tradersResponseSchema = z.object({
  traders: z.array(traderOutputSchema),
  timeRange: z.string(),
  totalCount: z.number(),
  rankingMode: z.string(),
  lastUpdated: z.string(),
  isStale: z.boolean(),
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
export function validateTradersResponse(data: unknown, logger: { warn: (msg: string, ...args: unknown[]) => void }): void {
  if (process.env.NODE_ENV !== 'development') return

  const parseResult = tradersResponseSchema.safeParse(data)
  if (!parseResult.success) {
    logger.warn('Traders API response schema drift detected:', parseResult.error.flatten())
  }
}
