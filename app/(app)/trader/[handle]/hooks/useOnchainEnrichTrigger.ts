'use client'

/**
 * On-demand on-chain enrichment trigger (Phase A — 即看即算).
 *
 * When a web3 wallet profile (okx_web3_solana / binance_web3_bsc) renders in
 * serving mode WITHOUT any on-chain-computed data yet (`onchain_derivation`
 * absent from the loaded extras), POST /api/trader/onchain-enrich once to
 * compute it now, then invalidate the trader-core queries so the fresh data
 * renders. No-op for non-web3 sources or already-enriched wallets. The returned
 * state keeps optional provider-capacity degradation explicit without turning
 * it into a fatal profile error. Fires once per (source, wallet) per mount.
 */

import { useEffect, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { getCsrfHeaders } from '@/lib/api/client'

function isWeb3Source(source: string): boolean {
  return source.includes('solana') || source.includes('web3_bsc') || source.includes('_bsc')
}

export type OnchainEnrichmentState = 'idle' | 'loading' | 'unavailable' | 'failed'

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
  const requestKey = `${source}:${exchangeTraderId}`
  const hasOnchainDerivation = Boolean(extras?.onchain_derivation)
  const firedKeyRef = useRef<string | null>(null)
  const [result, setResult] = useState<{
    key: string
    state: OnchainEnrichmentState
  }>({ key: requestKey, state: 'idle' })
  const state = result.key === requestKey ? result.state : 'idle'

  useEffect(() => {
    if (!enabled || !loaded || firedKeyRef.current === requestKey) return
    if (!source || !exchangeTraderId || !isWeb3Source(source)) return
    // Already has on-chain data (or a board that carried it) → nothing to do.
    if (hasOnchainDerivation) {
      setResult((previous) =>
        previous.key === requestKey && previous.state === 'idle'
          ? previous
          : { key: requestKey, state: 'idle' }
      )
      return
    }

    firedKeyRef.current = requestKey
    setResult({ key: requestKey, state: 'loading' })
    const controller = new AbortController()
    ;(async () => {
      try {
        const res = await fetch('/api/trader/onchain-enrich', {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...getCsrfHeaders() },
          body: JSON.stringify({ source, exchangeTraderId }),
          signal: controller.signal,
        })
        if (res.status === 503) {
          setResult({ key: requestKey, state: 'unavailable' })
          return
        }
        if (!res.ok) {
          setResult({ key: requestKey, state: 'failed' })
          return
        }
        const json = (await res.json()) as { status?: string; skipped?: boolean }
        // Only refetch when we actually wrote something new.
        if (json.status === 'enriched') {
          await queryClient.invalidateQueries({
            queryKey: ['trader-core', source, exchangeTraderId],
          })
        }
        if (!controller.signal.aborted) {
          setResult({ key: requestKey, state: 'idle' })
        }
      } catch {
        if (!controller.signal.aborted) {
          setResult({ key: requestKey, state: 'failed' })
        }
      }
    })()
    return () => controller.abort()
  }, [enabled, loaded, source, exchangeTraderId, hasOnchainDerivation, queryClient, requestKey])

  return state
}
