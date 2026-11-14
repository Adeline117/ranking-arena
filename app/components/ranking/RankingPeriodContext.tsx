'use client'

import { createContext, useContext } from 'react'

export type RankingPeriod = '7D' | '30D' | '90D'

/**
 * The period of the ranking currently on screen. Provided by RankingTable so
 * row/card cells can show period-specific disclosures without threading a
 * prop through every row component.
 */
export const RankingPeriodContext = createContext<RankingPeriod | null>(null)

export function useRankingPeriod(): RankingPeriod | null {
  return useContext(RankingPeriodContext)
}
