export interface OnboardingTheme {
  isDark: boolean
  cardBg: string
  cardBorder: string
  textPrimary: string
  textSecondary: string
  optionBg: string
  optionBorder: string
  selectedBg: string
  selectedBorder: string
  brandGradient: string
}

/** @deprecated UI-specific. Will be replaced by UnifiedTrader adapter. */
export type Trader = {
  source: string
  source_trader_id: string
  handle: string | null
  avatar_url: string | null
  roi: number | null
  arena_score: number | null
}

export type Group = {
  id: string
  name: string
  name_en: string | null
  description: string | null
  avatar_url: string | null
  member_count: number | null
}
