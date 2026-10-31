/**
 * Response contracts for the core user path:
 * homepage → rankings → trader detail → period switch → search.
 *
 * Each schema lists the fields clients depend on, not every field a route sends.
 * Metrics are nullable on purpose: null means "the source did not provide this",
 * and must never be replaced by a synthetic zero.
 *
 * e2e/hermetic/api-contract.spec.ts checks real responses against these.
 */
import { z } from 'zod'

const nullableNumber = z.number().nullable()
const nullableString = z.string().nullable()

export const PeriodSchema = z.enum(['7D', '30D', '90D'])

const SourceFreshnessSchema = z.object({
  source: z.string().min(1),
  updated_at: nullableString,
  is_stale: z.boolean(),
  age_seconds: nullableNumber,
})

/** GET /api/traders: the homepage list after hydration. */
export const TradersListResponseSchema = z.object({
  traders: z.array(
    z.object({
      id: z.string().min(1),
      handle: nullableString,
      source: z.string().min(1),
      rank: z.number().int().positive(),
      roi: nullableNumber,
      pnl: nullableNumber,
      win_rate: nullableNumber,
      max_drawdown: nullableNumber,
      arena_score: nullableNumber,
      avatar_url: nullableString,
      followers: nullableNumber,
      trades_count: nullableNumber,
    })
  ),
  timeRange: PeriodSchema,
  totalCount: nullableNumber,
  totalCountIsExact: z.boolean(),
  hasMore: z.boolean(),
  isStale: z.boolean(),
  lastUpdated: nullableString,
  availableSources: z.array(z.string()),
  source_freshness: z.array(SourceFreshnessSchema),
})

const envelope = <T extends z.ZodTypeAny>(data: T) =>
  z.object({ success: z.literal(true), data, meta: z.object({ timestamp: z.string() }) })

/** GET /api/rankings */
export const RankingsResponseSchema = envelope(
  z.object({
    traders: z.array(
      z.object({
        platform: z.string().min(1),
        trader_key: z.string().min(1),
        display_name: nullableString,
        rank: z.number().int().positive(),
        roi: nullableNumber,
        pnl: nullableNumber,
        arena_score: nullableNumber,
        win_rate: nullableNumber,
        max_drawdown: nullableNumber,
      })
    ),
    window: PeriodSchema,
    hasMore: z.boolean(),
    is_stale: z.boolean(),
    as_of: nullableString,
    source_freshness: z.array(SourceFreshnessSchema),
  })
)

/** GET /api/traders/[handle] */
export const TraderDetailResponseSchema = envelope(
  z.object({
    profile: z.object({
      handle: nullableString,
      id: z.string().min(1),
      source: z.string().min(1),
      avatar_url: nullableString,
      followers: nullableNumber,
    }),
    performance: z.object({
      roi_7d: nullableNumber,
      roi_30d: nullableNumber,
      roi_90d: nullableNumber,
      pnl: nullableNumber,
      win_rate: nullableNumber,
      max_drawdown: nullableNumber,
      arena_score_7d: nullableNumber,
      arena_score_30d: nullableNumber,
      arena_score_90d: nullableNumber,
    }),
  })
)

/** GET /api/search/suggestions */
export const SearchSuggestionsResponseSchema = envelope(
  z.object({
    query: z.string(),
    suggestions: z.array(
      z.object({
        type: z.string().min(1),
        value: z.string().min(1),
        label: z.string().min(1),
        source: z.string().optional(),
        rankingVisibility: z.string().optional(),
      })
    ),
  })
)

/** GET /api/search */
export const SearchResponseSchema = envelope(
  z.object({
    query: z.string(),
    total: z.number().int().nonnegative(),
    results: z.object({
      traders: z.array(
        z.object({
          id: z.string().min(1),
          type: z.literal('trader'),
          title: z.string().min(1),
          href: z.string().startsWith('/'),
        })
      ),
      posts: z.array(z.unknown()),
      users: z.array(z.unknown()),
      groups: z.array(z.unknown()),
    }),
  })
)

export type TradersListResponse = z.infer<typeof TradersListResponseSchema>
export type RankingsResponse = z.infer<typeof RankingsResponseSchema>
export type TraderDetailResponse = z.infer<typeof TraderDetailResponseSchema>
export type SearchSuggestionsResponse = z.infer<typeof SearchSuggestionsResponseSchema>
export type SearchResponse = z.infer<typeof SearchResponseSchema>
