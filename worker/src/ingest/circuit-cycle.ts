/**
 * Closes a per-source circuit-breaker cycle at the end of a Tier-B/D job and
 * raises the spec §4 failure-rate alert (>20% of requests in the cycle).
 *
 * WHY (2026-11 audit P1-4): Circuit.endCycle() had no caller, so the counters
 * only ever grew and the failure-rate alert never existed. Tier-B/D swallow
 * per-trader errors and the job still "succeeds" even at 100% failure.
 *
 * A cycle is the window between two endCycle() calls for the same source in
 * this process (circuits are per-source and shared across tiers). Tiny
 * samples are not alerted: 1 failure out of 1 request is noise, not a rate.
 * Never throws — alerting must not fail the crawl it reports on.
 */

import type IORedis from 'ioredis'
import { alert as defaultAlert } from '@/lib/ingest/alerting'
import { getCircuit as defaultGetCircuit } from '@/lib/ingest/fetch/fetcher'

export const MIN_CYCLE_SAMPLES = 5

export interface CircuitCycleDeps {
  getCircuit: (slug: string) => {
    endCycle(): { failureRate: number; shouldAlert: boolean; samples: number; failures: number }
  }
  alert: typeof defaultAlert
  redis: () => IORedis
}

export async function closeCircuitCycle(
  src: { slug: string; phase: number },
  tier: 'B' | 'D',
  deps: Partial<CircuitCycleDeps> & Pick<CircuitCycleDeps, 'redis'>
): Promise<{ alerted: boolean; failureRate: number; samples: number }> {
  const getCircuit = deps.getCircuit ?? defaultGetCircuit
  const alert = deps.alert ?? defaultAlert
  try {
    const cycle = getCircuit(src.slug).endCycle()
    const alerted = cycle.shouldAlert && cycle.samples >= MIN_CYCLE_SAMPLES
    if (alerted) {
      await alert(deps.redis(), {
        sourceSlug: src.slug,
        phase: src.phase,
        tier,
        message:
          `Tier-${tier} cycle failure rate ${(cycle.failureRate * 100).toFixed(0)}% ` +
          `(${cycle.failures}/${cycle.samples} requests failed; threshold 20%)`,
      })
    }
    return { alerted, failureRate: cycle.failureRate, samples: cycle.samples }
  } catch (err) {
    console.error(
      `[circuit-cycle] ${src.slug} Tier-${tier} cycle close/alert failed:`,
      err instanceof Error ? err.message : err
    )
    return { alerted: false, failureRate: 0, samples: 0 }
  }
}
