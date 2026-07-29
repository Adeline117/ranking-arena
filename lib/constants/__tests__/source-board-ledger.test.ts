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
import { REQUIRED_RELEASE_REGIONS } from '@/lib/ingest/worker-release-readiness'

const sorted = (values: readonly string[]) => [...values].sort()
const difference = (left: readonly string[], right: readonly string[]) => {
  const rightSet = new Set(right)
  return sorted(left.filter((value) => !rightSet.has(value)))
}

function parseArenaSeedRows(seed: string) {
  return [
    ...seed.matchAll(
      /^\s*\('([^']+)',\s*\(SELECT id FROM arena\.exchanges WHERE slug='[^']+'\),\s*'[^']+',\s*'[^']+',\s*'([^']+)',[\s\S]*?\s*'(local|vps_sg)',\s*\d+,\s*'[^']+',/gm
    ),
  ].map((match) => ({
    registrySlug: match[1],
    adapterSlug: match[2],
    fetchRegion: match[3],
  }))
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
    const seedRows = parseArenaSeedRows(seed)
    const ledgerRows = ledger.arenaSeedRegistry.sourceRows.map(({ registrySlug, adapterSlug }) => ({
      registrySlug,
      adapterSlug,
    }))
    const registeredAdapters = listAdapters()

    expect(
      seedRows.map(({ registrySlug, adapterSlug }) => ({ registrySlug, adapterSlug }))
    ).toEqual(ledgerRows)
    expect(ledger.counts.arenaSeedSourceRows).toBe(seedRows.length)
    expect(sorted(ledger.registeredIngestAdapterSlugs)).toEqual(sorted(registeredAdapters))
    expect(ledger.counts.registeredIngestAdapters).toBe(registeredAdapters.length)
    expect(sorted([...new Set(seedRows.map(({ adapterSlug }) => adapterSlug))])).toEqual(
      sorted(registeredAdapters)
    )
  })

  it('routes every replayable source into a required owned region', () => {
    const seed = readFileSync(join(process.cwd(), ledger.arenaSeedRegistry.migration), 'utf8')
    const seedRows = parseArenaSeedRows(seed)
    const finalRegionBySource = new Map(
      seedRows.map(({ registrySlug, fetchRegion }) => [registrySlug, fetchRegion])
    )
    const repair = readFileSync(join(process.cwd(), ledger.regionRouting.repairMigration), 'utf8')

    expect(ledger.schemaVersion).toBe(2)
    expect(sorted(ledger.regionRouting.requiredReleaseRegions)).toEqual(
      sorted(REQUIRED_RELEASE_REGIONS)
    )

    for (const reassignment of ledger.regionRouting.reassignments) {
      expect(finalRegionBySource.get(reassignment.registrySlug)).toBe(reassignment.from)
      const updateBlocks = [
        ...repair.matchAll(
          /UPDATE arena\.sources AS source\nSET[\s\S]*?\nWHERE source\.slug = '([^']+)'[\s\S]*?;/g
        ),
      ]
      const block = updateBlocks.find((match) => match[1] === reassignment.registrySlug)?.[0]
      expect(block).toContain(`fetch_region = '${reassignment.to}'`)
      finalRegionBySource.set(reassignment.registrySlug, reassignment.to)
    }

    const routedSources = Object.entries(
      ledger.regionRouting.finalReplayableSourcesByRegion
    ).flatMap(([region, sources]) => {
      expect(REQUIRED_RELEASE_REGIONS).toContain(region)
      return sources.map((source) => ({ source, region }))
    })
    expect(new Set(routedSources.map(({ source }) => source)).size).toBe(routedSources.length)
    expect(sorted(routedSources.map(({ source }) => source))).toEqual(
      sorted(seedRows.map(({ registrySlug }) => registrySlug))
    )
    for (const { source, region } of routedSources) {
      expect(finalRegionBySource.get(source)).toBe(region)
    }

    expect(ledger.counts.replayableLocalSourceRows).toBe(
      ledger.regionRouting.finalReplayableSourcesByRegion.local.length
    )
    expect(ledger.counts.replayableVpsSgSourceRows).toBe(
      ledger.regionRouting.finalReplayableSourcesByRegion.vps_sg.length
    )
    expect(ledger.regionRouting.finalReplayableSourcesByRegion).not.toHaveProperty('vps_jp')
    expect(ledger.regionRouting.currentFleetOwnership.status).toBe('unverified')

    const schedulerTest = readFileSync(
      join(process.cwd(), ledger.regionRouting.schedulerContract.test),
      'utf8'
    )
    expect(schedulerTest).toContain('routes every active source through its fetch_region queue')
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
