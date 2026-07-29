import {
  linkedAccountDisplayLabel,
  resolveLinkedAccountViewScope,
  parseExactRankHistory,
  resolveTraderHeaderAccountMetrics,
  servingFirstScreenMatchesLinkedAccount,
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
})

describe('servingFirstScreenMatchesLinkedAccount', () => {
  const selected = { platform: 'bitunix', traderKey: 'secondary' }
  const response = {
    subject: selected,
    firstScreen: { source: 'bitunix_futures', exchangeTraderId: 'secondary' },
  }

  it('accepts a canonical source only when the response echoes the exact requested subject', () => {
    expect(servingFirstScreenMatchesLinkedAccount(response, selected)).toBe(true)
  })

  it('rejects mismatched platform, trader key, first-screen identity, and malformed source', () => {
    expect(
      servingFirstScreenMatchesLinkedAccount(
        { ...response, subject: { ...selected, platform: 'bybit' } },
        selected
      )
    ).toBe(false)
    expect(
      servingFirstScreenMatchesLinkedAccount(
        { ...response, subject: { ...selected, traderKey: 'primary' } },
        selected
      )
    ).toBe(false)
    expect(
      servingFirstScreenMatchesLinkedAccount(
        { ...response, firstScreen: { ...response.firstScreen, exchangeTraderId: 'primary' } },
        selected
      )
    ).toBe(false)
    expect(
      servingFirstScreenMatchesLinkedAccount(
        { ...response, firstScreen: { ...response.firstScreen, source: ' bitunix_futures' } },
        selected
      )
    ).toBe(false)
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
