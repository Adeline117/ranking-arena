import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import type { SourceRow } from '@/lib/ingest/core/types'
import {
  evaluateTierBCopierSnapshotTrustV2ShadowPolicy,
  TIER_B_COPIER_SNAPSHOT_TRUST_V2_SHADOW_ENV,
  type TierBCopierSnapshotTrustV2ShadowDecision,
} from '../copier-snapshot-trust-v2-shadow-policy'

function source(overrides: Partial<SourceRow> = {}): SourceRow {
  return {
    id: 34,
    slug: 'bingx_futures',
    exchange_id: 3,
    product_type: 'futures',
    trader_kind_scope: 'human',
    adapter_slug: 'bingx',
    leaderboard_url: 'https://example.test/leaderboard',
    timeframes_native: [7, 30, 90],
    timeframes_derived: [],
    tf_label_map: {},
    expected_count: 2076,
    deep_profile_topn: 20,
    positions_topn: 20,
    profile_cache_ttl: '15 minutes',
    copier_table_depth: 'full',
    currency: 'USDT',
    page_size: 20,
    pagination_kind: 'numeric',
    cadence_tier_a: '15 minutes',
    cadence_tier_b: '1 hour',
    cadence_tier_d: '5 minutes',
    fetch_region: 'local',
    rate_budget_ms: 250,
    phase: 1,
    serving_mode: 'serving',
    status: 'active',
    meta: {
      boardKey: 'futures',
      copier_snapshot_trust_v2_shadow_enabled: true,
    },
    ...overrides,
  }
}

function decide(
  src: SourceRow,
  environmentValue: string | undefined
): TierBCopierSnapshotTrustV2ShadowDecision {
  return evaluateTierBCopierSnapshotTrustV2ShadowPolicy({ environmentValue, src })
}

function enabledDecision(src: SourceRow = source()): TierBCopierSnapshotTrustV2ShadowDecision {
  return decide(src, 'true')
}

describe('Tier-B copier snapshot trust v2 shadow policy', () => {
  it('requires both exact enablement keys and returns a log-safe receipt', () => {
    expect(TIER_B_COPIER_SNAPSHOT_TRUST_V2_SHADOW_ENV).toBe('COPIER_SNAPSHOT_TRUST_V2_SHADOW')
    expect(enabledDecision()).toEqual({ eligible: true, reason: 'eligible' })
    expect(Object.isFrozen(enabledDecision())).toBe(true)

    for (const environmentValue of [undefined, '', 'TRUE', ' true', 'true ']) {
      expect(decide(source(), environmentValue)).toEqual({
        eligible: false,
        reason: 'environment_disabled',
      })
    }

    for (const sourceFlag of [undefined, false, 'true', 1]) {
      expect(
        enabledDecision(
          source({
            meta: { boardKey: 'futures', copier_snapshot_trust_v2_shadow_enabled: sourceFlag },
          })
        )
      ).toEqual({ eligible: false, reason: 'source_shadow_disabled' })
    }

    const malformedMetaSource = source()
    Reflect.set(malformedMetaSource, 'meta', null)
    expect(enabledDecision(malformedMetaSource)).toEqual({
      eligible: false,
      reason: 'source_meta_invalid',
    })

    const secret = 'must-not-appear-in-a-policy-decision'
    const receipt = enabledDecision(
      source({
        meta: {
          boardKey: 'futures',
          copier_snapshot_trust_v2_shadow_enabled: true,
          credential: secret,
        },
      })
    )
    expect(receipt).toEqual({ eligible: true, reason: 'eligible' })
    expect(JSON.stringify(receipt)).not.toContain(secret)
  })

  it.each([
    ['slug', { slug: 'bingx_spot' }, 'source_slug_mismatch'],
    ['adapter', { adapter_slug: 'gate' }, 'source_adapter_mismatch'],
    ['product', { product_type: 'spot' }, 'source_product_type_mismatch'],
    ['trader kind', { trader_kind_scope: 'bot' }, 'source_trader_kind_scope_mismatch'],
    ['currency', { currency: 'USDC' }, 'source_currency_mismatch'],
    ['copier depth', { copier_table_depth: 'top10' }, 'source_copier_table_depth_mismatch'],
    [
      'board key',
      { meta: { boardKey: 'spot', copier_snapshot_trust_v2_shadow_enabled: true } },
      'source_board_key_mismatch',
    ],
  ] as const)('rejects a drifted BingX futures %s identity', (_dimension, overrides, reason) => {
    expect(enabledDecision(source(overrides))).toEqual({ eligible: false, reason })
  })

  it.each([
    ['inactive', 'source_status_not_active'],
    ['blocked_pending_vps', 'source_status_not_active'],
    ['dropped', 'source_status_not_active'],
  ] as const)('rejects a non-active source status: %s', (status, reason) => {
    expect(enabledDecision(source({ status }))).toEqual({ eligible: false, reason })
  })

  it.each([
    ['shadow', 'source_serving_mode_not_serving'],
    ['legacy', 'source_serving_mode_not_serving'],
  ] as const)('rejects a non-serving source mode: %s', (serving_mode, reason) => {
    expect(enabledDecision(source({ serving_mode }))).toEqual({ eligible: false, reason })
  })

  it('rejects the real Bitget bots shape even with both enablement keys', () => {
    expect(
      enabledDecision(
        source({
          slug: 'bitget_bots_futures',
          adapter_slug: 'bitget_bots',
          product_type: 'futures',
          trader_kind_scope: 'bot',
          currency: 'USDT',
          copier_table_depth: 'top10',
          meta: {
            boardKey: 'futures',
            copier_snapshot_trust_v2_shadow_enabled: true,
          },
        })
      )
    ).toEqual({ eligible: false, reason: 'source_slug_mismatch' })
  })

  it('has no capability imports or ambient environment access', () => {
    const implementation = readFileSync(
      join(process.cwd(), 'worker/src/ingest/copier-snapshot-trust-v2-shadow-policy.ts'),
      'utf8'
    )

    expect(implementation).toContain("import type { SourceRow } from '@/lib/ingest/core/types'")
    expect(implementation).not.toMatch(
      /from ['"][^'"]*(?:\/raw|copier-snapshot-trust-pipeline-v2|copier-snapshot-publish-v2|tier-b-profiles)['"]/u
    )
    expect(implementation).not.toMatch(/\bprocess\s*\.\s*env\b/u)
  })
})
