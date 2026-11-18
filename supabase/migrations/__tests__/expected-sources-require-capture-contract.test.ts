import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  ATTEMPT_BOUND_LEADERBOARD_ACQUISITION_V3_CONTRACT,
  ATTEMPT_BOUND_LEADERBOARD_ACQUISITION_V4_CONTRACT,
} from '@/lib/ingest/acquisition-attempts'
import { LEADERBOARD_ACQUISITION_ATTEMPT_BINDING_CONTRACT } from '@/lib/ingest/acquisition-manifest'
import {
  CAPTURE_CONTRACT_REGISTRATION_MARKER,
  RANK_PUBLICATION_MIN_EXPECTED_SOURCES,
} from '@/lib/rankings/publication/publish-season'

const read = (path: string) => readFileSync(join(process.cwd(), path), 'utf8')
const migration = read(
  'supabase/migrations/20261118113759_expected_sources_require_capture_contract.sql'
)
const acquisitionAttempts = read('lib/ingest/acquisition-attempts.ts')
const tierA = read('worker/src/ingest/processors/tier-a-leaderboard.ts')
const proof = read(
  'supabase/migrations/__tests__/expected-sources-require-capture-contract.pg17.sh'
)
const packageJson = read('package.json')
const ciWorkflow = read('.github/workflows/ci.yml')

const helper =
  migration.match(
    /CREATE OR REPLACE FUNCTION arena\.leaderboard_capture_contract_registered\([\s\S]*?\$function\$;/
  )?.[0] ?? ''

describe('expected sources require a capture contract registration (20261118113759)', () => {
  it('defines "valid registration" exactly as the worker validates the registry row', () => {
    // TypeScript side (lib/ingest/acquisition-attempts.ts): the worker selects
    // the row by source and contract, then requires these four properties.
    expect(acquisitionAttempts).toMatch(
      /isAttemptBoundLeaderboardAcquisitionContract\([\s\S]*?ATTEMPT_BOUND_LEADERBOARD_ACQUISITION_V3_CONTRACT \|\|[\s\S]*?ATTEMPT_BOUND_LEADERBOARD_ACQUISITION_V4_CONTRACT/
    )
    expect(acquisitionAttempts).toContain('row.adapter_slug !== input.adapterSlug ||')
    expect(acquisitionAttempts).toContain(
      'row.attempt_binding_contract !== LEADERBOARD_ACQUISITION_ATTEMPT_BINDING_CONTRACT ||'
    )
    expect(acquisitionAttempts).toContain('row.requires_runner_git_sha !== true')
    // Tier-A passes the source's own adapter slug, so SQL compares to it.
    expect(tierA).toContain('adapterSlug: src.adapter_slug,')

    // SQL side: the one helper mirrors each property with the same literals.
    expect(helper).not.toBe('')
    expect(helper).toContain(`'${ATTEMPT_BOUND_LEADERBOARD_ACQUISITION_V3_CONTRACT}'`)
    expect(helper).toContain(`'${ATTEMPT_BOUND_LEADERBOARD_ACQUISITION_V4_CONTRACT}'`)
    expect(helper).toContain(`'${LEADERBOARD_ACQUISITION_ATTEMPT_BINDING_CONTRACT}'`)
    expect(helper).toContain('capture.source_id = p_source_id')
    expect(helper).toContain('capture.adapter_slug = p_adapter_slug')
    expect(helper).toContain('capture.requires_runner_git_sha IS TRUE')
    // No hand-written source list anywhere in the migration.
    expect(migration).not.toMatch(/'(?:hyperliquid|bitget_futures|xt_spot|gmx|mexc_futures)'/)
  })

  it('puts the predicate in the single freshness authority the orchestrator reads', () => {
    expect(migration).toContain(
      'CREATE OR REPLACE FUNCTION public.arena_freshness_expected_sources()'
    )
    expect(migration).toContain(`-- ${CAPTURE_CONTRACT_REGISTRATION_MARKER}`)
    expect(migration).toMatch(
      /AND source_row\.serving_mode = 'serving'\n {4}-- leaderboard-capture-contract-registration@1\n {4}AND \(\n {6}arena\.leaderboard_capture_contract_registered\(\n {8}source_row\.id::integer,\n {8}source_row\.adapter_slug\n {6}\)/
    )
    // Isolation and the Bitget-bot quarantine are kept verbatim.
    expect(migration).toContain('-- leaderboard-publication-source-isolation@1')
    expect(migration).toContain('-- bitget-bot-cumulative-rank-quarantine@1')
    // Digest-fenced static replacement, no dynamic SQL.
    expect(migration).toContain('9427c4e01af650268ec07534a61101d9f177b38f07ceec621ae4e4b0a8cbc56b')
    expect(migration).not.toMatch(/^\s*EXECUTE\s+(?!FUNCTION)/m)
    expect(migration).not.toMatch(/\bDROP\b(?![^\n]*--)/)
  })

  it('lists unsupported sources from the same function and records them per cohort', () => {
    expect(migration).toMatch(
      /FUNCTION public\.arena_publication_unsupported_sources\(\)[\s\S]*?SET arena\.freshness_include_unsupported = 'on'[\s\S]*?FROM public\.arena_freshness_expected_sources\(\) AS declared/
    )
    expect(migration).toContain(
      'CREATE TABLE IF NOT EXISTS arena.leaderboard_publication_unsupported_sources'
    )
    expect(migration).toContain(
      'GRANT EXECUTE ON FUNCTION public.public_leaderboard_unsupported_sources()\n  TO anon, authenticated, service_role;'
    )
  })

  it('keeps the TypeScript floor at the reviewed value', () => {
    expect(RANK_PUBLICATION_MIN_EXPECTED_SOURCES).toBe(8)
  })

  it('has an executable PostgreSQL 17 proof wired into CI', () => {
    expect(proof).toContain('apply 20261118113759_expected_sources_require_capture_contract.sql')
    expect(packageJson).toContain(
      '"qa:expected-sources-capture-contract-pg17": "bash supabase/migrations/__tests__/expected-sources-require-capture-contract.pg17.sh"'
    )
    expect(ciWorkflow).toContain('run: npm run qa:expected-sources-capture-contract-pg17')
  })
})
