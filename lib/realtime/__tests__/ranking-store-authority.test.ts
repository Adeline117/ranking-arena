import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const store = readFileSync(join(process.cwd(), 'lib/realtime/ranking-store.ts'), 'utf8')

describe('sealed Redis ranking cache authority', () => {
  it('rebuilds from one stable sealed publication generation', () => {
    expect(store).toContain('readSealedRankingAuthorityGeneration(')
    expect(store).toContain('const authoritySources = publication.proofs.map')
    expect(store).toContain(".in('source', authoritySources)")
    expect(store).toContain(".filter('rank_publication_id', 'eq', publication.scoreCohortId)")
    expect(store).toContain(".order('arena_score', { ascending: false })")
    expect(store).toContain(".order('source', { ascending: true })")
    expect(store).toContain(".order('source_trader_id', { ascending: true })")
  })

  it('fails closed on partial reads and incomplete cache populations', () => {
    expect(store).toContain('if (error || data === null)')
    expect(store).toContain('allTraders.length !== expectedRowCount')
    expect(store).toContain('.abortSignal(workSignal)')
    expect(store).toContain('{ timeoutMs: 10_000, signal: workSignal }')
    expect(store).toContain("throw new Error('Redis unavailable")
    expect(store).toContain('acknowledgements.length !== commandCount')
    expect(store).toContain('generation returned duplicate member')
    expect(store).toMatch(
      /catch \(error\) \{\s+logger\.error\('\[ranking-store\] syncSortedSetFromLeaderboard failed:', error\)\s+throw error/
    )
  })

  it('batches Redis writes and verifies exact transaction acknowledgements', () => {
    expect(store).toContain('transaction.zadd(key, members[0], ...members.slice(1))')
    expect(store).toContain('transaction.hset(hashKey, detailEntries)')
    expect(store).toContain('exactAcknowledgements.set(rankingExpiryIndex, 1)')
    expect(store).toContain('exactAcknowledgements.set(detailExpiryIndex, 1)')
  })

  it('isolates the sealed namespace and forbids incremental public writes', () => {
    expect(store).toContain("const REDIS_KEY_PREFIX = 'ranking:sealed-v1'")
    expect(store).toContain("const DETAIL_HASH_PREFIX = 'ranking:detail:sealed-v1'")
    expect(store).toContain('Incremental scores have no publication proof')
    expect(store).not.toContain('writeBuffer')
    expect(store).not.toContain('scheduleFlush')
  })
})
