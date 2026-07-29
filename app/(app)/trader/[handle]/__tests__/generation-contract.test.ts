import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const page = readFileSync(join(__dirname, '..', 'page.tsx'), 'utf8')

describe('trader page direct ranking generation contract', () => {
  it('seals every per-season score read and the 90D metadata read', () => {
    expect(page).toContain('TRADER_SCORE_SEASONS.map(async (season)')
    expect(page.match(/readSealedRankingGeneration\(/g)).toHaveLength(2)
    expect(
      page.match(/\.filter\('rank_publication_id', 'eq', publication\.scoreCohortId\)/g)
    ).toHaveLength(2)
    expect(page).toContain('if (result.error)')
  })

  it('keeps cached ranking values in source-scoped sealed envelopes', () => {
    expect(page).toContain("['trader-serving-scores-sealed-v3']")
    expect(page).toContain("['trader-lb-meta-sealed-v3']")
    expect(page.match(/createSealedRankingCacheEntry\(sealedRead\)/g)).toHaveLength(2)
    expect(page.match(/parseSealedRankingCacheEntry</g)).toHaveLength(2)
    expect(page.match(/sources: \[publicPlatform\]/g)).toHaveLength(2)
    expect(page.match(/\[platform\]/g)?.length ?? 0).toBeGreaterThanOrEqual(2)
  })
})
