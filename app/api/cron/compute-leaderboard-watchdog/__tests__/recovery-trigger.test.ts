import { parseSeasonFreshnessPayload, triggerSeasonCompute } from '../recovery-trigger'

const response = (status: number, payload: unknown): Response =>
  ({
    ok: status >= 200 && status < 300,
    status,
    json: jest.fn().mockResolvedValue(payload),
  }) as unknown as Response

describe('compute leaderboard watchdog recovery contract', () => {
  it('parses one exact, valid freshness row', () => {
    expect(
      parseSeasonFreshnessPayload(
        [{ computed_at: '2026-07-29T10:00:00.000Z' }],
        Date.parse('2026-07-29T10:05:00.000Z')
      )
    ).toEqual({ ageMs: 300_000, ageMin: 5 })
  })

  it('treats a missing ranking row as stale', () => {
    expect(parseSeasonFreshnessPayload([], Date.now())).toEqual({ ageMs: Infinity, ageMin: -1 })
  })

  it.each([
    null,
    {},
    [null],
    [{ computed_at: null }],
    [{ computed_at: 'not-a-date' }],
    [{ computed_at: '2026-07-29T10:00:00.000Z', extra: true }],
    [{ computed_at: '2026-07-29T10:00:00.000Z' }, { computed_at: '2026-07-29T09:00:00.000Z' }],
  ])('rejects malformed freshness payload %#', (payload) => {
    expect(() => parseSeasonFreshnessPayload(payload, Date.now())).toThrow(
      'Leaderboard freshness query returned an invalid payload'
    )
  })

  it.each([
    [200, { ok: true }],
    [202, { accepted: true }],
  ])('accepts an explicit HTTP %s acknowledgement', async (status, payload) => {
    const fetchImpl = jest.fn().mockResolvedValue(response(status as number, payload))

    await expect(
      triggerSeasonCompute('https://arena.test', 'secret', '90D', {
        fetchImpl: fetchImpl as unknown as typeof fetch,
      })
    ).resolves.toEqual({
      season: '90D',
      triggered: true,
      note: `HTTP ${status} acknowledged`,
    })
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://arena.test/api/cron/compute-leaderboard?season=90D',
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    )
  })

  it.each([
    [200, { ok: false }],
    [200, { accepted: true }],
    [200, null],
    [202, {}],
    [202, { ok: false, accepted: true }],
    [401, { ok: true }],
    [404, { ok: true }],
    [500, { ok: true }],
  ])('does not claim HTTP %s with payload %# was triggered', async (status, payload) => {
    const fetchImpl = jest.fn().mockResolvedValue(response(status as number, payload))

    const result = await triggerSeasonCompute('https://arena.test', 'secret', '7D', {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })

    expect(result.triggered).toBe(false)
  })

  it.each([
    Object.assign(new Error('dns failed'), { name: 'TypeError' }),
    Object.assign(new Error('timed out'), { name: 'TimeoutError' }),
    Object.assign(new Error('aborted'), { name: 'AbortError' }),
  ])('does not claim a rejected request was triggered', async (error) => {
    const fetchImpl = jest.fn().mockRejectedValue(error)

    const result = await triggerSeasonCompute('https://arena.test', 'secret', '30D', {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })

    expect(result.triggered).toBe(false)
  })
})
