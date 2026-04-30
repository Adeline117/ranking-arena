/**
 * Trading Personality Quiz — Data definitions
 *
 * 12 personality types (each with a legendary trader master)
 * 15 questions across 10+ dimensions
 *
 * All user-facing strings use i18n keys (quizXxx).
 * Translations in lib/i18n/{en,zh,ja,ko}.ts.
 */

import type { PersonalityType, QuizQuestion } from './types'

// ─── 12 Personality Types ────────────────────────────────────────────

export const PERSONALITY_TYPES: PersonalityType[] = [
  {
    id: 'sniper',
    nameKey: 'quizTypeSniper',
    icon: 'crosshair',
    color: '#8B5CF6',
    gradient: 'linear-gradient(135deg, #8B5CF6 0%, #7C3AED 100%)',
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
    color: '#3B82F6',
    gradient: 'linear-gradient(135deg, #3B82F6 0%, #2563EB 100%)',
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
    color: '#16A34A',
    gradient: 'linear-gradient(135deg, #16A34A 0%, #15803D 100%)',
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
    color: '#7C3AED',
    gradient: 'linear-gradient(135deg, #7C3AED 0%, #6D28D9 100%)',
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
    color: '#DC2626',
    gradient: 'linear-gradient(135deg, #DC2626 0%, #B91C1C 100%)',
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
    color: '#6D28D9',
    gradient: 'linear-gradient(135deg, #6D28D9 0%, #5B21B6 100%)',
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
  {
    id: 'copycat',
    nameKey: 'quizTypeCopycat',
    icon: 'users',
    color: '#2563EB',
    gradient: 'linear-gradient(135deg, #2563EB 0%, #1D4ED8 100%)',
    descriptionKey: 'quizTypeCopycatDesc',
    strengthKeys: ['quizTypeCopycatStr1', 'quizTypeCopycatStr2', 'quizTypeCopycatStr3'],
    weaknessKeys: ['quizTypeCopycatWeak1', 'quizTypeCopycatWeak2', 'quizTypeCopycatWeak3'],
    styleKey: 'quizTypeCopycatStyle',
    riskLevel: 3,
    timeHorizon: 'medium',
    compatibleTypes: ['strategist', 'analyst'],
    incompatibleTypes: ['contrarian'],
    master: {
      nameKey: 'quizMasterCopycatName',
      yearsKey: 'quizMasterCopycatYears',
      taglineKey: 'quizMasterCopycatTag',
      bioKeys: ['quizMasterCopycatBio1', 'quizMasterCopycatBio2', 'quizMasterCopycatBio3'],
      famousTradeKey: 'quizMasterCopycatTrade',
      quoteKey: 'quizMasterCopycatQuote',
    },
  },
  {
    id: 'tourist',
    nameKey: 'quizTypeTourist',
    icon: 'compass',
    color: '#60A5FA',
    gradient: 'linear-gradient(135deg, #60A5FA 0%, #3B82F6 100%)',
    descriptionKey: 'quizTypeTouristDesc',
    strengthKeys: ['quizTypeTouristStr1', 'quizTypeTouristStr2', 'quizTypeTouristStr3'],
    weaknessKeys: ['quizTypeTouristWeak1', 'quizTypeTouristWeak2', 'quizTypeTouristWeak3'],
    styleKey: 'quizTypeTouristStyle',
    riskLevel: 3,
    timeHorizon: 'short',
    compatibleTypes: ['copycat', 'hodler'],
    incompatibleTypes: ['analyst', 'strategist'],
    master: {
      nameKey: 'quizMasterTouristName',
      yearsKey: 'quizMasterTouristYears',
      taglineKey: 'quizMasterTouristTag',
      bioKeys: ['quizMasterTouristBio1', 'quizMasterTouristBio2', 'quizMasterTouristBio3'],
      famousTradeKey: 'quizMasterTouristTrade',
      quoteKey: 'quizMasterTouristQuote',
    },
  },
  {
    id: 'paperhands',
    nameKey: 'quizTypePaperhands',
    icon: 'hand',
    color: '#F87171',
    gradient: 'linear-gradient(135deg, #F87171 0%, #EF4444 100%)',
    descriptionKey: 'quizTypePaperhandsDesc',
    strengthKeys: ['quizTypePaperhandsStr1', 'quizTypePaperhandsStr2', 'quizTypePaperhandsStr3'],
    weaknessKeys: ['quizTypePaperhandsWeak1', 'quizTypePaperhandsWeak2', 'quizTypePaperhandsWeak3'],
    styleKey: 'quizTypePaperhandsStyle',
    riskLevel: 1,
    timeHorizon: 'short',
    compatibleTypes: ['scalper', 'tourist'],
    incompatibleTypes: ['hodler', 'whale'],
    master: {
      nameKey: 'quizMasterPaperhandsName',
      yearsKey: 'quizMasterPaperhandsYears',
      taglineKey: 'quizMasterPaperhandsTag',
      bioKeys: ['quizMasterPaperhandsBio1', 'quizMasterPaperhandsBio2', 'quizMasterPaperhandsBio3'],
      famousTradeKey: 'quizMasterPaperhandsTrade',
      quoteKey: 'quizMasterPaperhandsQuote',
    },
  },
  {
    id: 'narrator',
    nameKey: 'quizTypeNarrator',
    icon: 'megaphone',
    color: '#22C55E',
    gradient: 'linear-gradient(135deg, #22C55E 0%, #16A34A 100%)',
    descriptionKey: 'quizTypeNarratorDesc',
    strengthKeys: ['quizTypeNarratorStr1', 'quizTypeNarratorStr2', 'quizTypeNarratorStr3'],
    weaknessKeys: ['quizTypeNarratorWeak1', 'quizTypeNarratorWeak2', 'quizTypeNarratorWeak3'],
    styleKey: 'quizTypeNarratorStyle',
    riskLevel: 4,
    timeHorizon: 'long',
    compatibleTypes: ['hodler', 'whale'],
    incompatibleTypes: ['scalper'],
    master: {
      nameKey: 'quizMasterNarratorName',
      yearsKey: 'quizMasterNarratorYears',
      taglineKey: 'quizMasterNarratorTag',
      bioKeys: ['quizMasterNarratorBio1', 'quizMasterNarratorBio2', 'quizMasterNarratorBio3'],
      famousTradeKey: 'quizMasterNarratorTrade',
      quoteKey: 'quizMasterNarratorQuote',
    },
  },
]

// Helper lookup
export const PERSONALITY_TYPE_MAP = Object.fromEntries(
  PERSONALITY_TYPES.map((t) => [t.id, t])
) as Record<string, PersonalityType>

/**
 * Contrast-safe text colors for dark backgrounds.
 * Some type colors (amber, emerald, slate) fail WCAG 4.5:1 AA when used as foreground text
 * on dark glass backgrounds. These lightened variants maintain brand identity with proper contrast.
 */
export const TYPE_TEXT_COLOR: Record<string, string> = {
  // Overrides only for types whose base color has poor contrast on BOTH light and dark glass.
  // Most types use their base color directly.
}

// ─── 15 Quiz Questions ──────────────────────────────────────────────

export const QUIZ_QUESTIONS: QuizQuestion[] = [
  // Q1 — Risk tolerance
  {
    id: 1,
    titleKey: 'quizQ1',
    options: [
      { id: 'a', labelKey: 'quizQ1A', scores: { contrarian: 1.0, whale: 0.5 } },
      { id: 'b', labelKey: 'quizQ1B', scores: { paperhands: 1.0, strategist: 0.5, analyst: 0.25 } },
      { id: 'c', labelKey: 'quizQ1C', scores: { tourist: 1.0, hodler: 0.5 } },
      { id: 'd', labelKey: 'quizQ1D', scores: { scalper: 0.5, degen: 1.0 } },
    ],
  },
  // Q2 — Time horizon
  {
    id: 2,
    titleKey: 'quizQ2',
    options: [
      { id: 'a', labelKey: 'quizQ2A', scores: { scalper: 1.0, degen: 0.5, tourist: 0.25 } },
      { id: 'b', labelKey: 'quizQ2B', scores: { sniper: 1.0, copycat: 0.5 } },
      { id: 'c', labelKey: 'quizQ2C', scores: { whale: 0.5, strategist: 1.0, paperhands: 0.25 } },
      { id: 'd', labelKey: 'quizQ2D', scores: { narrator: 1.0, hodler: 0.5 } },
    ],
  },
  // Q3 — Decision-making style (Yes/No)
  {
    id: 3,
    format: 'yesno',
    titleKey: 'quizQ3',
    options: [
      { id: 'yes', labelKey: 'quizYes', scores: { analyst: 1.0, sniper: 0.5, strategist: 0.25 } },
      { id: 'no', labelKey: 'quizNo', scores: { degen: 0.5, narrator: 1.0, scalper: 0.25 } },
      { id: 'unsure', labelKey: 'quizUnsure', scores: { strategist: 1.0, copycat: 0.5 } },
    ],
  },
  // Q4 — Reaction to losses
  {
    id: 4,
    titleKey: 'quizQ4',
    options: [
      { id: 'a', labelKey: 'quizQ4A', scores: { hodler: 1.0, whale: 0.5, narrator: 0.25 } },
      { id: 'b', labelKey: 'quizQ4B', scores: { sniper: 1.0, analyst: 0.5 } },
      { id: 'c', labelKey: 'quizQ4C', scores: { contrarian: 1.0, copycat: 0.5 } },
      { id: 'd', labelKey: 'quizQ4D', scores: { paperhands: 1.0, strategist: 0.5, scalper: 0.25 } },
    ],
  },
  // Q5 — Market analysis approach
  {
    id: 5,
    titleKey: 'quizQ5',
    options: [
      { id: 'a', labelKey: 'quizQ5A', scores: { analyst: 1.0, strategist: 0.5, tourist: 0.25 } },
      { id: 'b', labelKey: 'quizQ5B', scores: { sniper: 1.0, scalper: 0.5 } },
      { id: 'c', labelKey: 'quizQ5C', scores: { contrarian: 1.0, whale: 0.25 } },
      { id: 'd', labelKey: 'quizQ5D', scores: { copycat: 0.5, degen: 0.5, hodler: 0.25 } },
    ],
  },
  // Q6 — Social trading (Yes/No)
  {
    id: 6,
    format: 'yesno',
    titleKey: 'quizQ6',
    options: [
      { id: 'yes', labelKey: 'quizYes', scores: { copycat: 1.0, degen: 0.25 } },
      { id: 'no', labelKey: 'quizNo', scores: { contrarian: 0.5, sniper: 0.5, tourist: 1.0 } },
      { id: 'unsure', labelKey: 'quizUnsure', scores: { strategist: 0.5, hodler: 0.25 } },
    ],
  },
  // Q7 — Portfolio management
  {
    id: 7,
    titleKey: 'quizQ7',
    options: [
      { id: 'a', labelKey: 'quizQ7A', scores: { whale: 1.0, sniper: 0.5 } },
      { id: 'b', labelKey: 'quizQ7B', scores: { degen: 1.0, scalper: 0.5 } },
      { id: 'c', labelKey: 'quizQ7C', scores: { paperhands: 1.0, analyst: 0.5, strategist: 0.25 } },
      { id: 'd', labelKey: 'quizQ7D', scores: { hodler: 1.0, contrarian: 0.25 } },
    ],
  },
  // Q8 — Risk tolerance deeper (Yes/No)
  {
    id: 8,
    format: 'yesno',
    titleKey: 'quizQ8',
    options: [
      { id: 'yes', labelKey: 'quizYes', scores: { degen: 1.0, whale: 0.5, scalper: 0.25 } },
      { id: 'no', labelKey: 'quizNo', scores: { tourist: 1.0, strategist: 0.5, hodler: 0.25 } },
      { id: 'unsure', labelKey: 'quizUnsure', scores: { analyst: 0.5, sniper: 0.25 } },
    ],
  },
  // Q9 — Reaction to gains
  {
    id: 9,
    titleKey: 'quizQ11',
    options: [
      { id: 'a', labelKey: 'quizQ11A', scores: { scalper: 1.0, sniper: 0.5 } },
      { id: 'b', labelKey: 'quizQ11B', scores: { hodler: 1.0, whale: 0.5, narrator: 0.25 } },
      {
        id: 'c',
        labelKey: 'quizQ11C',
        scores: { paperhands: 1.0, analyst: 0.25, strategist: 0.25 },
      },
      { id: 'd', labelKey: 'quizQ11D', scores: { degen: 1.0, contrarian: 0.5 } },
    ],
  },
  // Q10 — Risk scenario
  {
    id: 10,
    titleKey: 'quizQ13',
    options: [
      { id: 'a', labelKey: 'quizQ13A', scores: { degen: 1.0, scalper: 0.5 } },
      { id: 'b', labelKey: 'quizQ13B', scores: { contrarian: 1.0, whale: 0.25 } },
      {
        id: 'c',
        labelKey: 'quizQ13C',
        scores: { strategist: 1.0, analyst: 0.5, paperhands: 0.25 },
      },
      { id: 'd', labelKey: 'quizQ13D', scores: { tourist: 1.0, sniper: 0.25, hodler: 0.25 } },
    ],
  },
  // Q11 — Staying informed
  {
    id: 11,
    titleKey: 'quizQ14',
    options: [
      { id: 'a', labelKey: 'quizQ14A', scores: { analyst: 1.0, sniper: 0.5 } },
      { id: 'b', labelKey: 'quizQ14B', scores: { whale: 1.0, contrarian: 0.5 } },
      { id: 'c', labelKey: 'quizQ14C', scores: { copycat: 1.0, scalper: 0.5, degen: 0.25 } },
      { id: 'd', labelKey: 'quizQ14D', scores: { hodler: 1.0, strategist: 0.5 } },
    ],
  },
  // Q12 — New token listing
  {
    id: 12,
    titleKey: 'quizQ17',
    options: [
      { id: 'a', labelKey: 'quizQ17A', scores: { narrator: 1.0, hodler: 0.25 } },
      { id: 'b', labelKey: 'quizQ17B', scores: { scalper: 1.0, degen: 0.5 } },
      { id: 'c', labelKey: 'quizQ17C', scores: { contrarian: 1.0, analyst: 0.25 } },
      { id: 'd', labelKey: 'quizQ17D', scores: { sniper: 0.5, copycat: 1.0 } },
    ],
  },
  // Q13 — Extreme positive funding rates
  {
    id: 13,
    titleKey: 'quizQ24',
    options: [
      { id: 'a', labelKey: 'quizQ24A', scores: { tourist: 1.0, paperhands: 0.25 } },
      { id: 'b', labelKey: 'quizQ24B', scores: { contrarian: 1.0, sniper: 0.5 } },
      { id: 'c', labelKey: 'quizQ24C', scores: { scalper: 1.0, degen: 0.5 } },
      { id: 'd', labelKey: 'quizQ24D', scores: { hodler: 0.5, narrator: 1.0 } },
    ],
  },
  // Q14 — Narrative vs chart (Yes/No)
  {
    id: 14,
    format: 'yesno',
    titleKey: 'quizQ28',
    options: [
      { id: 'yes', labelKey: 'quizYes', scores: { narrator: 1.0, copycat: 0.5, hodler: 0.25 } },
      { id: 'no', labelKey: 'quizNo', scores: { analyst: 1.0, sniper: 0.5, scalper: 0.25 } },
      { id: 'unsure', labelKey: 'quizUnsure', scores: { contrarian: 0.5, whale: 0.25 } },
    ],
  },
  // Q15 — What does success in trading mean?
  {
    id: 15,
    titleKey: 'quizQ30',
    options: [
      { id: 'a', labelKey: 'quizQ30A', scores: { strategist: 1.0, narrator: 0.5, hodler: 0.25 } },
      { id: 'b', labelKey: 'quizQ30B', scores: { scalper: 1.0, degen: 0.5, whale: 0.25 } },
      { id: 'c', labelKey: 'quizQ30C', scores: { hodler: 1.0, paperhands: 0.5, tourist: 0.25 } },
      { id: 'd', labelKey: 'quizQ30D', scores: { contrarian: 0.5, sniper: 1.0, copycat: 0.25 } },
    ],
  },
]
