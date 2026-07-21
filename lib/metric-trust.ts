import { z } from 'zod'

/**
 * Runtime-enforced field trust contract shared by ingestion, ranking, and UI.
 *
 * A provider-reported metric may delegate history/price/cost methodology to
 * that provider. Arena still has to prove population, window, unit, and
 * freshness. A reconstructed metric has to prove every dimension itself.
 */

export const METRIC_TRUST_SCHEMA_VERSION = 1 as const

export const RANKING_METRICS = ['roi', 'pnl', 'win_rate', 'mdd', 'sharpe'] as const
export const METRIC_PROVENANCE = [
  'source_reported',
  'source_normalized',
  'arena_rebuilt',
  'derived',
] as const
export const METRIC_QUALITY = ['complete', 'partial', 'unknown', 'unsupported'] as const
export const METRIC_EVIDENCE_STATES = [
  'verified',
  'source_owned',
  'not_required',
  'partial',
  'unknown',
] as const
export const RANKING_WINDOW_KEYS = ['7D', '30D', '90D'] as const
export const METRIC_VALUE_UNITS = ['percent', 'currency', 'ratio'] as const
export const RANKING_CURRENCIES = ['USDT', 'USDx', 'USDC', 'USD'] as const
export const RAW_EVIDENCE_ROLES = [
  'source_payload',
  'population_manifest',
  'normalization_components',
  'event_history',
  'price_history',
  'opening_inventory',
] as const

export type RankingMetric = (typeof RANKING_METRICS)[number]
export type MetricProvenance = (typeof METRIC_PROVENANCE)[number]
export type MetricQuality = (typeof METRIC_QUALITY)[number]
export type MetricEvidenceState = (typeof METRIC_EVIDENCE_STATES)[number]
export type RankingWindowKey = (typeof RANKING_WINDOW_KEYS)[number]
export type MetricValueUnit = (typeof METRIC_VALUE_UNITS)[number]
export type RankingCurrency = (typeof RANKING_CURRENCIES)[number]
export type RawEvidenceRole = (typeof RAW_EVIDENCE_ROLES)[number]

const nonEmptyString = z.string().trim().min(1)
const isoTimestamp = z.string().datetime()

export const metricTrustEvidenceSchema = z
  .object({
    schemaVersion: z.literal(METRIC_TRUST_SCHEMA_VERSION),
    metric: z.enum(RANKING_METRICS),
    provenance: z.enum(METRIC_PROVENANCE),
    methodologyVersion: nonEmptyString,
    quality: z.enum(METRIC_QUALITY),
    history: z.enum(METRIC_EVIDENCE_STATES),
    price: z.enum(METRIC_EVIDENCE_STATES),
    costBasis: z.enum(METRIC_EVIDENCE_STATES),
    population: z.enum(METRIC_EVIDENCE_STATES),
    window: z.enum(METRIC_EVIDENCE_STATES),
    unit: z.enum(METRIC_EVIDENCE_STATES),
    freshness: z.enum(METRIC_EVIDENCE_STATES),
    blockingReasons: z.array(
      z
        .object({
          code: nonEmptyString,
          state: z.enum(['partial', 'unknown']),
        })
        .strict()
    ),
  })
  .strict()

export const metricTrustBindingSchema = z
  .object({
    subjectKey: nonEmptyString,
    sourceId: nonEmptyString,
    sourceContractVersion: nonEmptyString,
    sourceRunId: nonEmptyString,
    fieldPath: nonEmptyString,
    rawRefs: z
      .array(
        z
          .object({
            role: z.enum(RAW_EVIDENCE_ROLES),
            ref: nonEmptyString,
            sha256: z.string().regex(/^[a-f0-9]{64}$/i),
            sourceRunId: nonEmptyString,
          })
          .strict()
      )
      .min(1),
    window: z
      .object({
        key: z.enum(RANKING_WINDOW_KEYS),
        startAt: isoTimestamp,
        endAt: isoTimestamp,
      })
      .strict(),
    valueUnit: z.enum(METRIC_VALUE_UNITS),
    currency: z.enum(RANKING_CURRENCIES),
    asOf: isoTimestamp,
    validUntil: isoTimestamp,
  })
  .strict()

export const rankingMetricInputSchema = z
  .object({
    value: z.number().finite().nullable(),
    evidence: metricTrustEvidenceSchema,
    binding: metricTrustBindingSchema,
  })
  .strict()

export type MetricTrustEvidence = z.infer<typeof metricTrustEvidenceSchema>
export type MetricTrustBinding = z.infer<typeof metricTrustBindingSchema>
export type RankingMetricInput = z.infer<typeof rankingMetricInputSchema>
export type MetricTrustMap = Partial<Record<RankingMetric, RankingMetricInput>>

export const sourceMetricFieldContractSchema = z
  .object({
    metric: z.enum(RANKING_METRICS),
    fieldPath: nonEmptyString,
    provenance: z.enum(METRIC_PROVENANCE),
    methodologyVersion: nonEmptyString,
    windowKeys: z.array(z.enum(RANKING_WINDOW_KEYS)).min(1),
    valueUnit: z.enum(METRIC_VALUE_UNITS),
    currencies: z.array(z.enum(RANKING_CURRENCIES)).min(1),
    requiredRawRoles: z.array(z.enum(RAW_EVIDENCE_ROLES)).min(1),
    maxFreshnessMs: z.number().int().positive(),
    maxWindowEndLagMs: z.number().int().min(0),
  })
  .strict()
  .superRefine((field, ctx) => {
    if (new Set(field.requiredRawRoles).size !== field.requiredRawRoles.length) {
      ctx.addIssue({ code: 'custom', message: 'duplicate required raw evidence role' })
    }
  })

export const metricSourceContractSchema = z
  .object({
    sourceId: nonEmptyString,
    version: nonEmptyString,
    fields: z.array(sourceMetricFieldContractSchema).min(1),
  })
  .strict()
  .superRefine((contract, ctx) => {
    const keys = contract.fields.map((field) => `${field.metric}:${field.fieldPath}`)
    if (new Set(keys).size !== keys.length) {
      ctx.addIssue({ code: 'custom', message: 'duplicate source metric field contract' })
    }
  })

export const rankingMethodContractSchema = z
  .object({
    id: nonEmptyString,
    version: nonEmptyString,
    requiredMetrics: z.array(z.enum(RANKING_METRICS)).min(1),
    windowKey: z.enum(RANKING_WINDOW_KEYS),
    comparisonCurrency: z.enum(RANKING_CURRENCIES),
    maxAsOfSkewMs: z.number().finite().min(0),
  })
  .strict()
  .superRefine((contract, ctx) => {
    if (new Set(contract.requiredMetrics).size !== contract.requiredMetrics.length) {
      ctx.addIssue({ code: 'custom', message: 'duplicate required ranking metric' })
    }
  })

export type SourceMetricFieldContract = z.infer<typeof sourceMetricFieldContractSchema>
export type MetricSourceContract = z.infer<typeof metricSourceContractSchema>
export type RankingMethodContract = z.infer<typeof rankingMethodContractSchema>

export const ARENA_CORE_7D_USDT_METHOD_ID = 'arena-core-roi-pnl-7d-usdt@1' as const
export const ARENA_CORE_30D_USDT_METHOD_ID = 'arena-core-roi-pnl-30d-usdt@1' as const
export const ARENA_CORE_90D_USDT_METHOD_ID = 'arena-core-roi-pnl-90d-usdt@1' as const

export const REGISTERED_RANKING_METHOD_IDS = [
  ARENA_CORE_7D_USDT_METHOD_ID,
  ARENA_CORE_30D_USDT_METHOD_ID,
  ARENA_CORE_90D_USDT_METHOD_ID,
] as const

const DIRECT_RAW_ROLES: RawEvidenceRole[] = ['source_payload', 'population_manifest']
const REBUILD_RAW_ROLES: RawEvidenceRole[] = [
  'event_history',
  'price_history',
  'opening_inventory',
  'population_manifest',
]

function registeredSourceContract(raw: unknown): MetricSourceContract {
  return metricSourceContractSchema.parse(raw)
}

function registeredMethodContract(raw: unknown): RankingMethodContract {
  return rankingMethodContractSchema.parse(raw)
}

/**
 * Trusted, code-reviewed source registry. Unknown sources fail closed. Adding
 * an adapter field requires a reviewed registry change; callers cannot submit
 * an ad-hoc contract alongside the value they want ranked.
 */
const SOURCE_CONTRACT_REGISTRY: Readonly<Record<string, MetricSourceContract>> = Object.freeze({
  binance_futures: registeredSourceContract({
    sourceId: 'binance_futures',
    version: '1',
    fields: [
      {
        metric: 'roi',
        fieldPath: 'data.list[].roi',
        provenance: 'source_reported',
        methodologyVersion: 'binance-board-roi@1',
        windowKeys: ['7D', '30D', '90D'],
        valueUnit: 'percent',
        currencies: ['USDT'],
        requiredRawRoles: DIRECT_RAW_ROLES,
        maxFreshnessMs: 6 * 60 * 60 * 1000,
        maxWindowEndLagMs: 5 * 60 * 1000,
      },
      {
        metric: 'pnl',
        fieldPath: 'data.list[].pnl',
        provenance: 'source_reported',
        methodologyVersion: 'binance-board-pnl@1',
        windowKeys: ['7D', '30D', '90D'],
        valueUnit: 'currency',
        currencies: ['USDT'],
        requiredRawRoles: DIRECT_RAW_ROLES,
        maxFreshnessMs: 6 * 60 * 60 * 1000,
        maxWindowEndLagMs: 5 * 60 * 1000,
      },
      {
        metric: 'roi',
        fieldPath: 'performance.roi',
        provenance: 'source_reported',
        methodologyVersion: 'binance-performance-roi@1',
        windowKeys: ['7D', '30D', '90D'],
        valueUnit: 'percent',
        currencies: ['USDT'],
        requiredRawRoles: DIRECT_RAW_ROLES,
        maxFreshnessMs: 6 * 60 * 60 * 1000,
        maxWindowEndLagMs: 5 * 60 * 1000,
      },
      {
        metric: 'pnl',
        fieldPath: 'performance.pnl',
        provenance: 'source_reported',
        methodologyVersion: 'binance-performance-pnl@1',
        windowKeys: ['7D', '30D', '90D'],
        valueUnit: 'currency',
        currencies: ['USDT'],
        requiredRawRoles: DIRECT_RAW_ROLES,
        maxFreshnessMs: 6 * 60 * 60 * 1000,
        maxWindowEndLagMs: 5 * 60 * 1000,
      },
    ],
  }),
  binance_web3_bsc: registeredSourceContract({
    sourceId: 'binance_web3_bsc',
    version: '1',
    fields: [
      {
        metric: 'roi',
        fieldPath: 'board.data.data[].realizedPnlPercent',
        provenance: 'source_reported',
        methodologyVersion: 'binance-web3-board-realized-pnl-percent@1',
        windowKeys: ['7D', '30D', '90D'],
        valueUnit: 'percent',
        currencies: ['USD'],
        requiredRawRoles: DIRECT_RAW_ROLES,
        maxFreshnessMs: 2 * 60 * 60 * 1000,
        maxWindowEndLagMs: 5 * 60 * 1000,
      },
      {
        metric: 'pnl',
        fieldPath: 'board.data.data[].realizedPnl',
        provenance: 'source_reported',
        methodologyVersion: 'binance-web3-board-realized-pnl@1',
        windowKeys: ['7D', '30D', '90D'],
        valueUnit: 'currency',
        currencies: ['USD'],
        requiredRawRoles: DIRECT_RAW_ROLES,
        maxFreshnessMs: 2 * 60 * 60 * 1000,
        maxWindowEndLagMs: 5 * 60 * 1000,
      },
      {
        metric: 'roi',
        fieldPath: 'rebuild.roi',
        provenance: 'arena_rebuilt',
        methodologyVersion: 'wallet-event-ledger-average-cost@1',
        windowKeys: ['7D', '30D', '90D'],
        valueUnit: 'percent',
        currencies: ['USD'],
        requiredRawRoles: REBUILD_RAW_ROLES,
        maxFreshnessMs: 2 * 60 * 60 * 1000,
        maxWindowEndLagMs: 5 * 60 * 1000,
      },
    ],
  }),
})

const METHOD_CONTRACT_REGISTRY: Readonly<Record<string, RankingMethodContract>> = Object.freeze({
  [ARENA_CORE_7D_USDT_METHOD_ID]: registeredMethodContract({
    id: 'arena-core-roi-pnl-7d-usdt',
    version: '1',
    requiredMetrics: ['roi', 'pnl'],
    windowKey: '7D',
    comparisonCurrency: 'USDT',
    maxAsOfSkewMs: 5 * 60 * 1000,
  }),
  [ARENA_CORE_30D_USDT_METHOD_ID]: registeredMethodContract({
    id: 'arena-core-roi-pnl-30d-usdt',
    version: '1',
    requiredMetrics: ['roi', 'pnl'],
    windowKey: '30D',
    comparisonCurrency: 'USDT',
    maxAsOfSkewMs: 5 * 60 * 1000,
  }),
  [ARENA_CORE_90D_USDT_METHOD_ID]: registeredMethodContract({
    id: 'arena-core-roi-pnl-90d-usdt',
    version: '1',
    requiredMetrics: ['roi', 'pnl'],
    windowKey: '90D',
    comparisonCurrency: 'USDT',
    maxAsOfSkewMs: 5 * 60 * 1000,
  }),
})

export type MetricRankState = 'eligible' | 'partial' | 'unknown'

export interface MetricRankVerdict {
  eligible: boolean
  state: MetricRankState
  reasons: string[]
}

const EXPECTED_VALUE_UNIT: Record<RankingMetric, MetricValueUnit> = {
  roi: 'percent',
  pnl: 'currency',
  win_rate: 'percent',
  mdd: 'percent',
  sharpe: 'ratio',
}

const WINDOW_DURATION_MS: Record<RankingWindowKey, number> = {
  '7D': 7 * 24 * 60 * 60 * 1000,
  '30D': 30 * 24 * 60 * 60 * 1000,
  '90D': 90 * 24 * 60 * 60 * 1000,
}

const TIME_BOUNDARY_TOLERANCE_MS = 5 * 60 * 1000

const ARENA_VERIFIED_DIMENSIONS = new Set(['population', 'window', 'unit', 'freshness'])

function objectOrNull(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function unique(values: string[]): string[] {
  return [...new Set(values)]
}

function isProviderMetric(provenance: MetricProvenance): boolean {
  return provenance === 'source_reported' || provenance === 'source_normalized'
}

function invalid(reason: string): MetricRankVerdict {
  return { eligible: false, state: 'unknown', reasons: [reason] }
}

function findRegisteredField(
  input: RankingMetricInput,
  sourceContract: MetricSourceContract
): SourceMetricFieldContract | null {
  return (
    sourceContract.fields.find(
      (field) =>
        field.metric === input.evidence.metric && field.fieldPath === input.binding.fieldPath
    ) ?? null
  )
}

/**
 * Evaluate one untrusted runtime input. Missing/malformed fields fail closed;
 * callers cannot promote a value by casting arbitrary JSON to the TS type.
 */
export function evaluateMetricRankEligibility(
  rawInput: unknown,
  now: Date = new Date()
): MetricRankVerdict {
  const parsed = rankingMetricInputSchema.safeParse(rawInput)
  if (!parsed.success) return invalid('trust_input_invalid')
  if (!Number.isFinite(now.getTime())) return invalid('evaluation_time_invalid')

  const input = parsed.data
  const sourceContract = SOURCE_CONTRACT_REGISTRY[input.binding.sourceId]
  if (!sourceContract) return invalid('source_contract_unknown')
  const { binding, evidence } = input
  const reasons: string[] = []
  let hasUnknown = false
  let hasPartial = false
  const addUnknown = (reason: string) => {
    hasUnknown = true
    reasons.push(reason)
  }
  const addPartial = (reason: string) => {
    hasPartial = true
    reasons.push(reason)
  }

  if (input.value === null) addUnknown('value_unknown')
  if (binding.sourceId !== sourceContract.sourceId) addUnknown('source_contract_mismatch')
  if (binding.sourceContractVersion !== sourceContract.version) {
    addUnknown('source_contract_version_mismatch')
  }
  if (binding.valueUnit !== EXPECTED_VALUE_UNIT[evidence.metric]) {
    addUnknown('metric_value_unit_mismatch')
  }

  const startMs = Date.parse(binding.window.startAt)
  const endMs = Date.parse(binding.window.endAt)
  const asOfMs = Date.parse(binding.asOf)
  const validUntilMs = Date.parse(binding.validUntil)
  if (startMs >= endMs) addUnknown('window_bounds_invalid')
  if (
    Math.abs(endMs - startMs - WINDOW_DURATION_MS[binding.window.key]) > TIME_BOUNDARY_TOLERANCE_MS
  ) {
    addUnknown('window_duration_mismatch')
  }
  if (endMs > asOfMs + TIME_BOUNDARY_TOLERANCE_MS) {
    addUnknown('window_ends_after_source_as_of')
  }
  if (asOfMs > now.getTime() + TIME_BOUNDARY_TOLERANCE_MS) addUnknown('source_as_of_in_future')
  if (validUntilMs <= asOfMs) addUnknown('freshness_bounds_invalid')
  if (validUntilMs <= now.getTime()) addUnknown('freshness_expired')

  const fieldContract = findRegisteredField(input, sourceContract)
  if (!fieldContract) {
    addUnknown('source_field_contract_unknown')
  } else {
    if (fieldContract.provenance !== evidence.provenance) {
      addUnknown('source_provenance_mismatch')
    }
    if (fieldContract.methodologyVersion !== evidence.methodologyVersion) {
      addUnknown('source_methodology_mismatch')
    }
    if (!fieldContract.windowKeys.includes(binding.window.key)) {
      addUnknown('source_window_unsupported')
    }
    if (fieldContract.valueUnit !== binding.valueUnit) {
      addUnknown('source_value_unit_mismatch')
    }
    if (!fieldContract.currencies.includes(binding.currency)) {
      addUnknown('source_currency_unsupported')
    }
    if (asOfMs - endMs > fieldContract.maxWindowEndLagMs) {
      addUnknown('source_window_end_lag_exceeded')
    }
    const rawRoles = new Set(binding.rawRefs.map((rawRef) => rawRef.role))
    for (const role of fieldContract.requiredRawRoles) {
      if (!rawRoles.has(role)) addUnknown(`source_lineage_${role}_missing`)
    }
    if (validUntilMs - asOfMs > fieldContract.maxFreshnessMs) {
      addUnknown('source_freshness_ttl_exceeded')
    }
  }

  const rawRefKeys = binding.rawRefs.map((rawRef) => `${rawRef.role}:${rawRef.ref}`)
  if (new Set(rawRefKeys).size !== rawRefKeys.length) addUnknown('source_lineage_duplicate')
  if (binding.rawRefs.some((rawRef) => rawRef.sourceRunId !== binding.sourceRunId)) {
    addUnknown('source_lineage_run_mismatch')
  }

  if (evidence.quality === 'unknown') addUnknown('quality_unknown')
  if (evidence.quality === 'unsupported') addUnknown('metric_unsupported')
  if (evidence.quality === 'partial') addPartial('quality_partial')

  const providerMetric = isProviderMetric(evidence.provenance)
  const states: Array<[string, MetricEvidenceState]> = [
    ['history', evidence.history],
    ['price', evidence.price],
    ['cost_basis', evidence.costBasis],
    ['population', evidence.population],
    ['window', evidence.window],
    ['unit', evidence.unit],
    ['freshness', evidence.freshness],
  ]
  for (const [field, state] of states) {
    if (state === 'unknown') addUnknown(`${field}_unknown`)
    if (state === 'partial') addPartial(`${field}_partial`)
    if (state === 'not_required') addPartial(`${field}_required_for_ranking`)
    if (!providerMetric && state === 'source_owned') {
      addUnknown(`${field}_cannot_be_source_owned_for_${evidence.provenance}`)
    }
    if (ARENA_VERIFIED_DIMENSIONS.has(field) && state === 'source_owned') {
      addUnknown(`${field}_must_be_verified_by_arena`)
    }
  }

  for (const reason of evidence.blockingReasons) {
    if (reason.state === 'unknown') addUnknown(reason.code)
    else addPartial(reason.code)
  }

  const deduped = unique(reasons)
  if (!hasUnknown && !hasPartial && evidence.quality === 'complete') {
    return { eligible: true, state: 'eligible', reasons: [] }
  }
  return {
    eligible: false,
    state: hasUnknown ? 'unknown' : 'partial',
    reasons: deduped,
  }
}

/**
 * Evaluate exactly the fields registered by one ranking methodology. Required
 * inputs must describe the same subject/source/run/window/currency snapshot;
 * optional fields outside the method do not downgrade the trader.
 */
export function evaluateRankingEligibility(
  rawInputs: unknown,
  rawMethodId: unknown,
  now: Date = new Date()
): MetricRankVerdict {
  if (typeof rawMethodId !== 'string') return invalid('ranking_methodology_unknown')
  const methodContract = METHOD_CONTRACT_REGISTRY[rawMethodId]
  if (!methodContract) return invalid('ranking_methodology_unknown')
  const inputRecord = objectOrNull(rawInputs)
  if (!inputRecord) return invalid('ranking_inputs_invalid')

  const reasons: string[] = []
  let state: MetricRankState = 'eligible'
  const parsedInputs: RankingMetricInput[] = []

  for (const metric of methodContract.requiredMetrics) {
    const rawInput = inputRecord[metric]
    if (rawInput === undefined) {
      reasons.push(`${metric}:evidence_unknown`)
      state = 'unknown'
      continue
    }
    const parsed = rankingMetricInputSchema.safeParse(rawInput)
    if (parsed.success) {
      parsedInputs.push(parsed.data)
      if (parsed.data.evidence.metric !== metric) {
        reasons.push(`${metric}:evidence_mismatch`)
        state = 'unknown'
        continue
      }
    }
    const verdict = evaluateMetricRankEligibility(rawInput, now)
    if (!verdict.eligible) {
      reasons.push(...verdict.reasons.map((reason) => `${metric}:${reason}`))
      if (verdict.state === 'unknown') state = 'unknown'
      else if (state === 'eligible') state = 'partial'
    }
  }

  const reference = parsedInputs[0]
  if (reference) {
    const referenceAsOf = Date.parse(reference.binding.asOf)
    for (const input of parsedInputs) {
      const { binding } = input
      if (binding.subjectKey !== reference.binding.subjectKey) {
        reasons.push(`${input.evidence.metric}:subject_mismatch`)
        state = 'unknown'
      }
      if (binding.sourceId !== reference.binding.sourceId) {
        reasons.push(`${input.evidence.metric}:source_mismatch`)
        state = 'unknown'
      }
      if (binding.sourceRunId !== reference.binding.sourceRunId) {
        reasons.push(`${input.evidence.metric}:source_run_mismatch`)
        state = 'unknown'
      }
      if (
        binding.window.key !== reference.binding.window.key ||
        binding.window.startAt !== reference.binding.window.startAt ||
        binding.window.endAt !== reference.binding.window.endAt
      ) {
        reasons.push(`${input.evidence.metric}:window_mismatch`)
        state = 'unknown'
      }
      if (binding.currency !== reference.binding.currency) {
        reasons.push(`${input.evidence.metric}:currency_mismatch`)
        state = 'unknown'
      }
      if (Math.abs(Date.parse(binding.asOf) - referenceAsOf) > methodContract.maxAsOfSkewMs) {
        reasons.push(`${input.evidence.metric}:source_as_of_skew_exceeded`)
        state = 'unknown'
      }
      if (binding.window.key !== methodContract.windowKey) {
        reasons.push(`${input.evidence.metric}:method_window_mismatch`)
        state = 'unknown'
      }
      if (binding.currency !== methodContract.comparisonCurrency) {
        reasons.push(`${input.evidence.metric}:method_currency_mismatch`)
        state = 'unknown'
      }
    }
  }

  const deduped = unique(reasons)
  return {
    eligible: deduped.length === 0,
    state: deduped.length === 0 ? 'eligible' : state,
    reasons: deduped,
  }
}
