'use client'

/**
 * On-demand on-chain enrichment trigger (Phase A — 即看即算).
 *
 * When a web3 wallet profile (okx_web3_solana / binance_web3_bsc) renders in
 * serving mode WITHOUT any on-chain-computed data yet (`onchain_derivation`
 * absent from the loaded extras), POST /api/trader/onchain-enrich once to
 * compute it now, then invalidate the trader-core queries so the fresh data
 * renders. No-op for non-web3 sources or already-enriched wallets. Fire-once
 * per (source, wallet) mount via a ref guard.
 */

import { useEffect, useRef } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { getCsrfHeaders } from '@/lib/api/client'

function isWeb3Source(source: string): boolean {
  return source.includes('solana') || source.includes('web3_bsc') || source.includes('_bsc')
}

export function useOnchainEnrichTrigger(params: {
  source: string
  exchangeTraderId: string
  extras: Record<string, unknown> | null | undefined
  enabled: boolean
  /** True once the serving core data has loaded (so absence = really absent). */
  loaded: boolean
}) {
  const { source, exchangeTraderId, extras, enabled, loaded } = params
  const queryClient = useQueryClient()
  const firedRef = useRef(false)

  useEffect(() => {
    if (!enabled || !loaded || firedRef.current) return
    if (!source || !exchangeTraderId || !isWeb3Source(source)) return
    // Already has on-chain data (or a board that carried it) → nothing to do.
    if (extras && extras.onchain_derivation) return

    firedRef.current = true
    const controller = new AbortController()
    ;(async () => {
      try {
        const res = await fetch('/api/trader/onchain-enrich', {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...getCsrfHeaders() },
          body: JSON.stringify({ source, exchangeTraderId }),
          signal: controller.signal,
        })
        if (!res.ok) return
        const json = (await res.json()) as { status?: string; skipped?: boolean }
        // Only refetch when we actually wrote something new.
        if (json.status === 'enriched') {
          await queryClient.invalidateQueries({
            queryKey: ['trader-core', source, exchangeTraderId],
          })
        }
      } catch {
        /* best-effort — rotation will cover it otherwise */
      }
    })()
    return () => controller.abort()
  }, [enabled, loaded, source, exchangeTraderId, extras, queryClient])
}
