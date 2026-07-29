import {
  emptyPublicLinkedAggregate,
  parsePublicLinkedAggregate,
  serializePublicLinkedAggregate,
} from '../linked-trader-public'

const SUBJECT = { platform: 'bybit', traderKey: 'trader-1' }

function account(overrides: Record<string, unknown> = {}) {
  return {
    id: 'internal-link-row-id',
    userId: 'private-user-id',
    linkedAt: '2026-07-01T00:00:00Z',
    platform: 'bybit',
    traderKey: 'trader-1',
    handle: 'Public Trader',
    label: 'Owner private label',
    isPrimary: true,
    roi: 12.5,
    pnl: 50_000,
    arenaScore: 88,
    winRate: 64,
    maxDrawdown: -12,
    rank: 7,
    ...overrides,
  }
}

describe('linked aggregate public DTO', () => {
  it('allowlists identity/profile evidence and force-closes unbound metrics', () => {
    const result = serializePublicLinkedAggregate(
      {
        accounts: [account(), account({ traderKey: 'trader-2', isPrimary: false })],
        combinedPnl: 100_000,
        bestRoi: { value: 12.5, platform: 'bybit', traderKey: 'trader-1' },
        weightedScore: 90,
        totalAccounts: 999,
      },
      SUBJECT
    )

    expect(result).toEqual({
      subject: SUBJECT,
      aggregated: { combinedPnl: null, bestRoi: null, weightedScore: null },
      accounts: [
        {
          id: 'bybit:trader-1',
          platform: 'bybit',
          traderKey: 'trader-1',
          handle: 'Public Trader',
          label: null,
          isPrimary: true,
          roi: 12.5,
          pnl: null,
          arenaScore: null,
          winRate: 64,
          maxDrawdown: 12,
          rank: null,
        },
        expect.objectContaining({ id: 'bybit:trader-2', traderKey: 'trader-2' }),
      ],
      totalAccounts: 2,
    })
    expect(JSON.stringify(result)).not.toMatch(/private-user|linkedAt|Owner private|50000/)
  })

  it('sanitizes old cached API values at the client boundary', () => {
    const parsed = parsePublicLinkedAggregate({
      subject: SUBJECT,
      aggregated: { combinedPnl: 123, bestRoi: { value: 99 }, weightedScore: 88 },
      accounts: [
        account({ roi: 10_000.01, winRate: 101, maxDrawdown: 100.01 }),
        account({ traderKey: 'trader-2', isPrimary: false }),
      ],
      totalAccounts: 2,
      userId: 'should-not-survive',
    })

    expect(parsed?.aggregated).toEqual({
      combinedPnl: null,
      bestRoi: null,
      weightedScore: null,
    })
    expect(parsed?.accounts[0]).toMatchObject({
      roi: null,
      pnl: null,
      arenaScore: null,
      winRate: null,
      maxDrawdown: null,
      rank: null,
      label: null,
    })
    expect(parsed).not.toHaveProperty('userId')
  })

  it('distinguishes authoritative empty membership from malformed or failed payloads', () => {
    expect(
      parsePublicLinkedAggregate({
        subject: SUBJECT,
        aggregated: null,
        accounts: [],
        totalAccounts: 0,
      })
    ).toEqual(emptyPublicLinkedAggregate(SUBJECT))
    expect(
      parsePublicLinkedAggregate({
        subject: SUBJECT,
        aggregated: null,
        accounts: [],
        totalAccounts: 2,
      })
    ).toBeNull()
    expect(
      parsePublicLinkedAggregate({
        subject: SUBJECT,
        aggregated: null,
        accounts: [],
        totalAccounts: 0,
        _error: 'fetch_failed',
      })
    ).toBeNull()
    expect(
      parsePublicLinkedAggregate({
        subject: SUBJECT,
        aggregated: null,
        accounts: [account()],
        totalAccounts: 1,
      })
    ).not.toBeNull()
    expect(
      parsePublicLinkedAggregate({
        subject: SUBJECT,
        aggregated: null,
        accounts: [account({ platform: ' bybit' })],
        totalAccounts: 1,
      })
    ).toBeNull()
  })

  it('binds even an empty response to the exact requested subject', () => {
    const empty = emptyPublicLinkedAggregate(SUBJECT)
    expect(parsePublicLinkedAggregate(empty, SUBJECT)).toEqual(empty)
    expect(
      parsePublicLinkedAggregate(empty, { platform: 'bybit', traderKey: 'another-trader' })
    ).toBeNull()
  })

  it('rejects duplicate identities, invalid primary sets, and unrelated server stats', () => {
    const duplicate = {
      subject: SUBJECT,
      aggregated: { combinedPnl: null, bestRoi: null, weightedScore: null },
      accounts: [account(), account()],
      totalAccounts: 2,
    }
    expect(parsePublicLinkedAggregate(duplicate)).toBeNull()
    expect(
      parsePublicLinkedAggregate({
        ...duplicate,
        accounts: [account(), account({ traderKey: 'trader-2' })],
      })
    ).toBeNull()
    expect(() =>
      serializePublicLinkedAggregate(
        {
          accounts: [account({ traderKey: 'someone-else' })],
          totalAccounts: 1,
        },
        SUBJECT
      )
    ).toThrow('do not contain the requested subject')
    expect(() => serializePublicLinkedAggregate({ accounts: 'bad' }, SUBJECT)).toThrow(
      'failed their public contract'
    )
  })

  it('preserves measured zero while failing unsafe profile numbers closed', () => {
    const parsed = parsePublicLinkedAggregate({
      subject: SUBJECT,
      aggregated: null,
      accounts: [account({ roi: 0, winRate: 0, maxDrawdown: 0 })],
      totalAccounts: 1,
    })

    expect(parsed?.accounts[0]).toMatchObject({ roi: 0, winRate: 0, maxDrawdown: 0 })
  })
})
