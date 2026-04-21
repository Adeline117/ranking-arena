/**
 * Trading Personality Quiz — Type definitions
 */

export type PersonalityTypeId =
  | 'sniper'
  | 'scalper'
  | 'whale'
  | 'analyst'
  | 'contrarian'
  | 'hodler'
  | 'degen'
  | 'strategist'

export interface PersonalityType {
  id: PersonalityTypeId
  nameKey: string
  icon: string // SVG icon name or text symbol (no emoji)
  color: string
  gradient: string
  descriptionKey: string
  strengthKeys: [string, string, string]
  weaknessKeys: [string, string, string]
  styleKey: string
  riskLevel: 1 | 2 | 3 | 4 | 5
  timeHorizon: 'short' | 'medium' | 'long'
  compatibleTypes: PersonalityTypeId[]
  incompatibleTypes: PersonalityTypeId[]
  master: TradingMaster
}

export interface TradingMaster {
  nameKey: string
  yearsKey: string
  taglineKey: string
  bioKeys: [string, string, string]
  famousTradeKey: string
  quoteKey: string
}

export interface QuizOption {
  id: string
  labelKey: string
  scores: Partial<Record<PersonalityTypeId, number>>
}

export interface QuizQuestion {
  id: number
  titleKey: string
  options: QuizOption[]
}

export interface QuizResult {
  primaryType: PersonalityTypeId
  secondaryType: PersonalityTypeId
  scores: Record<PersonalityTypeId, number>
  matchPercent: number
}

export interface QuizState {
  currentQuestion: number // 0 = start, 1-15 = questions, 16 = calculating
  answers: Record<number, string>
  result: QuizResult | null

  setAnswer: (questionId: number, optionId: string) => void
  goToQuestion: (n: number) => void
  setResult: (result: QuizResult) => void
  reset: () => void
}

export interface RecommendedTrader {
  handle: string
  name: string
  avatar_url: string | null
  platform: string
  roi_90d: number | null
  arena_score: number | null
  win_rate: number | null
  pnl_90d: number | null
}
