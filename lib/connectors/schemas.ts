/**
 * Zod validation schemas for exchange connector API responses.
 *
 * These schemas provide runtime validation at the boundary where we
 * parse external exchange API data. They are intentionally lenient
 * (most fields optional, passthrough on objects) to avoid breaking
 * on minor API changes while catching completely broken responses.
 *
 * Usage:
 *   const data = await fetch(...).then(r => r.json())
 *   const validated = warnValidate(BybitLeaderboardResponseSchema, data, 'bybit/leaderboard')
 */

import { z } from 'zod'
import { createLogger } from '@/lib/utils/logger'

const logger = createLogger('connector-schemas')

// ============================================
// Validation helper
// ============================================

/**
 * Validate data against schema. On failure, log a warning and return
 * the original data cast to the expected type (graceful degradation).
 */
export function warnValidate<T>(
  schema: z.ZodType<T>,
  data: unknown,
  context: string
): T {
  const result = schema.safeParse(data)
  if (!result.success) {
    const issues = result.error.issues
      .slice(0, 3)
      .map(i => `${i.path.join('.')}: ${i.message}`)
      .join('; ')
    logger.warn(`[${context}] Response validation warning: ${issues}`)
    return data as T
  }
  return result.data
}

// ============================================
// Shared primitives
// ============================================

/** Coerce string|number to number, allowing nullish */
const optNum = z.union([z.number(), z.string().transform(Number)]).optional().nullable()
const optStr = z.string().optional().nullable()
const optInt = z.union([z.number().int(), z.string().transform(Number)]).optional().nullable()

// ============================================
// Bybit
// ============================================

export const BybitLeaderEntrySchema = z.object({
  leaderId: z.string(),
  nickName: optStr,
  leaderName: optStr,
  avatar: optStr,
  avatarUrl: optStr,
  roi: optNum,
  roiRate: optNum,
  pnl: optNum,
  totalPnl: optNum,
  winRate: optNum,
  mdd: optNum,
  maxDrawdown: optNum,
  followerCount: optInt,
  copierNum: optInt,
}).passthrough()

export const BybitLeaderboardResponseSchema = z.object({
  retCode: z.number(),
  result: z.object({
    list: z.array(BybitLeaderEntrySchema),
    total: optInt,
  }).passthrough(),
}).passthrough()

export const BybitTraderDetailResponseSchema = z.object({
  retCode: z.number(),
  result: z.object({
    leaderId: z.string(),
    nickName: optStr,
    avatar: optStr,
    introduction: optStr,
    followerCount: optInt,
    copierNum: optInt,
    aum: optNum,
    createTime: optNum,
    totalPnl: optNum,
    roi: optNum,
    winRate: optNum,
    maxDrawdown: optNum,
    tradeCount: optInt,
    avgHoldTime: optNum,
    sharpeRatio: optNum,
  }).passthrough(),
}).passthrough()

export const BybitPerformanceResponseSchema = z.object({
  retCode: z.number(),
  result: z.object({
    list: z.array(z.object({
      time: z.number(),
      value: z.number(),
    }).passthrough()).nullable().default([]),
  }).passthrough(),
}).passthrough()

// ============================================
// Binance Futures
// ============================================

export const BinanceLeaderboardEntrySchema = z.object({
  encryptedUid: z.string(),
  nickName: z.string().optional().default(''),
  userPhotoUrl: z.string().optional().default(''),
  rank: z.number().optional(),
  roi: z.number(),
  pnl: z.number(),
  winRate: optNum,
  followerCount: optInt,
  copierCount: optInt,
}).passthrough()

export const BinanceLeaderboardResponseSchema = z.object({
  data: z.array(BinanceLeaderboardEntrySchema).nullable().default([]),
  total: z.number().optional(),
  success: z.boolean(),
}).passthrough()

export const BinanceTraderDetailSchema = z.object({
  encryptedUid: z.string(),
  nickName: z.string().optional().default(''),
  userPhotoUrl: z.string().optional().default(''),
  introduction: optStr,
  followerCount: optInt,
  copierCount: optInt,
  aum: optNum,
  createTime: optNum,
  roi: optNum,
  pnl: optNum,
  winRate: optNum,
  maxDrawdown: optNum,
  tradeCount: optInt,
  avgHoldingTime: optNum,
  sharpeRatio: optNum,
}).passthrough()

export const BinancePerformanceEntrySchema = z.object({
  time: z.number(),
  value: z.number(),
}).passthrough()

export const BinanceTraderDetailWrapperSchema = z.object({
  success: z.boolean(),
  data: BinanceTraderDetailSchema.nullable().optional(),
}).passthrough()

export const BinancePerformanceResponseSchema = z.object({
  data: z.array(BinancePerformanceEntrySchema).nullable().default([]),
}).passthrough()

// ============================================
// Binance Spot
// ============================================

export const BinanceSpotEntrySchema = z.object({
  portfolioId: z.string().optional(),
  encryptedUid: optStr,
  nickName: optStr,
  userPhotoUrl: optStr,
  roi: optNum,
  pnl: optNum,
  winRate: optNum,
  followerCount: optInt,
  copierCount: optInt,
  maxDrawdown: optNum,
}).passthrough()

export const BinanceSpotListResponseSchema = z.object({
  data: z.object({
    list: z.array(BinanceSpotEntrySchema).nullable().default([]),
    total: optInt,
  }).passthrough(),
  success: z.boolean(),
}).passthrough()

// ============================================
// Bitget Futures
// ============================================

export const BitgetTraderEntrySchema = z.object({
  traderId: z.string(),
  nickName: optStr,
  avatar: optStr,
  userPhoto: optStr,
  roi: optNum,
  totalProfit: optNum,
  pnl: optNum,
  winRatio: optNum,
  winRate: optNum,
  maxDrawdown: optNum,
  mdd: optNum,
  followerCount: optInt,
  currentCopyCount: optInt,
  tradeCount: optInt,
}).passthrough()

export const BitgetLeaderboardResponseSchema = z.object({
  code: z.string(),
  data: z.object({
    list: z.array(BitgetTraderEntrySchema).nullable().default([]),
    total: optInt,
  }).passthrough(),
}).passthrough()

export const BitgetTraderDetailResponseSchema = z.object({
  code: z.string(),
  data: z.object({
    traderId: z.string(),
    nickName: optStr,
    avatar: optStr,
    introduction: optStr,
    followerCount: optInt,
    currentCopyCount: optInt,
    aum: optNum,
    registerTime: optNum,
    totalProfit: optNum,
    roi: optNum,
    winRatio: optNum,
    maxDrawdown: optNum,
    totalTradeCount: optInt,
    avgHoldTime: optNum,
    sharpeRatio: optNum,
    profitDays: optInt,
    lossDays: optInt,
  }).passthrough(),
}).passthrough()

// ============================================
// Bitget Spot
// ============================================

export const BitgetSpotEntrySchema = z.object({
  traderId: z.string(),
  nickName: optStr,
  avatar: optStr,
  roi: optNum,
  totalProfit: optNum,
  winRatio: optNum,
  maxDrawdown: optNum,
  followerCount: optInt,
  currentCopyCount: optInt,
  totalTradeCount: optInt,
}).passthrough()

export const BitgetSpotListResponseSchema = z.object({
  code: z.string(),
  data: z.object({
    list: z.array(BitgetSpotEntrySchema).nullable().default([]),
    total: optInt,
  }).passthrough(),
}).passthrough()

// ============================================
// MEXC
// ============================================

export const MEXCTraderEntrySchema = z.object({
  traderUid: z.string(),
  nickName: optStr,
  avatar: optStr,
  roi: optNum,
  pnl: optNum,
  winRate: optNum,
  maxDrawdown: optNum,
  followerCount: optInt,
  tradeCount: optInt,
}).passthrough()

export const MEXCLeaderboardResponseSchema = z.object({
  code: z.number(),
  data: z.object({
    resultList: z.array(MEXCTraderEntrySchema).nullable().default([]),
    total: optInt,
  }).passthrough(),
}).passthrough()

// ============================================
// CoinEx
// ============================================

export const CoinExTraderEntrySchema = z.object({
  trader_id: z.string(),
  nick_name: optStr,
  avatar: optStr,
  roi: optNum,
  pnl: optNum,
  total_pnl: optNum,
  win_rate: optNum,
  max_drawdown: optNum,
  follower_count: optInt,
  trade_count: optInt,
}).passthrough()

export const CoinExLeaderboardResponseSchema = z.object({
  code: z.number(),
  data: z.object({
    data: z.array(CoinExTraderEntrySchema).nullable().default([]),
    total: optInt,
  }).passthrough(),
}).passthrough()

// ============================================
// OKX
// ============================================

export const OKXTraderEntrySchema = z.object({
  uniqueName: z.string(),
  nickName: optStr,
  portrait: optStr,
  roi: optNum,
  pnl: optNum,
  winRatio: optNum,
  maxDrawdown: optNum,
  copyTraderNum: optInt,
  aum: optNum,
}).passthrough()

export const OKXLeaderboardResponseSchema = z.object({
  code: z.string(),
  data: z.object({
    ranks: z.array(OKXTraderEntrySchema).nullable().default([]),
    total: optInt,
  }).passthrough(),
}).passthrough()

export const OKXTraderDetailResponseSchema = z.object({
  code: z.string(),
  data: OKXTraderEntrySchema.nullable().optional(),
}).passthrough()

// ============================================
// Hyperliquid
// ============================================

export const HyperliquidLeaderEntrySchema = z.object({
  ethAddress: z.string(),
  displayName: optStr,
  accountValue: z.union([z.number(), z.string()]),
  pnl: z.union([z.number(), z.string()]),
  roi: z.union([z.number(), z.string()]),
  vlm: z.union([z.number(), z.string()]).optional(),
  maxDrawdown: optNum,
  nTrades: optInt,
  winRate: optNum,
}).passthrough()

export const HyperliquidUserStateSchema = z.object({
  assetPositions: z.array(z.object({
    position: z.object({
      coin: z.string(),
      szi: z.string().optional(),
      entryPx: z.string().optional(),
      unrealizedPnl: z.string().optional(),
      returnOnEquity: z.string().optional(),
    }).passthrough(),
  }).passthrough()).optional().default([]),
  marginSummary: z.object({
    accountValue: z.string().optional(),
    totalRawUsd: z.string().optional(),
  }).passthrough().optional(),
}).passthrough()

export const HyperliquidFillSchema = z.object({
  coin: z.string(),
  px: z.string(),
  sz: z.string(),
  side: z.string(),
  time: z.number(),
  closedPnl: z.string().optional().default('0'),
}).passthrough()

export const HyperliquidLeaderboardResponseSchema = z.object({
  leaderboardRows: z.array(HyperliquidLeaderEntrySchema).optional(),
}).passthrough()

// ============================================
// Bitget Performance
// ============================================

export const BitgetPerformanceResponseSchema = z.object({
  code: z.string(),
  data: z.object({
    list: z.array(z.object({
      time: z.number(),
      value: z.number(),
    }).passthrough()).nullable().default([]),
  }).passthrough(),
}).passthrough()

// ============================================
// KuCoin
// ============================================

export const KuCoinTraderEntrySchema = z.object({
  leaderId: z.string(),
  nickName: optStr,
  avatar: optStr,
  roi: optNum,
  pnl: optNum,
  totalPnl: optNum,
  winRate: optNum,
  maxDrawdown: optNum,
  followerCount: optInt,
  tradeCount: optInt,
  aum: optNum,
}).passthrough()

export const KuCoinLeaderboardResponseSchema = z.object({
  code: z.string(),
  data: z.object({
    items: z.array(KuCoinTraderEntrySchema).nullable().default([]),
    totalNum: optInt,
  }).passthrough(),
}).passthrough()
