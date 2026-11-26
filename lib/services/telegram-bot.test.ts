import { getSupabaseAdmin } from '@/lib/supabase/server'
import { handleTelegramUpdate } from './telegram-bot'

jest.mock('@/lib/supabase/server', () => ({
  getSupabaseAdmin: jest.fn(),
}))

jest.mock('@/lib/data/unified', () => ({
  getLeaderboard: jest.fn(),
  searchTraders: jest.fn(),
}))

jest.mock('@/lib/logger', () => ({
  logger: {
    error: jest.fn(),
    warn: jest.fn(),
  },
}))

type QueryResult = {
  data: unknown[] | null
  error: { message: string } | null
  count?: number | null
}

function query(result: QueryResult) {
  const builder: Record<string, jest.Mock | ((...args: unknown[]) => Promise<unknown>)> = {}
  for (const method of ['select', 'eq', 'range']) {
    builder[method] = jest.fn(() => builder)
  }
  builder.then = (
    resolve: (value: QueryResult) => unknown,
    reject?: (reason: unknown) => unknown
  ) => Promise.resolve(result).then(resolve, reject)
  return builder
}

function statsUpdate() {
  return {
    update_id: 1,
    message: {
      message_id: 1,
      from: { id: 42, first_name: 'Public user', language_code: 'en' },
      chat: { id: 99, type: 'private' },
      text: '/stats',
      date: 0,
    },
  }
}

describe('Telegram /stats public ranking authority', () => {
  const originalFetch = global.fetch
  const fetchMock = jest.fn()
  const mockedGetSupabaseAdmin = getSupabaseAdmin as jest.MockedFunction<typeof getSupabaseAdmin>

  beforeEach(() => {
    jest.clearAllMocks()
    process.env.TELEGRAM_BOT_TOKEN = 'test-token'
    Object.defineProperty(global, 'fetch', { configurable: true, value: fetchMock, writable: true })
    fetchMock.mockResolvedValue({ ok: true, text: jest.fn().mockResolvedValue('') })
  })

  afterAll(() => {
    Object.defineProperty(global, 'fetch', {
      configurable: true,
      value: originalFetch,
      writable: true,
    })
  })

  it('uses only the sealed public view for the public bot audience', async () => {
    const countQuery = query({ data: null, error: null, count: 2 })
    const sourceQuery = query({
      data: [{ source: 'binance_futures' }, { source: 'bybit' }],
      error: null,
    })
    const from = jest.fn().mockReturnValueOnce(countQuery).mockReturnValueOnce(sourceQuery)
    mockedGetSupabaseAdmin.mockReturnValue({ from } as never)

    await handleTelegramUpdate(statsUpdate())

    expect(from).toHaveBeenCalledTimes(2)
    expect(from).toHaveBeenNthCalledWith(1, 'public_ranked_leaderboard')
    expect(from).toHaveBeenNthCalledWith(2, 'public_ranked_leaderboard')
    expect(from).not.toHaveBeenCalledWith('leaderboard_ranks')
    expect(countQuery.select).toHaveBeenCalledWith('source_trader_id', {
      count: 'exact',
      head: true,
    })
    expect(countQuery.eq).toHaveBeenCalledWith('season_id', '90D')
    expect(sourceQuery.eq).toHaveBeenCalledWith('season_id', '90D')

    const request = fetchMock.mock.calls[0]
    const payload = JSON.parse(String(request[1]?.body)) as { chat_id: number; text: string }
    expect(payload.chat_id).toBe(99)
    expect(payload.text).toContain('Ranked Traders: 2')
    expect(payload.text).toContain('Active Exchanges: 2')
  })

  it('does not turn a failed published cohort into a numeric zero', async () => {
    const countQuery = query({ data: null, error: { message: 'cohort unavailable' }, count: null })
    const sourceQuery = query({ data: null, error: { message: 'cohort unavailable' } })
    const from = jest.fn().mockReturnValueOnce(countQuery).mockReturnValueOnce(sourceQuery)
    mockedGetSupabaseAdmin.mockReturnValue({ from } as never)

    await handleTelegramUpdate(statsUpdate())

    const request = fetchMock.mock.calls[0]
    const payload = JSON.parse(String(request[1]?.body)) as { text: string }
    expect(payload.text).toContain('Unknown (published cohort unavailable)')
    expect(payload.text).not.toContain('Ranked Traders: 0')
    expect(from).not.toHaveBeenCalledWith('leaderboard_ranks')
  })

  it('withholds a malformed source list rather than presenting it as public', async () => {
    const countQuery = query({ data: null, error: null, count: 1 })
    const sourceQuery = query({ data: [{ source: 'untrusted_alias' }], error: null })
    const from = jest.fn().mockReturnValueOnce(countQuery).mockReturnValueOnce(sourceQuery)
    mockedGetSupabaseAdmin.mockReturnValue({ from } as never)

    await handleTelegramUpdate(statsUpdate())

    const request = fetchMock.mock.calls[0]
    const payload = JSON.parse(String(request[1]?.body)) as { text: string }
    expect(payload.text).toContain('Ranked Traders: 1')
    expect(payload.text).toContain('Active Exchanges: Unknown (published cohort unavailable)')
    expect(payload.text).not.toContain('untrusted_alias')
  })

  it('counts ranked traders and active exchanges without idle-window rows', async () => {
    const countQuery = query({ data: null, error: null, count: 2 })
    const sourceQuery = query({
      data: [{ source: 'binance_futures' }, { source: 'bybit' }],
      error: null,
    })
    const from = jest.fn().mockReturnValueOnce(countQuery).mockReturnValueOnce(sourceQuery)
    mockedGetSupabaseAdmin.mockReturnValue({ from } as never)

    await handleTelegramUpdate(statsUpdate())

    // Both queries share the predicate: the source list is only trusted when
    // it has exactly as many rows as the count.
    expect(countQuery.eq).toHaveBeenCalledWith('idle_window', false)
    expect(sourceQuery.eq).toHaveBeenCalledWith('idle_window', false)
    // Old rule (no idle row): the predicate removes nothing, same message.
    const payload = JSON.parse(String(fetchMock.mock.calls[0][1]?.body)) as { text: string }
    expect(payload.text).toContain('Ranked Traders: 2')
    expect(payload.text).toContain('Active Exchanges: 2')
  })
})
