import type { PoolClient } from 'pg'

import {
  buildLeaderboardAcquisitionManifest,
  buildLeaderboardAcquisitionManifestV3,
  LEADERBOARD_ACQUISITION_ATTEMPT_BINDING_CONTRACT,
  LEADERBOARD_ACQUISITION_MANIFEST_V2_CONTRACT,
  LEADERBOARD_ACQUISITION_MANIFEST_V3_CONTRACT,
} from '../../acquisition-manifest'
import type { ParsedLeaderboardRow, RawPage, SourceRow } from '../../core/types'
import {
  prepareLeaderboardMetricTrust,
  reconcileLeaderboardMetricTrust,
  writeLeaderboardMetricTrust,
} from '../metric-trust-publish'

const src = {
  id: 1,
  slug: 'binance_futures',
  adapter_slug: 'binance',
  currency: 'USDT',
  page_size: 100,
  pagination_kind: 'numeric',
  tf_label_map: {},
  meta: {},
} as SourceRow

const sourcePage: RawPage = {
  pageIndex: 1,
  payload: {
    code: '000000',
    success: true,
    data: {
      total: 2,
      list: [
        { leadPortfolioId: 'one', roi: 10, pnl: 100 },
        { leadPortfolioId: 'two', roi: 5, pnl: 50 },
      ],
    },
  },
  url: 'https://www.binance.com/bapi/futures/v1/friendly/future/copy-trade/home-page/query-list',
  fetchedAt: '2026-07-21T10:00:01.000Z',
}

const rows: ParsedLeaderboardRow[] = [
  {
    exchangeTraderId: 'one',
    rank: 1,
    nickname: 'One',
    avatarUrlOrigin: null,
    walletAddress: null,
    traderKind: 'human',
    botStrategy: null,
    headlineRoi: 10,
    headlinePnl: 100,
    headlineWinRate: null,
    headlineMetricSources: {
      roi: { fieldPath: 'data.list[].roi' },
      pnl: { fieldPath: 'data.list[].pnl' },
    },
    raw: {},
  },
  {
    exchangeTraderId: 'two',
    rank: 2,
    nickname: 'Two',
    avatarUrlOrigin: null,
    walletAddress: null,
    traderKind: 'human',
    botStrategy: null,
    headlineRoi: 5,
    headlinePnl: 50,
    headlineWinRate: null,
    // Staging removed PnL lineage: keep the visible value but make its trust
    // observation unknown so the ROI/PnL pair cannot enter ranking.
    headlineMetricSources: { roi: { fieldPath: 'data.list[].roi' } },
    raw: {},
  },
]

function manifestInput(
  source: SourceRow
): Parameters<typeof buildLeaderboardAcquisitionManifest>[0] {
  return {
    source: {
      id: source.id,
      slug: source.slug,
      adapter_slug: source.adapter_slug,
      configured_page_size: source.page_size,
      configured_pagination_kind: source.pagination_kind,
    },
    surface: 'tier_a_leaderboard',
    timeframe: 30,
    started_at: '2026-07-21T10:00:00.000Z',
    completed_at: '2026-07-21T10:00:03.000Z',
    runner_git_sha: 'a'.repeat(40),
    observation_cycle_id: 'tier-a:binance_futures:job-1:1784628000000',
    capture_evidence_state: 'verified',
    termination_reason: 'reported_population_reached',
    capture_config: { caller_page_cap: null, safety_page_cap: 5_000 },
    source_pages: [
      {
        raw_page: sourcePage,
        source_row_count: 2,
        request_sha256: 'b'.repeat(64),
        http_status: 200,
        pagination_position: { kind: 'page_index', request_page_index: 1 },
        source_reports: {
          population: { state: 'reported', value: 2 },
          page_count: { state: 'not_reported' },
          current_page: { state: 'not_reported' },
          page_size: { state: 'not_reported' },
        },
      },
    ],
    parse_pages: [sourcePage],
    parser_transformation: { kind: 'identity_projection', source_page_ordinals: [1] },
    accepted_population: 2,
    rejected_row_count: 0,
  }
}

function trustBundle(
  built:
    | ReturnType<typeof buildLeaderboardAcquisitionManifest>
    | ReturnType<typeof buildLeaderboardAcquisitionManifestV3>
) {
  return {
    sourceRunId: built.sourceRunId,
    manifest: built.manifest,
    artifacts: {
      sourcePayload: {
        id: 101,
        storagePath: 'binance_futures/tier_a_trust/source.json.gz',
        contentHash: 'c'.repeat(64),
      },
      populationManifest: {
        id: 102,
        storagePath: 'binance_futures/tier_a_trust/manifest.json.gz',
        contentHash: built.sourceRunId,
      },
    },
  }
}

function trustFixture(source: SourceRow = src) {
  return trustBundle(buildLeaderboardAcquisitionManifest(manifestInput(source)))
}

function attemptBoundTrustFixture(source: SourceRow = src) {
  return trustBundle(
    buildLeaderboardAcquisitionManifestV3({
      ...manifestInput(source),
      acquisition_attempt: {
        binding_contract: LEADERBOARD_ACQUISITION_ATTEMPT_BINDING_CONTRACT,
        attempt_id: '00000000-0000-4000-8000-000000000001',
        attempt_seq: 41,
      },
    })
  )
}

const contracts = [
  {
    id: '11',
    contract_version: '1',
    metric: 'pnl',
    field_path: 'data.list[].pnl',
    provenance: 'source_reported',
    methodology_version: 'binance-board-pnl@1',
    metric_set_id: 'binance-board-roi-pnl@1',
    timeframes: [7, 30, 90],
    value_unit: 'currency',
    currencies: ['USDT'],
    required_raw_roles: ['source_payload', 'population_manifest'],
    source_payload_scope: 'population_snapshot',
    max_freshness_ms: String(6 * 60 * 60 * 1000),
    max_window_end_lag_ms: String(5 * 60 * 1000),
    allow_derived_population: false,
  },
  {
    id: '12',
    contract_version: '1',
    metric: 'roi',
    field_path: 'data.list[].roi',
    provenance: 'source_reported',
    methodology_version: 'binance-board-roi@1',
    metric_set_id: 'binance-board-roi-pnl@1',
    timeframes: [7, 30, 90],
    value_unit: 'percent',
    currencies: ['USDT'],
    required_raw_roles: ['source_payload', 'population_manifest'],
    source_payload_scope: 'population_snapshot',
    max_freshness_ms: String(6 * 60 * 60 * 1000),
    max_window_end_lag_ms: String(5 * 60 * 1000),
    allow_derived_population: false,
  },
]

describe('Tier-A metric trust transaction writer', () => {
  it('prepares an attempt-bound v3 manifest through its version-specific parser', () => {
    const fixture = attemptBoundTrustFixture()
    const prepared = prepareLeaderboardMetricTrust({
      src,
      timeframe: 30,
      rows,
      rejectedRowCount: 0,
      bundle: fixture,
    })

    expect(prepared.sourceRunId).toBe(fixture.sourceRunId)
    expect(prepared.manifest).toMatchObject({
      data_contract: LEADERBOARD_ACQUISITION_MANIFEST_V3_CONTRACT,
      acquisition_attempt: {
        binding_contract: LEADERBOARD_ACQUISITION_ATTEMPT_BINDING_CONTRACT,
        attempt_id: '00000000-0000-4000-8000-000000000001',
        attempt_seq: 41,
      },
      assessment: { acquisition_state: 'complete', population_state: 'verified' },
    })
  })

  it('keeps v2 and v3 manifest parsers isolated and rejects unknown versions', () => {
    const v3 = attemptBoundTrustFixture()
    const v2 = trustFixture()
    const prepare = (manifest: typeof v3.manifest) =>
      prepareLeaderboardMetricTrust({
        src,
        timeframe: 30,
        rows,
        rejectedRowCount: 0,
        bundle: { ...v3, manifest },
      })

    expect(() =>
      prepare({
        ...v3.manifest,
        data_contract: LEADERBOARD_ACQUISITION_MANIFEST_V2_CONTRACT,
      } as unknown as typeof v3.manifest)
    ).toThrow()
    expect(() =>
      prepare({
        ...v2.manifest,
        data_contract: LEADERBOARD_ACQUISITION_MANIFEST_V3_CONTRACT,
      } as unknown as typeof v3.manifest)
    ).toThrow()
    expect(() =>
      prepare({
        ...v3.manifest,
        data_contract: 'arena.ingest.leaderboard-acquisition-manifest@4',
      } as unknown as typeof v3.manifest)
    ).toThrow('unsupported acquisition manifest contract')
  })

  it('writes run, fail-closed window observations, and exact RAW refs on one client', async () => {
    const query = jest.fn(async (sqlInput: unknown, params: unknown[] = []) => {
      const sql = String(sqlInput)
      if (sql.includes('arena.latest_terminal_leaderboard_acquisitions AS terminal')) {
        return { rows: [{ attempt_seq: '41' }], rowCount: 1 }
      }
      if (sql.includes('INSERT INTO arena.metric_trust_runs')) return { rows: [], rowCount: 1 }
      if (sql.includes('FROM arena.metric_source_contracts')) {
        return { rows: contracts, rowCount: contracts.length }
      }
      if (sql.includes('INSERT INTO arena.metric_trust_observations')) {
        const input = JSON.parse(String(params[0])) as Array<{
          contract_id: string
          trader_id: number
        }>
        return {
          rows: input.map((observation, index) => ({
            id: String(201 + index),
            contract_id: observation.contract_id,
            trader_id: String(observation.trader_id),
          })),
          rowCount: input.length,
        }
      }
      if (sql.includes('INSERT INTO arena.metric_trust_artifacts')) {
        const input = JSON.parse(String(params[0])) as Array<Record<string, unknown>>
        return { rows: input, rowCount: input.length }
      }
      throw new Error(`unexpected SQL: ${sql}`)
    })
    const client = { query } as unknown as PoolClient
    const prepared = prepareLeaderboardMetricTrust({
      src,
      timeframe: 30,
      rows,
      rejectedRowCount: 0,
      bundle: attemptBoundTrustFixture(),
    })

    await expect(
      writeLeaderboardMetricTrust(client, prepared, {
        snapshotId: 77,
        snapshotScrapedAt: '2026-07-21T10:00:03.000Z',
        traderIds: new Map([
          ['one', 1_001],
          ['two', 1_002],
        ]),
      })
    ).resolves.toEqual({
      sourceRunId: prepared.sourceRunId,
      observationsWritten: 4,
      artifactRefsWritten: 8,
    })

    const runCall = query.mock.calls.find(([sql]) =>
      String(sql).includes('INSERT INTO arena.metric_trust_runs')
    )!
    expect(runCall[1]).toEqual([
      prepared.sourceRunId,
      1,
      30,
      77,
      '2026-07-21T10:00:03.000Z',
      101,
      102,
      '2026-07-21T10:00:00.000Z',
      '2026-07-21T10:00:03.000Z',
      2,
      2,
      false,
      'complete',
      'verified',
    ])

    const outcomeCall = query.mock.calls.find(([sql]) =>
      String(sql).includes('arena.latest_terminal_leaderboard_acquisitions AS terminal')
    )!
    expect(query.mock.calls.indexOf(outcomeCall)).toBeLessThan(query.mock.calls.indexOf(runCall))
    expect(JSON.parse(String(outcomeCall[1][0]))).toEqual({
      attempt_id: '00000000-0000-4000-8000-000000000001',
      attempt_seq: 41,
      binding_contract: LEADERBOARD_ACQUISITION_ATTEMPT_BINDING_CONTRACT,
      capture_contract: LEADERBOARD_ACQUISITION_MANIFEST_V3_CONTRACT,
      source_id: 1,
      source_slug: 'binance_futures',
      adapter_slug: 'binance',
      timeframe: 30,
      observation_cycle_id: 'tier-a:binance_futures:job-1:1784628000000',
      runner_git_sha: 'a'.repeat(40),
      started_at: '2026-07-21T10:00:00.000Z',
      completed_at: '2026-07-21T10:00:03.000Z',
      terminal_state: 'complete',
      acquisition_state: 'complete',
      population_state: 'verified',
      capture_evidence_state: 'verified',
      termination_reason: 'reported_population_reached',
      source_run_id: prepared.sourceRunId,
      source_payload_raw_object_id: 101,
      source_payload_content_hash: 'c'.repeat(64),
      source_payload_storage_path: 'binance_futures/tier_a_trust/source.json.gz',
      manifest_raw_object_id: 102,
      manifest_content_hash: prepared.sourceRunId,
      manifest_storage_path: 'binance_futures/tier_a_trust/manifest.json.gz',
      reported_population: 2,
      population_report_state: 'consistent',
      source_page_count: 1,
      reported_page_count: null,
      page_count_report_state: 'unknown',
      observed_population: 2,
      accepted_population: 2,
      rejected_row_count: 0,
      deduplicated_row_count: 0,
      caller_limited: false,
      safety_limited: false,
    })

    const observationCall = query.mock.calls.find(([sql]) =>
      String(sql).includes('INSERT INTO arena.metric_trust_observations')
    )!
    const observations = JSON.parse(String(observationCall[1][0])) as Array<{
      exchange_trader_id: string
      contract_id: string
      quality: string
      blocking_reasons: unknown[]
    }>
    expect(observationCall[1].slice(1)).toEqual([
      1,
      77,
      '2026-07-21T10:00:03.000Z',
      prepared.sourceRunId,
      30,
      'USDT',
      '2026-07-21T10:00:01.000Z',
      '2026-06-21T10:00:01.000Z',
    ])
    expect(observations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          exchange_trader_id: 'one',
          quality: 'unknown',
          blocking_reasons: [{ code: 'native_window_boundary_unverified', state: 'unknown' }],
        }),
        expect.objectContaining({
          exchange_trader_id: 'two',
          contract_id: '11',
          quality: 'unknown',
          blocking_reasons: [
            { code: 'field_lineage_unknown', state: 'unknown' },
            { code: 'native_window_boundary_unverified', state: 'unknown' },
          ],
        }),
      ])
    )
  })

  it('rejects an attempt-bound write before inserts without the exact latest outcome', async () => {
    const query = jest.fn(async (sqlInput: unknown) => {
      const sql = String(sqlInput)
      if (sql.includes('arena.latest_terminal_leaderboard_acquisitions AS terminal')) {
        return { rows: [], rowCount: 0 }
      }
      throw new Error(`unexpected SQL: ${sql}`)
    })
    const prepared = prepareLeaderboardMetricTrust({
      src,
      timeframe: 30,
      rows,
      rejectedRowCount: 0,
      bundle: attemptBoundTrustFixture(),
    })

    await expect(
      writeLeaderboardMetricTrust(queryClient(query), prepared, {
        snapshotId: 77,
        snapshotScrapedAt: '2026-07-21T10:00:03.000Z',
        traderIds: new Map([
          ['one', 1_001],
          ['two', 1_002],
        ]),
      })
    ).rejects.toThrow('requires one exact complete acquisition outcome')
    expect(
      query.mock.calls.some(([sql]) => String(sql).includes('INSERT INTO arena.metric_trust_runs'))
    ).toBe(false)
  })

  it('rejects trusted publication when no reviewed population contract exists', () => {
    const spotSrc = { ...src, slug: 'binance_spot' }
    expect(() =>
      prepareLeaderboardMetricTrust({
        src: spotSrc,
        timeframe: 30,
        rows,
        rejectedRowCount: 0,
        bundle: trustFixture(spotSrc),
      })
    ).toThrow('no registered population metric contracts')
  })

  it('fails closed when database contracts drift from the reviewed registry', async () => {
    const query = jest.fn(async (sqlInput: unknown) => {
      const sql = String(sqlInput)
      if (sql.includes('INSERT INTO arena.metric_trust_runs')) return { rows: [], rowCount: 1 }
      if (sql.includes('FROM arena.metric_source_contracts')) {
        return { rows: contracts.slice(0, 1), rowCount: 1 }
      }
      throw new Error(`unexpected SQL: ${sql}`)
    })
    const prepared = prepareLeaderboardMetricTrust({
      src,
      timeframe: 30,
      rows,
      rejectedRowCount: 0,
      bundle: trustFixture(),
    })

    await expect(
      writeLeaderboardMetricTrust(queryClient(query), prepared, {
        snapshotId: 77,
        snapshotScrapedAt: '2026-07-21T10:00:03.000Z',
        traderIds: new Map([
          ['one', 1_001],
          ['two', 1_002],
        ]),
      })
    ).rejects.toThrow('code/database contract drift')
  })

  it('fails closed when duplicate active database contracts collapse to one key', async () => {
    const query = jest.fn(async (sqlInput: unknown) => {
      const sql = String(sqlInput)
      if (sql.includes('INSERT INTO arena.metric_trust_runs')) return { rows: [], rowCount: 1 }
      if (sql.includes('FROM arena.metric_source_contracts')) {
        return { rows: [...contracts, contracts[0]], rowCount: contracts.length + 1 }
      }
      throw new Error(`unexpected SQL: ${sql}`)
    })
    const prepared = prepareLeaderboardMetricTrust({
      src,
      timeframe: 30,
      rows,
      rejectedRowCount: 0,
      bundle: trustFixture(),
    })

    await expect(
      writeLeaderboardMetricTrust(queryClient(query), prepared, {
        snapshotId: 77,
        snapshotScrapedAt: '2026-07-21T10:00:03.000Z',
        traderIds: new Map([
          ['one', 1_001],
          ['two', 1_002],
        ]),
      })
    ).rejects.toThrow('code/database contract drift')
  })

  it('accepts an idempotent retry only after every row and artifact matches', async () => {
    const prepared = prepareLeaderboardMetricTrust({
      src,
      timeframe: 30,
      rows,
      rejectedRowCount: 0,
      bundle: trustFixture(),
    })
    const query = reconciliationQuery(prepared)

    await expect(reconcileLeaderboardMetricTrust(queryClient(query), prepared)).resolves.toEqual({
      snapshotId: 77,
      scrapedAt: '2026-07-21T10:00:03.000Z',
      expectedCount: 2,
      actualCount: 2,
      baselineUsed: 2,
      traderIds: new Map([
        ['one', 1_001],
        ['two', 1_002],
      ]),
      trust: {
        sourceRunId: prepared.sourceRunId,
        observationsWritten: 4,
        artifactRefsWritten: 8,
        replayed: true,
      },
    })
  })

  it('rejects an attempt-bound replay when the latest terminal outcome no longer authorizes it', async () => {
    const prepared = prepareLeaderboardMetricTrust({
      src,
      timeframe: 30,
      rows,
      rejectedRowCount: 0,
      bundle: attemptBoundTrustFixture(),
    })
    const baseQuery = reconciliationQuery(prepared)
    const query = jest.fn(async (sqlInput: unknown, params?: unknown[]) => {
      if (String(sqlInput).includes('arena.latest_terminal_leaderboard_acquisitions')) {
        return { rows: [], rowCount: 0 }
      }
      return baseQuery(sqlInput, params)
    })

    await expect(reconcileLeaderboardMetricTrust(queryClient(query), prepared)).rejects.toThrow(
      'requires one exact complete acquisition outcome'
    )
  })

  it('rejects an idempotent retry when one persisted artifact hash differs', async () => {
    const prepared = prepareLeaderboardMetricTrust({
      src,
      timeframe: 30,
      rows,
      rejectedRowCount: 0,
      bundle: trustFixture(),
    })

    await expect(
      reconcileLeaderboardMetricTrust(queryClient(reconciliationQuery(prepared, true)), prepared)
    ).rejects.toThrow('artifact references do not match')
  })

  it('rejects an idempotent retry after bound RAW evidence is quarantined', async () => {
    const prepared = prepareLeaderboardMetricTrust({
      src,
      timeframe: 30,
      rows,
      rejectedRowCount: 0,
      bundle: trustFixture(),
    })

    await expect(
      reconcileLeaderboardMetricTrust(
        queryClient(reconciliationQuery(prepared, false, true)),
        prepared
      )
    ).rejects.toThrow('existing source run does not exactly match')
  })

  it('rejects replay when the current snapshot identity drifted from the immutable run', async () => {
    const prepared = prepareLeaderboardMetricTrust({
      src,
      timeframe: 30,
      rows,
      rejectedRowCount: 0,
      bundle: trustFixture(),
    })
    const baseQuery = reconciliationQuery(prepared)
    const query = jest.fn(async (sqlInput: unknown, params?: unknown[]) => {
      const result = await baseQuery(sqlInput, params)
      if (String(sqlInput).includes('FROM arena.metric_trust_runs AS run')) {
        return {
          ...result,
          rows: result.rows.map((run: Record<string, unknown>) => ({
            ...run,
            current_snapshot_timeframe: 90,
          })),
        }
      }
      return result
    })

    await expect(reconcileLeaderboardMetricTrust(queryClient(query), prepared)).rejects.toThrow(
      'existing source run does not exactly match'
    )
  })

  it('rejects replay when a serving trader moved to another source', async () => {
    const prepared = prepareLeaderboardMetricTrust({
      src,
      timeframe: 30,
      rows,
      rejectedRowCount: 0,
      bundle: trustFixture(),
    })
    const baseQuery = reconciliationQuery(prepared)
    const query = jest.fn(async (sqlInput: unknown, params?: unknown[]) => {
      const result = await baseQuery(sqlInput, params)
      if (String(sqlInput).includes('FROM arena.leaderboard_entries AS entry')) {
        return {
          ...result,
          rows: result.rows.map((entry: Record<string, unknown>, index: number) =>
            index === 0 ? { ...entry, trader_source_id: 999 } : entry
          ),
        }
      }
      return result
    })

    await expect(reconcileLeaderboardMetricTrust(queryClient(query), prepared)).rejects.toThrow(
      'existing entry mismatch'
    )
  })
})

function queryClient(query: jest.Mock): PoolClient {
  return { query } as unknown as PoolClient
}

function reconciliationQuery(
  prepared: ReturnType<typeof prepareLeaderboardMetricTrust>,
  corruptArtifact = false,
  quarantinePopulation = false
) {
  const observationRows = [
    {
      id: '201',
      contract_id: '11',
      trader_id: '1001',
      exchange_trader_id: 'one',
      value: '100',
      quality: 'unknown',
      blocking_reasons: [{ code: 'native_window_boundary_unverified', state: 'unknown' }],
    },
    {
      id: '202',
      contract_id: '12',
      trader_id: '1001',
      exchange_trader_id: 'one',
      value: '10',
      quality: 'unknown',
      blocking_reasons: [{ code: 'native_window_boundary_unverified', state: 'unknown' }],
    },
    {
      id: '203',
      contract_id: '11',
      trader_id: '1002',
      exchange_trader_id: 'two',
      value: '50',
      quality: 'unknown',
      blocking_reasons: [
        { code: 'field_lineage_unknown', state: 'unknown' },
        { code: 'native_window_boundary_unverified', state: 'unknown' },
      ],
    },
    {
      id: '204',
      contract_id: '12',
      trader_id: '1002',
      exchange_trader_id: 'two',
      value: '5',
      quality: 'unknown',
      blocking_reasons: [{ code: 'native_window_boundary_unverified', state: 'unknown' }],
    },
  ].map((observation) => ({
    ...observation,
    history_state: 'source_owned',
    price_state: 'source_owned',
    cost_basis_state: 'source_owned',
    population_state: 'verified',
    window_state: 'unknown',
    unit_state: 'verified',
    freshness_state: 'verified',
    source_as_of: '2026-07-21 10:00:01+00',
    valid_until: '2026-07-21 16:00:01+00',
    window_start: '2026-06-21 10:00:01+00',
    window_end: '2026-07-21 10:00:01+00',
  }))
  const artifacts = observationRows.flatMap((observation) => [
    {
      observation_id: observation.id,
      role: 'source_payload',
      raw_object_id: '101',
      content_hash:
        corruptArtifact && observation.id === '201'
          ? 'd'.repeat(64)
          : prepared.artifacts.sourcePayload.contentHash,
    },
    {
      observation_id: observation.id,
      role: 'population_manifest',
      raw_object_id: '102',
      content_hash: prepared.sourceRunId,
    },
  ])
  return jest.fn(async (sqlInput: unknown) => {
    const sql = String(sqlInput)
    if (sql.includes('FROM arena.metric_trust_runs AS run')) {
      return {
        rows: [
          {
            source_id: 1,
            timeframe: 30,
            snapshot_id: '77',
            snapshot_scraped_at: '2026-07-21 10:00:03+00',
            population_raw_object_id: '101',
            manifest_raw_object_id: '102',
            started_at: '2026-07-21 10:00:00+00',
            completed_at: '2026-07-21 10:00:03+00',
            reported_population: 2,
            fetched_population: 2,
            caller_limited: false,
            acquisition_state: 'complete',
            population_state: 'verified',
            expected_count: 2,
            actual_count: 2,
            baseline_used: 2,
            count_check_passed: true,
            is_derived: false,
            snapshot_raw_object_id: '101',
            current_snapshot_source_id: 1,
            current_snapshot_timeframe: 30,
            current_snapshot_scraped_at: '2026-07-21 10:00:03+00',
            population_content_hash: prepared.artifacts.sourcePayload.contentHash,
            population_quarantined: quarantinePopulation,
            population_source_run_id: prepared.sourceRunId,
            population_role: 'source_payload',
            population_meta: {
              raw_integrity: { hash_algorithm: 'sha256', hash_scope: 'json_utf8' },
            },
            manifest_content_hash: prepared.sourceRunId,
            manifest_quarantined: false,
            manifest_source_run_id: prepared.sourceRunId,
            manifest_role: 'population_manifest',
            manifest_meta: {
              raw_integrity: { hash_algorithm: 'sha256', hash_scope: 'json_utf8' },
            },
          },
        ],
        rowCount: 1,
      }
    }
    if (sql.includes('FROM arena.leaderboard_entries AS entry')) {
      return {
        rows: [
          {
            trader_id: '1001',
            trader_source_id: 1,
            exchange_trader_id: 'one',
            timeframe: 30,
            scraped_at: '2026-07-21 10:00:03+00',
            rank: 1,
            headline_roi: '10',
            headline_pnl: '100',
            headline_win_rate: null,
            currency: 'USDT',
          },
          {
            trader_id: '1002',
            trader_source_id: 1,
            exchange_trader_id: 'two',
            timeframe: 30,
            scraped_at: '2026-07-21 10:00:03+00',
            rank: 2,
            headline_roi: '5',
            headline_pnl: '50',
            headline_win_rate: null,
            currency: 'USDT',
          },
        ],
        rowCount: 2,
      }
    }
    if (sql.includes('FROM arena.metric_source_contracts')) {
      return { rows: contracts, rowCount: contracts.length }
    }
    if (sql.includes('FROM arena.metric_trust_observations AS observation')) {
      return { rows: observationRows, rowCount: observationRows.length }
    }
    if (sql.includes('FROM arena.metric_trust_artifacts')) {
      return { rows: artifacts, rowCount: artifacts.length }
    }
    throw new Error(`unexpected SQL: ${sql}`)
  })
}
