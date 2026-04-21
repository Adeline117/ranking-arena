/**
 * Trading Personality Quiz — Data definitions
 *
 * 12 personality types (each with a legendary trader master)
 * 30 questions across 10+ dimensions
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
  {
    id: 'copycat',
    nameKey: 'quizTypeCopycat',
    icon: 'users',
    color: '#EC4899',
    gradient: 'linear-gradient(135deg, #EC4899 0%, #F43F5E 100%)',
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
    id: 'arbitrageur',
    nameKey: 'quizTypeArbitrageur',
    icon: 'scales',
    color: '#14B8A6',
    gradient: 'linear-gradient(135deg, #14B8A6 0%, #06B6D4 100%)',
    descriptionKey: 'quizTypeArbitrageurDesc',
    strengthKeys: ['quizTypeArbitrageurStr1', 'quizTypeArbitrageurStr2', 'quizTypeArbitrageurStr3'],
    weaknessKeys: ['quizTypeArbitrageurWeak1', 'quizTypeArbitrageurWeak2', 'quizTypeArbitrageurWeak3'],
    styleKey: 'quizTypeArbitrageurStyle',
    riskLevel: 1,
    timeHorizon: 'short',
    compatibleTypes: ['analyst', 'gridbot'],
    incompatibleTypes: ['degen'],
    master: {
      nameKey: 'quizMasterArbitrageurName',
      yearsKey: 'quizMasterArbitrageurYears',
      taglineKey: 'quizMasterArbitrageurTag',
      bioKeys: ['quizMasterArbitrageurBio1', 'quizMasterArbitrageurBio2', 'quizMasterArbitrageurBio3'],
      famousTradeKey: 'quizMasterArbitrageurTrade',
      quoteKey: 'quizMasterArbitrageurQuote',
    },
  },
  {
    id: 'gridbot',
    nameKey: 'quizTypeGridbot',
    icon: 'grid',
    color: '#A855F7',
    gradient: 'linear-gradient(135deg, #A855F7 0%, #7C3AED 100%)',
    descriptionKey: 'quizTypeGridbotDesc',
    strengthKeys: ['quizTypeGridbotStr1', 'quizTypeGridbotStr2', 'quizTypeGridbotStr3'],
    weaknessKeys: ['quizTypeGridbotWeak1', 'quizTypeGridbotWeak2', 'quizTypeGridbotWeak3'],
    styleKey: 'quizTypeGridbotStyle',
    riskLevel: 2,
    timeHorizon: 'medium',
    compatibleTypes: ['arbitrageur', 'strategist'],
    incompatibleTypes: ['whale'],
    master: {
      nameKey: 'quizMasterGridbotName',
      yearsKey: 'quizMasterGridbotYears',
      taglineKey: 'quizMasterGridbotTag',
      bioKeys: ['quizMasterGridbotBio1', 'quizMasterGridbotBio2', 'quizMasterGridbotBio3'],
      famousTradeKey: 'quizMasterGridbotTrade',
      quoteKey: 'quizMasterGridbotQuote',
    },
  },
  {
    id: 'narrator',
    nameKey: 'quizTypeNarrator',
    icon: 'megaphone',
    color: '#F43F5E',
    gradient: 'linear-gradient(135deg, #F43F5E 0%, #EF4444 100%)',
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

// ─── 30 Quiz Questions ──────────────────────────────────────────────

export const QUIZ_QUESTIONS: QuizQuestion[] = [
  // Q1 — Risk tolerance
  {
    id: 1,
    titleKey: 'quizQ1',
    options: [
      { id: 'a', labelKey: 'quizQ1A', scores: { contrarian: 1.0, whale: 0.5 } },
      { id: 'b', labelKey: 'quizQ1B', scores: { analyst: 1.0, strategist: 0.5, gridbot: 0.25 } },
      { id: 'c', labelKey: 'quizQ1C', scores: { hodler: 1.0, arbitrageur: 0.25 } },
      { id: 'd', labelKey: 'quizQ1D', scores: { scalper: 0.5, degen: 1.0 } },
    ],
  },
  // Q2 — Time horizon
  {
    id: 2,
    titleKey: 'quizQ2',
    options: [
      { id: 'a', labelKey: 'quizQ2A', scores: { scalper: 1.0, degen: 0.5, arbitrageur: 0.25 } },
      { id: 'b', labelKey: 'quizQ2B', scores: { sniper: 1.0, contrarian: 0.5 } },
      { id: 'c', labelKey: 'quizQ2C', scores: { whale: 0.5, strategist: 1.0, gridbot: 0.25 } },
      { id: 'd', labelKey: 'quizQ2D', scores: { hodler: 1.0, narrator: 0.5 } },
    ],
  },
  // Q3 — Decision-making style
  {
    id: 3,
    titleKey: 'quizQ3',
    options: [
      { id: 'a', labelKey: 'quizQ3A', scores: { analyst: 1.0, sniper: 0.5 } },
      { id: 'b', labelKey: 'quizQ3B', scores: { degen: 1.0, scalper: 0.25, narrator: 0.25 } },
      { id: 'c', labelKey: 'quizQ3C', scores: { contrarian: 0.5, whale: 1.0 } },
      { id: 'd', labelKey: 'quizQ3D', scores: { strategist: 1.0, hodler: 0.5, copycat: 0.25 } },
    ],
  },
  // Q4 — Reaction to losses
  {
    id: 4,
    titleKey: 'quizQ4',
    options: [
      { id: 'a', labelKey: 'quizQ4A', scores: { hodler: 1.0, whale: 0.5, narrator: 0.25 } },
      { id: 'b', labelKey: 'quizQ4B', scores: { sniper: 1.0, analyst: 0.5 } },
      { id: 'c', labelKey: 'quizQ4C', scores: { contrarian: 1.0, degen: 0.25 } },
      { id: 'd', labelKey: 'quizQ4D', scores: { scalper: 1.0, strategist: 0.5, gridbot: 0.25 } },
    ],
  },
  // Q5 — Market analysis approach
  {
    id: 5,
    titleKey: 'quizQ5',
    options: [
      { id: 'a', labelKey: 'quizQ5A', scores: { analyst: 1.0, strategist: 0.5, arbitrageur: 0.25 } },
      { id: 'b', labelKey: 'quizQ5B', scores: { sniper: 1.0, scalper: 0.5 } },
      { id: 'c', labelKey: 'quizQ5C', scores: { contrarian: 1.0, whale: 0.25 } },
      { id: 'd', labelKey: 'quizQ5D', scores: { degen: 1.0, hodler: 0.25, copycat: 0.25 } },
    ],
  },
  // Q6 — Social trading behavior
  {
    id: 6,
    titleKey: 'quizQ6',
    options: [
      { id: 'a', labelKey: 'quizQ6A', scores: { degen: 1.0, scalper: 0.25, copycat: 0.5 } },
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
      { id: 'c', labelKey: 'quizQ7C', scores: { strategist: 1.0, analyst: 0.5, gridbot: 0.25 } },
      { id: 'd', labelKey: 'quizQ7D', scores: { hodler: 1.0, contrarian: 0.25 } },
    ],
  },
  // Q8 — Risk tolerance (deeper)
  {
    id: 8,
    titleKey: 'quizQ8',
    options: [
      { id: 'a', labelKey: 'quizQ8A', scores: { degen: 1.0, whale: 0.5 } },
      { id: 'b', labelKey: 'quizQ8B', scores: { scalper: 1.0, sniper: 0.5, arbitrageur: 0.25 } },
      { id: 'c', labelKey: 'quizQ8C', scores: { strategist: 1.0, analyst: 0.5 } },
      { id: 'd', labelKey: 'quizQ8D', scores: { hodler: 1.0, contrarian: 0.25 } },
    ],
  },
  // Q9 — Time horizon (deeper)
  {
    id: 9,
    titleKey: 'quizQ9',
    options: [
      { id: 'a', labelKey: 'quizQ9A', scores: { scalper: 1.0, arbitrageur: 0.25 } },
      { id: 'b', labelKey: 'quizQ9B', scores: { sniper: 1.0, analyst: 0.25, copycat: 0.25 } },
      { id: 'c', labelKey: 'quizQ9C', scores: { whale: 0.5, strategist: 1.0 } },
      { id: 'd', labelKey: 'quizQ9D', scores: { hodler: 1.0, contrarian: 0.5, narrator: 0.25 } },
    ],
  },
  // Q10 — Decision-making (deeper)
  {
    id: 10,
    titleKey: 'quizQ10',
    options: [
      { id: 'a', labelKey: 'quizQ10A', scores: { whale: 1.0, contrarian: 0.5 } },
      { id: 'b', labelKey: 'quizQ10B', scores: { analyst: 1.0, strategist: 0.25, gridbot: 0.25 } },
      { id: 'c', labelKey: 'quizQ10C', scores: { sniper: 1.0, scalper: 0.5 } },
      { id: 'd', labelKey: 'quizQ10D', scores: { degen: 1.0, hodler: 0.25, narrator: 0.25 } },
    ],
  },
  // Q11 — Reaction to gains
  {
    id: 11,
    titleKey: 'quizQ11',
    options: [
      { id: 'a', labelKey: 'quizQ11A', scores: { scalper: 1.0, sniper: 0.5 } },
      { id: 'b', labelKey: 'quizQ11B', scores: { hodler: 1.0, whale: 0.5, narrator: 0.25 } },
      { id: 'c', labelKey: 'quizQ11C', scores: { strategist: 1.0, analyst: 0.25, gridbot: 0.25 } },
      { id: 'd', labelKey: 'quizQ11D', scores: { degen: 1.0, contrarian: 0.5 } },
    ],
  },
  // Q12 — Market analysis (deeper)
  {
    id: 12,
    titleKey: 'quizQ12',
    options: [
      { id: 'a', labelKey: 'quizQ12A', scores: { analyst: 1.0, strategist: 0.5, arbitrageur: 0.25 } },
      { id: 'b', labelKey: 'quizQ12B', scores: { sniper: 1.0, scalper: 0.25 } },
      { id: 'c', labelKey: 'quizQ12C', scores: { whale: 1.0, contrarian: 0.5 } },
      { id: 'd', labelKey: 'quizQ12D', scores: { degen: 0.5, hodler: 1.0, copycat: 0.25 } },
    ],
  },
  // Q13 — Risk scenario
  {
    id: 13,
    titleKey: 'quizQ13',
    options: [
      { id: 'a', labelKey: 'quizQ13A', scores: { degen: 1.0, scalper: 0.5 } },
      { id: 'b', labelKey: 'quizQ13B', scores: { contrarian: 1.0, whale: 0.25 } },
      { id: 'c', labelKey: 'quizQ13C', scores: { strategist: 1.0, analyst: 0.5, gridbot: 0.25 } },
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
      { id: 'c', labelKey: 'quizQ14C', scores: { degen: 1.0, scalper: 0.5, copycat: 0.25 } },
      { id: 'd', labelKey: 'quizQ14D', scores: { strategist: 1.0, hodler: 0.5 } },
    ],
  },
  // Q15 — Portfolio management (deeper)
  {
    id: 15,
    titleKey: 'quizQ15',
    options: [
      { id: 'a', labelKey: 'quizQ15A', scores: { strategist: 1.0, hodler: 0.5 } },
      { id: 'b', labelKey: 'quizQ15B', scores: { analyst: 1.0, sniper: 0.25, arbitrageur: 0.25 } },
      { id: 'c', labelKey: 'quizQ15C', scores: { whale: 1.0, contrarian: 0.5 } },
      { id: 'd', labelKey: 'quizQ15D', scores: { degen: 1.0, scalper: 0.5 } },
    ],
  },
  // Q16 — Trading journal style
  {
    id: 16,
    titleKey: 'quizQ16',
    options: [
      { id: 'a', labelKey: 'quizQ16A', scores: { copycat: 1.0, strategist: 0.25 } },
      { id: 'b', labelKey: 'quizQ16B', scores: { analyst: 1.0, gridbot: 0.5 } },
      { id: 'c', labelKey: 'quizQ16C', scores: { gridbot: 1.0, arbitrageur: 0.5 } },
      { id: 'd', labelKey: 'quizQ16D', scores: { degen: 1.0, scalper: 0.25 } },
    ],
  },
  // Q17 — New token listing
  {
    id: 17,
    titleKey: 'quizQ17',
    options: [
      { id: 'a', labelKey: 'quizQ17A', scores: { narrator: 1.0, hodler: 0.25 } },
      { id: 'b', labelKey: 'quizQ17B', scores: { degen: 1.0, scalper: 0.5 } },
      { id: 'c', labelKey: 'quizQ17C', scores: { contrarian: 1.0, analyst: 0.25 } },
      { id: 'd', labelKey: 'quizQ17D', scores: { sniper: 1.0, copycat: 0.25 } },
    ],
  },
  // Q18 — Friend asks for trading advice
  {
    id: 18,
    titleKey: 'quizQ18',
    options: [
      { id: 'a', labelKey: 'quizQ18A', scores: { copycat: 1.0, narrator: 0.25 } },
      { id: 'b', labelKey: 'quizQ18B', scores: { strategist: 1.0, analyst: 0.5 } },
      { id: 'c', labelKey: 'quizQ18C', scores: { hodler: 1.0, whale: 0.25 } },
      { id: 'd', labelKey: 'quizQ18D', scores: { degen: 0.5, contrarian: 1.0 } },
    ],
  },
  // Q19 — Cross-exchange price difference
  {
    id: 19,
    titleKey: 'quizQ19',
    options: [
      { id: 'a', labelKey: 'quizQ19A', scores: { arbitrageur: 1.0, analyst: 0.25 } },
      { id: 'b', labelKey: 'quizQ19B', scores: { scalper: 1.0, sniper: 0.5 } },
      { id: 'c', labelKey: 'quizQ19C', scores: { gridbot: 1.0, strategist: 0.25 } },
      { id: 'd', labelKey: 'quizQ19D', scores: { whale: 0.5, hodler: 1.0 } },
    ],
  },
  // Q20 — Bot error at 3 AM
  {
    id: 20,
    titleKey: 'quizQ20',
    options: [
      { id: 'a', labelKey: 'quizQ20A', scores: { gridbot: 1.0, arbitrageur: 0.5 } },
      { id: 'b', labelKey: 'quizQ20B', scores: { analyst: 1.0, strategist: 0.25 } },
      { id: 'c', labelKey: 'quizQ20C', scores: { arbitrageur: 1.0, gridbot: 0.25 } },
      { id: 'd', labelKey: 'quizQ20D', scores: { hodler: 0.5, degen: 1.0 } },
    ],
  },
  // Q21 — New narrative forming
  {
    id: 21,
    titleKey: 'quizQ21',
    options: [
      { id: 'a', labelKey: 'quizQ21A', scores: { narrator: 1.0, whale: 0.25 } },
      { id: 'b', labelKey: 'quizQ21B', scores: { copycat: 1.0, degen: 0.5 } },
      { id: 'c', labelKey: 'quizQ21C', scores: { degen: 1.0, scalper: 0.25 } },
      { id: 'd', labelKey: 'quizQ21D', scores: { analyst: 0.5, contrarian: 1.0 } },
    ],
  },
  // Q22 — Portfolio down 30%, thesis unchanged
  {
    id: 22,
    titleKey: 'quizQ22',
    options: [
      { id: 'a', labelKey: 'quizQ22A', scores: { narrator: 1.0, hodler: 0.5 } },
      { id: 'b', labelKey: 'quizQ22B', scores: { hodler: 1.0, strategist: 0.25 } },
      { id: 'c', labelKey: 'quizQ22C', scores: { contrarian: 1.0, whale: 0.5 } },
      { id: 'd', labelKey: 'quizQ22D', scores: { scalper: 0.5, sniper: 1.0 } },
    ],
  },
  // Q23 — Discover top trader's position
  {
    id: 23,
    titleKey: 'quizQ23',
    options: [
      { id: 'a', labelKey: 'quizQ23A', scores: { copycat: 1.0, degen: 0.25 } },
      { id: 'b', labelKey: 'quizQ23B', scores: { sniper: 1.0, analyst: 0.5 } },
      { id: 'c', labelKey: 'quizQ23C', scores: { whale: 1.0, narrator: 0.25 } },
      { id: 'd', labelKey: 'quizQ23D', scores: { contrarian: 1.0, strategist: 0.25 } },
    ],
  },
  // Q24 — Extreme positive funding rates
  {
    id: 24,
    titleKey: 'quizQ24',
    options: [
      { id: 'a', labelKey: 'quizQ24A', scores: { arbitrageur: 1.0, gridbot: 0.25 } },
      { id: 'b', labelKey: 'quizQ24B', scores: { contrarian: 1.0, sniper: 0.5 } },
      { id: 'c', labelKey: 'quizQ24C', scores: { scalper: 1.0, degen: 0.5 } },
      { id: 'd', labelKey: 'quizQ24D', scores: { analyst: 0.5, narrator: 1.0 } },
    ],
  },
  // Q25 — $10K to deploy in the next hour
  {
    id: 25,
    titleKey: 'quizQ25',
    options: [
      { id: 'a', labelKey: 'quizQ25A', scores: { degen: 1.0, narrator: 0.25 } },
      { id: 'b', labelKey: 'quizQ25B', scores: { scalper: 1.0, arbitrageur: 1.0 } },
      { id: 'c', labelKey: 'quizQ25C', scores: { whale: 1.0, hodler: 0.25 } },
      { id: 'd', labelKey: 'quizQ25D', scores: { strategist: 0.5, gridbot: 1.0 } },
    ],
  },
  // Q26 — Bad news, price hasn't moved
  {
    id: 26,
    titleKey: 'quizQ26',
    options: [
      { id: 'a', labelKey: 'quizQ26A', scores: { sniper: 1.0, scalper: 0.5 } },
      { id: 'b', labelKey: 'quizQ26B', scores: { analyst: 1.0, arbitrageur: 0.25 } },
      { id: 'c', labelKey: 'quizQ26C', scores: { narrator: 1.0, hodler: 0.25 } },
      { id: 'd', labelKey: 'quizQ26D', scores: { contrarian: 0.5, whale: 1.0 } },
    ],
  },
  // Q27 — Grid bot made 2% this week
  {
    id: 27,
    titleKey: 'quizQ27',
    options: [
      { id: 'a', labelKey: 'quizQ27A', scores: { gridbot: 1.0, arbitrageur: 0.5 } },
      { id: 'b', labelKey: 'quizQ27B', scores: { strategist: 1.0, analyst: 0.25 } },
      { id: 'c', labelKey: 'quizQ27C', scores: { arbitrageur: 1.0, gridbot: 0.25 } },
      { id: 'd', labelKey: 'quizQ27D', scores: { degen: 1.0, whale: 0.25 } },
    ],
  },
  // Q28 — CT hyping 100x narrative token
  {
    id: 28,
    titleKey: 'quizQ28',
    options: [
      { id: 'a', labelKey: 'quizQ28A', scores: { narrator: 1.0, copycat: 0.5 } },
      { id: 'b', labelKey: 'quizQ28B', scores: { copycat: 1.0, degen: 0.25 } },
      { id: 'c', labelKey: 'quizQ28C', scores: { degen: 1.0, scalper: 0.5 } },
      { id: 'd', labelKey: 'quizQ28D', scores: { contrarian: 0.5, analyst: 1.0 } },
    ],
  },
  // Q29 — Perfect backtest system, next step
  {
    id: 29,
    titleKey: 'quizQ29',
    options: [
      { id: 'a', labelKey: 'quizQ29A', scores: { gridbot: 1.0, strategist: 0.5 } },
      { id: 'b', labelKey: 'quizQ29B', scores: { analyst: 1.0, arbitrageur: 0.25 } },
      { id: 'c', labelKey: 'quizQ29C', scores: { strategist: 1.0, copycat: 0.25 } },
      { id: 'd', labelKey: 'quizQ29D', scores: { degen: 1.0, whale: 0.5 } },
    ],
  },
  // Q30 — What does success in trading mean?
  {
    id: 30,
    titleKey: 'quizQ30',
    options: [
      { id: 'a', labelKey: 'quizQ30A', scores: { hodler: 1.0, narrator: 0.5, strategist: 0.25 } },
      { id: 'b', labelKey: 'quizQ30B', scores: { scalper: 0.5, degen: 1.0, whale: 0.25 } },
      { id: 'c', labelKey: 'quizQ30C', scores: { analyst: 1.0, gridbot: 0.5, arbitrageur: 0.25 } },
      { id: 'd', labelKey: 'quizQ30D', scores: { copycat: 0.5, contrarian: 1.0, sniper: 0.25 } },
    ],
  },
]
