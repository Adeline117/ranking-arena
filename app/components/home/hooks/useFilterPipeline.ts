'use client'

/**
 * useFilterPipeline — the filtering/sorting data pipeline for rankings.
 *
 * Extracted from useRankingFilters. Handles the full filter chain:
 * category → exchange → preset → advanced → search → pagination
 */

import { useMemo, useState, useEffect, useRef } from 'react'
import type { Trader } from '../../ranking/RankingTable'
import type { FilterConfig } from '../../premium/AdvancedFilter'
import { CategoryType, filterByCategory } from '../../ranking/CategoryRankingTabs'
import { getScoreGradeLetter } from '@/lib/utils/score-explain'
import { PRESETS, type PresetId } from '../../ranking/FilterPresets'

/** Client-side advanced filter logic */
function applyAdvancedFilter(list: Trader[], config: FilterConfig): Trader[] {
  return list.filter(trader => {
    if (config.exchange?.length) {
      const src = (trader.source || '').toLowerCase()
      if (!config.exchange.some(ex => src === ex || src.startsWith(ex))) return false
    }
    if (config.roi_min != null && (trader.roi ?? 0) < config.roi_min) return false
    if (config.roi_max != null && (trader.roi ?? 0) > config.roi_max) return false
    if (config.drawdown_min != null && trader.max_drawdown != null && Math.abs(trader.max_drawdown) < config.drawdown_min) return false
    if (config.drawdown_max != null && trader.max_drawdown != null && Math.abs(trader.max_drawdown) > config.drawdown_max) return false
    if (config.min_pnl != null && (trader.pnl == null || trader.pnl < config.min_pnl)) return false
    if (config.min_score != null && (trader.arena_score == null || trader.arena_score < config.min_score)) return false
    if (config.min_win_rate != null && (trader.win_rate == null || trader.win_rate < config.min_win_rate)) return false
    if (config.grade && trader.arena_score != null) {
      if (getScoreGradeLetter(trader.arena_score) !== config.grade) return false
    }
    return true
  })
}

interface UseFilterPipelineOptions {
  traders: Trader[]
  category: CategoryType
  selectedExchange: string | null
  activePreset: PresetId | null
  filterConfig: FilterConfig
  hasActiveFilters: boolean
  searchQuery: string
  isPro: boolean
  serverSearchResults: Trader[]
  fetchPage?: (page: number, opts?: Record<string, string | undefined>) => Promise<void>
}

export function useFilterPipeline({
  traders,
  category,
  selectedExchange,
  activePreset,
  filterConfig,
  hasActiveFilters,
  searchQuery,
  isPro,
  serverSearchResults,
  fetchPage,
}: UseFilterPipelineOptions) {
  // With server-side pagination (fetchPage available), category is already filtered by the API.
  const categoryFiltered = useMemo(
    () => fetchPage
      ? traders
      : (category === 'all'
        ? traders
        : traders.filter(trader => trader.source && filterByCategory(trader.source, category))),
    [traders, category, fetchPage]
  )

  const exchangeFiltered = useMemo(() => {
    const raw = selectedExchange
      ? categoryFiltered.filter(trader => trader.source === selectedExchange)
      : categoryFiltered
    return (selectedExchange && raw.length === 0 && categoryFiltered.length > 0)
      ? categoryFiltered
      : raw
  }, [categoryFiltered, selectedExchange])

  const presetFiltered = useMemo(() => {
    if (!activePreset || activePreset === 'all') return exchangeFiltered
    const presetConfig = PRESETS.find(p => p.id === activePreset)
    if (!presetConfig) return exchangeFiltered
    const raw = exchangeFiltered.filter(trader => presetConfig.filter({ source: trader.source }))
    return (raw.length === 0 && exchangeFiltered.length > 0) ? exchangeFiltered : raw
  }, [activePreset, exchangeFiltered])

  const advancedFiltered = useMemo(
    () => hasActiveFilters ? applyAdvancedFilter(presetFiltered, filterConfig) : presetFiltered,
    [hasActiveFilters, presetFiltered, filterConfig]
  )

  // Merge server search results with client-side filtered data
  const filteredTraders = useMemo(() => {
    const base = isPro ? advancedFiltered : advancedFiltered
    const q = searchQuery.trim().toLowerCase()
    if (q.length < 2) return base
    const clientMatches = base.filter(t => {
      const handle = (t.handle || t.id || '').toLowerCase()
      return handle.includes(q) || t.id.toLowerCase().includes(q)
    })
    if (clientMatches.length > 0) return base
    const existingIds = new Set(base.map(t => t.id))
    const newResults = serverSearchResults.filter(t => !existingIds.has(t.id))
    return [...base, ...newResults]
  }, [isPro, advancedFiltered, serverSearchResults, searchQuery])

  const source = useMemo(() => traders.length > 0 ? traders[0].source : 'all', [traders])

  return {
    categoryFiltered,
    exchangeFiltered,
    advancedFiltered,
    filteredTraders,
    source,
  }
}

export { applyAdvancedFilter }
