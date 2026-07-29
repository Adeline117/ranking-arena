import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const queries = readFileSync(join(process.cwd(), 'lib/data/trader/queries.ts'), 'utf8')
const searchStart = queries.indexOf('export async function searchTraders(')
const searchEnd = queries.indexOf('/**\n * Get "did you mean"', searchStart)
const searchSource = queries.slice(searchStart, searchEnd)

describe('trader search ranking authority', () => {
  it('uses text search only for candidates and rematerializes exact public identities', () => {
    expect(searchSource).toContain('isPublicRankingSourceAllowed(t.source)')
    expect(searchSource).toContain('await readSealedRankIdentities(')
    expect(searchSource).toContain("supabase,\n    '90D',")
    expect(searchSource).not.toContain(".from('leaderboard_ranks')")
  })

  it('never accepts mutable rank fields returned by the fuzzy candidate RPC', () => {
    expect(searchSource).not.toContain('scoreMap.set(key, {')
    expect(searchSource).toContain('for (const row of sealedRanks.value)')
  })
})
