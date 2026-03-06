/**
 * Zod validation schemas for platform connector API responses.
 *
 * These schemas provide runtime validation at the boundary where we
 * parse external exchange API data. They are intentionally lenient
 * (most fields optional, passthrough on objects) to avoid breaking
 * on minor API changes while catching completely broken responses.
 *
 * Uses the same `warnValidate()` helper from `../schemas`.
 */

import { z } from 'zod'

// ============================================
// Shared primitives (same as ../schemas.ts)
// ============================================

/** Coerce string|number to number, allowing nullish */
const optNum = z.union([z.number(), z.string().transform(Number)]).optional().nullable()
const optStr = z.string().optional().nullable()
const optInt = z.union([z.number().int(), z.string().transform(Number)]).optional().nullable()

// ============================================
// Binance Futures
// ============================================

export const BinanceFuturesLeaderboardEntrySchema = z.object({
  encryptedUid: z.string(),
  nickName: optStr,
  userPhotoUrl: optStr,
  rank: optInt,
  value: optNum,
  pnl: optNum,
  followerCount: optInt,
  copyCount: optInt,
  twitterUrl: optStr,
}).passthrough()

export const BinanceFuturesLeaderboardResponseSchema = z.object({
  data: z.object({
    otherLeaderboardUrl: optStr,
    list: z.array(BinanceFuturesLeaderboardEntrySchema).optional().default([]),
  }).passthrough().nullable().optional(),
  success: z.boolean(),
  code: optStr,
  message: optStr,
}).passthrough()

export const BinanceFuturesBaseInfoResponseSchema = z.object({
  data: z.object({
    nickName: optStr,
    userPhotoUrl: optStr,
    positionShared: z.boolean().optional(),
    deliveryPositionShared: z.boolean().optional(),
    followingCount: optInt,
    followerCount: optInt,
    twitterUrl: optStr,
    introduction: optStr,
  }).passthrough().nullable().optional(),
  success: z.boolean(),
}).passthrough()

export const BinanceFuturesPerformanceResponseSchema = z.object({
  data: z.array(z.object({
    periodType: z.string().optional(),
    statisticsType: z.string().optional(),
    value: optNum,
  }).passthrough()).nullable().optional().default([]),
  success: z.boolean(),
}).passthrough()

export const BinanceFuturesPositionResponseSchema = z.object({
  data: z.object({
    otherPositionRetList: z.array(z.object({
      symbol: optStr,
      entryPrice: optNum,
      markPrice: optNum,
      pnl: optNum,
      roe: optNum,
      amount: optNum,
      leverage: optNum,
      updateTimeStamp: optNum,
    }).passthrough()).optional().default([]),
  }).passthrough().nullable().optional(),
  success: z.boolean(),
}).passthrough()

// ============================================
// Bybit Futures
// ============================================

export const BybitFuturesLeaderboardResponseSchema = z.object({
  retCode: optInt,
  result: z.object({
    data: z.array(z.object({
      leaderMark: optStr,
      nickName: optStr,
      avatar: optStr,
      roi: optNum,
      pnl: optNum,
      winRate: optNum,
      maxDrawdown: optNum,
      followerCount: optInt,
      currentFollowerCount: optInt,
    }).passthrough()).optional().default([]),
    total: optInt,
  }).passthrough().optional().nullable(),
}).passthrough()

export const BybitFuturesDetailResponseSchema = z.object({
  retCode: optInt,
  result: z.object({
    leaderMark: optStr,
    nickName: optStr,
    avatar: optStr,
    introduction: optStr,
    roi: optNum,
    pnl: optNum,
    winRate: optNum,
    maxDrawdown: optNum,
    tradeCount: optInt,
    followerCount: optInt,
    currentFollowerCount: optInt,
    aum: optNum,
  }).passthrough().optional().nullable(),
}).passthrough()

export const BybitFuturesTimeseriesResponseSchema = z.object({
  retCode: optInt,
  result: z.object({
    pnlList: z.array(z.object({
      timestamp: optNum,
      pnl: optNum,
      roi: optNum,
    }).passthrough()).optional().default([]),
  }).passthrough().optional().nullable(),
}).passthrough()

// ============================================
// OKX Futures
// ============================================

export const OkxFuturesLeaderboardResponseSchema = z.object({
  code: optStr,
  data: z.object({
    ranks: z.array(z.object({
      uniqueName: optStr,
      nickName: optStr,
      portrait: optStr,
      profitRatio: optNum,
      profit: optNum,
      winRatio: optNum,
      maxDrawdown: optNum,
      copyTraderNum: optInt,
      followerNum: optInt,
      aum: optNum,
    }).passthrough()).optional().default([]),
    total: optInt,
  }).passthrough().optional().nullable(),
}).passthrough()

export const OkxFuturesDetailResponseSchema = z.object({
  code: optStr,
  data: z.object({
    uniqueName: optStr,
    nickName: optStr,
    portrait: optStr,
    desc: optStr,
    profitRatio: optNum,
    profit: optNum,
    winRatio: optNum,
    maxDrawdown: optNum,
    tradeCount: optInt,
    followerNum: optInt,
    copyTraderNum: optInt,
    aum: optNum,
    dailyProfitList: z.array(z.object({
      ts: optNum,
      profit: optNum,
    }).passthrough()).optional().default([]),
  }).passthrough().optional().nullable(),
}).passthrough()

// ============================================
// Bitget Futures
// ============================================

export const BitgetFuturesLeaderboardResponseSchema = z.object({
  code: optStr,
  data: z.object({
    list: z.array(z.object({
      traderId: optStr,
      traderName: optStr,
      headUrl: optStr,
      roi: optNum,
      profit: optNum,
      winRate: optNum,
      drawDown: optNum,
      followerNum: optInt,
      copyTraderNum: optInt,
      totalOrder: optInt,
      totalFollowAssets: optNum,
    }).passthrough()).optional().default([]),
    total: optInt,
  }).passthrough().optional().nullable(),
}).passthrough()

export const BitgetFuturesDetailResponseSchema = z.object({
  code: optStr,
  data: z.object({
    traderId: optStr,
    traderName: optStr,
    headUrl: optStr,
    introduction: optStr,
    roi: optNum,
    profit: optNum,
    winRate: optNum,
    drawDown: optNum,
    followerNum: optInt,
    copyTraderNum: optInt,
    totalOrder: optInt,
    totalFollowAssets: optNum,
  }).passthrough().optional().nullable(),
}).passthrough()

export const BitgetFuturesTimeseriesResponseSchema = z.object({
  code: optStr,
  data: z.array(z.object({
    date: optNum,
    profit: optNum,
  }).passthrough()).optional().nullable().default([]),
}).passthrough()

// ============================================
// MEXC Futures
// ============================================

export const MexcFuturesLeaderboardResponseSchema = z.object({
  code: optInt,
  data: z.object({
    list: z.array(z.object({
      uid: optStr,
      nickname: optStr,
      avatar: optStr,
      yield: optNum,
      pnl: optNum,
      winRate: optNum,
      maxRetrace: optNum,
      followerCount: optInt,
      copyCount: optInt,
      aum: optNum,
    }).passthrough()).optional().default([]),
    total: optInt,
  }).passthrough().optional().nullable(),
}).passthrough()

export const MexcFuturesDetailResponseSchema = z.object({
  code: optInt,
  data: z.object({
    uid: optStr,
    nickname: optStr,
    avatar: optStr,
    yield: optNum,
    pnl: optNum,
    winRate: optNum,
    maxRetrace: optNum,
    followerCount: optInt,
    copyCount: optInt,
    aum: optNum,
  }).passthrough().optional().nullable(),
}).passthrough()

// ============================================
// KuCoin Futures
// ============================================

export const KucoinFuturesLeaderboardResponseSchema = z.object({
  code: optStr,
  data: z.object({
    items: z.array(z.object({
      uid: optStr,
      nickName: optStr,
      avatar: optStr,
      roi: optNum,
      totalPnl: optNum,
      winRate: optNum,
      maxDrawdown: optNum,
      followerCount: optInt,
      currentCopyCount: optInt,
    }).passthrough()).optional().default([]),
    totalNum: optInt,
  }).passthrough().optional().nullable(),
}).passthrough()

export const KucoinFuturesDetailResponseSchema = z.object({
  code: optStr,
  data: z.object({
    uid: optStr,
    nickName: optStr,
    avatar: optStr,
    roi: optNum,
    totalPnl: optNum,
    winRate: optNum,
    maxDrawdown: optNum,
    followerCount: optInt,
    currentCopyCount: optInt,
  }).passthrough().optional().nullable(),
}).passthrough()

// ============================================
// HTX Futures
// ============================================

export const HtxFuturesLeaderboardResponseSchema = z.object({
  code: optInt,
  data: z.object({
    list: z.array(z.object({
      uid: optStr,
      nickName: optStr,
      avatar: optStr,
      roi: optNum,
      pnl: optNum,
      winRate: optNum,
      maxDrawdown: optNum,
      followerCount: optInt,
      copyCount: optInt,
    }).passthrough()).optional().default([]),
    total: optInt,
  }).passthrough().optional().nullable(),
}).passthrough()

export const HtxFuturesDetailResponseSchema = z.object({
  code: optInt,
  data: z.object({
    uid: optStr,
    nickName: optStr,
    avatar: optStr,
    roi: optNum,
    pnl: optNum,
    winRate: optNum,
    maxDrawdown: optNum,
    followerCount: optInt,
    copyCount: optInt,
  }).passthrough().optional().nullable(),
}).passthrough()

// ============================================
// CoinEx Futures
// ============================================

export const CoinexFuturesLeaderboardResponseSchema = z.object({
  code: optInt,
  data: z.object({
    items: z.array(z.object({
      trader_id: optStr,
      nickname: optStr,
      avatar: optStr,
      roi: optNum,
      profit: optNum,
      win_rate: optNum,
      max_drawdown: optNum,
      followers: optInt,
      copiers: optInt,
    }).passthrough()).optional().default([]),
    total: optInt,
  }).passthrough().optional().nullable(),
}).passthrough()

export const CoinexFuturesDetailResponseSchema = z.object({
  code: optInt,
  data: z.object({
    trader_id: optStr,
    nickname: optStr,
    avatar: optStr,
    roi: optNum,
    profit: optNum,
    win_rate: optNum,
    max_drawdown: optNum,
    followers: optInt,
    copiers: optInt,
  }).passthrough().optional().nullable(),
}).passthrough()

// ============================================
// Hyperliquid Perp
// ============================================

export const HyperliquidLeaderboardResponseSchema = z.object({
  leaderboardRows: z.array(z.object({
    ethAddress: optStr,
    displayName: optStr,
    accountValue: z.union([z.number(), z.string()]).optional(),
    pnl: z.union([z.number(), z.string()]).optional(),
    roi: z.union([z.number(), z.string()]).optional(),
  }).passthrough()).optional().default([]),
}).passthrough()

export const HyperliquidClearinghouseResponseSchema = z.object({
  marginSummary: z.object({
    accountValue: optStr,
    totalRawPnl: optStr,
    totalRawUsd: optStr,
  }).passthrough().optional().nullable(),
  assetPositions: z.array(z.object({
    position: z.object({
      coin: optStr,
      szi: optStr,
      entryPx: optStr,
      unrealizedPnl: optStr,
    }).passthrough().optional(),
  }).passthrough()).optional().default([]),
}).passthrough()

export const HyperliquidFillsResponseSchema = z.array(z.object({
  coin: optStr,
  px: optStr,
  sz: optStr,
  side: optStr,
  time: optNum,
  closedPnl: optStr,
}).passthrough()).optional().default([])

// ============================================
// Gate.io Futures
// ============================================

export const GateioFuturesLeaderboardResponseSchema = z.object({
  data: z.object({
    list: z.array(z.object({
      uid: optStr,
      nickname: optStr,
      avatar: optStr,
      roi: optNum,
      pnl: optNum,
      followers: optInt,
      copiers: optInt,
      winRate: optNum,
      maxDrawdown: optNum,
    }).passthrough()).optional().default([]),
  }).passthrough().optional().nullable(),
}).passthrough()

export const GateioFuturesDetailResponseSchema = z.object({
  data: z.object({
    uid: optStr,
    nickname: optStr,
    avatar: optStr,
    roi: optNum,
    pnl: optNum,
    followers: optInt,
    copiers: optInt,
    winRate: optNum,
    maxDrawdown: optNum,
  }).passthrough().optional().nullable(),
}).passthrough()

// ============================================
// dYdX Perp
// ============================================

export const DydxLeaderboardResponseSchema = z.object({
  pnlRanking: z.array(z.object({
    address: optStr,
    pnl: optNum,
    rank: optInt,
  }).passthrough()).optional().default([]),
}).passthrough()

export const DydxSubaccountResponseSchema = z.object({
  subaccount: z.object({
    equity: optStr,
    freeCollateral: optStr,
    openPerpetualPositions: z.record(z.string(), z.unknown()).optional(),
  }).passthrough().optional().nullable(),
}).passthrough()

export const DydxHistoricalPnlResponseSchema = z.object({
  historicalPnl: z.array(z.object({
    createdAt: optStr,
    totalPnl: optStr,
    equity: optStr,
  }).passthrough()).optional().default([]),
}).passthrough()

// ============================================
// GMX Perp
// ============================================

export const GmxLeaderboardResponseSchema = z.union([
  z.array(z.object({
    account: optStr,
    id: optStr,
    realizedPnl: z.union([z.number(), z.string()]).optional(),
    maxCapital: z.union([z.number(), z.string()]).optional(),
    wins: optInt,
    losses: optInt,
  }).passthrough()),
  z.object({
    accounts: z.array(z.object({
      account: optStr,
      id: optStr,
      realizedPnl: z.union([z.number(), z.string()]).optional(),
      maxCapital: z.union([z.number(), z.string()]).optional(),
      wins: optInt,
      losses: optInt,
    }).passthrough()).optional().default([]),
  }).passthrough(),
])

export const GmxSubgraphResponseSchema = z.object({
  data: z.object({
    periodAccountStats: z.array(z.object({
      period: optStr,
      realizedPnl: z.union([z.number(), z.string()]).optional(),
      maxCapital: z.union([z.number(), z.string()]).optional(),
    }).passthrough()).optional().default([]),
  }).passthrough().optional().nullable(),
}).passthrough()

// ============================================
// Gains Perp
// ============================================

export const GainsOpenTradesResponseSchema = z.array(z.object({
  trader: optStr,
  pairIndex: optInt,
  index: optInt,
  leverage: optNum,
  collateralAmount: optNum,
  openPrice: optNum,
  tp: optNum,
  sl: optNum,
  timestamp: optNum,
}).passthrough()).optional().default([])

export const GainsTradeHistoryResponseSchema = z.array(z.object({
  address: optStr,
  pnl: optNum,
  pnlPercent: optNum,
  action: optStr,
  pair: optStr,
  leverage: optNum,
  collateral: optNum,
  date: optStr,
}).passthrough()).optional().default([])

// ============================================
// Kwenta Perp
// ============================================

export const KwentaStatsResponseSchema = z.object({
  data: z.object({
    futuresStats: z.array(z.object({
      id: optStr,
      account: z.string(),
      pnl: optStr,
      pnlWithFeesPaid: optStr,
      totalVolume: optStr,
      feesPaid: optStr,
      liquidations: optStr,
      totalTrades: optStr,
      smartMarginVolume: optStr,
    }).passthrough()).optional().default([]),
  }).passthrough().optional().nullable(),
}).passthrough()

export const KwentaPositionsResponseSchema = z.object({
  data: z.object({
    futuresPositions: z.array(z.object({
      id: optStr,
      account: optStr,
      isOpen: z.boolean().optional(),
      entryPrice: optStr,
      exitPrice: optStr,
      size: optStr,
      realizedPnl: optStr,
      netFunding: optStr,
      feesPaid: optStr,
      openTimestamp: optStr,
      closeTimestamp: optStr,
    }).passthrough()).optional().default([]),
  }).passthrough().optional().nullable(),
}).passthrough()

// ============================================
// BingX Futures
// ============================================

export const BingxFuturesLeaderboardResponseSchema = z.object({
  code: optInt,
  data: z.object({
    list: z.array(z.object({
      uniqueId: optStr,
      traderName: optStr,
      headUrl: optStr,
      roi: optNum,
      pnl: optNum,
      followerNum: optInt,
      copyNum: optInt,
      winRate: optNum,
      maxDrawdown: optNum,
      aum: optNum,
    }).passthrough()).optional().default([]),
  }).passthrough().optional().nullable(),
}).passthrough()

export const BingxFuturesDetailResponseSchema = z.object({
  code: optInt,
  data: z.object({
    uniqueId: optStr,
    traderName: optStr,
    headUrl: optStr,
    roi: optNum,
    pnl: optNum,
    followerNum: optInt,
    copyNum: optInt,
    winRate: optNum,
    maxDrawdown: optNum,
    aum: optNum,
  }).passthrough().optional().nullable(),
}).passthrough()

// ============================================
// BloFin Futures
// ============================================

export const BlofinFuturesLeaderboardResponseSchema = z.object({
  code: optInt,
  data: z.object({
    list: z.array(z.object({
      traderId: optStr,
      nickName: optStr,
      avatar: optStr,
      roi: optNum,
      pnl: optNum,
      followers: optInt,
      winRate: optNum,
      sharpeRatio: optNum,
      maxDrawdown: optNum,
    }).passthrough()).optional().default([]),
  }).passthrough().optional().nullable(),
}).passthrough()

export const BlofinFuturesDetailResponseSchema = z.object({
  code: optInt,
  data: z.object({
    traderId: optStr,
    nickName: optStr,
    avatar: optStr,
    roi: optNum,
    pnl: optNum,
    followers: optInt,
    winRate: optNum,
    sharpeRatio: optNum,
    maxDrawdown: optNum,
  }).passthrough().optional().nullable(),
}).passthrough()

// ============================================
// Phemex Futures
// ============================================

export const PhemexFuturesLeaderboardResponseSchema = z.object({
  code: optInt,
  data: z.object({
    rows: z.array(z.object({
      uid: optStr,
      nickname: optStr,
      avatar: optStr,
      roi: optNum,
      pnl: optNum,
      winRate: optNum,
      maxDrawdown: optNum,
      followers: optInt,
      copiers: optInt,
    }).passthrough()).optional().default([]),
    total: optInt,
  }).passthrough().optional().nullable(),
}).passthrough()

export const PhemexFuturesDetailResponseSchema = z.object({
  code: optInt,
  data: z.object({
    uid: optStr,
    nickname: optStr,
    avatar: optStr,
    roi: optNum,
    pnl: optNum,
    winRate: optNum,
    maxDrawdown: optNum,
    followers: optInt,
    copiers: optInt,
  }).passthrough().optional().nullable(),
}).passthrough()

// ============================================
// BitMart Futures
// ============================================

export const BitmartFuturesLeaderboardResponseSchema = z.object({
  code: optInt,
  data: z.object({
    list: z.array(z.object({
      traderId: optStr,
      nickname: optStr,
      avatar: optStr,
      roi: optNum,
      pnl: optNum,
      followers: optInt,
      copiers: optInt,
    }).passthrough()).optional().default([]),
  }).passthrough().optional().nullable(),
}).passthrough()

export const BitmartFuturesDetailResponseSchema = z.object({
  code: optInt,
  data: z.object({
    traderId: optStr,
    nickname: optStr,
    avatar: optStr,
    roi: optNum,
    pnl: optNum,
    followers: optInt,
    copiers: optInt,
  }).passthrough().optional().nullable(),
}).passthrough()

// ============================================
// LBank Futures
// ============================================

export const LbankFuturesLeaderboardResponseSchema = z.object({
  data: z.object({
    list: z.array(z.object({
      uid: optStr,
      nickname: optStr,
      avatar: optStr,
      roi: optNum,
      pnl: optNum,
      followers: optInt,
      winRate: optNum,
    }).passthrough()).optional().default([]),
  }).passthrough().optional().nullable(),
}).passthrough()

// ============================================
// WEEX Futures
// ============================================

export const WeexFuturesLeaderboardResponseSchema = z.object({
  code: optInt,
  data: z.object({
    list: z.array(z.object({
      uid: optStr,
      nickname: optStr,
      avatar: optStr,
      roi: optNum,
      pnl: optNum,
      winRate: optNum,
      maxDrawdown: optNum,
      followers: optInt,
      copiers: optInt,
    }).passthrough()).optional().default([]),
  }).passthrough().optional().nullable(),
}).passthrough()

export const WeexFuturesDetailResponseSchema = z.object({
  code: optInt,
  data: z.object({
    uid: optStr,
    nickname: optStr,
    avatar: optStr,
    roi: optNum,
    pnl: optNum,
    winRate: optNum,
    maxDrawdown: optNum,
    followers: optInt,
    copiers: optInt,
  }).passthrough().optional().nullable(),
}).passthrough()

// ============================================
// XT Futures
// ============================================

export const XtFuturesLeaderboardResponseSchema = z.object({
  code: optInt,
  data: z.object({
    list: z.array(z.object({
      uid: optStr,
      nickname: optStr,
      avatar: optStr,
      roi: optNum,
      pnl: optNum,
      followerCount: optInt,
      copyCount: optInt,
      winRate: optNum,
      maxDrawdown: optNum,
      aum: optNum,
    }).passthrough()).optional().default([]),
  }).passthrough().optional().nullable(),
}).passthrough()

export const XtFuturesDetailResponseSchema = z.object({
  code: optInt,
  data: z.object({
    uid: optStr,
    nickname: optStr,
    avatar: optStr,
    roi: optNum,
    pnl: optNum,
    followerCount: optInt,
    copyCount: optInt,
    winRate: optNum,
    maxDrawdown: optNum,
    aum: optNum,
  }).passthrough().optional().nullable(),
}).passthrough()

// ============================================
// Pionex Futures
// ============================================

export const PionexFuturesDiscoverResponseSchema = z.object({
  data: z.object({
    bots: z.array(z.object({
      botId: optStr,
      botName: optStr,
      creatorId: optStr,
      creatorName: optStr,
      roi: optNum,
      pnl: optNum,
      copiers: optInt,
      aum: optNum,
    }).passthrough()).optional().default([]),
  }).passthrough().optional().nullable(),
}).passthrough()

// ============================================
// MUX Perp
// ============================================

export const MuxAccountsResponseSchema = z.object({
  data: z.object({
    accounts: z.array(z.object({
      id: z.string(),
      cumulativeVolumeUSD: optStr,
      cumulativePnlUSD: optStr,
      cumulativeFeeUSD: optStr,
      openPositionCount: optInt,
      closedPositionCount: optInt,
    }).passthrough()).optional().default([]),
  }).passthrough().optional().nullable(),
}).passthrough()

export const MuxAccountResponseSchema = z.object({
  data: z.object({
    account: z.object({
      id: optStr,
      cumulativeVolumeUSD: optStr,
      cumulativePnlUSD: optStr,
      cumulativeFeeUSD: optStr,
      openPositionCount: optInt,
      closedPositionCount: optInt,
    }).passthrough().optional().nullable(),
  }).passthrough().optional().nullable(),
}).passthrough()

export const MuxPositionsResponseSchema = z.object({
  data: z.object({
    positions: z.array(z.object({
      id: optStr,
      account: optStr,
      isLong: z.boolean().optional(),
      sizeUSD: optStr,
      collateralUSD: optStr,
      realisedPnlUSD: optStr,
      closedAtTimestamp: optStr,
      status: optStr,
    }).passthrough()).optional().default([]),
  }).passthrough().optional().nullable(),
}).passthrough()
