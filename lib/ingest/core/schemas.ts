/**
 * Zod schemas for canonical parsed rows — the staging validation layer
 * (spec §5.2). A row failing its schema OR missing a source-required field
 * is quarantined into arena.staging_rejects, never silently NULLed.
 */

import { z } from 'zod'
import { PARSED_POSITION_HISTORY_LIMITATIONS } from './types'

const finite = z.number().finite()
const nullableFinite = finite.nullable()
const isoTs = z.string().min(10) // ISO timestamp; DB casts to timestamptz
const parsedMetricFieldSourceSchema = z
  .object({
    fieldPath: z.string().trim().min(1),
    sourcePageOrdinal: z.number().int().positive().optional(),
  })
  .strict()

export const parsedLeaderboardRowSchema = z
  .object({
    exchangeTraderId: z.string().min(1),
    rank: z.number().int().positive(),
    nickname: z.string().nullable(),
    avatarUrlOrigin: z.string().nullable(),
    walletAddress: z.string().nullable(),
    traderKind: z.enum(['human', 'bot']),
    botStrategy: z.enum(['martingale', 'grid', 'ai']).nullable(),
    headlineRoi: nullableFinite,
    headlinePnl: nullableFinite,
    headlineWinRate: nullableFinite,
    headlineMdd: nullableFinite.optional(),
    headlineSharpe: nullableFinite.optional(),
    headlineMetricSources: z
      .object({
        roi: parsedMetricFieldSourceSchema.optional(),
        pnl: parsedMetricFieldSourceSchema.optional(),
        win_rate: parsedMetricFieldSourceSchema.optional(),
        mdd: parsedMetricFieldSourceSchema.optional(),
        sharpe: parsedMetricFieldSourceSchema.optional(),
      })
      .strict()
      .optional(),
    raw: z.record(z.string(), z.unknown()),
  })
  .superRefine((row, ctx) => {
    const values = {
      roi: row.headlineRoi,
      pnl: row.headlinePnl,
      win_rate: row.headlineWinRate,
      mdd: row.headlineMdd,
      sharpe: row.headlineSharpe,
    }
    for (const metric of Object.keys(row.headlineMetricSources ?? {}) as Array<
      keyof typeof values
    >) {
      if (values[metric] === null || values[metric] === undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['headlineMetricSources', metric],
          message: 'field source cannot be attached to a missing metric',
        })
      }
    }
  })

export const parsedStatsSchema = z.object({
  timeframe: z.union([z.literal(0), z.literal(7), z.literal(30), z.literal(90)]),
  asOf: isoTs,
  roi: nullableFinite,
  pnl: nullableFinite,
  sharpe: nullableFinite,
  mdd: nullableFinite,
  winRate: nullableFinite,
  winPositions: z.number().int().nullable(),
  totalPositions: z.number().int().nullable(),
  copierPnl: nullableFinite,
  copierCount: z.number().int().nullable(),
  aum: nullableFinite,
  volume: nullableFinite,
  profitShareRate: nullableFinite,
  holdingDurationAvgHours: nullableFinite,
  tradingPreferences: z.record(z.string(), z.unknown()).nullable(),
  extras: z.record(z.string(), z.unknown()),
})

export const seriesPointSchema = z.object({ ts: isoTs, value: finite })

export const parsedProfileSchema = z.object({
  stats: z.array(parsedStatsSchema),
  series: z.array(
    z.object({
      timeframe: z.union([z.literal(0), z.literal(7), z.literal(30), z.literal(90)]),
      metric: z.string().min(1),
      points: z.array(seriesPointSchema),
    })
  ),
  nickname: z.string().nullable(),
  avatarUrlOrigin: z.string().nullable(),
})

export const parsedPositionSchema = z.object({
  symbol: z.string().min(1),
  side: z.string().nullable(),
  leverage: nullableFinite,
  size: nullableFinite,
  entryPrice: nullableFinite,
  markPrice: nullableFinite,
  unrealizedPnl: nullableFinite,
  raw: z.record(z.string(), z.unknown()),
})

const canonicalClaimString = z
  .string()
  .min(1)
  .superRefine((value, ctx) => {
    if (value !== value.trim()) {
      ctx.addIssue({
        code: 'custom',
        message: 'claim strings must be canonical without edge whitespace',
      })
    }
  })

const parsedPositionHistoryFieldSourceSchema = z
  .object({
    fieldPaths: z
      .array(canonicalClaimString)
      .min(1)
      .superRefine((paths, ctx) => {
        if (new Set(paths).size !== paths.length) {
          ctx.addIssue({ code: 'custom', message: 'field paths must be unique' })
        }
      }),
  })
  .strict()

const parsedPositionHistoryFieldSourcesSchema = z
  .object({
    sourceFactId: parsedPositionHistoryFieldSourceSchema.optional(),
    sourceLifecycleMarker: parsedPositionHistoryFieldSourceSchema.optional(),
    sourceReturn: parsedPositionHistoryFieldSourceSchema.optional(),
    openedAt: parsedPositionHistoryFieldSourceSchema.optional(),
    closedAt: parsedPositionHistoryFieldSourceSchema.optional(),
    symbol: parsedPositionHistoryFieldSourceSchema.optional(),
    side: parsedPositionHistoryFieldSourceSchema.optional(),
    leverage: parsedPositionHistoryFieldSourceSchema.optional(),
    size: parsedPositionHistoryFieldSourceSchema.optional(),
    entryPrice: parsedPositionHistoryFieldSourceSchema.optional(),
    exitPrice: parsedPositionHistoryFieldSourceSchema.optional(),
    realizedPnl: parsedPositionHistoryFieldSourceSchema.optional(),
  })
  .strict()

const parsedPositionHistoryLimitationsSchema = z
  .array(z.enum(PARSED_POSITION_HISTORY_LIMITATIONS))
  .superRefine((limitations, ctx) => {
    if (new Set(limitations).size !== limitations.length) {
      ctx.addIssue({ code: 'custom', message: 'limitations must be unique' })
    }
  })

const parsedPositionHistoryClaimFields = [
  'sourceFactId',
  'sourceLifecycleMarker',
  'sourceReturn',
  'openedAt',
  'closedAt',
  'symbol',
  'side',
  'leverage',
  'size',
  'entryPrice',
  'exitPrice',
  'realizedPnl',
] as const

export const parsedPositionHistoryRowSchema = z
  .object({
    kind: z.literal('position_history'),
    openedAt: isoTs.nullable(),
    closedAt: isoTs.nullable(),
    symbol: z.string().min(1),
    side: z.string().nullable(),
    leverage: nullableFinite,
    size: nullableFinite,
    entryPrice: nullableFinite,
    exitPrice: nullableFinite,
    realizedPnl: nullableFinite,
    sourceFactId: canonicalClaimString.nullable().optional(),
    sourceLifecycleMarker: canonicalClaimString.nullable().optional(),
    sourceReturn: nullableFinite.optional(),
    fieldSources: parsedPositionHistoryFieldSourcesSchema.optional(),
    limitations: parsedPositionHistoryLimitationsSchema.optional(),
    dedupeHash: z.string().min(1),
    raw: z.record(z.string(), z.unknown()),
  })
  .strict()
  .superRefine((row, ctx) => {
    // Adapters may migrate to this claim substrate incrementally. Once a row
    // opts in, every parsed value and its source location must agree both ways.
    // The path remains an untrusted parser claim: the acquisition framework
    // must still exact-match it against a reviewed source contract.
    const usesClaimSubstrate =
      row.sourceFactId !== undefined ||
      row.sourceLifecycleMarker !== undefined ||
      row.sourceReturn !== undefined ||
      row.fieldSources !== undefined ||
      row.limitations !== undefined
    if (usesClaimSubstrate) {
      for (const field of parsedPositionHistoryClaimFields) {
        const valuePresent = row[field] !== null && row[field] !== undefined
        const sourcePresent = row.fieldSources?.[field] !== undefined
        if (valuePresent !== sourcePresent) {
          ctx.addIssue({
            code: 'custom',
            path: ['fieldSources', field],
            message: `field source must exactly match whether ${field} is present`,
          })
        }
      }

      // Objective "missing" limitations must independently agree both ways
      // with the values they describe; a path claim is not a completeness
      // verdict.
      const limitations = new Set(row.limitations ?? [])
      const missingClaims = [
        ['sourceFactId', 'source_fact_id_missing'],
        ['sourceLifecycleMarker', 'source_lifecycle_marker_missing'],
        ['sourceReturn', 'source_return_missing'],
        ['realizedPnl', 'source_realized_pnl_missing'],
      ] as const

      for (const [field, limitation] of missingClaims) {
        const valueMissing = row[field] === null || row[field] === undefined
        const limitationDeclared = limitations.has(limitation)
        if (valueMissing !== limitationDeclared) {
          ctx.addIssue({
            code: 'custom',
            path: ['limitations'],
            message: `${limitation} must exactly match whether ${field} is missing`,
          })
        }
      }
    }
  })

export const parsedOrderRowSchema = z.object({
  kind: z.literal('orders'),
  ts: isoTs,
  orderKind: z.string().nullable(),
  symbol: z.string().nullable(),
  side: z.string().nullable(),
  price: nullableFinite,
  qty: nullableFinite,
  dedupeHash: z.string().min(1),
  raw: z.record(z.string(), z.unknown()),
})

export const parsedTransferRowSchema = z.object({
  kind: z.literal('transfers'),
  ts: isoTs,
  direction: z.enum(['in', 'out']).nullable(),
  asset: z.string().nullable(),
  amount: nullableFinite,
  dedupeHash: z.string().min(1),
  raw: z.record(z.string(), z.unknown()),
})

export const parsedCopierRowSchema = z.object({
  kind: z.literal('copiers'),
  ts: isoTs,
  copierLabel: z.string().nullable(),
  copierPnl: nullableFinite,
  copierInvested: nullableFinite,
  copyDurationDays: z.number().int().nullable(),
  dedupeHash: z.string().min(1),
  raw: z.record(z.string(), z.unknown()),
})

export const parsedHistoryRowSchema = z.union([
  parsedPositionHistoryRowSchema,
  parsedOrderRowSchema,
  parsedTransferRowSchema,
  parsedCopierRowSchema,
])
