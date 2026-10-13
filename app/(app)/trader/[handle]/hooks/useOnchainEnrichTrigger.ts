'use client'

/**
 * On-demand on-chain enrichment trigger (Phase A — 即看即算).
 *
 * V1 source keeps on-demand enrichment unpublished. The browser-safe fixed
 * gate reports optional unavailability before this hook schedules a request,
 * so profile mounts do not repeatedly POST to the endpoint's 410 tombstone.
 * The historical request flow remains below for a separately reviewed future
 * publication, and is exercised only with an explicit test-only GO.
 */

import { useEffect, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { getCsrfHeaders } from '@/lib/api/client'
import { TRADER_CORE_QUERY_EPOCH } from '@/lib/hooks/useTraderCore'
import { isV1IngestExecutionPublished } from '@/lib/ingest/v1-execution-publication'

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
  const v1ExecutionUnavailable = !isV1IngestExecutionPublished()
  const requestKey = `${source}:${exchangeTraderId}`
  const hasOnchainDerivation = Boolean(extras?.onchain_derivation)
  const firedKeyRef = useRef<string | null>(null)
  const [result, setResult] = useState<{
    key: string
    state: OnchainEnrichmentState
  }>({ key: requestKey, state: 'idle' })
  const state = result.key === requestKey ? result.state : 'idle'

  useEffect(() => {
    if (v1ExecutionUnavailable) return
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
            queryKey: ['trader-core', TRADER_CORE_QUERY_EPOCH, source, exchangeTraderId],
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
  }, [
    enabled,
    loaded,
    source,
    exchangeTraderId,
    hasOnchainDerivation,
    queryClient,
    requestKey,
    v1ExecutionUnavailable,
  ])

  return v1ExecutionUnavailable ? 'unavailable' : state
}
