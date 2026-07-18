import { observationCycleId } from '../observation-cycle'

describe('observationCycleId', () => {
  it('stays stable across retries of one BullMQ job instance', () => {
    const first = observationCycleId(
      { id: 'revive-kick-tiera-xt-spot', timestamp: 1_784_361_600_000 },
      'tier-a',
      'xt_spot'
    )
    const retry = observationCycleId(
      { id: 'revive-kick-tiera-xt-spot', timestamp: 1_784_361_600_000 },
      'tier-a',
      'xt_spot'
    )
    expect(retry).toBe(first)
  })

  it('distinguishes separate revive jobs that reuse the same fixed id', () => {
    const first = observationCycleId(
      { id: 'revive-kick-tiera-xt-spot', timestamp: 1_784_361_600_000 },
      'tier-a',
      'xt_spot'
    )
    const later = observationCycleId(
      { id: 'revive-kick-tiera-xt-spot', timestamp: 1_784_365_200_000 },
      'tier-a',
      'xt_spot'
    )
    expect(later).not.toBe(first)
  })

  it('uses a stable timestamp when BullMQ provides no custom id', () => {
    expect(
      observationCycleId({ id: undefined, timestamp: 1_784_361_600_000 }, 'derive', 'mexc')
    ).toBe('derive:mexc:anonymous:1784361600000')
  })

  it('fails closed without a stable job-instance timestamp', () => {
    expect(
      observationCycleId({ id: 'reused-id', timestamp: Number.NaN }, 'tier-a', 'xt_spot')
    ).toBeNull()
  })
})
