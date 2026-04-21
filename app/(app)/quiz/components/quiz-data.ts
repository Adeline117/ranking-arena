/**
 * Trading Personality Quiz — Data definitions
 *
 * 8 personality types (each with a legendary trader master)
 * 15 questions across 7 dimensions
 *
 * All user-facing strings use i18n keys (quizXxx).
 * Translations in lib/i18n/{en,zh,ja,ko}.ts.
 */

import type { PersonalityType, QuizQuestion } from './types'

// ─── 8 Personality Types ─────────────────────────────────────────────

export const PERSONALITY_TYPES: PersonalityType[] = [
  {
    id: 'sniper',
    nameKey: 'quizTypeSniper',
    icon: 'crosshair',
    color: '#3B82F6',
    gradient: 'linear-gradient(135deg, #3B82F6 0%, #6366F1 100%)',
    descriptionKey: 'quizTypeSniperDesc',
    strengthKeys: ['quizTypeSniperStr1', 'quizTypeSniperStr2', 'quizTypeSniperStr3'],
    weaknessKeys: ['quizTypeSniperWeak1', 'quizTypeSniperWeak2', 'quizTypeSniperWeak3'],
    styleKey: 'quizTypeSniperStyle',
    riskLevel: 2,
    timeHorizon: 'medium',
    compatibleTypes: ['analyst', 'strategist'],
    incompatibleTypes: ['degen'],
    master: {
      nameKey: 'quizMasterSniperName',
      yearsKey: 'quizMasterSniperYears',
      taglineKey: 'quizMasterSniperTag',
      bioKeys: ['quizMasterSniperBio1', 'quizMasterSniperBio2', 'quizMasterSniperBio3'],
      famousTradeKey: 'quizMasterSniperTrade',
      quoteKey: 'quizMasterSniperQuote',
    },
  },
  {
    id: 'scalper',
    nameKey: 'quizTypeScalper',
    icon: 'bolt',
    color: '#F59E0B',
    gradient: 'linear-gradient(135deg, #F59E0B 0%, #F97316 100%)',
    descriptionKey: 'quizTypeScalperDesc',
    strengthKeys: ['quizTypeScalperStr1', 'quizTypeScalperStr2', 'quizTypeScalperStr3'],
    weaknessKeys: ['quizTypeScalperWeak1', 'quizTypeScalperWeak2', 'quizTypeScalperWeak3'],
    styleKey: 'quizTypeScalperStyle',
    riskLevel: 3,
    timeHorizon: 'short',
    compatibleTypes: ['sniper', 'degen'],
    incompatibleTypes: ['hodler'],
    master: {
      nameKey: 'quizMasterScalperName',
      yearsKey: 'quizMasterScalperYears',
      taglineKey: 'quizMasterScalperTag',
      bioKeys: ['quizMasterScalperBio1', 'quizMasterScalperBio2', 'quizMasterScalperBio3'],
      famousTradeKey: 'quizMasterScalperTrade',
      quoteKey: 'quizMasterScalperQuote',
    },
  },
  {
    id: 'whale',
    nameKey: 'quizTypeWhale',
    icon: 'wave',
    color: '#06B6D4',
    gradient: 'linear-gradient(135deg, #06B6D4 0%, #0891B2 100%)',
    descriptionKey: 'quizTypeWhaleDesc',
    strengthKeys: ['quizTypeWhaleStr1', 'quizTypeWhaleStr2', 'quizTypeWhaleStr3'],
    weaknessKeys: ['quizTypeWhaleWeak1', 'quizTypeWhaleWeak2', 'quizTypeWhaleWeak3'],
    styleKey: 'quizTypeWhaleStyle',
    riskLevel: 4,
    timeHorizon: 'medium',
    compatibleTypes: ['contrarian', 'sniper'],
    incompatibleTypes: ['scalper'],
    master: {
      nameKey: 'quizMasterWhaleName',
      yearsKey: 'quizMasterWhaleYears',
      taglineKey: 'quizMasterWhaleTag',
      bioKeys: ['quizMasterWhaleBio1', 'quizMasterWhaleBio2', 'quizMasterWhaleBio3'],
      famousTradeKey: 'quizMasterWhaleTrade',
      quoteKey: 'quizMasterWhaleQuote',
    },
  },
  {
    id: 'analyst',
    nameKey: 'quizTypeAnalyst',
    icon: 'chart',
    color: '#8B5CF6',
    gradient: 'linear-gradient(135deg, #8B5CF6 0%, #7C3AED 100%)',
    descriptionKey: 'quizTypeAnalystDesc',
    strengthKeys: ['quizTypeAnalystStr1', 'quizTypeAnalystStr2', 'quizTypeAnalystStr3'],
    weaknessKeys: ['quizTypeAnalystWeak1', 'quizTypeAnalystWeak2', 'quizTypeAnalystWeak3'],
    styleKey: 'quizTypeAnalystStyle',
    riskLevel: 2,
    timeHorizon: 'medium',
    compatibleTypes: ['sniper', 'strategist'],
    incompatibleTypes: ['degen'],
    master: {
      nameKey: 'quizMasterAnalystName',
      yearsKey: 'quizMasterAnalystYears',
      taglineKey: 'quizMasterAnalystTag',
      bioKeys: ['quizMasterAnalystBio1', 'quizMasterAnalystBio2', 'quizMasterAnalystBio3'],
      famousTradeKey: 'quizMasterAnalystTrade',
      quoteKey: 'quizMasterAnalystQuote',
    },
  },
  {
    id: 'contrarian',
    nameKey: 'quizTypeContrarian',
    icon: 'reverse',
    color: '#EF4444',
    gradient: 'linear-gradient(135deg, #EF4444 0%, #DC2626 100%)',
    descriptionKey: 'quizTypeContrarianDesc',
    strengthKeys: ['quizTypeContrarianStr1', 'quizTypeContrarianStr2', 'quizTypeContrarianStr3'],
    weaknessKeys: ['quizTypeContrarianWeak1', 'quizTypeContrarianWeak2', 'quizTypeContrarianWeak3'],
    styleKey: 'quizTypeContrarianStyle',
    riskLevel: 4,
    timeHorizon: 'medium',
    compatibleTypes: ['whale', 'analyst'],
    incompatibleTypes: ['scalper'],
    master: {
      nameKey: 'quizMasterContrarianName',
      yearsKey: 'quizMasterContrarianYears',
      taglineKey: 'quizMasterContrarianTag',
      bioKeys: ['quizMasterContrarianBio1', 'quizMasterContrarianBio2', 'quizMasterContrarianBio3'],
      famousTradeKey: 'quizMasterContrarianTrade',
      quoteKey: 'quizMasterContrarianQuote',
    },
  },
  {
    id: 'hodler',
    nameKey: 'quizTypeHodler',
    icon: 'diamond',
    color: '#10B981',
    gradient: 'linear-gradient(135deg, #10B981 0%, #059669 100%)',
    descriptionKey: 'quizTypeHodlerDesc',
    strengthKeys: ['quizTypeHodlerStr1', 'quizTypeHodlerStr2', 'quizTypeHodlerStr3'],
    weaknessKeys: ['quizTypeHodlerWeak1', 'quizTypeHodlerWeak2', 'quizTypeHodlerWeak3'],
    styleKey: 'quizTypeHodlerStyle',
    riskLevel: 1,
    timeHorizon: 'long',
    compatibleTypes: ['strategist', 'analyst'],
    incompatibleTypes: ['scalper'],
    master: {
      nameKey: 'quizMasterHodlerName',
      yearsKey: 'quizMasterHodlerYears',
      taglineKey: 'quizMasterHodlerTag',
      bioKeys: ['quizMasterHodlerBio1', 'quizMasterHodlerBio2', 'quizMasterHodlerBio3'],
      famousTradeKey: 'quizMasterHodlerTrade',
      quoteKey: 'quizMasterHodlerQuote',
    },
  },
  {
    id: 'degen',
    nameKey: 'quizTypeDegen',
    icon: 'flame',
    color: '#F97316',
    gradient: 'linear-gradient(135deg, #F97316 0%, #EF4444 100%)',
    descriptionKey: 'quizTypeDegenDesc',
    strengthKeys: ['quizTypeDegenStr1', 'quizTypeDegenStr2', 'quizTypeDegenStr3'],
    weaknessKeys: ['quizTypeDegenWeak1', 'quizTypeDegenWeak2', 'quizTypeDegenWeak3'],
    styleKey: 'quizTypeDegenStyle',
    riskLevel: 5,
    timeHorizon: 'short',
    compatibleTypes: ['scalper', 'whale'],
    incompatibleTypes: ['hodler'],
    master: {
      nameKey: 'quizMasterDegenName',
      yearsKey: 'quizMasterDegenYears',
      taglineKey: 'quizMasterDegenTag',
      bioKeys: ['quizMasterDegenBio1', 'quizMasterDegenBio2', 'quizMasterDegenBio3'],
      famousTradeKey: 'quizMasterDegenTrade',
      quoteKey: 'quizMasterDegenQuote',
    },
  },
  {
    id: 'strategist',
    nameKey: 'quizTypeStrategist',
    icon: 'chess',
    color: '#6366F1',
    gradient: 'linear-gradient(135deg, #6366F1 0%, #4F46E5 100%)',
    descriptionKey: 'quizTypeStrategistDesc',
    strengthKeys: ['quizTypeStrategistStr1', 'quizTypeStrategistStr2', 'quizTypeStrategistStr3'],
    weaknessKeys: ['quizTypeStrategistWeak1', 'quizTypeStrategistWeak2', 'quizTypeStrategistWeak3'],
    styleKey: 'quizTypeStrategistStyle',
    riskLevel: 2,
    timeHorizon: 'long',
    compatibleTypes: ['analyst', 'hodler'],
    incompatibleTypes: ['degen'],
    master: {
      nameKey: 'quizMasterStrategistName',
      yearsKey: 'quizMasterStrategistYears',
      taglineKey: 'quizMasterStrategistTag',
      bioKeys: ['quizMasterStrategistBio1', 'quizMasterStrategistBio2', 'quizMasterStrategistBio3'],
      famousTradeKey: 'quizMasterStrategistTrade',
      quoteKey: 'quizMasterStrategistQuote',
    },
  },
]

// Helper lookup
export const PERSONALITY_TYPE_MAP = Object.fromEntries(
  PERSONALITY_TYPES.map((t) => [t.id, t])
) as Record<string, PersonalityType>

// ─── 15 Quiz Questions ──────────────────────────────────────────────

export const QUIZ_QUESTIONS: QuizQuestion[] = [
  // Q1 — Risk tolerance
  {
    id: 1,
    titleKey: 'quizQ1',
    options: [
      { id: 'a', labelKey: 'quizQ1A', scores: { contrarian: 1.0, whale: 0.5 } },
      { id: 'b', labelKey: 'quizQ1B', scores: { analyst: 1.0, strategist: 0.5 } },
      { id: 'c', labelKey: 'quizQ1C', scores: { hodler: 1.0 } },
      { id: 'd', labelKey: 'quizQ1D', scores: { scalper: 0.5, degen: 1.0 } },
    ],
  },
  // Q2 — Time horizon
  {
    id: 2,
    titleKey: 'quizQ2',
    options: [
      { id: 'a', labelKey: 'quizQ2A', scores: { scalper: 1.0, degen: 0.5 } },
      { id: 'b', labelKey: 'quizQ2B', scores: { sniper: 1.0, contrarian: 0.5 } },
      { id: 'c', labelKey: 'quizQ2C', scores: { whale: 0.5, strategist: 1.0 } },
      { id: 'd', labelKey: 'quizQ2D', scores: { hodler: 1.0 } },
    ],
  },
  // Q3 — Decision-making style
  {
    id: 3,
    titleKey: 'quizQ3',
    options: [
      { id: 'a', labelKey: 'quizQ3A', scores: { analyst: 1.0, sniper: 0.5 } },
      { id: 'b', labelKey: 'quizQ3B', scores: { degen: 1.0, scalper: 0.25 } },
      { id: 'c', labelKey: 'quizQ3C', scores: { contrarian: 0.5, whale: 1.0 } },
      { id: 'd', labelKey: 'quizQ3D', scores: { strategist: 1.0, hodler: 0.5 } },
    ],
  },
  // Q4 — Reaction to losses
  {
    id: 4,
    titleKey: 'quizQ4',
    options: [
      { id: 'a', labelKey: 'quizQ4A', scores: { hodler: 1.0, whale: 0.5 } },
      { id: 'b', labelKey: 'quizQ4B', scores: { sniper: 1.0, analyst: 0.5 } },
      { id: 'c', labelKey: 'quizQ4C', scores: { contrarian: 1.0, degen: 0.25 } },
      { id: 'd', labelKey: 'quizQ4D', scores: { scalper: 1.0, strategist: 0.5 } },
    ],
  },
  // Q5 — Market analysis approach
  {
    id: 5,
    titleKey: 'quizQ5',
    options: [
      { id: 'a', labelKey: 'quizQ5A', scores: { analyst: 1.0, strategist: 0.5 } },
      { id: 'b', labelKey: 'quizQ5B', scores: { sniper: 1.0, scalper: 0.5 } },
      { id: 'c', labelKey: 'quizQ5C', scores: { contrarian: 1.0, whale: 0.25 } },
      { id: 'd', labelKey: 'quizQ5D', scores: { degen: 1.0, hodler: 0.25 } },
    ],
  },
  // Q6 — Social trading behavior
  {
    id: 6,
    titleKey: 'quizQ6',
    options: [
      { id: 'a', labelKey: 'quizQ6A', scores: { degen: 1.0, scalper: 0.25 } },
      { id: 'b', labelKey: 'quizQ6B', scores: { analyst: 1.0, sniper: 0.5 } },
      { id: 'c', labelKey: 'quizQ6C', scores: { contrarian: 1.0 } },
      { id: 'd', labelKey: 'quizQ6D', scores: { hodler: 0.5, strategist: 1.0 } },
    ],
  },
  // Q7 — Portfolio management
  {
    id: 7,
    titleKey: 'quizQ7',
    options: [
      { id: 'a', labelKey: 'quizQ7A', scores: { whale: 1.0, sniper: 0.5 } },
      { id: 'b', labelKey: 'quizQ7B', scores: { scalper: 0.5, degen: 1.0 } },
      { id: 'c', labelKey: 'quizQ7C', scores: { strategist: 1.0, analyst: 0.5 } },
      { id: 'd', labelKey: 'quizQ7D', scores: { hodler: 1.0, contrarian: 0.25 } },
    ],
  },
  // Q8 — Risk tolerance (deeper)
  {
    id: 8,
    titleKey: 'quizQ8',
    options: [
      { id: 'a', labelKey: 'quizQ8A', scores: { degen: 1.0, whale: 0.5 } },
      { id: 'b', labelKey: 'quizQ8B', scores: { scalper: 1.0, sniper: 0.5 } },
      { id: 'c', labelKey: 'quizQ8C', scores: { strategist: 1.0, analyst: 0.5 } },
      { id: 'd', labelKey: 'quizQ8D', scores: { hodler: 1.0, contrarian: 0.25 } },
    ],
  },
  // Q9 — Time horizon (deeper)
  {
    id: 9,
    titleKey: 'quizQ9',
    options: [
      { id: 'a', labelKey: 'quizQ9A', scores: { scalper: 1.0 } },
      { id: 'b', labelKey: 'quizQ9B', scores: { sniper: 1.0, analyst: 0.25 } },
      { id: 'c', labelKey: 'quizQ9C', scores: { whale: 0.5, strategist: 1.0 } },
      { id: 'd', labelKey: 'quizQ9D', scores: { hodler: 1.0, contrarian: 0.5 } },
    ],
  },
  // Q10 — Decision-making (deeper)
  {
    id: 10,
    titleKey: 'quizQ10',
    options: [
      { id: 'a', labelKey: 'quizQ10A', scores: { whale: 1.0, contrarian: 0.5 } },
      { id: 'b', labelKey: 'quizQ10B', scores: { analyst: 1.0, strategist: 0.25 } },
      { id: 'c', labelKey: 'quizQ10C', scores: { sniper: 1.0, scalper: 0.5 } },
      { id: 'd', labelKey: 'quizQ10D', scores: { degen: 1.0, hodler: 0.25 } },
    ],
  },
  // Q11 — Reaction to gains
  {
    id: 11,
    titleKey: 'quizQ11',
    options: [
      { id: 'a', labelKey: 'quizQ11A', scores: { scalper: 1.0, sniper: 0.5 } },
      { id: 'b', labelKey: 'quizQ11B', scores: { hodler: 1.0, whale: 0.5 } },
      { id: 'c', labelKey: 'quizQ11C', scores: { strategist: 1.0, analyst: 0.25 } },
      { id: 'd', labelKey: 'quizQ11D', scores: { degen: 1.0, contrarian: 0.5 } },
    ],
  },
  // Q12 — Market analysis (deeper)
  {
    id: 12,
    titleKey: 'quizQ12',
    options: [
      { id: 'a', labelKey: 'quizQ12A', scores: { analyst: 1.0, strategist: 0.5 } },
      { id: 'b', labelKey: 'quizQ12B', scores: { sniper: 1.0, scalper: 0.25 } },
      { id: 'c', labelKey: 'quizQ12C', scores: { whale: 1.0, contrarian: 0.5 } },
      { id: 'd', labelKey: 'quizQ12D', scores: { degen: 0.5, hodler: 1.0 } },
    ],
  },
  // Q13 — Risk scenario
  {
    id: 13,
    titleKey: 'quizQ13',
    options: [
      { id: 'a', labelKey: 'quizQ13A', scores: { degen: 1.0, scalper: 0.5 } },
      { id: 'b', labelKey: 'quizQ13B', scores: { contrarian: 1.0, whale: 0.25 } },
      { id: 'c', labelKey: 'quizQ13C', scores: { strategist: 1.0, analyst: 0.5 } },
      { id: 'd', labelKey: 'quizQ13D', scores: { hodler: 1.0, sniper: 0.25 } },
    ],
  },
  // Q14 — Social trading (deeper)
  {
    id: 14,
    titleKey: 'quizQ14',
    options: [
      { id: 'a', labelKey: 'quizQ14A', scores: { analyst: 0.5, sniper: 1.0 } },
      { id: 'b', labelKey: 'quizQ14B', scores: { whale: 1.0, contrarian: 0.5 } },
      { id: 'c', labelKey: 'quizQ14C', scores: { degen: 1.0, scalper: 0.5 } },
      { id: 'd', labelKey: 'quizQ14D', scores: { strategist: 1.0, hodler: 0.5 } },
    ],
  },
  // Q15 — Portfolio management (deeper)
  {
    id: 15,
    titleKey: 'quizQ15',
    options: [
      { id: 'a', labelKey: 'quizQ15A', scores: { strategist: 1.0, hodler: 0.5 } },
      { id: 'b', labelKey: 'quizQ15B', scores: { analyst: 1.0, sniper: 0.25 } },
      { id: 'c', labelKey: 'quizQ15C', scores: { whale: 1.0, contrarian: 0.5 } },
      { id: 'd', labelKey: 'quizQ15D', scores: { degen: 1.0, scalper: 0.5 } },
    ],
  },
]
