/** @jest-environment node */
import type IORedis from 'ioredis'

jest.mock('@/lib/ingest/fetch/fetcher', () => ({ getCircuit: jest.fn() }))
jest.mock('@/lib/ingest/alerting', () => ({ alert: jest.fn() }))

import { Circuit } from '@/lib/ingest/fetch/circuit'
import { closeCircuitCycle, MIN_CYCLE_SAMPLES } from '../circuit-cycle'

const redis = {} as IORedis
const src = { slug: 'bybit', phase: 1 }

function circuitWith(successes: number, failures: number) {
  const c = new Circuit('bybit')
  for (let i = 0; i < successes; i++) c.recordSuccess()
  for (let i = 0; i < failures; i++) c.recordFailure(false)
  return c
}

describe('closeCircuitCycle', () => {
  it('alerts when the cycle failure rate exceeds 20% with enough samples', async () => {
    const alert = jest.fn()
    const c = circuitWith(6, 4)
    const res = await closeCircuitCycle(src, 'B', {
      redis: () => redis,
      alert,
      getCircuit: () => c,
    })
    expect(res).toMatchObject({ alerted: true, samples: 10 })
    expect(alert).toHaveBeenCalledWith(
      redis,
      expect.objectContaining({ sourceSlug: 'bybit', phase: 1, tier: 'B' })
    )
    expect(alert.mock.calls[0][1].message).toContain('4/10')
    // The cycle is reset: the next close sees no samples.
    expect(c.endCycle().samples).toBe(0)
  })

  it('does not alert at or below the threshold', async () => {
    const alert = jest.fn()
    await closeCircuitCycle(src, 'D', {
      redis: () => redis,
      alert,
      getCircuit: () => circuitWith(8, 2),
    })
    expect(alert).not.toHaveBeenCalled()
  })

  it('does not alert on a tiny sample', async () => {
    const alert = jest.fn()
    await closeCircuitCycle(src, 'D', {
      redis: () => redis,
      alert,
      getCircuit: () => circuitWith(0, MIN_CYCLE_SAMPLES - 1),
    })
    expect(alert).not.toHaveBeenCalled()
  })

  it('never throws when alerting fails', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {})
    const alert = jest.fn().mockRejectedValue(new Error('redis down'))
    await expect(
      closeCircuitCycle(src, 'B', {
        redis: () => redis,
        alert,
        getCircuit: () => circuitWith(0, 10),
      })
    ).resolves.toMatchObject({ alerted: false })
  })
})
