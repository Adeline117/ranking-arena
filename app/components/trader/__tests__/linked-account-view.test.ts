import {
  linkedAccountDisplayLabel,
  isExactSourceNotServingError,
  parseExactTraderFirstScreenResponse,
  resolveLinkedAccountViewScope,
  parseExactRankHistory,
  resolveTraderHeaderAccountMetrics,
  traderDetailMatchesLinkedAccount,
  traderDetailMatchesRequestedRoute,
} from '../linked-account-view'
import type { PublicLinkedAccount } from '@/lib/data/linked-trader-public'

const metrics = {
  roi90d: 0,
  arenaScore: 88,
  scoreConfidence: 'full',
  tradesCount: 100,
  rank: 7,
  platform: 'bybit',
  traderKey: 'account-1',
  tradingStyle: 'swing_trader',
  lastUpdated: '2026-07-29T00:00:00Z',
  isBot: true,
}

describe('resolveTraderHeaderAccountMetrics', () => {
  it('removes every account-scoped value in aggregate or unresolved membership scope', () => {
    expect(resolveTraderHeaderAccountMetrics(true, metrics)).toEqual({
      roi90d: undefined,
      arenaScore: null,
      scoreConfidence: null,
      tradesCount: null,
      rank: null,
      platform: undefined,
      traderKey: undefined,
      tradingStyle: null,
      lastUpdated: null,
      isBot: false,
    })
  })

  it('preserves a measured zero and exact identity in single-account scope', () => {
    expect(resolveTraderHeaderAccountMetrics(false, metrics)).toBe(metrics)
    expect(resolveTraderHeaderAccountMetrics(false, metrics).roi90d).toBe(0)
  })
})

describe('linkedAccountDisplayLabel', () => {
  it('adds a stable public identity only when exchange names collide', () => {
    const sameExchange = [
      { platform: 'bybit', traderKey: 'primary-key', handle: null },
      { platform: 'bybit', traderKey: 'secondary-key', handle: 'desk-two' },
    ]
    expect(linkedAccountDisplayLabel(sameExchange[0], sameExchange)).toContain('primary-key')
    expect(linkedAccountDisplayLabel(sameExchange[1], sameExchange)).toContain('desk-two')
    expect(
      linkedAccountDisplayLabel({ platform: 'okx', traderKey: 'only-account', handle: null }, [
        { platform: 'okx', traderKey: 'only-account', handle: null },
      ])
    ).not.toContain('only-account')
  })
})

function account(platform: string, traderKey: string, isPrimary: boolean): PublicLinkedAccount {
  return {
    id: `${platform}:${traderKey}`,
    platform,
    traderKey,
    handle: traderKey,
    label: null,
    isPrimary,
    roi: null,
    pnl: null,
    arenaScore: null,
    winRate: null,
    maxDrawdown: null,
    rank: null,
  }
}

const accounts = [account('bybit', 'primary', true), account('okx', 'secondary', false)]

describe('resolveLinkedAccountViewScope', () => {
  it('keeps a requested account unresolved until live membership is authoritative', () => {
    expect(
      resolveLinkedAccountViewScope({
        selectionEnabled: true,
        requestedAccount: { platform: 'okx', traderKey: 'secondary' },
        malformedSelection: false,
        authoritativeReady: false,
        accounts: [],
      })
    ).toMatchObject({
      mode: 'unresolved',
      selectedAccount: null,
      suppressAccountMetrics: true,
      shouldResetSelection: false,
    })
  })

  it('accepts only an exact member of an authoritative multi-account relation', () => {
    const valid = resolveLinkedAccountViewScope({
      selectionEnabled: true,
      requestedAccount: { platform: 'okx', traderKey: 'secondary' },
      malformedSelection: false,
      authoritativeReady: true,
      accounts,
    })
    expect(valid.mode).toBe('selected')
    expect(valid.selectedAccount).toBe(accounts[1])

    for (const requestedAccount of [
      { platform: 'okx', traderKey: 'missing' },
      { platform: 'bybit', traderKey: 'SECONDARY' },
    ]) {
      expect(
        resolveLinkedAccountViewScope({
          selectionEnabled: true,
          requestedAccount,
          malformedSelection: false,
          authoritativeReady: true,
          accounts,
        })
      ).toMatchObject({
        mode: 'invalid',
        selectedAccount: null,
        suppressAccountMetrics: true,
        shouldResetSelection: true,
      })
    }
  })

  it('uses aggregate only after a successful multi-account read and disables fake serving switches', () => {
    expect(
      resolveLinkedAccountViewScope({
        selectionEnabled: true,
        requestedAccount: null,
        malformedSelection: false,
        authoritativeReady: true,
        accounts,
      }).mode
    ).toBe('aggregate')
    expect(
      resolveLinkedAccountViewScope({
        selectionEnabled: false,
        requestedAccount: null,
        malformedSelection: false,
        authoritativeReady: false,
        accounts: [],
      }).mode
    ).toBe('primary')
  })

  it('keeps the exact route account visible while auxiliary membership is unavailable', () => {
    expect(
      resolveLinkedAccountViewScope({
        selectionEnabled: true,
        requestedAccount: null,
        malformedSelection: false,
        authoritativeReady: false,
        accounts: [],
      })
    ).toEqual({
      mode: 'primary',
      selectedAccount: null,
      suppressAccountMetrics: false,
      shouldResetSelection: false,
    })
  })

  it('preserves an explicit All intent while membership revalidates', () => {
    expect(
      resolveLinkedAccountViewScope({
        selectionEnabled: true,
        requestedAccount: null,
        malformedSelection: false,
        authoritativeReady: false,
        accounts: [],
        preserveAggregateIntent: true,
      })
    ).toEqual({
      mode: 'aggregate',
      selectedAccount: null,
      suppressAccountMetrics: true,
      shouldResetSelection: false,
    })
  })

  it('invalidates malformed selections and selections after the relation shrinks', () => {
    expect(
      resolveLinkedAccountViewScope({
        selectionEnabled: true,
        requestedAccount: null,
        malformedSelection: true,
        authoritativeReady: true,
        accounts,
      })
    ).toMatchObject({ mode: 'invalid', shouldResetSelection: true })
    expect(
      resolveLinkedAccountViewScope({
        selectionEnabled: true,
        requestedAccount: { platform: 'bybit', traderKey: 'primary' },
        malformedSelection: false,
        authoritativeReady: true,
        accounts: [accounts[0]],
      })
    ).toMatchObject({ mode: 'invalid', shouldResetSelection: true })
  })
})

describe('traderDetailMatchesLinkedAccount', () => {
  it('requires an exact source and trader identity before publishing selected detail', () => {
    const selected = { platform: 'okx', traderKey: 'secondary' }
    expect(
      traderDetailMatchesLinkedAccount(
        { profile: { id: 'secondary', source: 'okx', handle: 'display-name' } },
        selected
      )
    ).toBe(true)
    expect(
      traderDetailMatchesLinkedAccount(
        { profile: { id: 'primary', source: 'okx', handle: 'secondary' } },
        selected
      )
    ).toBe(false)
    expect(
      traderDetailMatchesLinkedAccount({ profile: { id: 'secondary', source: 'bybit' } }, selected)
    ).toBe(false)
    expect(traderDetailMatchesLinkedAccount({ performance: { roi_90d: 99 } }, selected)).toBe(false)
  })

  it('accepts only resolver-equivalent casing for a complete EVM account key', () => {
    const lowerWallet = `0x${'ab'.repeat(20)}`
    const mixedCaseWallet = `0x${'Ab'.repeat(20)}`
    expect(
      traderDetailMatchesLinkedAccount(
        { profile: { id: lowerWallet, source: 'gmx' } },
        { platform: 'gmx', traderKey: mixedCaseWallet }
      )
    ).toBe(true)
    expect(
      traderDetailMatchesLinkedAccount(
        { profile: { id: 'TraderABC', source: 'legacy_exchange' } },
        { platform: 'legacy_exchange', traderKey: 'traderabc' }
      )
    ).toBe(false)
  })
})

describe('traderDetailMatchesRequestedRoute', () => {
  it('binds a legacy platform override to its exact source and route identity', () => {
    expect(
      traderDetailMatchesRequestedRoute(
        { profile: { id: 'account-id', handle: 'public-handle', source: 'legacy_exchange' } },
        'legacy_exchange',
        'public-handle'
      )
    ).toBe(true)
    expect(
      traderDetailMatchesRequestedRoute(
        { profile: { id: 'account-id', handle: 'public-handle', source: 'other_exchange' } },
        'legacy_exchange',
        'public-handle'
      )
    ).toBe(false)
    expect(
      traderDetailMatchesRequestedRoute(
        { profile: { id: 'another-id', handle: 'another-handle', source: 'legacy_exchange' } },
        'legacy_exchange',
        'public-handle'
      )
    ).toBe(false)
  })

  it('normalizes only complete EVM wallet identities like the resolver', () => {
    const lowerWallet = `0x${'ab'.repeat(20)}`
    const mixedCaseWallet = `0x${'Ab'.repeat(20)}`
    expect(
      traderDetailMatchesRequestedRoute(
        { profile: { id: mixedCaseWallet, handle: 'wallet-owner', source: 'hyperliquid' } },
        'hyperliquid',
        lowerWallet
      )
    ).toBe(true)

    expect(
      traderDetailMatchesRequestedRoute(
        { profile: { id: 'TraderABC', handle: 'TraderABC', source: 'legacy_exchange' } },
        'legacy_exchange',
        'traderabc'
      )
    ).toBe(false)
    expect(
      traderDetailMatchesRequestedRoute(
        { profile: { id: '0xAbCd', handle: '0xAbCd', source: 'legacy_exchange' } },
        'legacy_exchange',
        '0xabcd'
      )
    ).toBe(false)
  })
})

describe('parseExactTraderFirstScreenResponse', () => {
  const expected = { kind: 'route', platform: 'bitunix', handle: 'public-handle' } as const
  const response = () => ({
    request: { platform: 'bitunix', handle: 'public-handle' },
    subject: { platform: 'bitunix_futures', traderKey: 'canonical-id' },
    firstScreen: {
      source: 'bitunix_futures',
      exchangeTraderId: 'canonical-id',
      nickname: 'Desk One',
      avatarMirrorUrl: null,
      avatarOriginUrl: null,
      avatarSrc: null,
      walletAddress: null,
      traderKind: 'human',
      botStrategy: null,
      entries: [
        {
          timeframe: 90,
          rank: 7,
          headlineRoi: 0,
          headlinePnl: { value: 0, currency: 'USDT' },
          headlineWinRate: 0,
          extras: { win_rate: 0, mdd: 0, sparkline: [0, 1] },
          provenance: {
            source: 'bitunix_futures',
            asOf: '2026-07-29T00:00:00.000Z',
          },
        },
      ],
    },
    capability: null,
    is_verified_data: true,
  })

  it('returns a rebuilt typed response only for exact request echo and canonical subject', () => {
    const raw = response()
    const parsed = parseExactTraderFirstScreenResponse(raw, expected)
    expect(parsed).not.toBeNull()
    expect(parsed).not.toBe(raw)
    expect(parsed).toMatchObject({
      request: { platform: 'bitunix', handle: 'public-handle' },
      subject: { platform: 'bitunix_futures', traderKey: 'canonical-id' },
      firstScreen: {
        source: 'bitunix_futures',
        exchangeTraderId: 'canonical-id',
        entries: [
          {
            rank: 7,
            headlineRoi: 0,
            headlinePnl: { value: 0, currency: 'USDT' },
            headlineWinRate: 0,
            extras: { win_rate: 0, mdd: 0, sparkline: [0, 1] },
          },
        ],
      },
    })
    const linkedRaw = {
      ...raw,
      request: { ...raw.request, handle: 'canonical-id' },
    }
    expect(
      parseExactTraderFirstScreenResponse(linkedRaw, {
        kind: 'linked',
        platform: 'bitunix',
        traderKey: 'canonical-id',
      })
    ).not.toBeNull()
    expect(
      parseExactTraderFirstScreenResponse(raw, {
        kind: 'linked',
        platform: 'bitunix',
        traderKey: 'public-handle',
      })
    ).toBeNull()
  })

  it('binds linked requests to the exact trader key with EVM address canonicalization', () => {
    const raw = response()
    const lowerWallet = `0x${'ab'.repeat(20)}`
    const mixedCaseWallet = `0x${'Ab'.repeat(20)}`
    const walletResponse = {
      ...raw,
      request: { ...raw.request, handle: mixedCaseWallet },
      subject: { ...raw.subject, traderKey: mixedCaseWallet },
      firstScreen: { ...raw.firstScreen, exchangeTraderId: lowerWallet },
    }
    const parsed = parseExactTraderFirstScreenResponse(walletResponse, {
      kind: 'linked',
      platform: 'bitunix',
      traderKey: lowerWallet,
    })

    expect(parsed?.request.handle).toBe(lowerWallet)
    expect(parsed?.subject.traderKey).toBe(lowerWallet)
    expect(parsed?.firstScreen.exchangeTraderId).toBe(lowerWallet)
    expect(
      parseExactTraderFirstScreenResponse(walletResponse, {
        kind: 'linked',
        platform: 'bitunix',
        traderKey: `0x${'cd'.repeat(20)}`,
      })
    ).toBeNull()
  })

  it('rejects a missing or mismatched request echo instead of trusting response-owned identity', () => {
    const raw = response()
    expect(parseExactTraderFirstScreenResponse({ ...raw, request: null }, expected)).toBeNull()
    expect(
      parseExactTraderFirstScreenResponse(
        { ...raw, request: { ...raw.request, platform: 'bybit' } },
        expected
      )
    ).toBeNull()
    expect(
      parseExactTraderFirstScreenResponse(
        { ...raw, request: { ...raw.request, handle: 'another-handle' } },
        expected
      )
    ).toBeNull()
  })

  it('rejects malformed or non-canonical subject and first-screen identity', () => {
    const raw = response()
    for (const malformed of [
      { ...raw, subject: null },
      { ...raw, subject: {} },
      { ...raw, subject: { ...raw.subject, platform: 'bitunix' } },
      {
        ...raw,
        firstScreen: { ...raw.firstScreen, exchangeTraderId: 'another-id' },
      },
    ]) {
      expect(parseExactTraderFirstScreenResponse(malformed, expected)).toBeNull()
    }
  })

  it('requires entries to be an array of complete objects', () => {
    const raw = response()
    for (const entries of [null, {}, [null], [{}]]) {
      expect(
        parseExactTraderFirstScreenResponse(
          { ...raw, firstScreen: { ...raw.firstScreen, entries } },
          expected
        )
      ).toBeNull()
    }
  })

  it('validates capability before exposing it to serving consumers', () => {
    const raw = response()
    const capability = {
      timeframes: { '7': 'native', '30': 'derived', '90': 'absent' },
      inceptionTf: false,
      metrics: ['roi', 'pnl'],
      surfaces: {
        positions: true,
        position_history: true,
        orders: false,
        transfers: false,
        copiers: false,
      },
      copierDepth: 'none',
      currency: 'USDT',
      isOnchain: false,
      derivedBoardNote: true,
      exchangeName: 'Bitunix Futures',
    }

    expect(
      parseExactTraderFirstScreenResponse({ ...raw, capability }, expected)?.capability
    ).toEqual(capability)
    expect(parseExactTraderFirstScreenResponse({ ...raw, capability: {} }, expected)).toBeNull()
  })

  it('rejects non-finite entry metrics and never sanitizes them to zero', () => {
    const raw = response()
    const entry = raw.firstScreen.entries[0]
    const invalidEntries = [
      { ...entry, rank: Number.POSITIVE_INFINITY },
      { ...entry, headlineRoi: Number.NaN },
      { ...entry, headlinePnl: { value: Number.NEGATIVE_INFINITY, currency: 'USDT' } },
      { ...entry, headlineWinRate: Number.POSITIVE_INFINITY },
      { ...entry, extras: { ...entry.extras, mdd: Number.NaN } },
    ]
    for (const invalidEntry of invalidEntries) {
      expect(
        parseExactTraderFirstScreenResponse(
          { ...raw, firstScreen: { ...raw.firstScreen, entries: [invalidEntry] } },
          expected
        )
      ).toBeNull()
    }
  })
})

describe('isExactSourceNotServingError', () => {
  const expected = {
    kind: 'route',
    platform: 'legacy_exchange',
    handle: 'public-handle',
  } as const
  const error = (overrides: Record<string, unknown> = {}) => ({
    status: 404,
    info: {
      success: false,
      error: {
        details: {
          reason: 'source_not_serving',
          request: { platform: 'legacy_exchange', handle: 'public-handle' },
        },
      },
    },
    ...overrides,
  })

  it('allows fallback only for an exact request-bound source_not_serving 404', () => {
    expect(isExactSourceNotServingError(error(), expected)).toBe(true)
    expect(
      isExactSourceNotServingError(error(), {
        kind: 'linked',
        platform: 'legacy_exchange',
        traderKey: 'public-handle',
      })
    ).toBe(true)
  })

  it('rejects generic trader 404s, wrong status and malformed envelopes', () => {
    const generic404 = error({
      info: {
        success: false,
        error: {
          details: {
            reason: 'trader_not_found',
            request: { platform: 'legacy_exchange', handle: 'public-handle' },
          },
        },
      },
    })
    expect(isExactSourceNotServingError(generic404, expected)).toBe(false)
    expect(isExactSourceNotServingError(error({ status: 500 }), expected)).toBe(false)
    expect(isExactSourceNotServingError({ status: 404, info: null }, expected)).toBe(false)
    expect(
      isExactSourceNotServingError(
        { status: 404, info: { success: false, error: { details: null } } },
        expected
      )
    ).toBe(false)
  })

  it('rejects a source_not_serving proof echoed for another request', () => {
    const wrongPlatform = error({
      info: {
        success: false,
        error: {
          details: {
            reason: 'source_not_serving',
            request: { platform: 'other_exchange', handle: 'public-handle' },
          },
        },
      },
    })
    const wrongHandle = error({
      info: {
        success: false,
        error: {
          details: {
            reason: 'source_not_serving',
            request: { platform: 'legacy_exchange', handle: 'another-handle' },
          },
        },
      },
    })
    expect(isExactSourceNotServingError(wrongPlatform, expected)).toBe(false)
    expect(isExactSourceNotServingError(wrongHandle, expected)).toBe(false)
  })
})

describe('parseExactRankHistory', () => {
  const payload = {
    platform: 'bitunix_futures',
    trader_key: 'secondary',
    period: '90D',
    history: [{ date: '2026-07-29', rank: 7, arena_score: 88 }],
  }

  it('publishes history only for the exact echoed subject', () => {
    expect(parseExactRankHistory(payload, 'bitunix_futures', 'secondary')).toEqual(payload.history)
    expect(parseExactRankHistory(payload, 'bitunix', 'secondary')).toBeNull()
    expect(parseExactRankHistory(payload, 'bitunix_futures', 'primary')).toBeNull()
  })

  it('rejects malformed points instead of partially publishing them', () => {
    expect(
      parseExactRankHistory(
        { ...payload, history: [{ date: '2026-07-29', rank: 0, arena_score: 88 }] },
        'bitunix_futures',
        'secondary'
      )
    ).toBeNull()
  })
})
