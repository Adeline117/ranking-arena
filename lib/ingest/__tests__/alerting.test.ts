/**
 * @jest-environment node
 */
import type IORedis from 'ioredis'
import {
  ALERT_FAILURE_COUNT_KEY,
  ALERT_FAILURE_LOG_KEY,
  DIGEST_KEY,
  DigestDeliveryError,
  alert,
  flushDigest,
  pageCooldownKey,
  sendTelegram,
} from '../alerting'

/** Minimal in-memory Redis covering the commands alerting.ts uses. */
class FakeRedis {
  strings = new Map<string, string>()
  lists = new Map<string, string[]>()
  async set(key: string, value: string, _ex: string, _ttl: number, nx: string) {
    if (nx === 'NX' && this.strings.has(key)) return null
    this.strings.set(key, value)
    return 'OK'
  }
  async get(key: string) {
    return this.strings.get(key) ?? null
  }
  async del(key: string) {
    const had = this.strings.delete(key) || this.lists.delete(key)
    return had ? 1 : 0
  }
  async incr(key: string) {
    const n = Number(this.strings.get(key) ?? '0') + 1
    this.strings.set(key, String(n))
    return n
  }
  private list(key: string) {
    const l = this.lists.get(key) ?? []
    this.lists.set(key, l)
    return l
  }
  async rpush(key: string, ...vals: string[]) {
    return this.list(key).push(...vals)
  }
  async lpush(key: string, ...vals: string[]) {
    const l = this.list(key)
    for (const v of vals) l.unshift(v)
    return l.length
  }
  async lrange(key: string, start: number, stop: number) {
    const l = this.lists.get(key) ?? []
    const end = stop < 0 ? l.length + stop + 1 : stop + 1
    return l.slice(start < 0 ? Math.max(0, l.length + start) : start, end)
  }
  async ltrim(key: string, start: number, stop: number) {
    const kept = await this.lrange(key, start, stop)
    this.lists.set(key, kept)
    return 'OK'
  }
  multi() {
    const ops: Array<() => Promise<unknown>> = []
    const chain = {
      lrange: (k: string, a: number, b: number) => (ops.push(() => this.lrange(k, a, b)), chain),
      del: (k: string) => (ops.push(() => this.del(k)), chain),
      exec: async () => {
        const out: Array<[Error | null, unknown]> = []
        for (const op of ops) out.push([null, await op()])
        return out
      },
    }
    return chain
  }
}

const asRedis = (r: FakeRedis) => r as unknown as IORedis
const noSleep = async () => {}

function mockFetch(...responses: Array<{ status: number } | Error>) {
  const fn = jest.fn()
  for (const r of responses) {
    if (r instanceof Error) fn.mockRejectedValueOnce(r)
    else
      fn.mockResolvedValueOnce({
        ok: r.status >= 200 && r.status < 300,
        status: r.status,
        text: async () => `status ${r.status}`,
      })
  }
  global.fetch = fn as unknown as typeof fetch
  return fn
}

const ORIGINAL_ENV = process.env
const ORIGINAL_FETCH = global.fetch

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV, TELEGRAM_BOT_TOKEN: 'tok', TELEGRAM_ALERT_CHAT_ID: 'chat' }
  jest.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  process.env = ORIGINAL_ENV
  global.fetch = ORIGINAL_FETCH
  jest.restoreAllMocks()
})

describe('sendTelegram', () => {
  it('passes an abort signal (timeout) to fetch', async () => {
    const fetchFn = mockFetch({ status: 200 })
    const res = await sendTelegram('hi', { sleep: noSleep })
    expect(res).toEqual({ ok: true, attempts: 1 })
    expect(fetchFn.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal)
  })

  it('retries network errors and 5xx a bounded number of times', async () => {
    const fetchFn = mockFetch(new Error('ECONNRESET'), { status: 502 }, { status: 200 })
    const res = await sendTelegram('hi', { sleep: noSleep })
    expect(res).toEqual({ ok: true, attempts: 3 })
    expect(fetchFn).toHaveBeenCalledTimes(3)
  })

  it('gives up after maxAttempts', async () => {
    const fetchFn = mockFetch({ status: 500 }, { status: 500 }, { status: 500 }, { status: 200 })
    const res = await sendTelegram('hi', { sleep: noSleep })
    expect(res.ok).toBe(false)
    expect(fetchFn).toHaveBeenCalledTimes(3)
  })

  it('does not retry a 401 (credential problem will not heal)', async () => {
    const fetchFn = mockFetch({ status: 401 }, { status: 200 })
    const res = await sendTelegram('hi', { sleep: noSleep })
    expect(res).toMatchObject({ ok: false, attempts: 1 })
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })

  it('reports unconfigured without calling fetch', async () => {
    delete process.env.TELEGRAM_BOT_TOKEN
    const fetchFn = mockFetch({ status: 200 })
    const res = await sendTelegram('hi')
    expect(res).toMatchObject({ ok: false, reason: 'telegram_not_configured' })
    expect(fetchFn).not.toHaveBeenCalled()
  })
})

describe('alert', () => {
  const page = { sourceSlug: 'bybit', phase: 1, tier: 'A' as const, message: 'stale' }

  it('keeps the cooldown after a delivered page', async () => {
    const redis = new FakeRedis()
    mockFetch({ status: 200 })
    await alert(asRedis(redis), page, { sleep: noSleep })
    expect(redis.strings.has(pageCooldownKey('bybit', 'A'))).toBe(true)
    expect(redis.lists.get(DIGEST_KEY)).toHaveLength(1)
    expect(redis.strings.get(ALERT_FAILURE_COUNT_KEY)).toBeUndefined()
  })

  it('releases the cooldown and records the failure when the page is not delivered', async () => {
    const redis = new FakeRedis()
    mockFetch({ status: 401 })
    await alert(asRedis(redis), page, { sleep: noSleep })
    expect(redis.strings.has(pageCooldownKey('bybit', 'A'))).toBe(false)
    expect(redis.strings.get(ALERT_FAILURE_COUNT_KEY)).toBe('1')
    const log = JSON.parse(redis.lists.get(ALERT_FAILURE_LOG_KEY)![0])
    expect(log).toMatchObject({ kind: 'page' })
    expect(log.reason).toContain('http_401')
    // The record is still in the digest.
    expect(redis.lists.get(DIGEST_KEY)).toHaveLength(1)

    // Next sentinel pass is allowed to try again.
    const fetchFn = mockFetch({ status: 200 })
    await alert(asRedis(redis), page, { sleep: noSleep })
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })

  it('still queues the digest when fetch throws on every attempt', async () => {
    const redis = new FakeRedis()
    mockFetch(new Error('timeout'), new Error('timeout'), new Error('timeout'))
    await expect(alert(asRedis(redis), page, { sleep: noSleep })).resolves.toBeUndefined()
    expect(redis.lists.get(DIGEST_KEY)).toHaveLength(1)
  })

  it('does not page non-Tier-A alerts', async () => {
    const redis = new FakeRedis()
    const fetchFn = mockFetch({ status: 200 })
    await alert(asRedis(redis), { ...page, tier: 'B' })
    expect(fetchFn).not.toHaveBeenCalled()
    expect(redis.lists.get(DIGEST_KEY)).toHaveLength(1)
  })

  it('does not re-page inside the cooldown window', async () => {
    const redis = new FakeRedis()
    const fetchFn = mockFetch({ status: 200 }, { status: 200 })
    await alert(asRedis(redis), page)
    await alert(asRedis(redis), page)
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })
})

describe('flushDigest', () => {
  const item = (slug: string, msg: string) =>
    JSON.stringify({ sourceSlug: slug, phase: 2, tier: 'B', message: msg, at: 'x' })

  it('drains and sends the digest', async () => {
    const redis = new FakeRedis()
    await redis.rpush(DIGEST_KEY, item('a', '1'), item('b', '2'))
    mockFetch({ status: 200 })
    await expect(flushDigest(asRedis(redis), { sleep: noSleep })).resolves.toBe(2)
    expect(redis.lists.get(DIGEST_KEY)).toBeUndefined()
  })

  it('returns 0 for an empty digest without sending', async () => {
    const redis = new FakeRedis()
    const fetchFn = mockFetch({ status: 200 })
    await expect(flushDigest(asRedis(redis))).resolves.toBe(0)
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('restores items in order ahead of newer ones and throws when the send fails', async () => {
    const redis = new FakeRedis()
    await redis.rpush(DIGEST_KEY, item('a', '1'), item('b', '2'))
    global.fetch = jest.fn(async () => {
      // An alert arriving while the digest is in flight.
      await redis.rpush(DIGEST_KEY, item('c', 'late'))
      return { ok: false, status: 401, text: async () => 'Unauthorized' }
    }) as unknown as typeof fetch
    await expect(flushDigest(asRedis(redis), { sleep: noSleep })).rejects.toBeInstanceOf(
      DigestDeliveryError
    )
    const left = redis.lists.get(DIGEST_KEY)!.map((s) => JSON.parse(s).message)
    expect(left).toEqual(['1', '2', 'late'])
    expect(redis.strings.get(ALERT_FAILURE_COUNT_KEY)).toBe('1')
    expect(JSON.parse(redis.lists.get(ALERT_FAILURE_LOG_KEY)![0]).kind).toBe('digest')
  })
})
