import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import ledger from '@/docs/source-board-ledger.json'
import { ALL_SOURCES, SOURCES_WITH_DATA } from '../exchanges'
import {
  PUBLIC_RANKING_QUARANTINED_SOURCES,
  isPublicRankingSourceAllowed,
} from '@/lib/rankings/publication-policy'
import '@/lib/ingest/adapters/register'
import { listAdapters } from '@/lib/ingest/core/adapter'

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

  it('maps every replayable Arena seed row to a registered ingest adapter', () => {
    const seed = readFileSync(join(process.cwd(), ledger.arenaSeedRegistry.migration), 'utf8')
    const seedRows = [
      ...seed.matchAll(
        /\('([a-z0-9_]+)',\s*\(SELECT id FROM arena\.exchanges WHERE slug='[a-z0-9_]+'\),\s*'[a-z]+',\s*'[a-z]+',\s*'([a-z0-9_]+)'/g
      ),
    ].map((match) => ({ registrySlug: match[1], adapterSlug: match[2] }))
    const ledgerRows = ledger.arenaSeedRegistry.sourceRows.map(({ registrySlug, adapterSlug }) => ({
      registrySlug,
      adapterSlug,
    }))
    const registeredAdapters = listAdapters()

    expect(seedRows).toEqual(ledgerRows)
    expect(ledger.counts.arenaSeedSourceRows).toBe(seedRows.length)
    expect(sorted(ledger.registeredIngestAdapterSlugs)).toEqual(sorted(registeredAdapters))
    expect(ledger.counts.registeredIngestAdapters).toBe(registeredAdapters.length)
    expect(sorted([...new Set(seedRows.map(({ adapterSlug }) => adapterSlug))])).toEqual(
      sorted(registeredAdapters)
    )
  })

  it('pins the intentional identity gaps between code and Arena seed registries', () => {
    const arenaPlatformIdentities = ledger.arenaSeedRegistry.sourceRows.map(
      ({ platformIdentity }) => platformIdentity
    )

    expect(sorted(ledger.setDifferences.codeRegistryWithoutArenaSeedIdentity)).toEqual(
      difference(ALL_SOURCES, arenaPlatformIdentities)
    )
    expect(sorted(ledger.setDifferences.arenaSeedIdentityWithoutCodeRegistry)).toEqual(
      difference(arenaPlatformIdentities, ALL_SOURCES)
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
    expect(sorted(ledger.setDifferences.arenaSeedWithoutLatestCheckedInFieldRows)).toEqual(
      difference(
        ledger.arenaSeedRegistry.sourceRows.map(({ registrySlug }) => registrySlug),
        evidenceSlugs
      )
    )
  })
})
