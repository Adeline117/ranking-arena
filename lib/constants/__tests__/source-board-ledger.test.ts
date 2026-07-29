import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import ledger from '@/docs/source-board-ledger.json'
import { ALL_SOURCES, SOURCES_WITH_DATA } from '../exchanges'
import {
  PUBLIC_RANKING_QUARANTINED_SOURCES,
  isPublicRankingSourceAllowed,
} from '@/lib/rankings/publication-policy'

const sorted = (values: readonly string[]) => [...values].sort()
const difference = (left: readonly string[], right: readonly string[]) => {
  const rightSet = new Set(right)
  return sorted(left.filter((value) => !rightSet.has(value)))
}

describe('machine-verifiable source-board ledger', () => {
  it('partitions every code-registry board into one company or protocol family', () => {
    const familySources = ledger.families.flatMap(({ sources }) => sources)

    expect(ledger.countUnit).toBe('source_board')
    expect(new Set(ledger.families.map(({ id }) => id)).size).toBe(ledger.families.length)
    expect(new Set(familySources).size).toBe(familySources.length)
    expect(sorted(familySources)).toEqual(sorted(ALL_SOURCES))
    expect(ledger.counts.codeRegistrySourceBoards).toBe(ALL_SOURCES.length)
    expect(ledger.counts.companyOrProtocolFamilies).toBe(ledger.families.length)
  })

  it('derives public permission and configured-data differences from code', () => {
    const publicAllowed = ALL_SOURCES.filter(isPublicRankingSourceAllowed)

    expect(sorted(ledger.publicRankingQuarantinedSources)).toEqual(
      sorted(PUBLIC_RANKING_QUARANTINED_SOURCES)
    )
    expect(ledger.counts.publicRankingAllowedSourceBoards).toBe(publicAllowed.length)
    expect(sorted(ledger.configuredSourcesWithData)).toEqual(sorted(SOURCES_WITH_DATA))
    expect(ledger.counts.configuredSourcesWithData).toBe(SOURCES_WITH_DATA.length)
    expect(sorted(ledger.setDifferences.publicAllowedWithoutConfiguredData)).toEqual(
      difference(publicAllowed, SOURCES_WITH_DATA)
    )
    expect(sorted(ledger.setDifferences.configuredDataWithoutPublicRankingPermission)).toEqual(
      difference(SOURCES_WITH_DATA, publicAllowed)
    )
  })

  it('keeps current serving unknown and validates the dated checked-in evidence separately', () => {
    expect(ledger.currentServing).toMatchObject({ count: null, status: 'unverified' })

    const evidencePath = join(process.cwd(), ledger.latestCheckedInServingEvidence.artifact)
    const evidence = readFileSync(evidencePath, 'utf8')
    const evidenceSlugs = [...evidence.matchAll(/^## ([a-z0-9_]+)$/gm)].map((match) => match[1])

    expect(evidence).toContain(
      `generated_at          | \`${ledger.latestCheckedInServingEvidence.generatedAt}\``
    )
    expect(evidence).toContain(
      `**${ledger.latestCheckedInServingEvidence.count} serving sources.**`
    )
    expect(sorted(ledger.latestCheckedInServingEvidence.registrySlugs)).toEqual(
      sorted(evidenceSlugs)
    )
    expect(ledger.latestCheckedInServingEvidence.count).toBe(evidenceSlugs.length)
  })
})
