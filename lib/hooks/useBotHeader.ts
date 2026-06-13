'use client'

/**
 * useBotHeader — fetch the bot-instance header (spec §1.3) for a serving-mode
 * bot profile. Only enabled when the trader is a bot; static-ish data so a
 * long staleTime + no polling.
 */

import { useQuery } from '@tanstack/react-query'
import { fetcher } from '@/lib/hooks/fetchers'
import { STALE_SLOW } from '@/lib/hooks/cache-presets'
import type { BotHeader } from '@/lib/data/serving/bot-header'
import type { ApiSuccessResponse } from '@/lib/types/index'

export function useBotHeader({
  source,
  exchangeTraderId,
  enabled = true,
}: {
  source: string
  exchangeTraderId: string
  enabled?: boolean
}) {
  const url = `/api/traders/${encodeURIComponent(exchangeTraderId)}/bot?source=${encodeURIComponent(source)}`
  const query = useQuery<BotHeader | null>({
    queryKey: ['trader-bot-header', source, exchangeTraderId],
    queryFn: async () => {
      const res = await fetcher<ApiSuccessResponse<BotHeader | null>>(url)
      return res.data
    },
    enabled: enabled && Boolean(source) && Boolean(exchangeTraderId),
    staleTime: STALE_SLOW,
    refetchOnWindowFocus: false,
  })
  return { bot: query.data ?? null, isLoading: query.isLoading }
}
