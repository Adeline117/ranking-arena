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

export type TraderPageData = Record<string, any>

export type ProfileTabKey = 'overview' | 'stats' | 'portfolio'

export interface UserProfileClientProps {
  handle: string
  serverProfile: ServerProfile | null
  serverTraderData?: TraderPageData | null
}
