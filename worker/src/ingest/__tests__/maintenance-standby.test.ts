/** @jest-environment node */
import { runMaintenanceWithStandby, STANDBY_GRACE } from '../maintenance-standby'

function fakeRedis() {
  const store = new Map<string, string>()
  return {
    store,
    get: jest.fn(async (k: string) => store.get(k) ?? null),
    set: jest.fn(async (k: string, v: string) => {
      store.set(k, v)
      return 'OK'
    }),
  }
}

const FRESHNESS = 'maint:freshness'
const EVERY = 30 * 60_000
const PRIMARY = `arena:ingest:maint-last:${FRESHNESS}:primary`

describe('runMaintenanceWithStandby', () => {
  beforeEach(() => jest.spyOn(console, 'warn').mockImplementation(() => {}))
  afterEach(() => jest.restoreAllMocks())

  it('always runs a primary job and records the primary marker', async () => {
    const redis = fakeRedis()
    const fn = jest.fn(async () => ({ stale: 0 }))
    await expect(
      runMaintenanceWithStandby(redis as never, FRESHNESS, {}, fn, () => 1_000)
    ).resolves.toEqual({ stale: 0 })
    expect(fn).toHaveBeenCalled()
    expect(redis.store.get(PRIMARY)).toBe('1000')
  })

  it('skips a standby run while the primary is healthy', async () => {
    const redis = fakeRedis()
    redis.store.set(PRIMARY, String(10_000))
    const fn = jest.fn()
    const res = await runMaintenanceWithStandby(
      redis as never,
      FRESHNESS,
      { standby: true },
      fn,
      () => 10_000 + EVERY
    )
    expect(fn).not.toHaveBeenCalled()
    expect(res).toMatchObject({ skipped: 'primary-healthy' })
  })

  it('takes over when the primary is overdue, without refreshing the primary marker', async () => {
    const redis = fakeRedis()
    redis.store.set(PRIMARY, '0')
    const fn = jest.fn(async () => ({ stale: 3 }))
    const now = STANDBY_GRACE * EVERY + 1
    await expect(
      runMaintenanceWithStandby(redis as never, FRESHNESS, { standby: true }, fn, () => now)
    ).resolves.toEqual({ stale: 3 })
    expect(redis.store.get(PRIMARY)).toBe('0')
    expect(redis.store.get(`arena:ingest:maint-last:${FRESHNESS}:standby`)).toBe(String(now))
  })

  it('takes over when the primary never ran', async () => {
    const redis = fakeRedis()
    const fn = jest.fn(async () => 'ran')
    await expect(
      runMaintenanceWithStandby(redis as never, FRESHNESS, { standby: true }, fn)
    ).resolves.toBe('ran')
  })

  it('fails open when the primary marker cannot be read', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {})
    const redis = fakeRedis()
    redis.get.mockRejectedValueOnce(new Error('ECONNRESET'))
    const fn = jest.fn(async () => 'ran')
    await expect(
      runMaintenanceWithStandby(redis as never, FRESHNESS, { standby: true }, fn)
    ).resolves.toBe('ran')
  })

  it('does not record a marker when the job throws', async () => {
    const redis = fakeRedis()
    await expect(
      runMaintenanceWithStandby(redis as never, FRESHNESS, {}, async () => {
        throw new Error('boom')
      })
    ).rejects.toThrow('boom')
    expect(redis.store.has(PRIMARY)).toBe(false)
  })
})
