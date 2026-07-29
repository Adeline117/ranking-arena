import {
  buildLeaderboardAcquisitionManifestV4,
  LEADERBOARD_ACQUISITION_ATTEMPT_BINDING_CONTRACT,
  LEADERBOARD_ACQUISITION_MANIFEST_V3_CONTRACT,
  LEADERBOARD_ACQUISITION_MANIFEST_V4_CONTRACT,
  LEADERBOARD_PARTITIONED_NUMERIC_AGGREGATION_CONTRACT,
  LEADERBOARD_PARTITIONED_NUMERIC_PARSER_PAGE_CONTRACT,
  projectPartitionedNumericParserPage,
  type BuildLeaderboardAcquisitionManifestV4Input,
} from '../../acquisition-manifest'
import type { ParsedLeaderboardRow, SourceRow } from '../../core/types'
import type { IngestQueryExecutor } from '../../db'
import {
  fenceAttemptBoundLeaderboardEvidencePublicationCommit,
  prepareLeaderboardAttemptBoundV4Evidence,
  type LeaderboardAttemptBoundV4Bundle,
} from '../metric-trust-publish'

const source = {
  adapter_slug: 'bitget_bots',
  currency: 'USDT',
  id: 13,
  page_size: 20,
  pagination_kind: 'numeric',
  slug: 'bitget_bots_futures',
} as SourceRow

const rows: ParsedLeaderboardRow[] = [
  {
    avatarUrlOrigin: null,
    botStrategy: 'grid',
    exchangeTraderId: 'grid-1',
    headlinePnl: 10,
    headlineRoi: 20,
    headlineWinRate: null,
    nickname: 'Grid One',
    rank: 1,
    raw: {},
    traderKind: 'bot',
    walletAddress: null,
  },
  {
    avatarUrlOrigin: null,
    botStrategy: 'martingale',
    exchangeTraderId: 'martingale-1',
    headlinePnl: 5,
    headlineRoi: 8,
    headlineWinRate: null,
    nickname: 'Martingale One',
    rank: 2,
    raw: {},
    traderKind: 'bot',
    walletAddress: null,
  },
]

function v4Bundle(
  artifactOverrides: Partial<LeaderboardAttemptBoundV4Bundle['artifacts']['sourcePayload']> = {}
): LeaderboardAttemptBoundV4Bundle {
  const sourcePages: BuildLeaderboardAcquisitionManifestV4Input['source_pages'] = [
    {
      raw_page: {
        fetchedAt: '2026-07-28T10:00:01.000Z',
        pageIndex: 1,
        payload: { data: [{ strategyId: 'grid-1' }], totalRecord: '1' },
        url: 'https://api.bitget.test/bots',
      },
      source_row_count: 1,
      request_sha256: 'b'.repeat(64),
      http_status: 200,
      pagination_position: {
        kind: 'partitioned_page_index',
        partition_ordinal: 1,
        partition_id: 'futures_grid',
        request_page_index: 1,
      },
      source_reports: {
        population: { state: 'reported', value: 1 },
        page_count: { state: 'not_reported' },
        current_page: { state: 'reported', value: 1 },
        page_size: { state: 'reported', value: 20 },
      },
    },
    {
      raw_page: {
        fetchedAt: '2026-07-28T10:00:02.000Z',
        pageIndex: 2,
        payload: { data: [{ strategyId: 'martingale-1' }], totalRecord: '1' },
        url: 'https://api.bitget.test/bots',
      },
      source_row_count: 1,
      request_sha256: 'c'.repeat(64),
      http_status: 200,
      pagination_position: {
        kind: 'partitioned_page_index',
        partition_ordinal: 2,
        partition_id: 'futures_martingale',
        request_page_index: 1,
      },
      source_reports: {
        population: { state: 'reported', value: 1 },
        page_count: { state: 'not_reported' },
        current_page: { state: 'reported', value: 1 },
        page_size: { state: 'reported', value: 20 },
      },
    },
  ]
  const parserTransformation: BuildLeaderboardAcquisitionManifestV4Input['parser_transformation'] =
    {
      kind: 'partitioned_numeric_projection',
      source_page_ordinals: [1, 2],
      algorithm_contract: LEADERBOARD_PARTITIONED_NUMERIC_PARSER_PAGE_CONTRACT,
      page_bindings: [
        {
          source_page_ordinal: 1,
          partition_ordinal: 1,
          partition_id: 'futures_grid',
          request_page_index: 1,
          request_page_size: 20,
        },
        {
          source_page_ordinal: 2,
          partition_ordinal: 2,
          partition_id: 'futures_martingale',
          request_page_index: 1,
          request_page_size: 20,
        },
      ],
    }
  const built = buildLeaderboardAcquisitionManifestV4({
    source: {
      id: source.id,
      slug: source.slug,
      adapter_slug: source.adapter_slug,
      configured_page_size: source.page_size,
      configured_pagination_kind: source.pagination_kind,
      configured_partition_ids: ['futures_grid', 'futures_martingale'],
    },
    surface: 'tier_a_leaderboard',
    timeframe: 30,
    started_at: '2026-07-28T10:00:00.000Z',
    completed_at: '2026-07-28T10:00:03.000Z',
    runner_git_sha: 'a'.repeat(40),
    observation_cycle_id: 'tier-a:bitget_bots_futures:job-1:1785232800000',
    capture_evidence_state: 'verified',
    termination_reason: 'reported_population_reached',
    capture_config: { caller_page_cap: null, safety_page_cap: 10_000 },
    source_pages: sourcePages,
    parse_pages: sourcePages.map((page, index) =>
      projectPartitionedNumericParserPage(page.raw_page, parserTransformation.page_bindings[index]!)
    ),
    parser_transformation: parserTransformation,
    accepted_population: 2,
    rejected_row_count: 0,
    acquisition_attempt: {
      binding_contract: LEADERBOARD_ACQUISITION_ATTEMPT_BINDING_CONTRACT,
      attempt_id: '00000000-0000-4000-8000-000000000004',
      attempt_seq: 44,
    },
    pagination_topology: {
      kind: 'partitioned_numeric',
      aggregation_contract: LEADERBOARD_PARTITIONED_NUMERIC_AGGREGATION_CONTRACT,
      rank_scope: 'partition_local_concatenated_for_storage',
      partitions: [
        {
          partition_id: 'futures_grid',
          source_page_ordinals: [1],
          parser_page_ordinals: [1],
          termination_reason: 'reported_population_reached',
          capture_config: { caller_page_cap: null, safety_page_cap: 5_000 },
        },
        {
          partition_id: 'futures_martingale',
          source_page_ordinals: [2],
          parser_page_ordinals: [2],
          termination_reason: 'reported_population_reached',
          capture_config: { caller_page_cap: null, safety_page_cap: 5_000 },
        },
      ],
    },
  })
  return {
    sourceRunId: built.sourceRunId,
    manifest: built.manifest,
    artifacts: {
      sourcePayload: {
        id: 201,
        storagePath: 'bitget_bots_futures/tier_a/source.json.gz',
        contentHash: 'd'.repeat(64),
        ...artifactOverrides,
      },
      populationManifest: {
        id: 202,
        storagePath: 'bitget_bots_futures/tier_a/manifest.json.gz',
        contentHash: built.sourceRunId,
      },
    },
  }
}

function prepared(bundle = v4Bundle()) {
  return prepareLeaderboardAttemptBoundV4Evidence({
    src: source,
    timeframe: 30,
    rows,
    rejectedRowCount: 0,
    bundle,
  })
}

function fenceClient(terminalRows: Array<{ attempt_seq: string }>): {
  client: IngestQueryExecutor
  query: jest.Mock
} {
  const query = jest
    .fn()
    .mockResolvedValueOnce({ rows: [{}], rowCount: 1 })
    .mockResolvedValueOnce({ rows: terminalRows, rowCount: terminalRows.length })
  return { client: { query } as IngestQueryExecutor, query }
}

describe('attempt-bound leaderboard publication fence', () => {
  it('locks the source/window and accepts one exact V4 terminal evidence row', async () => {
    const evidence = prepared()
    const { client, query } = fenceClient([{ attempt_seq: '44' }])

    await expect(
      fenceAttemptBoundLeaderboardEvidencePublicationCommit(client, evidence)
    ).resolves.toBeUndefined()

    expect(String(query.mock.calls[0][0])).toContain('pg_catalog.pg_advisory_xact_lock')
    expect(query.mock.calls[0][1]).toEqual([`arena.leaderboard-acquisition-source:${source.id}:30`])
    expect(String(query.mock.calls[1][0])).toMatch(
      /latest_terminal_leaderboard_acquisitions[\s\S]+terminal\.capture_contract = expected\.capture_contract[\s\S]+terminal\.source_payload_content_hash = expected\.source_payload_content_hash[\s\S]+terminal\.manifest_storage_path = expected\.manifest_storage_path/
    )
    expect(JSON.parse(query.mock.calls[1][1][0])).toEqual(
      expect.objectContaining({
        capture_contract: LEADERBOARD_ACQUISITION_MANIFEST_V4_CONTRACT,
        source_run_id: evidence.sourceRunId,
        source_payload_raw_object_id: 201,
        source_payload_content_hash: 'd'.repeat(64),
        source_payload_storage_path: 'bitget_bots_futures/tier_a/source.json.gz',
        manifest_raw_object_id: 202,
        manifest_content_hash: evidence.sourceRunId,
        manifest_storage_path: 'bitget_bots_futures/tier_a/manifest.json.gz',
        reported_population: 2,
        observed_population: 2,
        accepted_population: 2,
      })
    )
  })

  it('fails the commit fence when a newer latest terminal replaced the attempt', async () => {
    const { client } = fenceClient([])

    await expect(
      fenceAttemptBoundLeaderboardEvidencePublicationCommit(client, prepared())
    ).rejects.toThrow('requires one exact complete acquisition outcome')
  })

  it.each([
    ['RAW pointer', { id: 999 }],
    ['RAW hash', { contentHash: 'e'.repeat(64) }],
    ['RAW path', { storagePath: 'bitget_bots_futures/tier_a/replaced.json.gz' }],
  ])('fails the commit fence when the terminal %s differs', async (_label, override) => {
    const evidence = prepared(v4Bundle(override))
    const { client, query } = fenceClient([])

    await expect(
      fenceAttemptBoundLeaderboardEvidencePublicationCommit(client, evidence)
    ).rejects.toThrow('requires one exact complete acquisition outcome')

    expect(JSON.parse(query.mock.calls[1][1][0])).toEqual(
      expect.objectContaining({
        source_payload_raw_object_id: evidence.artifacts.sourcePayload.id,
        source_payload_content_hash: evidence.artifacts.sourcePayload.contentHash,
        source_payload_storage_path: evidence.artifacts.sourcePayload.storagePath,
      })
    )
  })

  it('rejects a non-V4 contract before opening a publication transaction', () => {
    const bundle = v4Bundle()
    const wrongContract = {
      ...bundle,
      manifest: {
        ...bundle.manifest,
        data_contract: LEADERBOARD_ACQUISITION_MANIFEST_V3_CONTRACT,
      },
    } as unknown as LeaderboardAttemptBoundV4Bundle

    expect(() => prepared(wrongContract)).toThrow('requires a v4 manifest')
  })
})
