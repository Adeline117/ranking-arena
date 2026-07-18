import { createHash } from 'node:crypto'
import { deserialize, serialize } from 'node:v8'

import {
  inspectDexAcquisitionConsistentPair,
  verifyDexAcquisitionManifestTranscriptConsistency,
} from '../lib/dex-acquisition-binding'
import { parseDexAcquisitionRunManifest } from '../lib/dex-acquisition-run-manifest'
import { parseDexAcquisitionTranscript } from '../lib/dex-acquisition-transcript'
import type { DexGoldenSource } from '../lib/dex-golden-wallets'
import {
  cloneDexAcquisitionPairFixture,
  makeDexAcquisitionPairFixture,
  makeDexPairParentFixture,
  recomputeDexPairQueryTotals,
  recomputeDexPairTelemetryTotals,
  recommitDexPairManifest,
  rehashDexPairEndpointProfile,
  type DexAcquisitionPairFixture,
  type DexPairVariant,
} from '../test-helpers/dex-acquisition-pair-fixture'

const PAIR_CASES = [
  ['binance_web3_bsc', 'direct', 'bsc_provider_address_index', 'one_per_golden_wallet'],
  [
    'binance_web3_bsc',
    'sqd_wallet',
    'sqd_finalized_stream_wallet_locator',
    'single_batched_golden_locator',
  ],
  [
    'binance_web3_bsc',
    'protocol_rpc',
    'manifest_protocol_event_rpc_scan',
    'single_protocol_manifest_stream',
  ],
  [
    'binance_web3_bsc',
    'protocol_sqd',
    'manifest_protocol_event_sqd_finalized_stream',
    'single_protocol_manifest_stream',
  ],
  ['okx_web3_solana', 'direct', 'solana_rpc_signatures_for_address', 'one_per_golden_wallet'],
  [
    'okx_web3_solana',
    'sqd_wallet',
    'sqd_finalized_stream_wallet_locator',
    'single_batched_golden_locator',
  ],
  [
    'okx_web3_solana',
    'protocol_rpc',
    'manifest_protocol_event_rpc_scan',
    'single_protocol_manifest_stream',
  ],
  [
    'okx_web3_solana',
    'protocol_sqd',
    'manifest_protocol_event_sqd_finalized_stream',
    'single_protocol_manifest_stream',
  ],
] as const satisfies ReadonlyArray<
  readonly [
    DexGoldenSource,
    DexPairVariant,
    DexAcquisitionPairFixture['manifest']['query_policy']['acquisition_mode'],
    DexAcquisitionPairFixture['manifest']['query_policy']['lane_topology']['kind'],
  ]
>

function hash(label: string): string {
  return createHash('sha256').update(`dex-acquisition-binding-test:${label}`).digest('hex')
}

function bind(pair: DexAcquisitionPairFixture) {
  return verifyDexAcquisitionManifestTranscriptConsistency({
    manifestInput: pair.manifest,
    transcriptInput: pair.transcript,
    parentSnapshotInput: makeDexPairParentFixture(),
  })
}

function expectRejected(pair: DexAcquisitionPairFixture, expected: RegExp): void {
  expect(() =>
    parseDexAcquisitionRunManifest(pair.manifest, makeDexPairParentFixture())
  ).not.toThrow()
  expect(() =>
    parseDexAcquisitionTranscript(pair.transcript, makeDexPairParentFixture())
  ).not.toThrow()
  expect(() => bind(pair)).toThrow(expected)
}

function setDiscoveryPhaseCapacity(pair: DexAcquisitionPairFixture, maximum: number): void {
  const budget = pair.manifest.query_policy.budgets.phases.discovery
  budget.max_request_attempts = maximum
  budget.max_wire_bytes = maximum
  budget.max_decoded_bytes = maximum
}

function recordOneCandidate(
  pair: DexAcquisitionPairFixture,
  outcome: 'strict_success' | 'unavailable'
): void {
  const row = pair.transcript.wallet_results[0]
  row.candidate_identity_count = 1
  row.unique_in_window_candidate_count = 1
  row.first_candidate_height = 101
  row.last_candidate_height = 101
  pair.transcript.candidate_totals.candidate_identity_count = 1
  pair.transcript.candidate_totals.unique_in_window_candidate_count = 1

  if (outcome === 'strict_success') {
    row.strict_membership_execution_success_count = 1
    pair.transcript.candidate_totals.strict_membership_execution_success_count = 1
  } else {
    row.evidence_unavailable_count = 1
    pair.transcript.candidate_totals.evidence_unavailable_count = 1
    pair.transcript.structural_state = 'partial'
  }
}

describe('DEX acquisition manifest/transcript consistency binding', () => {
  it.each(PAIR_CASES)(
    'binds a valid %s %s pair without upgrading claims',
    (source, variant, expectedMode, expectedTopology) => {
      const token = bind(makeDexAcquisitionPairFixture(source, variant))
      const inspection = inspectDexAcquisitionConsistentPair(token)

      expect(inspection.manifest.golden_sample.source_slug).toBe(source)
      expect(inspection.manifest.query_policy.acquisition_mode).toBe(expectedMode)
      expect(inspection.transcript.source.acquisition_mode).toBe(expectedMode)
      expect(inspection.manifest.query_policy.lane_topology.kind).toBe(expectedTopology)
      expect(inspection.manifest.claims.execution_authorized).toBe(false)
      expect(inspection.manifest.serving_authorized).toBe(false)
      expect(inspection.manifest.rank_eligible).toBe(false)
      expect(inspection.manifest.score_eligible).toBe(false)
      expect(inspection.transcript.claims.referenced_artifacts_verified).toBe(false)
      expect(inspection.transcript.claims.technical_run_complete).toBe(false)
      expect(inspection.transcript.serving_authorized).toBe(false)
      expect(inspection.transcript.rank_eligible).toBe(false)
      expect(inspection.transcript.score_eligible).toBe(false)
    }
  )

  it('mints an identity-bound, frozen, non-serializable token with defensive inspections', () => {
    const pair = makeDexAcquisitionPairFixture()
    const originalRunnerSha = pair.manifest.runner_git_sha
    const token = bind(pair)

    expect(Object.getPrototypeOf(token)).toBeNull()
    expect(Object.keys(token)).toEqual([])
    expect(Object.isFrozen(token)).toBe(true)
    expect(() => JSON.stringify(token)).toThrow(/not serializable/)
    expect(() => inspectDexAcquisitionConsistentPair({})).toThrow(/consistent/)
    expect(() => inspectDexAcquisitionConsistentPair({ ...token })).toThrow(/consistent/)
    expect(() => inspectDexAcquisitionConsistentPair(Object.create(token))).toThrow(/consistent/)
    expect(Object.getOwnPropertySymbols(token)).toEqual([])

    const serializedClone: unknown = deserialize(serialize(token))
    expect(() => inspectDexAcquisitionConsistentPair(serializedClone)).toThrow(/consistent/)
    const descriptorCopy = Object.create(null) as object
    Object.defineProperties(descriptorCopy, Object.getOwnPropertyDescriptors(token))
    expect(() => inspectDexAcquisitionConsistentPair(descriptorCopy)).toThrow(/consistent/)

    pair.manifest.runner_git_sha = 'ef'.repeat(20)
    pair.transcript.generator_git_sha = 'ef'.repeat(20)
    const firstInspection = inspectDexAcquisitionConsistentPair(token)
    const secondInspection = inspectDexAcquisitionConsistentPair(token)

    expect(firstInspection.manifest.runner_git_sha).toBe(originalRunnerSha)
    expect(firstInspection).not.toBe(secondInspection)
    expect(firstInspection.manifest).not.toBe(secondInspection.manifest)
    expect(firstInspection.transcript).not.toBe(secondInspection.transcript)
    expect(Object.isFrozen(firstInspection)).toBe(true)
    expect(Object.isFrozen(firstInspection.manifest.window)).toBe(true)
    expect(Object.isFrozen(firstInspection.transcript.telemetry.phases)).toBe(true)
    expect(() => inspectDexAcquisitionConsistentPair(firstInspection)).toThrow(/consistent/)
  })

  it('rejects a transcript bound to a different run-manifest digest', () => {
    const pair = makeDexAcquisitionPairFixture()
    pair.transcript.artifacts.run_manifest_sha256 = hash('wrong-manifest')
    expectRejected(pair, /run manifest SHA/)
  })

  it('rejects a transcript bound to a different query-policy digest', () => {
    const pair = makeDexAcquisitionPairFixture()
    pair.transcript.artifacts.query_policy_sha256 = hash('wrong-query-policy')
    expectRejected(pair, /query policy SHA/)
  })

  it('rejects source-role and runner-revision drift', () => {
    const sourceDrift = makeDexAcquisitionPairFixture()
    sourceDrift.transcript.source.declared_source_role = 'declared_differential'
    expectRejected(sourceDrift, /source/)

    const runnerDrift = makeDexAcquisitionPairFixture()
    runnerDrift.transcript.generator_git_sha = 'ef'.repeat(20)
    expectRejected(runnerDrift, /runner revision/)
  })

  it('rejects a transcript generated before its manifest resolved', () => {
    const pair = makeDexAcquisitionPairFixture()
    pair.transcript.generated_at = '2026-07-15T00:30:00.000Z'
    expectRejected(pair, /generated before its run manifest resolved/)
  })

  it('rejects a structurally valid but different transcript window', () => {
    const pair = makeDexAcquisitionPairFixture()
    pair.transcript.window.start_at = '2026-07-07T00:00:00.000Z'
    pair.transcript.window.end_at = '2026-07-14T00:00:00.000Z'
    expectRejected(pair, /window start/)
  })

  it('rejects endpoint registry, profile, and phase projection drift', () => {
    const registryDrift = makeDexAcquisitionPairFixture()
    registryDrift.transcript.endpoint_bindings.registry_sha256 = hash('wrong-registry')
    expectRejected(registryDrift, /endpoint registry SHA/)

    const profileDrift = makeDexAcquisitionPairFixture()
    const discoveryProfile = profileDrift.transcript.endpoint_bindings.profiles.find(
      (profile) => profile.profile_id === profileDrift.transcript.endpoint_bindings.phases.discovery
    )
    if (discoveryProfile === undefined) throw new Error('fixture discovery profile missing')
    discoveryProfile.endpoint_id = 'alchemy.bnb-index.secondary'
    rehashDexPairEndpointProfile(discoveryProfile)
    expectRejected(profileDrift, /endpoint profiles/)

    const phaseDrift = makeDexAcquisitionPairFixture('binance_web3_bsc', 'sqd_wallet')
    phaseDrift.transcript.endpoint_bindings.phases.boundary_resolution =
      phaseDrift.transcript.endpoint_bindings.phases.discovery
    expectRejected(phaseDrift, /endpoint phase bindings/)
  })

  it('rejects a protocol digest drift even when the transcript is internally self-consistent', () => {
    const pair = makeDexAcquisitionPairFixture('okx_web3_solana', 'protocol_sqd')
    const replacement = hash('wrong-protocol')
    pair.transcript.artifacts.protocol_manifest_sha256 = replacement
    const lane = pair.transcript.query_lanes[0]
    if (lane.scope.kind !== 'all_protocol_manifest_events') {
      throw new Error('fixture protocol lane missing')
    }
    lane.scope.protocol_manifest_sha256 = replacement
    expectRejected(pair, /protocol manifest SHA/)
  })

  it('does not guess equivalence between transcript anchors and manifest boundary evidence', () => {
    const pair = makeDexAcquisitionPairFixture()
    pair.transcript.window.height_range.start_anchor_semantic_sha256 = hash(
      'independent-start-anchor'
    )

    const inspection = inspectDexAcquisitionConsistentPair(bind(pair))
    expect(inspection.transcript.window.height_range.start_anchor_semantic_sha256).toBe(
      hash('independent-start-anchor')
    )
    expect(inspection.transcript.claims.referenced_artifacts_verified).toBe(false)
  })

  it.each([
    ['request_count', 'request attempts'],
    ['response_wire_bytes', 'wire bytes'],
    ['response_decoded_bytes', 'decoded bytes'],
  ] as const)('rejects a phase that exceeds its %s budget', (field) => {
    const pair = makeDexAcquisitionPairFixture()
    pair.transcript.telemetry.phases.boundary_resolution[field] = 2
    recomputeDexPairTelemetryTotals(pair.transcript)
    expectRejected(pair, /phase budget: boundary_resolution/)
  })

  it.each(['request_bytes', 'response_wire_bytes', 'response_decoded_bytes'] as const)(
    'rejects impossible discovery %s totals',
    (field) => {
      const pair = makeDexAcquisitionPairFixture()
      pair.transcript.telemetry.phases.discovery[field] = 1
      recomputeDexPairTelemetryTotals(pair.transcript)
      expectRejected(pair, /impossible byte totals: discovery/)
    }
  )

  it('rejects zero-duration network telemetry', () => {
    const zeroDuration = makeDexAcquisitionPairFixture()
    zeroDuration.transcript.telemetry.duration_ms = 0
    expectRejected(zeroDuration, /zero duration/)
  })

  it('rejects discovery requests and accepted responses not attributed to lanes and pages', () => {
    const requestDrift = makeDexAcquisitionPairFixture()
    setDiscoveryPhaseCapacity(requestDrift, 51)
    recommitDexPairManifest(requestDrift)
    const requestPhase = requestDrift.transcript.telemetry.phases.discovery
    requestPhase.request_count = 51
    requestPhase.request_bytes = 51
    recomputeDexPairTelemetryTotals(requestDrift.transcript)
    expectRejected(requestDrift, /unattributed discovery request attempts/)

    const responseDrift = makeDexAcquisitionPairFixture()
    setDiscoveryPhaseCapacity(responseDrift, 51)
    recommitDexPairManifest(responseDrift)
    const responsePhase = responseDrift.transcript.telemetry.phases.discovery
    responsePhase.request_count = 51
    responsePhase.accepted_response_count = 51
    responsePhase.request_bytes = 51
    responsePhase.response_wire_bytes = 51
    responsePhase.response_decoded_bytes = 51
    responseDrift.transcript.query_lanes[0].attempt_count = 2
    recomputeDexPairQueryTotals(responseDrift.transcript)
    recomputeDexPairTelemetryTotals(responseDrift.transcript)
    expectRejected(responseDrift, /unattributed accepted discovery responses/)
  })

  it('rejects run duration beyond the manifest cap', () => {
    const pair = makeDexAcquisitionPairFixture()
    pair.transcript.telemetry.duration_ms = 1_001
    expectRejected(pair, /duration budget/)
  })

  it('rejects page and attempt overflow at the individual lane boundary', () => {
    const pageOverflow = makeDexAcquisitionPairFixture()
    pageOverflow.manifest.query_policy.budgets.max_attempts_per_request = 2
    setDiscoveryPhaseCapacity(pageOverflow, 100)
    const transactionBudget = pageOverflow.manifest.query_policy.budgets.phases.transaction_evidence
    transactionBudget.max_request_attempts = 400
    transactionBudget.max_wire_bytes = 400
    transactionBudget.max_decoded_bytes = 400
    recommitDexPairManifest(pageOverflow)
    pageOverflow.transcript.query_lanes[0].attempt_count = 2
    pageOverflow.transcript.query_lanes[0].page_count = 2
    recomputeDexPairQueryTotals(pageOverflow.transcript)
    const pagePhase = pageOverflow.transcript.telemetry.phases.discovery
    pagePhase.request_count = 51
    pagePhase.accepted_response_count = 51
    pagePhase.request_bytes = 51
    pagePhase.response_wire_bytes = 51
    pagePhase.response_decoded_bytes = 51
    recomputeDexPairTelemetryTotals(pageOverflow.transcript)
    expectRejected(pageOverflow, /query lane exceeds/)

    const attemptOverflow = makeDexAcquisitionPairFixture()
    setDiscoveryPhaseCapacity(attemptOverflow, 51)
    recommitDexPairManifest(attemptOverflow)
    attemptOverflow.transcript.query_lanes[0].attempt_count = 2
    recomputeDexPairQueryTotals(attemptOverflow.transcript)
    const attemptPhase = attemptOverflow.transcript.telemetry.phases.discovery
    attemptPhase.request_count = 51
    attemptPhase.request_bytes = 51
    recomputeDexPairTelemetryTotals(attemptOverflow.transcript)
    expectRejected(attemptOverflow, /query lane exceeds/)
  })

  it('rejects direct-wallet raw candidates beyond the per-lane cap', () => {
    const pair = makeDexAcquisitionPairFixture()
    const row = pair.transcript.wallet_results[0]
    row.candidate_identity_count = 2
    row.duplicate_candidate_count = 2
    pair.transcript.candidate_totals.candidate_identity_count = 2
    pair.transcript.candidate_totals.duplicate_candidate_count = 2
    expectRejected(pair, /raw-candidate budget/)
  })

  it.each(['sqd_wallet', 'protocol_rpc'] as const)(
    'does not equate %s wallet aggregates with unrecorded shared-lane raw volume',
    (variant) => {
      const pair = makeDexAcquisitionPairFixture('binance_web3_bsc', variant)
      const row = pair.transcript.wallet_results[0]
      row.candidate_identity_count = 2
      row.duplicate_candidate_count = 2
      pair.transcript.candidate_totals.candidate_identity_count = 2
      pair.transcript.candidate_totals.duplicate_candidate_count = 2

      const inspection = inspectDexAcquisitionConsistentPair(bind(pair))
      expect(inspection.transcript.claims.referenced_artifacts_verified).toBe(false)
      expect(inspection.transcript.claims.technical_run_complete).toBe(false)
      expect(inspection.manifest.claims.execution_authorized).toBe(false)
    }
  )

  it('keeps a partial transcript consistent without calling it complete', () => {
    const pair = makeDexAcquisitionPairFixture()
    recordOneCandidate(pair, 'unavailable')
    const phase = pair.transcript.telemetry.phases.transaction_evidence
    phase.request_count = 1
    phase.request_bytes = 1
    recomputeDexPairTelemetryTotals(pair.transcript)

    const inspection = inspectDexAcquisitionConsistentPair(bind(pair))
    expect(inspection.transcript.structural_state).toBe('partial')
    expect(inspection.transcript.claims.technical_run_complete).toBe(false)
    expect(inspection.transcript.claims.referenced_artifacts_verified).toBe(false)
    expect(inspection.manifest.claims.execution_authorized).toBe(false)
  })

  it.each([
    ['response_wire_bytes', 'max_wire_bytes'],
    ['response_decoded_bytes', 'max_decoded_bytes'],
  ] as const)(
    'rejects a discovery aggregate that exceeds its per-page-derived %s envelope',
    (telemetryField, budgetField) => {
      const pair = makeDexAcquisitionPairFixture()
      pair.manifest.query_policy.budgets.phases.discovery[budgetField] = 100
      recommitDexPairManifest(pair)
      pair.transcript.telemetry.phases.discovery[telemetryField] = 51
      recomputeDexPairTelemetryTotals(pair.transcript)
      expectRejected(pair, /discovery aggregate/)
    }
  )

  it('rejects transaction requests beyond candidate fan-out', () => {
    const pair = makeDexAcquisitionPairFixture()
    recordOneCandidate(pair, 'unavailable')
    const phase = pair.transcript.telemetry.phases.transaction_evidence
    phase.request_count = 5
    phase.request_bytes = 5
    recomputeDexPairTelemetryTotals(pair.transcript)
    expectRejected(pair, /candidate RPC fan-out/)
  })

  it.each(['response_wire_bytes', 'response_decoded_bytes'] as const)(
    'rejects a transaction aggregate beyond its per-RPC-derived %s envelope',
    (field) => {
      const pair = makeDexAcquisitionPairFixture()
      recordOneCandidate(pair, 'strict_success')
      const phase = pair.transcript.telemetry.phases.transaction_evidence
      phase.request_count = 1
      phase.accepted_response_count = 1
      phase.request_bytes = 1
      phase.response_wire_bytes = 1
      phase.response_decoded_bytes = 1
      phase[field] = 2
      recomputeDexPairTelemetryTotals(pair.transcript)
      expectRejected(pair, /transaction aggregate/)
    }
  )

  it('compares measured billing exactly while preserving unknown cost as unknown', () => {
    const overCap = makeDexAcquisitionPairFixture()
    overCap.transcript.telemetry.cost = {
      measurement_state: 'measured',
      currency: 'USD',
      billed_usd: '1.2501',
      pricing_evidence_sha256: hash('over-cap-pricing'),
    }
    expectRejected(overCap, /billing cap/)

    const exactCap = makeDexAcquisitionPairFixture()
    exactCap.transcript.telemetry.cost = {
      measurement_state: 'measured',
      currency: 'USD',
      billed_usd: '1.25',
      pricing_evidence_sha256: hash('exact-cap-pricing'),
    }
    expect(() => bind(exactCap)).not.toThrow()

    const unknown = inspectDexAcquisitionConsistentPair(bind(makeDexAcquisitionPairFixture()))
    expect(unknown.transcript.telemetry.cost.measurement_state).toBe('unknown')
    expect(unknown.transcript.telemetry.cost.billed_usd).toBeNull()
    expect(unknown.transcript.claims.referenced_artifacts_verified).toBe(false)
  })

  it('does not share mutable parent fixtures or pair fixtures between tests', () => {
    const firstParent = makeDexPairParentFixture() as {
      wallets: Array<{ wallet: string }>
    }
    const secondParent = makeDexPairParentFixture() as {
      wallets: Array<{ wallet: string }>
    }
    const pair = makeDexAcquisitionPairFixture()
    const clonedPair = cloneDexAcquisitionPairFixture(pair)
    const originalParentWallet = secondParent.wallets[0].wallet
    const originalManifestHeight = pair.manifest.window.height_range.start_inclusive
    const originalTranscriptRequests = pair.transcript.telemetry.phases.discovery.request_count

    firstParent.wallets[0].wallet = 'mutated-parent-wallet'
    clonedPair.manifest.window.height_range.start_inclusive = 999
    clonedPair.transcript.telemetry.phases.discovery.request_count = 999

    expect(firstParent).not.toBe(secondParent)
    expect(secondParent.wallets[0].wallet).toBe(originalParentWallet)
    expect(clonedPair).not.toBe(pair)
    expect(clonedPair.manifest).not.toBe(pair.manifest)
    expect(clonedPair.transcript).not.toBe(pair.transcript)
    expect(pair.manifest.window.height_range.start_inclusive).toBe(originalManifestHeight)
    expect(pair.transcript.telemetry.phases.discovery.request_count).toBe(
      originalTranscriptRequests
    )
  })
})
