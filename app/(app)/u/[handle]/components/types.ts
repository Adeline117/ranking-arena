import type {
  TraderProfile,
  TraderPerformance,
  TraderStats,
  PortfolioItem,
  TraderFeedItem,
} from '@/lib/data/trader'

export interface ServerProfile {
  id: string
  handle: string
  bio?: string
  avatar_url?: string
  cover_url?: string
  show_followers?: boolean
  show_following?: boolean
  followers: number
  following: number
  followingTraders: number
  isRegistered: boolean
  isVerifiedTrader?: boolean
  proBadgeTier: 'pro' | null
  role?: string
  traderHandle?: string
  exp?: number
}

export interface EquityCurveData {
  '90D': Array<{ date: string; roi: number; pnl: number }>
  '30D': Array<{ date: string; roi: number; pnl: number }>
  '7D': Array<{ date: string; roi: number; pnl: number }>
}

export interface AssetBreakdownData {
  '90D': Array<{ symbol: string; weightPct: number }>
  '30D': Array<{ symbol: string; weightPct: number }>
  '7D': Array<{ symbol: string; weightPct: number }>
}

export interface PositionHistoryEntry {
  symbol: string
  direction: 'long' | 'short'
  positionType: string
  marginMode: string
  openTime: string
  closeTime: string
  entryPrice: number
  exitPrice: number
  maxPositionSize: number
  closedSize: number
  pnlUsd: number
  pnlPct: number
  status: string
}

/** @deprecated Use TraderDetail from lib/types/unified-trader.ts */
export type TraderPageData = {
  profile?: TraderProfile | null
  performance?: TraderPerformance | null
  stats?: TraderStats | null
  portfolio?: PortfolioItem[]
  positionHistory?: PositionHistoryEntry[]
  feed?: TraderFeedItem[]
  similarTraders?: (TraderProfile & { roi_90d?: number; arena_score?: number })[]
  equityCurve?: EquityCurveData
  assetBreakdown?: AssetBreakdownData
  positionSummary?: {
    avgLeverage: number | null
    longPositions: number | null
    shortPositions: number | null
    totalPositions: number | null
    totalMarginUsd: number | null
    totalUnrealizedPnl: number | null
  } | null
  trackedSince?: string
  lastUpdated?: string | null
}

export type ProfileTabKey = 'overview' | 'stats' | 'portfolio'

export interface UserProfileClientProps {
  handle: string
  serverProfile: ServerProfile | null
  serverTraderData?: TraderPageData | null
}
