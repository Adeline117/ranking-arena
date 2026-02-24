'use client'

/**
 * RankingRow - re-exports TraderRow for consistent naming in this directory.
 * The split of RankingTable delegates row rendering to TraderRow (table view)
 * and TraderCard (card view). This file provides the unified import alias.
 */
export { TraderRow as RankingRow } from './TraderRow'
export { TraderCard as RankingCard } from './TraderCard'
