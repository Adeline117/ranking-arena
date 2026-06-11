/**
 * Zod schemas for canonical parsed rows — the staging validation layer
 * (spec §5.2). A row failing its schema OR missing a source-required field
 * is quarantined into arena.staging_rejects, never silently NULLed.
 */

import { z } from 'zod'

const finite = z.number().finite()
const nullableFinite = finite.nullable()
const isoTs = z.string().min(10) // ISO timestamp; DB casts to timestamptz

export const parsedLeaderboardRowSchema = z.object({
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
  raw: z.record(z.string(), z.unknown()),
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

export const parsedPositionHistoryRowSchema = z.object({
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
  dedupeHash: z.string().min(1),
  raw: z.record(z.string(), z.unknown()),
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

export const parsedHistoryRowSchema = z.discriminatedUnion('kind', [
  parsedPositionHistoryRowSchema,
  parsedOrderRowSchema,
  parsedTransferRowSchema,
  parsedCopierRowSchema,
])
