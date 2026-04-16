'use client'

/**
 * useSavedFilters — CRUD for saved filter presets.
 *
 * Manages saving/loading/deleting custom filter configurations
 * via API calls and local state.
 */

import { useState, useCallback } from 'react'
import type { FilterConfig, SavedFilter } from '../../premium/AdvancedFilter'
import { getCsrfHeaders } from '@/lib/api/client'
import { useAuthSession } from '@/lib/hooks/useAuthSession'

export function useSavedFilters() {
  const [savedFilters, setSavedFilters] = useState<SavedFilter[]>([])
  const { getAuthHeaders } = useAuthSession()

  const handleSaveFilter = useCallback(async (name: string, config: FilterConfig) => {
    try {
      const res = await fetch('/api/saved-filters', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...getAuthHeaders(), ...getCsrfHeaders() },
        body: JSON.stringify({ name, config }),
      })
      if (res.ok) {
        const json = await res.json()
        setSavedFilters(prev => [...prev, json.filter || json.data])
      }
    } catch { /* ignore */ }
  }, [getAuthHeaders])

  const handleLoadFilter = useCallback((filter: SavedFilter) => {
    return filter.filter_config
  }, [])

  const handleDeleteFilter = useCallback(async (filterId: string) => {
    try {
      await fetch(`/api/saved-filters?id=${filterId}`, {
        method: 'DELETE',
        headers: { ...getAuthHeaders(), ...getCsrfHeaders() },
      })
      setSavedFilters(prev => prev.filter(f => f.id !== filterId))
    } catch { /* ignore */ }
  }, [getAuthHeaders])

  return {
    savedFilters,
    handleSaveFilter,
    handleLoadFilter,
    handleDeleteFilter,
  }
}
