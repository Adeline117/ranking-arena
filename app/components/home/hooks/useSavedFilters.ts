'use client'

/**
 * useSavedFilters — CRUD for saved filter presets.
 *
 * Uses React Query useMutation for save/delete with optimistic updates.
 */

import { useState, useCallback } from 'react'
import { useMutation } from '@tanstack/react-query'
import type { FilterConfig, SavedFilter } from '../../premium/AdvancedFilter'
import { getCsrfHeaders } from '@/lib/api/client'
import { useAuthSession } from '@/lib/hooks/useAuthSession'

export function useSavedFilters() {
  const [savedFilters, setSavedFilters] = useState<SavedFilter[]>([])
  const { getAuthHeaders } = useAuthSession()

  const saveMutation = useMutation({
    mutationFn: async ({ name, config }: { name: string; config: FilterConfig }) => {
      const res = await fetch('/api/saved-filters', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...getAuthHeaders(), ...getCsrfHeaders() },
        body: JSON.stringify({ name, config }),
      })
      if (!res.ok) throw new Error('Failed to save filter')
      const json = await res.json()
      return json.filter || json.data
    },
    onSuccess: (newFilter) => {
      setSavedFilters((prev) => [...prev, newFilter])
    },
  })

  const deleteMutation = useMutation({
    mutationFn: async (filterId: string) => {
      await fetch(`/api/saved-filters?id=${filterId}`, {
        method: 'DELETE',
        headers: { ...getAuthHeaders(), ...getCsrfHeaders() },
      })
      return filterId
    },
    onMutate: async (filterId) => {
      // Optimistic: remove from list immediately
      setSavedFilters((prev) => prev.filter((f) => f.id !== filterId))
    },
  })

  const handleSaveFilter = useCallback(
    (name: string, config: FilterConfig) => saveMutation.mutate({ name, config }),
    [saveMutation]
  )

  const handleLoadFilter = useCallback((filter: SavedFilter) => {
    return filter.filter_config
  }, [])

  const handleDeleteFilter = useCallback(
    (filterId: string) => deleteMutation.mutate(filterId),
    [deleteMutation]
  )

  return {
    savedFilters,
    handleSaveFilter,
    handleLoadFilter,
    handleDeleteFilter,
  }
}
