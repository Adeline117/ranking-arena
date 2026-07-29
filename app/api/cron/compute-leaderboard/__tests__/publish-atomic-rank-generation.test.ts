/**
 * @jest-environment node
 */

import { parseSourcePublicationEvidence } from '../source-publication-evidence'
import {
  publishAtomicRankGeneration,
  type AtomicRankPublicationClient,
} from '../publish-atomic-rank-generation'
import type { ScoredTrader } from '../score-traders'

const COHORT = '123e4567-e89b-42d3-a456-426614174000'
const MANIFEST = '223e4567-e89b-42d3-a456-426614174000'
const MANIFEST_DIGEST = 'c'.repeat(64)
const BATCH_DIGEST = 'a'.repeat(64)
const WRITE_SET_DIGEST = 'b'.repeat(64)

function canonical(date: Date): string {
  return `${date.toISOString().slice(0, 23)}000Z`
}

function evidence(now: Date, retained = false) {
  const boardAt = new Date(now.getTime() - 60_000).toISOString()
  return parseSourcePublicationEvidence(
    {
      scoreRows: [
        {
          platform: 'binance_futures',
          market_type: 'futures',
          trader_key: 'trader-1',
          board_rank: 1,
          roi_pct: 12.3456,
          pnl_usd: 250.12,
          win_rate: 60,
          max_drawdown: 8,
          copiers: 4,
          trades_count: 20,
          sharpe_ratio: 1.2,
          sortino_ratio: 1.4,
          calmar_ratio: 1.1,
          volatility_pct: 15,
          trader_kind: null,
          handle: 'Trader',
          avatar_url: null,
          currency: 'USDT',
          as_of: boardAt,
          board_as_of: boardAt,
        },
      ],
      physicalBoards: [
        {
          registry_slug: 'binance-futures',
          filter_source: 'binance_futures',
          window: '30D',
          snapshot_id: 101,
          scraped_at: boardAt,
          actual_count: 1,
          entry_count: 1,
          rank_limit: 1000,
          rank_limited_entry_count: 1,
          evidence_status: retained ? 'latest_attempt_failed' : 'passed',
          latest_passed_tie_count: 1,
          latest_attempt_id: retained ? 102 : 101,
          latest_attempt_scraped_at: boardAt,
          latest_attempt_passed: retained ? false : true,
        },
      ],
    },
    { window: '30D', rankLimit: 1000, maxAgeHours: 48, now }
  )
}

function scoredTrader(): ScoredTrader {
  return {
    source: 'binance_futures',
    source_trader_id: 'trader-1',
    source_as_of: new Date().toISOString(),
    arena_score: 80,
    arena_score_v3: 72.34,
    arena_score_v4: 80,
    score_factors: {
      roi: 0.6,
      pnl: 0.7,
      drawdown: 0.8,
      sharpe: 0.7,
      consistency: 0.6,
    },
    roi: 12.3456,
    pnl: 250.12,
    win_rate: 60,
    max_drawdown: 8,
    followers: 7,
    copiers: 4,
    trades_count: 20,
    handle: 'Trader',
    avatar_url: '/logo.svg',
    profitability_score: 64,
    risk_control_score: 75,
    execution_score: 60,
    score_completeness: 'full',
    trading_style: 'swing',
    avg_holding_hours: 12.5,
    style_confidence: 0.8,
    sharpe_ratio: 1.2,
    sortino_ratio: 1.4,
    profit_factor: 2.1,
    calmar_ratio: 1.1,
    trader_type: 'human',
    metrics_estimated: false,
    is_outlier: false,
  }
}

function client(now: Date) {
  const computedAt = canonical(now)
  const claimedAt = canonical(new Date(now.getTime() + 1_000))
  const leaseExpiresAt = canonical(new Date(now.getTime() + 301_000))
  const calls: Array<[string, Record<string, unknown>]> = []
  const rpc = jest.fn((name: string, args: Record<string, unknown>) => {
    calls.push([name, args])
    let data: unknown
    switch (name) {
      case 'prepare_leaderboard_score_input_manifest_v1':
        data = {
          contract: 'leaderboard-score-input-manifest-seal@1',
          manifestId: MANIFEST,
          manifestDigest: MANIFEST_DIGEST,
          inputCount: 1,
          inputDigest: 'd'.repeat(64),
          outputDigest: 'e'.repeat(64),
          outputs: [
            {
              source: 'binance_futures',
              sourceTraderId: 'trader-1',
              totalScore: 88.25,
              quality: 0.8,
              confidence: 0.9,
              factors: {
                roi: 0.6,
                pnl: 0.7,
                drawdown: 0.8,
                sharpe: 0.7,
                consistency: 0.6,
              },
            },
          ],
          validUntil: args.p_valid_until,
        }
        break
      case 'plan_leaderboard_rank_generation_batch_v1':
        data = {
          contract: 'leaderboard-rank-persisted-batch-evidence@1',
          season_id: '30D',
          score_cohort_id: COHORT,
          row_count: 1,
          source_count: 1,
          first_source: 'binance_futures',
          first_source_trader_id: 'trader-1',
          last_source: 'binance_futures',
          last_source_trader_id: 'trader-1',
          batch_sha256: BATCH_DIGEST,
          canonical_octet_length: 500,
          source_proofs: [],
        }
        break
      case 'plan_leaderboard_rank_generation_write_set_v1':
        data = {
          contract: 'leaderboard-rank-generation-write-set-plan@1',
          season_id: '30D',
          score_cohort_id: COHORT,
          expected_rank_count: 1,
          expected_batch_count: 1,
          write_set_sha256: WRITE_SET_DIGEST,
        }
        break
      case 'claim_leaderboard_rank_generation':
        data = {
          contract: 'leaderboard-rank-generation-claim@1',
          season_id: '30D',
          score_cohort_id: COHORT,
          generation_seq: 7,
          phase: 'claimed',
          write_set_sha256: WRITE_SET_DIGEST,
          expected_rank_count: 1,
          expected_batch_count: 1,
          computed_at: computedAt,
          claimed_at: claimedAt,
          lease_expires_at: leaseExpiresAt,
        }
        break
      case 'stage_leaderboard_rank_generation_batch_v1':
        data = {
          contract: 'leaderboard-rank-generation-batch-stage@1',
          season_id: '30D',
          generation_seq: 7,
          score_cohort_id: COHORT,
          phase: 'writing',
          batch_index: 0,
          batch_sha256: BATCH_DIGEST,
          row_count: 1,
          source_count: 1,
          staged_at: claimedAt,
        }
        break
      case 'finalize_leaderboard_rank_generation_v1':
        data = {
          contract: 'leaderboard-rank-generation-finalization@1',
          season_id: '30D',
          generation_seq: 7,
          score_cohort_id: COHORT,
          phase: 'sealed',
          is_sealed: true,
          replayed: false,
          cleanup: {},
          rerank: {},
          publication: {
            contract: 'leaderboard-rank-publication@1',
            season_id: '30D',
            score_cohort_id: COHORT,
            source_count: 1,
            trader_count: 1,
            published_at: claimedAt,
            is_sealed: true,
            proofs: [
              {
                source: 'binance_futures',
                source_as_of: (args.p_source_publications as Array<{ source_as_of: string }>)[0]
                  .source_as_of,
                recorded_at: claimedAt,
                score_cohort_id: COHORT,
                rank_mutation_seq: 1,
                published_rank_count: 1,
                published_identity_sha256: 'f'.repeat(64),
              },
            ],
          },
        }
        break
      default:
        throw new Error(`unexpected RPC ${name}`)
    }
    return Promise.resolve({ data, error: null, status: 200 })
  })
  const upsert = jest.fn().mockResolvedValue({ error: null })
  const publicationClient: AtomicRankPublicationClient = {
    rpc,
    from: jest.fn(() => ({ upsert })),
  }
  return { publicationClient, calls, rpc, upsert }
}

describe('publishAtomicRankGeneration', () => {
  it('uses PG17 outputs and activates only claim -> stage -> atomic finalizer', async () => {
    const now = new Date()
    const { publicationClient, calls, upsert } = client(now)
    const result = await publishAtomicRankGeneration(
      {
        supabase: publicationClient,
        season: '30D',
        sourceEvidence: evidence(now),
        scoredTraders: [scoredTrader()],
      },
      {
        scoreCohortId: COHORT,
        computedAt: canonical(now),
        validUntil: canonical(new Date(now.getTime() + 20 * 60_000)),
      }
    )

    expect(result).toEqual({
      season: '30D',
      scoreCohortId: COHORT,
      generationSeq: 7,
      publishedCount: 1,
      sourceCount: 1,
      manifestId: MANIFEST,
      manifestDigest: MANIFEST_DIGEST,
      writeSetSha256: WRITE_SET_DIGEST,
    })
    expect(calls.map(([name]) => name)).toEqual([
      'prepare_leaderboard_score_input_manifest_v1',
      'plan_leaderboard_rank_generation_batch_v1',
      'plan_leaderboard_rank_generation_write_set_v1',
      'claim_leaderboard_rank_generation',
      'stage_leaderboard_rank_generation_batch_v1',
      'finalize_leaderboard_rank_generation_v1',
    ])
    const stageRows = calls.find(([name]) => name.startsWith('stage_'))?.[1].p_rows
    expect(stageRows).toEqual([
      expect.objectContaining({
        arena_score: 88.25,
        arena_score_v4: 88.25,
        rank: null,
        rank_change: null,
        is_new: null,
        profitability_score: 66,
        risk_control_score: 75,
        execution_score: 60,
      }),
    ])
    expect(upsert).toHaveBeenCalledTimes(1)
  })

  it('rejects retained source authority before creating a manifest', async () => {
    const now = new Date()
    const { publicationClient, rpc, upsert } = client(now)

    await expect(
      publishAtomicRankGeneration({
        supabase: publicationClient,
        season: '30D',
        sourceEvidence: evidence(now, true),
        scoredTraders: [scoredTrader()],
      })
    ).rejects.toThrow('exact source authority is not fully publishable')
    expect(rpc).not.toHaveBeenCalled()
    expect(upsert).not.toHaveBeenCalled()
  })
})
