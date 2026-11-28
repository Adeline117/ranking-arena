import { getSupabaseAdmin } from '@/lib/supabase/server'
import { handleTelegramUpdate } from './telegram-bot'
import { fakePublicRankedCountClient } from '@/lib/data/testing/public-ranked-count-client'

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

  function useCounts(state: Parameters<typeof fakePublicRankedCountClient>[0]) {
    const fake = fakePublicRankedCountClient(state)
    mockedGetSupabaseAdmin.mockReturnValue(fake.client as never)
    return fake
  }

  function sentText(): string {
    const payload = JSON.parse(String(fetchMock.mock.calls[0][1]?.body)) as { text: string }
    return payload.text
  }

  it('uses only the sealed public view for the public bot audience', async () => {
    const fake = useCounts({
      served: ['binance_futures', 'bybit'],
      nonIdleBySource: { binance_futures: 1, bybit: 1 },
    })

    await handleTelegramUpdate(statsUpdate())

    expect(new Set(fake.relations)).toEqual(new Set(['public_ranked_leaderboard']))
    for (const filter of fake.filters) {
      expect(filter).toEqual(expect.objectContaining({ season_id: '90D' }))
    }

    const payload = JSON.parse(String(fetchMock.mock.calls[0][1]?.body)) as { chat_id: number }
    expect(payload.chat_id).toBe(99)
    expect(sentText()).toContain('Ranked Traders: 2')
    expect(sentText()).toContain('Active Exchanges: 2')
  })

  it('lists the active exchanges of a board larger than one 1,000-row page', async () => {
    useCounts({
      served: ['binance_futures', 'bybit'],
      nonIdleBySource: { binance_futures: 2_600, bybit: 1_500 },
    })

    await handleTelegramUpdate(statsUpdate())

    expect(sentText()).toContain(`Ranked Traders: ${(4_100).toLocaleString()}`)
    expect(sentText()).toContain('Active Exchanges: 2')
  })

  it('does not turn a failed published cohort into a numeric zero', async () => {
    const fake = useCounts({
      served: ['binance_futures'],
      nonIdleBySource: { binance_futures: 1 },
      failCountFor: ['total'],
    })

    await handleTelegramUpdate(statsUpdate())

    expect(sentText()).toContain('Unknown (published cohort unavailable)')
    expect(sentText()).not.toContain('Ranked Traders: 0')
    expect(fake.relations).not.toContain('leaderboard_ranks')
  })

  it('withholds a source list naming a non-public source rather than presenting it', async () => {
    useCounts({ served: ['untrusted_alias'], nonIdleBySource: { untrusted_alias: 1 } })

    await handleTelegramUpdate(statsUpdate())

    expect(sentText()).toContain('Ranked Traders: 1')
    expect(sentText()).toContain('Active Exchanges: Unknown (published cohort unavailable)')
    expect(sentText()).not.toContain('untrusted_alias')
  })

  it('counts ranked traders and active exchanges without idle-window rows', async () => {
    const fake = useCounts({
      served: ['binance_futures', 'bybit', 'okx_futures'],
      nonIdleBySource: { binance_futures: 1, bybit: 1, okx_futures: 0 },
    })

    await handleTelegramUpdate(statsUpdate())

    for (const filter of fake.filters) {
      expect(filter).toEqual(expect.objectContaining({ idle_window: false }))
    }
    // The source whose rows are all idle is not an active exchange.
    expect(sentText()).toContain('Ranked Traders: 2')
    expect(sentText()).toContain('Active Exchanges: 2')
  })
})
