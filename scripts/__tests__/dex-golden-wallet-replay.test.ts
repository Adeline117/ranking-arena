import fixtureJson from '../fixtures/dex-golden-wallets.v1.json'
import {
  buildDexGoldenWalletCandidates,
  type DexGoldenWalletQueryRow,
} from '../lib/dex-golden-wallet-query'
import {
  assertDexGoldenProductionDatabaseUrlLiteral,
  buildDexGoldenPinnedQueryParameters,
  DEX_GOLDEN_PINNED_CANDIDATE_QUERY,
  dexGoldenPinnedCandidateQuerySha256,
  parseDexGoldenGeneratorArgs,
  verifyDexGoldenPinnedSnapshotRebuild,
} from '../lib/dex-golden-wallet-replay'
import {
  buildDexGoldenWalletSnapshot,
  parseDexGoldenWalletSnapshot,
} from '../lib/dex-golden-wallets'

const SOURCE_META = {
  binance_web3_bsc: { chainId: '56', currency: 'USDT' },
  okx_web3_solana: { chainId: '501', currency: 'USDC' },
} as const
const VERIFIER_GIT_SHA = 'a'.repeat(40)
const PRODUCTION_DATABASE_URL =
  'postgresql://postgres.iknktzifjdyujdccyhsv:secret@aws-0-us-west-2.pooler.supabase.com:5432/postgres'

function syntheticRows(): DexGoldenWalletQueryRow[] {
  const fixture = parseDexGoldenWalletSnapshot(fixtureJson)
  return fixture.wallets.map((wallet) => {
    const source = SOURCE_META[wallet.source_slug]
    const activity = String(wallet.activity_proxy_count)
    return {
      source_slug: wallet.source_slug,
      snapshot_id: wallet.source_snapshot_id,
      snapshot_scraped_at: wallet.source_snapshot_scraped_at,
      snapshot_actual_count: 50,
      source_currency: source.currency,
      entry_currency: source.currency,
      source_meta_chain_id: source.chainId,
      is_derived: false,
      wallet_address: wallet.wallet,
      exchange_trader_id: wallet.wallet,
      source_rank: wallet.source_rank,
      pnl_90d_raw: wallet.pnl_90d,
      activity_json_type: 'number',
      activity_total_raw: activity,
      activity_buy_json_type: wallet.source_slug === 'binance_web3_bsc' ? 'number' : null,
      activity_buy_raw: wallet.source_slug === 'binance_web3_bsc' ? activity : null,
      activity_sell_json_type: wallet.source_slug === 'binance_web3_bsc' ? 'number' : null,
      activity_sell_raw: wallet.source_slug === 'binance_web3_bsc' ? '0' : null,
      period_type: wallet.source_slug === 'okx_web3_solana' ? '5' : null,
      raw_chain_id: source.chainId,
    }
  })
}

function expandedSyntheticRows(): DexGoldenWalletQueryRow[] {
  const rows = syntheticRows().map((row) => ({ ...row, snapshot_actual_count: 51 }))
  const extraWallets = {
    binance_web3_bsc: `0x${'f'.repeat(40)}`,
    okx_web3_solana: '11111111111111111111111111111111',
  } as const
  for (const sourceSlug of Object.keys(extraWallets) as Array<keyof typeof extraWallets>) {
    const sourceRows = rows.filter((row) => row.source_slug === sourceSlug)
    const template = sourceRows[0]
    const wallet = extraWallets[sourceSlug]
    rows.push({
      ...template,
      wallet_address: wallet,
      exchange_trader_id: wallet,
      source_rank: Math.max(...sourceRows.map((row) => row.source_rank)) + 1,
      pnl_90d_raw: '1',
      activity_total_raw: '0',
      activity_buy_raw: sourceSlug === 'binance_web3_bsc' ? '0' : null,
      activity_sell_raw: sourceSlug === 'binance_web3_bsc' ? '0' : null,
    })
  }
  return rows
}

function syntheticFixture(rows: readonly DexGoldenWalletQueryRow[]): unknown {
  const productionFixture = parseDexGoldenWalletSnapshot(fixtureJson)
  return buildDexGoldenWalletSnapshot({
    candidates: buildDexGoldenWalletCandidates(rows),
    generatedAt: productionFixture.generated_at,
    generatorGitSha: productionFixture.generator_git_sha,
    sampleSeed: productionFixture.sample_seed,
  }).snapshot
}

function rebuild(fixture: unknown, rows: readonly DexGoldenWalletQueryRow[]) {
  return verifyDexGoldenPinnedSnapshotRebuild({
    fixture,
    rows,
    verifierGitSha: VERIFIER_GIT_SHA,
    verifierWorktreeClean: true,
    databaseUrl: PRODUCTION_DATABASE_URL,
  })
}

describe('DEX golden-wallet pinned replay', () => {
  it('accepts only the default generation mode or the explicit read-only replay mode', () => {
    expect(parseDexGoldenGeneratorArgs([])).toBe('generate-latest')
    expect(parseDexGoldenGeneratorArgs(['--verify-pinned'])).toBe('verify-pinned')
    expect(() => parseDexGoldenGeneratorArgs(['--verify-pinned', '--write'])).toThrow('Usage')
    expect(() => parseDexGoldenGeneratorArgs(['--latest'])).toThrow('Usage')
  })

  it('accepts only literal Ranking Arena production URL authority shapes', () => {
    const poolerUrl =
      'postgresql://postgres.iknktzifjdyujdccyhsv:secret@aws-0-us-west-2.pooler.supabase.com:5432/postgres'
    expect(() =>
      assertDexGoldenProductionDatabaseUrlLiteral(
        'postgresql://postgres:secret@db.iknktzifjdyujdccyhsv.supabase.co:5432/postgres'
      )
    ).not.toThrow()
    expect(() => assertDexGoldenProductionDatabaseUrlLiteral(poolerUrl)).not.toThrow()
    for (const suffix of [
      '?host=evil.example',
      '?user=other',
      '?sslmode=disable',
      '#ignored-override',
    ]) {
      expect(() => assertDexGoldenProductionDatabaseUrlLiteral(`${poolerUrl}${suffix}`)).toThrow(
        'must not contain query parameters or a fragment'
      )
    }
    const otherDatabaseUrl = new URL(poolerUrl)
    otherDatabaseUrl.pathname = '/other'
    expect(() => assertDexGoldenProductionDatabaseUrlLiteral(otherDatabaseUrl.toString())).toThrow(
      'select the postgres database explicitly'
    )
    const previousPgPort = process.env.PGPORT
    process.env.PGPORT = '9999'
    try {
      expect(() =>
        assertDexGoldenProductionDatabaseUrlLiteral(
          'postgresql://postgres:secret@db.iknktzifjdyujdccyhsv.supabase.co/postgres'
        )
      ).toThrow('unsupported production port')
    } finally {
      if (previousPgPort === undefined) delete process.env.PGPORT
      else process.env.PGPORT = previousPgPort
    }
    expect(() =>
      assertDexGoldenProductionDatabaseUrlLiteral(poolerUrl.replace(':5432/', ':443/'))
    ).toThrow('unsupported production port')
    expect(() =>
      assertDexGoldenProductionDatabaseUrlLiteral(
        'postgresql://postgres.other-project:do-not-leak@aws-0-us-west-2.pooler.supabase.com:5432/postgres'
      )
    ).toThrow('not bound to Ranking Arena production')
    try {
      assertDexGoldenProductionDatabaseUrlLiteral(
        'postgresql://postgres.other-project:do-not-leak@aws-0-us-west-2.pooler.supabase.com:5432/postgres'
      )
    } catch (error) {
      expect(String(error)).not.toContain('do-not-leak')
    }
  })

  it('derives exact source/snapshot pairs in canonical source order', () => {
    expect(buildDexGoldenPinnedQueryParameters(fixtureJson)).toEqual({
      sourceSlugs: ['binance_web3_bsc', 'okx_web3_solana'],
      snapshotIds: ['18904', '18891'],
    })
  })

  it('pins the exact replay SQL while excluding mutable current serving status', () => {
    expect(DEX_GOLDEN_PINNED_CANDIDATE_QUERY).toContain('unnest($1::text[], $2::bigint[])')
    expect(DEX_GOLDEN_PINNED_CANDIDATE_QUERY).toContain('ls.id = r.snapshot_id')
    expect(DEX_GOLDEN_PINNED_CANDIDATE_QUERY).toContain('ls.count_check_passed')
    expect(DEX_GOLDEN_PINNED_CANDIDATE_QUERY).not.toContain("s.status = 'active'")
    expect(DEX_GOLDEN_PINNED_CANDIDATE_QUERY).not.toContain("s.serving_mode = 'serving'")
    expect(dexGoldenPinnedCandidateQuerySha256()).toBe(
      'aa164efcd956c6b4fcecd05b208638a438b14c8681dab852b8c545a2bae33dd4'
    )
  })

  it('rebuilds only the selected fixture and keeps every broader trust claim closed', () => {
    const rows = syntheticRows()
    const fixture = syntheticFixture(rows)
    const report = rebuild(fixture, rows)

    expect(report).toMatchObject({
      data_contract: 'arena.dex.golden-wallet-pinned-snapshot-rebuild@1',
      result: 'selected_fixture_rebuilt',
      verification_scope: 'normalized_leaderboard_snapshot_rows_only',
      selected_fixture_sha256_verified: true,
      provider_refetch_performed: false,
      provider_body_persistence_authorized: false,
      population_denominator_authorized: false,
      serving_authorized: false,
      rank_eligible: false,
      score_eligible: false,
      verifier_git_sha: VERIFIER_GIT_SHA,
      verifier_worktree_clean: true,
      database_url_binding: 'literal_authority_bound_to_ranking_arena_project_ref',
      tls_transport_encrypted: true,
      tls_server_identity_verified: false,
      production_database_identity_verified: false,
      candidate_query_binding: 'verifier_code_only_not_parent_fixture',
      queried_row_set_commitment_state: 'observed_unpinned',
      eligible_candidate_set_commitment_state: 'observed_unpinned',
      queried_row_count: 100,
      eligible_candidate_count: 100,
      eligible_candidate_counts: {
        binance_web3_bsc: 50,
        okx_web3_solana: 50,
      },
    })
    expect(report.expected_snapshot_sha256).toBe(report.rebuilt_snapshot_sha256)
    expect(report.observed_query_row_set_sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(report.observed_eligible_candidate_set_sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(JSON.stringify(report)).not.toContain(rows[0].exchange_trader_id)
  })

  it('refuses to issue rebuild evidence for dirty or unidentifiable verifier code', () => {
    const rows = syntheticRows()
    const fixture = syntheticFixture(rows)
    expect(() =>
      verifyDexGoldenPinnedSnapshotRebuild({
        fixture,
        rows,
        verifierGitSha: VERIFIER_GIT_SHA,
        verifierWorktreeClean: false,
        databaseUrl: PRODUCTION_DATABASE_URL,
      })
    ).toThrow('clean Git worktree')
    expect(() =>
      verifyDexGoldenPinnedSnapshotRebuild({
        fixture,
        rows,
        verifierGitSha: 'dirty',
        verifierWorktreeClean: true,
        databaseUrl: PRODUCTION_DATABASE_URL,
      })
    ).toThrow('full lowercase SHA')
    expect(() =>
      verifyDexGoldenPinnedSnapshotRebuild({
        fixture,
        rows,
        verifierGitSha: VERIFIER_GIT_SHA,
        verifierWorktreeClean: true,
        databaseUrl:
          'postgresql://postgres.other:secret@aws-0-us-west-2.pooler.supabase.com:5432/postgres',
      })
    ).toThrow('not bound to Ranking Arena production')
  })

  it('is independent of PostgreSQL row delivery order', () => {
    const rows = syntheticRows()
    const fixture = syntheticFixture(rows)
    const forward = rebuild(fixture, rows)
    const reverse = rebuild(fixture, [...rows].reverse())
    const dateObjects = rebuild(
      fixture,
      rows.map((row) => ({
        ...row,
        snapshot_scraped_at: new Date(row.snapshot_scraped_at),
      }))
    )

    expect(reverse).toEqual(forward)
    expect(dateObjects).toEqual(forward)
  })

  it('rejects any candidate mutation that changes the frozen fixture', () => {
    const rows = syntheticRows()
    const fixture = syntheticFixture(rows)
    const mutated = rows.map((row, index) =>
      index === 0
        ? {
            ...row,
            activity_total_raw: String(Number(row.activity_total_raw) + 1),
            activity_buy_raw: String(Number(row.activity_buy_raw) + 1),
          }
        : row
    )

    expect(() => rebuild(fixture, mutated)).toThrow(
      'pinned golden-wallet snapshot rebuild mismatch'
    )
  })

  it('binds queried fields even when they do not affect the selected fixture', () => {
    const rows = syntheticRows()
    const fixture = syntheticFixture(rows)
    const baseline = rebuild(fixture, rows)
    const changedUnusedField = rows.map((row, index) =>
      index === 0 ? { ...row, raw_chain_id: '999' } : row
    )
    const changed = rebuild(fixture, changedUnusedField)

    expect(changed.expected_snapshot_sha256).toBe(baseline.expected_snapshot_sha256)
    expect(changed.observed_eligible_candidate_set_sha256).toBe(
      baseline.observed_eligible_candidate_set_sha256
    )
    expect(changed.observed_query_row_set_sha256).not.toBe(baseline.observed_query_row_set_sha256)
  })

  it('labels unselected-candidate drift as observed and unpinned, never fully verified', () => {
    const rows = expandedSyntheticRows()
    const fixture = syntheticFixture(rows)
    const selected = new Set(
      parseDexGoldenWalletSnapshot(fixture).wallets.map(
        (wallet) => `${wallet.source_slug}:${wallet.wallet}`
      )
    )
    const omitted = rows.find(
      (row) => !selected.has(`${row.source_slug}:${row.exchange_trader_id}`)
    )
    expect(omitted).toBeDefined()
    const changedRows = rows.map((row) =>
      row === omitted ? { ...row, pnl_90d_raw: String(Number(row.pnl_90d_raw) + 1) } : row
    )

    const baseline = rebuild(fixture, rows)
    const changed = rebuild(fixture, changedRows)
    expect(changed.result).toBe('selected_fixture_rebuilt')
    expect(changed.selected_fixture_sha256_verified).toBe(true)
    expect(changed.queried_row_set_commitment_state).toBe('observed_unpinned')
    expect(changed.eligible_candidate_set_commitment_state).toBe('observed_unpinned')
    expect(changed.observed_query_row_set_sha256).not.toBe(baseline.observed_query_row_set_sha256)
    expect(changed.observed_eligible_candidate_set_sha256).not.toBe(
      baseline.observed_eligible_candidate_set_sha256
    )
  })
})
