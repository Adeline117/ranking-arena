import {
  ARENA_CORE_30D_USDT_METHOD_ID,
  METRIC_TRUST_SCHEMA_VERSION,
  evaluateMetricRankEligibility,
  evaluateRankingEligibility,
  type MetricTrustEvidence,
  type RankingMetric,
  type RankingMetricInput,
} from '@/lib/metric-trust'

const NOW = new Date('2026-07-21T12:00:00.000Z')
const RUN_ID = 'run-2026-07-21-01'

function directRawRefs(sourceId = 'binance_futures', runId = RUN_ID) {
  return [
    {
      role: 'source_payload' as const,
      ref: `raw://${sourceId}/${runId}/profile-1`,
      sha256: 'a'.repeat(64),
      sourceRunId: runId,
    },
    {
      role: 'population_manifest' as const,
      ref: `manifest://${sourceId}/${runId}/30D`,
      sha256: 'b'.repeat(64),
      sourceRunId: runId,
    },
  ]
}

function rebuildRawRefs(runId = RUN_ID) {
  return [
    {
      role: 'event_history' as const,
      ref: 'raw://binance-web3/tx-history-1',
      sha256: 'c'.repeat(64),
      sourceRunId: runId,
    },
    {
      role: 'price_history' as const,
      ref: 'raw://binance-web3/price-history-1',
      sha256: 'd'.repeat(64),
      sourceRunId: runId,
    },
    {
      role: 'opening_inventory' as const,
      ref: 'raw://binance-web3/opening-inventory-1',
      sha256: 'e'.repeat(64),
      sourceRunId: runId,
    },
    {
      role: 'population_manifest' as const,
      ref: 'manifest://binance-web3/30D',
      sha256: 'f'.repeat(64),
      sourceRunId: runId,
    },
  ]
}

function input(
  metric: RankingMetric = 'roi',
  overrides: {
    value?: number | null
    evidence?: Partial<MetricTrustEvidence>
    binding?: Partial<RankingMetricInput['binding']>
  } = {}
): RankingMetricInput {
  const isPnl = metric === 'pnl'
  const isMdd = metric === 'mdd'
  return {
    value: overrides.value === undefined ? (isPnl ? 1234 : 12.5) : overrides.value,
    evidence: {
      schemaVersion: METRIC_TRUST_SCHEMA_VERSION,
      metric,
      provenance: 'source_reported',
      methodologyVersion: isPnl
        ? 'binance-performance-pnl@1'
        : isMdd
          ? 'binance-performance-mdd@1'
          : 'binance-performance-roi@1',
      quality: 'complete',
      history: 'source_owned',
      price: 'source_owned',
      costBasis: 'source_owned',
      population: 'verified',
      window: 'verified',
      unit: 'verified',
      freshness: 'verified',
      blockingReasons: [],
      ...overrides.evidence,
    },
    binding: {
      subjectKey: 'binance_futures:trader-1',
      sourceId: 'binance_futures',
      sourceContractVersion: '1',
      sourceRunId: RUN_ID,
      fieldPath: isPnl ? 'performance.pnl' : isMdd ? 'performance.mdd' : 'performance.roi',
      rawRefs: directRawRefs(),
      window: {
        key: '30D',
        startAt: '2026-06-21T11:00:00.000Z',
        endAt: '2026-07-21T11:00:00.000Z',
      },
      valueUnit: isPnl ? 'currency' : 'percent',
      currency: 'USDT',
      asOf: '2026-07-21T11:00:00.000Z',
      validUntil: '2026-07-21T13:00:00.000Z',
      ...overrides.binding,
    },
  }
}

function rebuiltRoi(evidence: Partial<MetricTrustEvidence> = {}): RankingMetricInput {
  return input('roi', {
    evidence: {
      provenance: 'arena_rebuilt',
      methodologyVersion: 'wallet-event-ledger-average-cost@1',
      ...evidence,
    },
    binding: {
      subjectKey: 'binance_web3_bsc:0xabc',
      sourceId: 'binance_web3_bsc',
      sourceContractVersion: '1',
      fieldPath: 'rebuild.roi',
      rawRefs: rebuildRawRefs(),
      currency: 'USD',
    },
  })
}

function binanceBoardMetric(metric: 'roi' | 'pnl'): RankingMetricInput {
  return input(metric, {
    evidence: {
      methodologyVersion: metric === 'roi' ? 'binance-board-roi@1' : 'binance-board-pnl@1',
    },
    binding: {
      fieldPath: metric === 'roi' ? 'data.list[].roi' : 'data.list[].pnl',
    },
  })
}

function binanceWalletMetric(metric: 'roi' | 'pnl'): RankingMetricInput {
  return input(metric, {
    evidence: {
      methodologyVersion:
        metric === 'roi'
          ? 'binance-web3-board-realized-pnl-percent@1'
          : 'binance-web3-board-realized-pnl@1',
    },
    binding: {
      subjectKey: 'binance_web3_bsc:0xabc',
      sourceId: 'binance_web3_bsc',
      sourceContractVersion: '1',
      fieldPath:
        metric === 'roi' ? 'board.data.data[].realizedPnlPercent' : 'board.data.data[].realizedPnl',
      rawRefs: directRawRefs('binance_web3_bsc'),
      currency: 'USD',
    },
  })
}

describe('metric trust ranking gate', () => {
  it('admits a registered and verified provider-reported metric', () => {
    expect(evaluateMetricRankEligibility(input(), NOW)).toEqual({
      eligible: true,
      state: 'eligible',
      reasons: [],
    })
  })

  it('registers the real Binance Tier-A board paths separately from profile paths', () => {
    expect(evaluateMetricRankEligibility(binanceBoardMetric('roi'), NOW).eligible).toBe(true)
    expect(evaluateMetricRankEligibility(binanceBoardMetric('pnl'), NOW).eligible).toBe(true)
  })

  it('keeps Binance Wallet board metrics source-reported and USD-bound', () => {
    expect(binanceWalletMetric('roi').evidence.provenance).toBe('source_reported')
    expect(evaluateMetricRankEligibility(binanceWalletMetric('roi'), NOW).eligible).toBe(true)
    expect(evaluateMetricRankEligibility(binanceWalletMetric('pnl'), NOW).eligible).toBe(true)
  })

  it.each([
    ['history', { history: 'partial' as const }, 'history_partial'],
    ['price', { price: 'unknown' as const }, 'price_unknown'],
    ['cost basis', { costBasis: 'unknown' as const }, 'cost_basis_unknown'],
    ['population', { population: 'partial' as const }, 'population_partial'],
  ])('rejects a %s gap instead of applying a score penalty', (_label, evidence, reason) => {
    const verdict = evaluateMetricRankEligibility(input('roi', { evidence }), NOW)
    expect(verdict.eligible).toBe(false)
    expect(verdict.reasons).toContain(reason)
  })

  it('gives unknown precedence when unknown and partial coexist', () => {
    expect(
      evaluateMetricRankEligibility(
        input('roi', { evidence: { history: 'partial', price: 'unknown' } }),
        NOW
      )
    ).toMatchObject({ eligible: false, state: 'unknown' })
  })

  it('fails closed on malformed runtime evidence', () => {
    const valid = input()
    const malformed = { ...valid, evidence: { ...valid.evidence, history: 'typo' } }
    expect(evaluateMetricRankEligibility(malformed, NOW)).toEqual({
      eligible: false,
      state: 'unknown',
      reasons: ['trust_input_invalid'],
    })
  })

  it('does not trust an unregistered source or methodology', () => {
    expect(
      evaluateMetricRankEligibility(input('roi', { binding: { sourceId: 'made_up' } }), NOW)
    ).toEqual({ eligible: false, state: 'unknown', reasons: ['source_contract_unknown'] })

    const verdict = evaluateMetricRankEligibility(
      input('roi', { evidence: { methodologyVersion: 'arena-made-up@1' } }),
      NOW
    )
    expect(verdict.reasons).toContain('source_methodology_mismatch')
  })

  it('rejects evidence bound to an obsolete source contract version', () => {
    const verdict = evaluateMetricRankEligibility(
      input('roi', { binding: { sourceContractVersion: '0' } }),
      NOW
    )
    expect(verdict.reasons).toContain('source_contract_version_mismatch')
  })

  it('does not let an Arena reconstruction claim provider-owned evidence', () => {
    const verdict = evaluateMetricRankEligibility(rebuiltRoi(), NOW)
    expect(verdict.reasons).toEqual(
      expect.arrayContaining([
        'history_cannot_be_source_owned_for_arena_rebuilt',
        'price_cannot_be_source_owned_for_arena_rebuilt',
        'cost_basis_cannot_be_source_owned_for_arena_rebuilt',
      ])
    )
  })

  it('admits a reconstruction only after every ranking dimension is verified', () => {
    expect(
      evaluateMetricRankEligibility(
        rebuiltRoi({ history: 'verified', price: 'verified', costBasis: 'verified' }),
        NOW
      )
    ).toEqual({ eligible: true, state: 'eligible', reasons: [] })
  })

  it('requires distinct, role-complete RAW evidence from the bound run', () => {
    const refs = rebuildRawRefs()
    const verdict = evaluateMetricRankEligibility(
      rebuiltRoi({ history: 'verified', price: 'verified', costBasis: 'verified' }),
      NOW
    )
    expect(verdict.eligible).toBe(true)

    const incomplete = rebuiltRoi({
      history: 'verified',
      price: 'verified',
      costBasis: 'verified',
    })
    incomplete.binding.rawRefs = [refs[0], { ...refs[0] }]
    const blocked = evaluateMetricRankEligibility(incomplete, NOW)
    expect(blocked).toMatchObject({ eligible: false, state: 'unknown' })
    expect(blocked.reasons).toEqual(
      expect.arrayContaining([
        'source_lineage_price_history_missing',
        'source_lineage_opening_inventory_missing',
        'source_lineage_population_manifest_missing',
        'source_lineage_duplicate',
      ])
    )
  })

  it('preserves an explicit unknown blocking reason', () => {
    const verdict = evaluateMetricRankEligibility(
      input('roi', {
        evidence: {
          blockingReasons: [{ code: 'opening_inventory_unknown', state: 'unknown' }],
        },
      }),
      NOW
    )
    expect(verdict).toMatchObject({ eligible: false, state: 'unknown' })
    expect(verdict.reasons).toContain('opening_inventory_unknown')
  })

  it('rejects a null value and an expired freshness binding', () => {
    const verdict = evaluateMetricRankEligibility(
      input('roi', {
        value: null,
        binding: { validUntil: '2026-07-21T11:30:00.000Z' },
      }),
      NOW
    )
    expect(verdict).toMatchObject({ eligible: false, state: 'unknown' })
    expect(verdict.reasons).toEqual(expect.arrayContaining(['value_unknown', 'freshness_expired']))
  })

  it('rejects a false window label and freshness beyond the registered SLA', () => {
    const verdict = evaluateMetricRankEligibility(
      input('roi', {
        binding: {
          window: {
            key: '30D',
            startAt: '2026-07-20T11:00:00.000Z',
            endAt: '2026-07-21T11:00:00.000Z',
          },
          validUntil: '2026-07-22T11:00:00.000Z',
        },
      }),
      NOW
    )
    expect(verdict).toMatchObject({ eligible: false, state: 'unknown' })
    expect(verdict.reasons).toEqual(
      expect.arrayContaining(['window_duration_mismatch', 'source_freshness_ttl_exceeded'])
    )
  })

  it('admits the exact required set without being blocked by optional MDD', () => {
    const verdict = evaluateRankingEligibility(
      {
        roi: input('roi'),
        pnl: input('pnl'),
        mdd: input('mdd', { evidence: { quality: 'partial', history: 'partial' } }),
      },
      ARENA_CORE_30D_USDT_METHOD_ID,
      NOW
    )
    expect(verdict).toEqual({ eligible: true, state: 'eligible', reasons: [] })
  })

  it('fails closed when a required field has no evidence', () => {
    expect(
      evaluateRankingEligibility({ roi: input('roi') }, ARENA_CORE_30D_USDT_METHOD_ID, NOW)
    ).toEqual({
      eligible: false,
      state: 'unknown',
      reasons: ['pnl:evidence_unknown'],
    })
  })

  it('rejects an unregistered or caller-signed ranking methodology', () => {
    expect(evaluateRankingEligibility({}, 'made-up@1', NOW)).toEqual({
      eligible: false,
      state: 'unknown',
      reasons: ['ranking_methodology_unknown'],
    })
    expect(
      evaluateRankingEligibility(
        { roi: input('roi'), pnl: input('pnl') },
        {
          id: 'caller-signed',
          version: '1',
          requiredMetrics: ['roi'],
          windowKey: '30D',
          comparisonCurrency: 'USDT',
          maxAsOfSkewMs: 0,
        },
        NOW
      )
    ).toEqual({
      eligible: false,
      state: 'unknown',
      reasons: ['ranking_methodology_unknown'],
    })
  })

  it('rejects mixed-window inputs even when each field claims verified', () => {
    const verdict = evaluateRankingEligibility(
      {
        roi: input('roi'),
        pnl: input('pnl', {
          binding: {
            window: {
              key: '90D',
              startAt: '2026-04-22T11:00:00.000Z',
              endAt: '2026-07-21T11:00:00.000Z',
            },
          },
        }),
      },
      ARENA_CORE_30D_USDT_METHOD_ID,
      NOW
    )
    expect(verdict).toMatchObject({ eligible: false, state: 'unknown' })
    expect(verdict.reasons).toEqual(
      expect.arrayContaining(['pnl:window_mismatch', 'pnl:method_window_mismatch'])
    )
  })

  it('rejects fields from different acquisition runs', () => {
    const otherRun = 'run-2026-07-21-02'
    const verdict = evaluateRankingEligibility(
      {
        roi: input('roi'),
        pnl: input('pnl', {
          binding: { sourceRunId: otherRun, rawRefs: directRawRefs('binance_futures', otherRun) },
        }),
      },
      ARENA_CORE_30D_USDT_METHOD_ID,
      NOW
    )
    expect(verdict.reasons).toContain('pnl:source_run_mismatch')
    expect(verdict.state).toBe('unknown')
  })
})
