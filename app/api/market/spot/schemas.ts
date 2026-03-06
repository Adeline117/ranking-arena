/**
 * Zod validation schemas for CoinGecko /coins/markets API response.
 *
 * Validates the external data boundary before we transform and cache it.
 * Intentionally lenient (nullable/optional on non-critical fields, passthrough)
 * to avoid crashing on minor CoinGecko API changes.
 */

import { z } from 'zod'
import { createLogger } from '@/lib/utils/logger'

const logger = createLogger('market-spot-schemas')

export const CoinGeckoMarketEntrySchema = z.object({
  id: z.string(),
  symbol: z.string(),
  name: z.string(),
  image: z.string().nullable().optional(),
  current_price: z.number().nullable(),
  price_change_percentage_24h: z.number().nullable().optional(),
  price_change_percentage_1h_in_currency: z.number().nullable().optional(),
  price_change_percentage_7d_in_currency: z.number().nullable().optional(),
  high_24h: z.number().nullable().optional(),
  low_24h: z.number().nullable().optional(),
  total_volume: z.number().nullable().optional(),
  market_cap: z.number().nullable().optional(),
  market_cap_rank: z.number().nullable().optional(),
}).passthrough()

export const CoinGeckoMarketsResponseSchema = z.array(CoinGeckoMarketEntrySchema)

/**
 * Validate CoinGecko response. On failure, log a warning and return
 * the original data (graceful degradation).
 */
export function validateCoinGeckoResponse<T>(
  schema: z.ZodType<T>,
  data: unknown,
  context: string
): T {
  const result = schema.safeParse(data)
  if (!result.success) {
    const issues = result.error.issues
      .slice(0, 5)
      .map(i => `${i.path.join('.')}: ${i.message}`)
      .join('; ')
    logger.warn(`[${context}] CoinGecko response validation warning: ${issues}`)
    return data as T
  }
  return result.data
}
