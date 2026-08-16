import type { SourceRow } from '@/lib/ingest/core/types'

/**
 * A deliberate two-key gate for the first Tier-B trust-v2 shadow canary.
 *
 * The caller supplies the environment value instead of this policy reading
 * the ambient environment itself. That keeps the decision deterministic, testable, and
 * unable to acquire RAW or publication capabilities by import side effect.
 */
export const TIER_B_COPIER_SNAPSHOT_TRUST_V2_SHADOW_ENV = 'COPIER_SNAPSHOT_TRUST_V2_SHADOW' as const

export type TierBCopierSnapshotTrustV2ShadowIneligibleReason =
  | 'environment_disabled'
  | 'source_meta_invalid'
  | 'source_shadow_disabled'
  | 'source_status_not_active'
  | 'source_serving_mode_not_serving'
  | 'source_slug_mismatch'
  | 'source_adapter_mismatch'
  | 'source_product_type_mismatch'
  | 'source_trader_kind_scope_mismatch'
  | 'source_currency_mismatch'
  | 'source_copier_table_depth_mismatch'
  | 'source_board_key_mismatch'

/** A stable, log-safe result: it deliberately includes no live source values. */
export type TierBCopierSnapshotTrustV2ShadowDecision =
  | Readonly<{ eligible: true; reason: 'eligible' }>
  | Readonly<{ eligible: false; reason: TierBCopierSnapshotTrustV2ShadowIneligibleReason }>

export interface TierBCopierSnapshotTrustV2ShadowPolicyInput {
  /** Must be the exact value of COPIER_SNAPSHOT_TRUST_V2_SHADOW. */
  readonly environmentValue: string | undefined
  /** Only these source facts participate in the narrow canary identity. */
  readonly src: Readonly<
    Pick<
      SourceRow,
      | 'slug'
      | 'adapter_slug'
      | 'product_type'
      | 'trader_kind_scope'
      | 'currency'
      | 'copier_table_depth'
      | 'status'
      | 'serving_mode'
      | 'meta'
    >
  >
}

const eligible: TierBCopierSnapshotTrustV2ShadowDecision = Object.freeze({
  eligible: true,
  reason: 'eligible',
})

function ineligible(
  reason: TierBCopierSnapshotTrustV2ShadowIneligibleReason
): TierBCopierSnapshotTrustV2ShadowDecision {
  return Object.freeze({ eligible: false, reason })
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Fail-closed admission for the Tier-B copier trust-v2 shadow path.
 *
 * This intentionally permits exactly one reviewed source variant. It is not
 * a general copier capability predicate: widening it requires a code review
 * and an explicit identity addition here.
 */
export function evaluateTierBCopierSnapshotTrustV2ShadowPolicy(
  input: TierBCopierSnapshotTrustV2ShadowPolicyInput
): TierBCopierSnapshotTrustV2ShadowDecision {
  const { environmentValue, src } = input

  if (environmentValue !== 'true') return ineligible('environment_disabled')
  if (!isRecord(src.meta)) return ineligible('source_meta_invalid')
  if (src.meta.copier_snapshot_trust_v2_shadow_enabled !== true) {
    return ineligible('source_shadow_disabled')
  }
  if (src.status !== 'active') return ineligible('source_status_not_active')
  if (src.serving_mode !== 'serving') return ineligible('source_serving_mode_not_serving')
  if (src.slug !== 'bingx_futures') return ineligible('source_slug_mismatch')
  if (src.adapter_slug !== 'bingx') return ineligible('source_adapter_mismatch')
  if (src.product_type !== 'futures') return ineligible('source_product_type_mismatch')
  if (src.trader_kind_scope !== 'human') {
    return ineligible('source_trader_kind_scope_mismatch')
  }
  if (src.currency !== 'USDT') return ineligible('source_currency_mismatch')
  if (src.copier_table_depth !== 'full') {
    return ineligible('source_copier_table_depth_mismatch')
  }
  if (src.meta.boardKey !== 'futures') return ineligible('source_board_key_mismatch')

  return eligible
}
