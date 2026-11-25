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

function verifiedAccount(overrides: Record<string, unknown> = {}) {
  return account({ rankingVisibility: 'verified', rankingVisibilityReason: null, ...overrides })
}

describe('linked aggregate public DTO', () => {
  it('keeps identity but force-closes unproved internal performance fields', () => {
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
          rankingVisibility: 'unknown',
          rankingVisibilityReason: 'public_cohort_unavailable',
          roi: null,
          pnl: null,
          arenaScore: null,
          winRate: null,
          maxDrawdown: null,
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
      rankingVisibility: 'unknown',
      rankingVisibilityReason: 'public_cohort_unavailable',
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

  it('allows metrics only on a complete verified ranking account', () => {
    const result = serializePublicLinkedAggregate(
      {
        accounts: [
          verifiedAccount(),
          verifiedAccount({ traderKey: 'trader-2', isPrimary: false, roi: 0, winRate: 0 }),
        ],
        combinedPnl: 100_000,
        bestRoi: { value: 12.5, platform: 'bybit', traderKey: 'trader-1' },
        weightedScore: 90,
      },
      SUBJECT
    )

    expect(result.aggregated).toEqual({ combinedPnl: null, bestRoi: null, weightedScore: null })
    expect(result.accounts).toEqual([
      expect.objectContaining({
        rankingVisibility: 'verified',
        rankingVisibilityReason: null,
        roi: 12.5,
        pnl: null,
        arenaScore: 88,
        winRate: 64,
        maxDrawdown: 12,
        rank: 7,
      }),
      expect.objectContaining({
        traderKey: 'trader-2',
        rankingVisibility: 'verified',
        roi: 0,
        winRate: 0,
      }),
    ])
  })

  it('never synthesizes zero-valued aggregate performance metrics', () => {
    const result = serializePublicLinkedAggregate(
      {
        accounts: [verifiedAccount(), verifiedAccount({ traderKey: 'trader-2', isPrimary: false })],
        combinedPnl: 0,
        bestRoi: { value: 0, platform: 'bybit', traderKey: 'trader-1' },
        weightedScore: 0,
      },
      SUBJECT
    )

    expect(result.aggregated).toEqual({ combinedPnl: null, bestRoi: null, weightedScore: null })
  })

  it('keeps a verified account whose ranked row has no win rate or drawdown', () => {
    const parsed = parsePublicLinkedAggregate({
      subject: SUBJECT,
      aggregated: { combinedPnl: null, bestRoi: null, weightedScore: null },
      accounts: [
        verifiedAccount({ winRate: null }),
        verifiedAccount({ traderKey: 'trader-2', isPrimary: false, maxDrawdown: null }),
        verifiedAccount({
          traderKey: 'trader-3',
          isPrimary: false,
          winRate: null,
          maxDrawdown: null,
          roi: -31.5,
        }),
      ],
      totalAccounts: 3,
    })

    expect(parsed?.accounts).toEqual([
      expect.objectContaining({
        rankingVisibility: 'verified',
        roi: 12.5,
        arenaScore: 88,
        winRate: null,
        maxDrawdown: 12,
        rank: 7,
      }),
      expect.objectContaining({ rankingVisibility: 'verified', winRate: 64, maxDrawdown: null }),
      expect.objectContaining({
        rankingVisibility: 'verified',
        roi: -31.5,
        winRate: null,
        maxDrawdown: null,
      }),
    ])
  })

  it.each([
    ['win rate out of range', { winRate: 101 }],
    ['non-numeric win rate', { winRate: '64' }],
    ['drawdown out of range', { maxDrawdown: 250 }],
    ['non-finite drawdown', { maxDrawdown: Number.NaN }],
    ['missing ROI', { roi: null }],
    ['missing score', { arenaScore: null }],
  ])('still fails a verified account closed on %s', (_label, overrides) => {
    const parsed = parsePublicLinkedAggregate({
      subject: SUBJECT,
      aggregated: null,
      accounts: [verifiedAccount(overrides)],
      totalAccounts: 1,
    })
    expect(parsed?.accounts[0]).toMatchObject({
      rankingVisibility: 'partial',
      rankingVisibilityReason: 'public_cohort_unverified',
      roi: null,
      winRate: null,
      maxDrawdown: null,
      rank: null,
    })
  })

  it('fails forged verified status closed when its public ranking shape is incomplete', () => {
    const parsed = parsePublicLinkedAggregate({
      subject: SUBJECT,
      aggregated: null,
      accounts: [verifiedAccount({ rank: null })],
      totalAccounts: 1,
    })

    expect(parsed?.accounts[0]).toMatchObject({
      rankingVisibility: 'partial',
      rankingVisibilityReason: 'public_cohort_unverified',
      roi: null,
      pnl: null,
      arenaScore: null,
      winRate: null,
      maxDrawdown: null,
      rank: null,
    })
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

  it('preserves verified measured zero while failing unsafe profile numbers closed', () => {
    const parsed = parsePublicLinkedAggregate({
      subject: SUBJECT,
      aggregated: null,
      accounts: [verifiedAccount({ roi: 0, winRate: 0, maxDrawdown: 0 })],
      totalAccounts: 1,
    })

    expect(parsed?.accounts[0]).toMatchObject({
      rankingVisibility: 'verified',
      roi: 0,
      winRate: 0,
      maxDrawdown: 0,
    })
  })
})
