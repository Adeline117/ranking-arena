import {
  assertMeilisearchReconciliationMatch,
  assertMeilisearchReconciliationEvidence,
  assertMeilisearchTaskSucceeded,
  buildFrozenLeaderboardReconciliationEvidence,
  buildMeilisearchCompoundId,
  buildMeilisearchReconciliationEvidence,
  leaderboardRowToMeilisearchIdentity,
  sortUniqueMeilisearchDocuments,
  type FrozenLeaderboardIdentityRow,
  type MeilisearchReconciliationEvidence,
} from '../meilisearch-authoritative-rebuild'

function sourceRow(
  sourceTraderId: string,
  seasonId: FrozenLeaderboardIdentityRow['season_id'] = '90D',
  source = 'binance_futures'
): FrozenLeaderboardIdentityRow {
  return {
    source,
    source_trader_id: sourceTraderId,
    season_id: seasonId,
  }
}

describe('Meilisearch authoritative rebuild contract', () => {
  it('preserves the live compound-id format and sanitizes only the trader component', () => {
    expect(buildMeilisearchCompoundId(sourceRow('wallet/0xabc:def', '30D'))).toBe(
      'binance_futures--wallet_0xabc_def--30D'
    )
    expect(leaderboardRowToMeilisearchIdentity(sourceRow('alice', '7D'))).toEqual({
      id: 'binance_futures--alice--7D',
      season_id: '7D',
    })
  })

  it.each([
    [sourceRow('alice', '1D'), 'Unsupported Meilisearch rebuild season'],
    [sourceRow('alice', '90D', 'bad/source'), 'valid Meilisearch id component'],
    [sourceRow('   '), 'source_trader_id must not be empty'],
    [sourceRow(' alice'), 'source_trader_id must not have surrounding whitespace'],
    [sourceRow('alice '), 'source_trader_id must not have surrounding whitespace'],
  ])('rejects invalid source identity input %#', (row, message) => {
    expect(() => buildMeilisearchCompoundId(row)).toThrow(message)
  })

  it('sorts by stable ASCII id order without mutating the caller input', () => {
    const input = [
      leaderboardRowToMeilisearchIdentity(sourceRow('zeta', '90D')),
      leaderboardRowToMeilisearchIdentity(sourceRow('alpha', '7D')),
      leaderboardRowToMeilisearchIdentity(sourceRow('alpha', '30D')),
    ]
    const originalOrder = input.map((document) => document.id)

    const sorted = sortUniqueMeilisearchDocuments(input)

    expect(sorted.map((document) => document.id)).toEqual([
      'binance_futures--alpha--30D',
      'binance_futures--alpha--7D',
      'binance_futures--zeta--90D',
    ])
    expect(input.map((document) => document.id)).toEqual(originalOrder)
    expect(Object.isFrozen(sorted)).toBe(true)
  })

  it('fails closed when distinct source identities sanitize to the same compound id', () => {
    expect(() =>
      buildFrozenLeaderboardReconciliationEvidence([
        sourceRow('wallet/a', '90D'),
        sourceRow('wallet:a', '90D'),
      ])
    ).toThrow('Duplicate Meilisearch document id: binance_futures--wallet_a--90D')
  })

  it('rejects a target document whose compound-id season disagrees with its season field', () => {
    expect(() =>
      buildMeilisearchReconciliationEvidence([
        { id: 'binance_futures--alice--7D', season_id: '30D' },
      ])
    ).toThrow('Meilisearch document season mismatch')
  })

  it.each([
    [{ id: '--alice--7D', season_id: '7D' as const }],
    [{ id: 'binance_futures----7D', season_id: '7D' as const }],
  ])('rejects a target document without both non-empty compound components %#', (document) => {
    expect(() => buildMeilisearchReconciliationEvidence([document])).toThrow(
      'Invalid Meilisearch compound document id'
    )
  })

  it('rejects an empty authoritative inventory before it can reconcile or swap', () => {
    expect(() => buildMeilisearchReconciliationEvidence([])).toThrow('total_count must be positive')
  })

  it('rejects an authoritative inventory when any required season is empty', () => {
    expect(() =>
      buildFrozenLeaderboardReconciliationEvidence([
        sourceRow('alice', '7D'),
        sourceRow('bob', '90D'),
      ])
    ).toThrow('season_counts.30D must be positive')
  })

  it('builds order-independent season, total, and complete sorted-id evidence', () => {
    const rows = [
      sourceRow('zeta', '90D'),
      sourceRow('alpha', '7D'),
      sourceRow('alpha', '30D'),
      sourceRow('beta', '90D', 'okx_spot'),
    ]

    const forward = buildFrozenLeaderboardReconciliationEvidence(rows)
    const reverse = buildFrozenLeaderboardReconciliationEvidence([...rows].reverse())

    expect(forward).toEqual({
      contract_version: 'meilisearch-authoritative-rebuild-v1',
      total_count: 4,
      season_counts: { '7D': 1, '30D': 1, '90D': 2 },
      sorted_id_sha256: 'f104e9c56732dc15e1b0901575cc3d328ac35bbd5bed5ee87535bd835289436a',
    })
    expect(reverse).toEqual(forward)
  })

  it('accepts only exact reconciliation parity', () => {
    const expected = buildFrozenLeaderboardReconciliationEvidence([
      sourceRow('alice', '7D'),
      sourceRow('bob', '30D'),
      sourceRow('carol', '90D'),
    ])
    const observed = buildMeilisearchReconciliationEvidence([
      { id: 'binance_futures--carol--90D', season_id: '90D' },
      { id: 'binance_futures--alice--7D', season_id: '7D' },
      { id: 'binance_futures--bob--30D', season_id: '30D' },
    ])

    expect(() => assertMeilisearchReconciliationMatch(expected, observed)).not.toThrow()
  })

  it('reports every reconciliation dimension that differs', () => {
    const expected = buildFrozenLeaderboardReconciliationEvidence([
      sourceRow('alice', '7D'),
      sourceRow('bob', '30D'),
      sourceRow('carol', '90D'),
    ])
    const observed: MeilisearchReconciliationEvidence = {
      ...expected,
      total_count: 4,
      season_counts: { '7D': 1, '30D': 1, '90D': 2 },
      sorted_id_sha256: '0'.repeat(64),
    }

    expect(() => assertMeilisearchReconciliationMatch(expected, observed)).toThrow(
      'total_count, season_counts.90D, sorted_id_sha256'
    )
  })

  it.each([
    [{ contract_version: 'v2' }, 'unsupported contract version'],
    [{ total_count: -1 }, 'expected.total_count'],
    [{ total_count: Number.MAX_SAFE_INTEGER + 1 }, 'expected.total_count'],
    [{ total_count: 4 }, 'season counts do not equal total'],
    [{ season_counts: { '7D': 1, '30D': 0, '90D': 1 } }, 'season_counts.30D must be positive'],
    [{ season_counts: { '7D': 1, '30D': 1, '90D': 1, ALL: 3 } }, 'unexpected season_counts shape'],
    [{ sorted_id_sha256: 'A'.repeat(64) }, 'invalid sorted_id_sha256'],
    [{ sorted_id_sha256: 'a'.repeat(63) }, 'invalid sorted_id_sha256'],
  ])('rejects malformed runtime reconciliation evidence %#', (override, message) => {
    const valid = buildFrozenLeaderboardReconciliationEvidence([
      sourceRow('alice', '7D'),
      sourceRow('bob', '30D'),
      sourceRow('carol', '90D'),
    ])
    const malformed = {
      ...valid,
      ...override,
    }

    expect(() =>
      assertMeilisearchReconciliationMatch(malformed as MeilisearchReconciliationEvidence, valid)
    ).toThrow(message)
  })

  it('rejects missing or extra top-level runtime evidence fields', () => {
    const valid = buildFrozenLeaderboardReconciliationEvidence([
      sourceRow('alice', '7D'),
      sourceRow('bob', '30D'),
      sourceRow('carol', '90D'),
    ])
    const { sorted_id_sha256: _missing, ...missingSha } = valid

    expect(() => assertMeilisearchReconciliationEvidence(missingSha)).toThrow(
      'unexpected evidence shape'
    )
    expect(() => assertMeilisearchReconciliationEvidence({ ...valid, extra: true })).toThrow(
      'unexpected evidence shape'
    )
  })

  it('accepts only the requested task after Meilisearch reports succeeded', () => {
    expect(
      assertMeilisearchTaskSucceeded(
        { uid: 42, status: 'succeeded', error: null, private: 'not reflected' },
        42
      )
    ).toEqual({ task_uid: 42, status: 'succeeded' })
    expect(assertMeilisearchTaskSucceeded({ taskUid: 43, status: 'succeeded' })).toEqual({
      task_uid: 43,
      status: 'succeeded',
    })
  })

  it.each(['enqueued', 'processing', 'failed', 'canceled'])(
    'rejects the non-success task status %s',
    (status) => {
      expect(() => assertMeilisearchTaskSucceeded({ uid: 42, status })).toThrow(
        `did not succeed (status: ${status})`
      )
    }
  )

  it('rejects malformed, mismatched, and internally contradictory task responses', () => {
    expect(() => assertMeilisearchTaskSucceeded(null)).toThrow('must be an object')
    expect(() => assertMeilisearchTaskSucceeded({ status: 'succeeded' })).toThrow(
      'missing a valid task identifier'
    )
    expect(() =>
      assertMeilisearchTaskSucceeded({ uid: 42, taskUid: 41, status: 'succeeded' })
    ).toThrow('conflicting task identifiers')
    expect(() => assertMeilisearchTaskSucceeded({ uid: 42, status: 'succeeded' }, 41)).toThrow(
      'task identifier mismatch'
    )
    expect(() =>
      assertMeilisearchTaskSucceeded({ uid: 42, status: 'succeeded', error: { secret: 'x' } })
    ).toThrow('reported an error despite succeeded status')
  })

  it('does not reflect an unknown task status into errors', () => {
    const secretLikeStatus = 'token-should-not-appear'
    expect(() => assertMeilisearchTaskSucceeded({ uid: 42, status: secretLikeStatus })).toThrow(
      'status: <invalid>'
    )
    try {
      assertMeilisearchTaskSucceeded({ uid: 42, status: secretLikeStatus })
    } catch (error) {
      expect(String(error)).not.toContain(secretLikeStatus)
    }
  })
})
