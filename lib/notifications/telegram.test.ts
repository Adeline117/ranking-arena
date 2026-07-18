jest.mock('@/lib/cache/redis-client', () => ({
  getSharedRedis: jest.fn(),
}))

jest.mock('@/lib/logger', () => ({
  logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn() },
}))

import { getSharedRedis } from '@/lib/cache/redis-client'
import { logger } from '@/lib/logger'
import { sendTelegramAlert, sendTelegramAlertDetailed, type TelegramAlertOptions } from './telegram'

const mockGetSharedRedis = getSharedRedis as jest.MockedFunction<typeof getSharedRedis>
const mockLogger = logger as jest.Mocked<typeof logger>
const redisStore = new Map<string, string>()

const mockRedis = {
  eval: jest.fn(
    async (
      script: string,
      keys: string[],
      args: Array<string | number>
    ): Promise<string | number> => {
      const values = [...keys, ...args.map(String)]

      if (script.includes("return 'deduplicated'")) {
        const [dedupKey, inflightKey, leaseToken] = values
        if (redisStore.has(dedupKey)) return 'deduplicated'
        if (redisStore.has(inflightKey)) return 'in_flight'
        redisStore.set(inflightKey, leaseToken)
        return 'acquired'
      }

      if (script.includes("redis.call('SET', KEYS[1], ARGV[2]")) {
        const [dedupKey, inflightKey, leaseToken, deliveredAt] = values
        redisStore.set(dedupKey, deliveredAt)
        if (redisStore.get(inflightKey) === leaseToken) redisStore.delete(inflightKey)
        return 1
      }

      const [inflightKey, leaseToken] = values
      if (redisStore.get(inflightKey) === leaseToken) {
        redisStore.delete(inflightKey)
        return 1
      }
      return 0
    }
  ),
  del: jest.fn(async (...keys: string[]) => {
    for (const key of keys) redisStore.delete(key)
    return keys.length
  }),
}

const baseAlert: TelegramAlertOptions = {
  level: 'critical',
  source: 'test-source',
  title: 'Database unavailable',
  message: 'The primary database cannot be reached.',
}

const dedupKey = 'alert:dedup:test-source:Database unavailable'
const inflightKey = 'alert:inflight:test-source:Database unavailable'
const originalFetch = global.fetch

function telegramResponse(status: number, ok: boolean): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => ({ ok }),
  } as Response
}

beforeEach(() => {
  jest.clearAllMocks()
  redisStore.clear()
  process.env.TELEGRAM_BOT_TOKEN = 'super-secret-bot-token'
  process.env.TELEGRAM_ALERT_CHAT_ID = 'super-secret-chat-id'
  mockGetSharedRedis.mockResolvedValue(mockRedis as never)
  global.fetch = jest.fn().mockResolvedValue(telegramResponse(200, true))
})

afterAll(() => {
  global.fetch = originalFetch
  delete process.env.TELEGRAM_BOT_TOKEN
  delete process.env.TELEGRAM_ALERT_CHAT_ID
})

describe('sendTelegramAlertDetailed', () => {
  test('commits the dedup marker only after Telegram confirms delivery', async () => {
    let markerExistedDuringRequest = true
    ;(global.fetch as jest.Mock).mockImplementationOnce(async () => {
      markerExistedDuringRequest = redisStore.has(dedupKey)
      return telegramResponse(200, true)
    })

    const first = await sendTelegramAlertDetailed(baseAlert)
    const second = await sendTelegramAlertDetailed(baseAlert)

    expect(first).toEqual({ outcome: 'delivered', httpStatus: 200 })
    expect(second).toEqual({ outcome: 'suppressed', reason: 'deduplicated' })
    expect(markerExistedDuringRequest).toBe(false)
    expect(redisStore.has(dedupKey)).toBe(true)
    expect(redisStore.has(inflightKey)).toBe(false)
    expect(global.fetch).toHaveBeenCalledTimes(1)
  })

  test.each([
    [401, false],
    [500, false],
    [200, false],
  ])('does not suppress retries after an HTTP %i response with ok=%s', async (status, ok) => {
    ;(global.fetch as jest.Mock)
      .mockResolvedValueOnce(telegramResponse(status, ok))
      .mockResolvedValueOnce(telegramResponse(status, ok))

    const alert = { ...baseAlert, title: `HTTP failure ${status} ${String(ok)}` }
    const first = await sendTelegramAlertDetailed(alert)
    const second = await sendTelegramAlertDetailed(alert)

    expect(first).toEqual({ outcome: 'failed', reason: 'http_error', httpStatus: status })
    expect(second.outcome).toBe('failed')
    expect(global.fetch).toHaveBeenCalledTimes(2)
    expect(Array.from(redisStore.keys()).some((key) => key.startsWith('alert:dedup:'))).toBe(false)
    expect(Array.from(redisStore.keys()).some((key) => key.startsWith('alert:inflight:'))).toBe(
      false
    )
  })

  test('releases the lease after a timeout so the next alert can retry', async () => {
    const timeout = Object.assign(new Error('request timed out'), { name: 'TimeoutError' })
    ;(global.fetch as jest.Mock).mockRejectedValueOnce(timeout).mockRejectedValueOnce(timeout)

    const alert = { ...baseAlert, title: 'Timeout retry' }
    const first = await sendTelegramAlertDetailed(alert)
    const second = await sendTelegramAlertDetailed(alert)

    expect(first).toEqual({ outcome: 'failed', reason: 'timeout' })
    expect(second).toEqual({ outcome: 'failed', reason: 'timeout' })
    expect(global.fetch).toHaveBeenCalledTimes(2)
    expect(Array.from(redisStore.keys()).some((key) => key.startsWith('alert:dedup:'))).toBe(false)
  })

  test('releases the lease after a network error', async () => {
    ;(global.fetch as jest.Mock).mockRejectedValueOnce(new Error('socket closed'))

    const result = await sendTelegramAlertDetailed({
      ...baseAlert,
      title: 'Network retry',
    })

    expect(result).toEqual({ outcome: 'failed', reason: 'network_error' })
    expect(Array.from(redisStore.keys()).some((key) => key.startsWith('alert:dedup:'))).toBe(false)
    expect(Array.from(redisStore.keys()).some((key) => key.startsWith('alert:inflight:'))).toBe(
      false
    )
  })

  test('single-flights concurrent calls', async () => {
    let resolveRequest!: (response: Response) => void
    const request = new Promise<Response>((resolve) => {
      resolveRequest = resolve
    })
    ;(global.fetch as jest.Mock).mockReturnValueOnce(request)

    const alert = { ...baseAlert, title: 'Concurrent failure' }
    const leader = sendTelegramAlertDetailed(alert)
    await Promise.resolve()
    await Promise.resolve()
    const follower = await sendTelegramAlertDetailed(alert)

    expect(follower).toEqual({ outcome: 'suppressed', reason: 'in_flight' })
    expect(global.fetch).toHaveBeenCalledTimes(1)

    resolveRequest(telegramResponse(200, true))
    await expect(leader).resolves.toEqual({ outcome: 'delivered', httpStatus: 200 })
  })

  test('uses the same delivery-only semantics when Redis is unavailable', async () => {
    mockGetSharedRedis.mockResolvedValue(null)
    const alert = { ...baseAlert, title: 'Memory fallback delivery' }

    const first = await sendTelegramAlertDetailed(alert)
    const second = await sendTelegramAlertDetailed(alert)

    expect(first.outcome).toBe('delivered')
    expect(second).toEqual({ outcome: 'suppressed', reason: 'deduplicated' })
    expect(global.fetch).toHaveBeenCalledTimes(1)
  })

  test('does not delete a newer owner lease when the original lease expires', async () => {
    const alert = { ...baseAlert, title: 'Lease ownership' }
    const key = 'alert:inflight:test-source:Lease ownership'
    ;(global.fetch as jest.Mock).mockImplementationOnce(async () => {
      redisStore.set(key, 'new-owner-token')
      return telegramResponse(200, true)
    })

    await expect(sendTelegramAlertDetailed(alert)).resolves.toEqual({
      outcome: 'delivered',
      httpStatus: 200,
    })
    expect(redisStore.get(key)).toBe('new-owner-token')
  })

  test('bypasses dedup for reports and preserves the boolean compatibility API', async () => {
    const report = { ...baseAlert, level: 'report' as const, title: 'Daily report' }

    await expect(sendTelegramAlert(report)).resolves.toBe(true)
    await expect(sendTelegramAlert(report)).resolves.toBe(true)
    expect(global.fetch).toHaveBeenCalledTimes(2)
    ;(global.fetch as jest.Mock).mockResolvedValueOnce(telegramResponse(401, false))
    await expect(sendTelegramAlert({ ...report, title: 'Failed report' })).resolves.toBe(false)
  })

  test('returns expected suppression for log-only and buffered levels', async () => {
    await expect(
      sendTelegramAlertDetailed({ ...baseAlert, level: 'info', title: 'Info' })
    ).resolves.toEqual({ outcome: 'suppressed', reason: 'info_log_only' })
    await expect(
      sendTelegramAlertDetailed({ ...baseAlert, level: 'warning', title: 'Warning' })
    ).resolves.toEqual({ outcome: 'suppressed', reason: 'warning_buffered' })
    expect(global.fetch).not.toHaveBeenCalled()
  })

  test('does not leak the bot token or chat id into error logs', async () => {
    ;(global.fetch as jest.Mock).mockResolvedValueOnce(telegramResponse(401, false))
    await sendTelegramAlertDetailed({ ...baseAlert, title: 'Secret-safe failure' })

    const logText = JSON.stringify(mockLogger.error.mock.calls)
    expect(logText).not.toContain(process.env.TELEGRAM_BOT_TOKEN)
    expect(logText).not.toContain(process.env.TELEGRAM_ALERT_CHAT_ID)
  })
})
