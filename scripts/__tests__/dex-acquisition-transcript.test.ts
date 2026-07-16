import { createHash } from 'node:crypto'

import fixtureJson from '../fixtures/dex-golden-wallets.v1.json'
import {
  DEX_ACQUISITION_TRANSCRIPT_CONTRACT,
  DEX_ACQUISITION_TRANSCRIPT_SCHEMA_VERSION,
  dexAcquisitionTranscriptSha256,
  type DexAcquisitionTranscript,
  parseDexAcquisitionTranscript,
} from '../lib/dex-acquisition-transcript'
import {
  buildDexGoldenWalletChainSubset,
  DEX_GOLDEN_WALLET_CONTRACT,
  DEX_GOLDEN_WALLET_SUBSET_CONTRACT,
  dexGoldenWalletSnapshotSha256,
  type DexGoldenSource,
} from '../lib/dex-golden-wallets'

const HASH = {
  start: '11'.repeat(32),
  end: '22'.repeat(32),
  endpoint: '33'.repeat(32),
  manifest: '44'.repeat(32),
  query: '55'.repeat(32),
  pages: '66'.repeat(32),
  checkpoints: '77'.repeat(32),
  transactions: '88'.repeat(32),
  catalog: '99'.repeat(32),
  gap: 'aa'.repeat(32),
  pricing: 'dd'.repeat(32),
  protocol: 'ee'.repeat(32),
} as const

const EXPECTED_PARENT_SHA256 = '736144afddfb61c3140c4286caf480578345aae1c30f9e65c50341092cf2e5ba'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function hash(label: string): string {
  return createHash('sha256').update(label).digest('hex')
}

function validTranscript(source: DexGoldenSource = 'binance_web3_bsc'): DexAcquisitionTranscript {
  const { subset, sha256: subsetSha256 } = buildDexGoldenWalletChainSubset(fixtureJson, source)
  const isBsc = source === 'binance_web3_bsc'
  const walletResults = subset.wallets.map((wallet) => ({
    wallet: wallet.wallet,
    cohort: wallet.cohort,
    candidate_identity_count: 0,
    duplicate_candidate_count: 0,
    outside_window_candidate_count: 0,
    unique_in_window_candidate_count: 0,
    strict_membership_execution_success_count: 0,
    strict_membership_execution_failure_count: 0,
    evidence_unavailable_count: 0,
    evidence_rejected_count: 0,
    first_candidate_height: null,
    last_candidate_height: null,
  }))
  const queryLanes = subset.wallets.map((wallet, index) => ({
    lane_id: `wallet-${String(index).padStart(2, '0')}`,
    scope: { kind: 'wallet' as const, wallet: wallet.wallet },
    query_state: 'exhausted' as const,
    completion_reason: 'window_boundary_reached' as const,
    attempt_count: 1,
    page_count: 1,
    page_chain_sha256: hash(`page-chain:${source}:${index}`),
    checkpoint_sha256: hash(`checkpoint:${source}:${index}`),
  }))

  return {
    schema_version: DEX_ACQUISITION_TRANSCRIPT_SCHEMA_VERSION,
    data_contract: DEX_ACQUISITION_TRANSCRIPT_CONTRACT,
    purpose: 'phase0_7d_technical_bakeoff_only',
    mode: 'shadow_only',
    generated_at: '2026-07-16T20:00:00.000Z',
    generator_git_sha: 'ab'.repeat(20),
    structural_state: 'structurally_complete',
    chain: isBsc
      ? { namespace: 'eip155', reference: '56', height_unit: 'block' }
      : { namespace: 'solana', reference: 'mainnet-beta', height_unit: 'slot' },
    golden_sample: {
      parent_contract: DEX_GOLDEN_WALLET_CONTRACT,
      parent_snapshot_sha256: EXPECTED_PARENT_SHA256,
      subset_contract: DEX_GOLDEN_WALLET_SUBSET_CONTRACT,
      subset_sha256: subsetSha256,
      source_slug: source,
      wallet_count: 50,
      selection_scope: 'leaderboard_derived_stratified_technical_sample',
    },
    window: {
      timeframe_days: 7,
      semantics: 'completed_utc_days_half_open',
      start_at: '2026-07-08T00:00:00.000Z',
      end_at: '2026-07-15T00:00:00.000Z',
      duration_seconds: 604800,
      height_range: {
        start_inclusive: 100,
        end_exclusive: 107,
        start_anchor_semantic_sha256: HASH.start,
        end_anchor_semantic_sha256: HASH.end,
      },
    },
    source: {
      provider_id: isBsc ? 'alchemy' : 'solana-foundation-rpc',
      data_source_id: isBsc ? 'alchemy-bnb-mainnet-address-index' : 'solana-mainnet-rpc',
      endpoint_id: isBsc ? 'alchemy.bnb-mainnet.primary' : 'solana.mainnet.primary',
      endpoint_identity_sha256: HASH.endpoint,
      acquisition_mode: isBsc ? 'bsc_provider_address_index' : 'solana_rpc_signatures_for_address',
      query_shape: 'one_query_per_wallet',
      completeness_scope: isBsc ? 'provider_address_index_query' : 'rpc_address_signature_query',
      source_independence_group: isBsc ? 'alchemy-bnb-mainnet' : 'solana-foundation-mainnet',
      finality_claim: isBsc
        ? 'provider_index_with_strict_rpc_membership'
        : 'strict_rpc_membership_bound',
      declared_source_role: 'primary_shadow',
      auth_mode: isBsc ? 'api_key' : 'none',
      redirect_policy: 'error',
      exact_endpoint_per_run: true,
      mixed_provider_pages: false,
    },
    artifacts: {
      run_manifest_sha256: HASH.manifest,
      query_policy_sha256: HASH.query,
      page_ledger_sha256: HASH.pages,
      checkpoint_chain_sha256: HASH.checkpoints,
      transaction_evidence_index_sha256: HASH.transactions,
      protocol_manifest_sha256: null,
    },
    candidate_evidence: {
      data_contract: 'arena.dex.transaction-membership-index@1',
      verification_method: isBsc
        ? 'bsc_strict_rpc_receipt_status_block_membership'
        : 'solana_strict_rpc_signature_status_block_membership',
      provider_independence: 'not_asserted',
    },
    block_catalog: {
      state: 'complete',
      completeness_scope: 'same_provider_internal_continuity_only',
      produced_unit_count: isBsc ? 7 : 5,
      verified_skipped_unit_count: isBsc ? 0 : 2,
      missing_unit_count: 0,
      unexplained_gap_count: 0,
      duplicate_delivery_count: 0,
      out_of_order_count: 0,
      first_observed_height: 100,
      last_observed_height: isBsc ? 106 : 105,
      evidence_sha256: HASH.catalog,
      independent_gap_evidence_sha256: isBsc ? null : HASH.gap,
    },
    query_lanes: queryLanes,
    query_totals: {
      lane_count: 50,
      exhausted_lane_count: 50,
      partial_lane_count: 0,
      failed_lane_count: 0,
      not_attempted_lane_count: 0,
      attempt_count: 50,
      page_count: 50,
    },
    wallet_results: walletResults,
    candidate_totals: {
      wallet_count: 50,
      candidate_identity_count: 0,
      duplicate_candidate_count: 0,
      outside_window_candidate_count: 0,
      unique_in_window_candidate_count: 0,
      strict_membership_execution_success_count: 0,
      strict_membership_execution_failure_count: 0,
      evidence_unavailable_count: 0,
      evidence_rejected_count: 0,
    },
    telemetry: {
      phases: {
        boundary_resolution: {
          request_count: 1,
          request_bytes: 512,
          response_wire_bytes: 1024,
          response_decoded_bytes: 2048,
          retry_count: 0,
          rate_limit_count: 0,
        },
        block_catalog: {
          request_count: 1,
          request_bytes: 512,
          response_wire_bytes: 1024,
          response_decoded_bytes: 2048,
          retry_count: 0,
          rate_limit_count: 0,
        },
        discovery: {
          request_count: 50,
          request_bytes: 3072,
          response_wire_bytes: 6144,
          response_decoded_bytes: 12288,
          retry_count: 0,
          rate_limit_count: 0,
        },
        transaction_evidence: {
          request_count: 0,
          request_bytes: 0,
          response_wire_bytes: 0,
          response_decoded_bytes: 0,
          retry_count: 0,
          rate_limit_count: 0,
        },
      },
      request_count: 52,
      request_bytes: 4096,
      response_wire_bytes: 8192,
      response_decoded_bytes: 16384,
      duration_ms: 2000,
      retry_count: 0,
      rate_limit_count: 0,
      cost: {
        measurement_state: 'unknown',
        currency: 'USD',
        billed_usd: null,
        pricing_evidence_sha256: null,
      },
    },
    claims: {
      technical_sample_scope: 'leaderboard_derived_stratified_50_wallets',
      query_exhaustion_scope: 'provider_query_only',
      block_catalog_scope: 'same_provider_internal_continuity_only',
      wallet_chain_history_complete: false,
      chain_population_complete: false,
      population_denominator_eligible: false,
      population_recall_measured: false,
      population_recall: null,
      referenced_artifacts_verified: false,
      technical_run_complete: false,
      source_independence_verified: false,
    },
    serving_authorized: false,
    rank_eligible: false,
    score_eligible: false,
  }
}

function firstRow(transcript: DexAcquisitionTranscript) {
  return transcript.wallet_results[0]
}

function firstLane(transcript: DexAcquisitionTranscript) {
  return transcript.query_lanes[0]
}

function asSqdBatch(transcript: DexAcquisitionTranscript): DexAcquisitionTranscript {
  transcript.source.acquisition_mode = 'sqd_finalized_stream_wallet_locator'
  transcript.source.query_shape = 'batched_wallet_locator'
  transcript.source.completeness_scope = 'provider_dataset_wallet_locator_query'
  transcript.source.finality_claim = 'provider_finalized_stream_assertion'
  transcript.query_lanes = [
    {
      lane_id: 'all-golden-wallets',
      scope: { kind: 'all_golden_wallets' },
      query_state: 'exhausted',
      completion_reason: 'range_sentinel_observed',
      attempt_count: 1,
      page_count: 1,
      page_chain_sha256: hash('sqd:all:pages'),
      checkpoint_sha256: hash('sqd:all:checkpoint'),
    },
  ]
  transcript.query_totals = {
    lane_count: 1,
    exhausted_lane_count: 1,
    partial_lane_count: 0,
    failed_lane_count: 0,
    not_attempted_lane_count: 0,
    attempt_count: 1,
    page_count: 1,
  }
  transcript.telemetry.phases.boundary_resolution = {
    request_count: 0,
    request_bytes: 0,
    response_wire_bytes: 0,
    response_decoded_bytes: 0,
    retry_count: 0,
    rate_limit_count: 0,
  }
  transcript.telemetry.phases.discovery = {
    request_count: 1,
    request_bytes: 512,
    response_wire_bytes: 1024,
    response_decoded_bytes: 2048,
    retry_count: 0,
    rate_limit_count: 0,
  }
  transcript.telemetry.request_count = 2
  transcript.telemetry.request_bytes = 1024
  transcript.telemetry.response_wire_bytes = 2048
  transcript.telemetry.response_decoded_bytes = 4096
  return transcript
}

function recordTransactionEvidenceRequest(transcript: DexAcquisitionTranscript): void {
  transcript.telemetry.phases.transaction_evidence = {
    request_count: 1,
    request_bytes: 256,
    response_wire_bytes: 512,
    response_decoded_bytes: 1024,
    retry_count: 0,
    rate_limit_count: 0,
  }
  transcript.telemetry.request_count += 1
  transcript.telemetry.request_bytes += 256
  transcript.telemetry.response_wire_bytes += 512
  transcript.telemetry.response_decoded_bytes += 1024
}

describe('DEX acquisition transcript contract', () => {
  it('accepts complete BSC and Solana technical transcripts bound to the real fixture', () => {
    expect(dexGoldenWalletSnapshotSha256(fixtureJson)).toBe(EXPECTED_PARENT_SHA256)
    expect(parseDexAcquisitionTranscript(validTranscript(), fixtureJson)).toEqual(validTranscript())
    expect(
      parseDexAcquisitionTranscript(validTranscript('okx_web3_solana'), fixtureJson).chain
    ).toEqual({ namespace: 'solana', reference: 'mainnet-beta', height_unit: 'slot' })
  })

  it('pins a domain-bound hash and changes it when evidence changes', () => {
    const transcript = validTranscript()
    const expected = 'd024714254c3f03679f99f60800234febe7ae1fb0ab6da46955c33d568d6cbcf'
    expect(dexAcquisitionTranscriptSha256(transcript, fixtureJson)).toBe(expected)

    const reorderedObject = {
      ...transcript,
      chain: { ...transcript.chain },
      artifacts: { ...transcript.artifacts },
    }
    expect(dexAcquisitionTranscriptSha256(reorderedObject, fixtureJson)).toBe(expected)

    const changed = clone(transcript)
    changed.telemetry.duration_ms += 1
    expect(dexAcquisitionTranscriptSha256(changed, fixtureJson)).not.toBe(expected)
  })

  it('re-derives the parent and subset instead of trusting plausible SHA fields', () => {
    const wrongParent = validTranscript()
    wrongParent.golden_sample.parent_snapshot_sha256 = HASH.start
    expect(() => parseDexAcquisitionTranscript(wrongParent, fixtureJson)).toThrow(
      /parent snapshot SHA/
    )

    const wrongSubset = validTranscript()
    wrongSubset.golden_sample.subset_sha256 = HASH.end
    expect(() => parseDexAcquisitionTranscript(wrongSubset, fixtureJson)).toThrow(/subset SHA/)

    const foreignFixture = clone(fixtureJson)
    foreignFixture.generated_at = '2026-07-16T17:52:20.000Z'
    expect(() => parseDexAcquisitionTranscript(validTranscript(), foreignFixture)).toThrow(
      /parent snapshot SHA/
    )
  })

  it('rejects a missing, duplicate, reordered, or cross-chain wallet row', () => {
    const missing = validTranscript()
    missing.wallet_results.pop()
    expect(() => parseDexAcquisitionTranscript(missing, fixtureJson)).toThrow()

    const duplicate = validTranscript()
    duplicate.wallet_results[1].wallet = duplicate.wallet_results[0].wallet
    expect(() => parseDexAcquisitionTranscript(duplicate, fixtureJson)).toThrow(
      /wallet\/cohort order/
    )

    const reordered = validTranscript()
    ;[reordered.wallet_results[0], reordered.wallet_results[1]] = [
      reordered.wallet_results[1],
      reordered.wallet_results[0],
    ]
    expect(() => parseDexAcquisitionTranscript(reordered, fixtureJson)).toThrow(
      /wallet\/cohort order/
    )

    const foreignChain = validTranscript()
    foreignChain.golden_sample.source_slug = 'okx_web3_solana'
    expect(() => parseDexAcquisitionTranscript(foreignChain, fixtureJson)).toThrow(/subset SHA/)
  })

  it('rejects sparse rows, unknown fields, secret-shaped endpoint values, and authorization', () => {
    const sparse = validTranscript()
    delete sparse.wallet_results[2]
    expect(() => parseDexAcquisitionTranscript(sparse, fixtureJson)).toThrow()

    const unknown = validTranscript() as DexAcquisitionTranscript & { coverage_rate: number }
    unknown.coverage_rate = 1
    expect(() => parseDexAcquisitionTranscript(unknown, fixtureJson)).toThrow()

    const secretUrl = validTranscript()
    secretUrl.source.endpoint_id = 'https://example.test/?apiKey=secret'
    expect(() => parseDexAcquisitionTranscript(secretUrl, fixtureJson)).toThrow()

    const authorized = validTranscript() as DexAcquisitionTranscript & {
      serving_authorized: boolean
    }
    authorized.serving_authorized = true
    expect(() => parseDexAcquisitionTranscript(authorized, fixtureJson)).toThrow()
  })

  it('requires an exact completed seven-day UTC half-open window', () => {
    const shifted = validTranscript()
    shifted.window.start_at = '2026-07-08T00:00:01.000Z'
    expect(() => parseDexAcquisitionTranscript(shifted, fixtureJson)).toThrow(/UTC midnight/)

    const short = validTranscript()
    short.window.end_at = '2026-07-14T00:00:00.000Z'
    expect(() => parseDexAcquisitionTranscript(short, fixtureJson)).toThrow(/exactly seven/)

    const generatedEarly = validTranscript()
    generatedEarly.generated_at = '2026-07-14T23:59:59.999Z'
    expect(() => parseDexAcquisitionTranscript(generatedEarly, fixtureJson)).toThrow(
      /before its window ends/
    )

    const emptyRange = validTranscript()
    emptyRange.window.height_range.end_exclusive = 100
    expect(() => parseDexAcquisitionTranscript(emptyRange, fixtureJson)).toThrow(/non-empty/)

    const aliasedAnchors = validTranscript()
    aliasedAnchors.window.height_range.end_anchor_semantic_sha256 =
      aliasedAnchors.window.height_range.start_anchor_semantic_sha256
    expect(() => parseDexAcquisitionTranscript(aliasedAnchors, fixtureJson)).toThrow(
      /distinct anchor evidence/
    )
  })

  it('rejects negative zero, unsafe integers, zero hashes, and non-canonical money', () => {
    const negativeZero = validTranscript()
    negativeZero.telemetry.retry_count = -0
    expect(() => parseDexAcquisitionTranscript(negativeZero, fixtureJson)).toThrow(/negative zero/)

    const unsafe = validTranscript()
    unsafe.telemetry.request_bytes = Number.MAX_SAFE_INTEGER + 1
    expect(() => parseDexAcquisitionTranscript(unsafe, fixtureJson)).toThrow(/safe/)

    const zeroHash = validTranscript()
    zeroHash.artifacts.page_ledger_sha256 = '0'.repeat(64)
    expect(() => parseDexAcquisitionTranscript(zeroHash, fixtureJson)).toThrow(/nonzero/)

    const money = validTranscript()
    money.telemetry.cost = {
      measurement_state: 'measured',
      currency: 'USD',
      billed_usd: '01.00',
      pricing_evidence_sha256: HASH.pricing,
    }
    expect(() => parseDexAcquisitionTranscript(money, fixtureJson)).toThrow()
  })

  it('enforces chain-specific acquisition and finality claims', () => {
    const wrongMode = validTranscript()
    wrongMode.source.acquisition_mode = 'solana_rpc_signatures_for_address'
    wrongMode.source.finality_claim = 'strict_rpc_membership_bound'
    expect(() => parseDexAcquisitionTranscript(wrongMode, fixtureJson)).toThrow(/BSC transcript/)

    const looseBsc = validTranscript()
    looseBsc.source.finality_claim = 'provider_finalized_stream_assertion'
    expect(() => parseDexAcquisitionTranscript(looseBsc, fixtureJson)).toThrow(/address-index/)

    const wrongEvidenceMethod = validTranscript()
    wrongEvidenceMethod.candidate_evidence.verification_method =
      'solana_strict_rpc_signature_status_block_membership'
    expect(() => parseDexAcquisitionTranscript(wrongEvidenceMethod, fixtureJson)).toThrow(
      /candidate evidence method/
    )

    const malformedSqd = validTranscript()
    malformedSqd.source.acquisition_mode = 'sqd_finalized_stream_wallet_locator'
    expect(() => parseDexAcquisitionTranscript(malformedSqd, fixtureJson)).toThrow(
      /SQD acquisition/
    )

    const sqd = asSqdBatch(validTranscript())
    expect(parseDexAcquisitionTranscript(sqd, fixtureJson).source.query_shape).toBe(
      'batched_wallet_locator'
    )

    const protocol = asSqdBatch(validTranscript())
    protocol.source.acquisition_mode = 'manifest_protocol_event_rpc_scan'
    protocol.source.query_shape = 'protocol_wide_local_match'
    protocol.source.completeness_scope = 'manifest_protocol_events_in_height_range'
    expect(() => parseDexAcquisitionTranscript(protocol, fixtureJson)).toThrow(
      /RPC protocol-event acquisition/
    )

    protocol.source.finality_claim = 'strict_rpc_membership_bound'
    firstLane(protocol).completion_reason = 'height_range_completed'
    expect(() => parseDexAcquisitionTranscript(protocol, fixtureJson)).toThrow(/protocol manifest/)

    protocol.artifacts.protocol_manifest_sha256 = HASH.protocol
    expect(parseDexAcquisitionTranscript(protocol, fixtureJson).source.acquisition_mode).toBe(
      'manifest_protocol_event_rpc_scan'
    )

    firstLane(protocol).completion_reason = 'range_sentinel_observed'
    expect(() => parseDexAcquisitionTranscript(protocol, fixtureJson)).toThrow(
      /exhausted query lane/
    )
  })

  it('partitions block/slot ranges and requires independent skipped-slot evidence', () => {
    const missing = validTranscript()
    missing.block_catalog.produced_unit_count = 6
    expect(() => parseDexAcquisitionTranscript(missing, fixtureJson)).toThrow(/partition the range/)

    const bscSkipped = validTranscript()
    bscSkipped.block_catalog.produced_unit_count = 6
    bscSkipped.block_catalog.verified_skipped_unit_count = 1
    expect(() => parseDexAcquisitionTranscript(bscSkipped, fixtureJson)).toThrow(
      /cannot classify skipped/
    )

    const solanaNoProof = validTranscript('okx_web3_solana')
    solanaNoProof.block_catalog.independent_gap_evidence_sha256 = null
    expect(() => parseDexAcquisitionTranscript(solanaNoProof, fixtureJson)).toThrow(
      /independent gap evidence/
    )

    const sameProviderGapProof = validTranscript('okx_web3_solana')
    sameProviderGapProof.block_catalog.independent_gap_evidence_sha256 =
      sameProviderGapProof.block_catalog.evidence_sha256
    expect(() => parseDexAcquisitionTranscript(sameProviderGapProof, fixtureJson)).toThrow(
      /distinct evidence domains/
    )

    const impossibleSolanaBounds = validTranscript('okx_web3_solana')
    impossibleSolanaBounds.block_catalog.last_observed_height = 100
    expect(() => parseDexAcquisitionTranscript(impossibleSolanaBounds, fixtureJson)).toThrow(
      /observed height span/
    )

    const inventedBscGapProof = validTranscript()
    inventedBscGapProof.block_catalog.independent_gap_evidence_sha256 = HASH.gap
    expect(() => parseDexAcquisitionTranscript(inventedBscGapProof, fixtureJson)).toThrow(
      /reserved for verified Solana/
    )

    const impossibleGapCount = validTranscript()
    impossibleGapCount.block_catalog.state = 'partial'
    impossibleGapCount.block_catalog.produced_unit_count = 6
    impossibleGapCount.block_catalog.missing_unit_count = 1
    impossibleGapCount.block_catalog.unexplained_gap_count = 2
    impossibleGapCount.structural_state = 'partial'
    expect(() => parseDexAcquisitionTranscript(impossibleGapCount, fixtureJson)).toThrow(
      /cannot exceed missing units/
    )

    const gapMarkedComplete = validTranscript()
    gapMarkedComplete.block_catalog.produced_unit_count = 6
    gapMarkedComplete.block_catalog.missing_unit_count = 1
    expect(() => parseDexAcquisitionTranscript(gapMarkedComplete, fixtureJson)).toThrow(
      /complete block catalog/
    )
  })

  it('keeps not-run block catalogs empty and prevents them from passing a complete run', () => {
    const notRun = validTranscript()
    notRun.block_catalog = {
      state: 'not_run',
      completeness_scope: 'same_provider_internal_continuity_only',
      produced_unit_count: 0,
      verified_skipped_unit_count: 0,
      missing_unit_count: 0,
      unexplained_gap_count: 0,
      duplicate_delivery_count: 0,
      out_of_order_count: 0,
      first_observed_height: null,
      last_observed_height: null,
      evidence_sha256: null,
      independent_gap_evidence_sha256: null,
    }
    expect(() => parseDexAcquisitionTranscript(notRun, fixtureJson)).toThrow(
      /structural_state must be partial/
    )

    notRun.structural_state = 'partial'
    notRun.telemetry.phases.block_catalog = {
      request_count: 0,
      request_bytes: 0,
      response_wire_bytes: 0,
      response_decoded_bytes: 0,
      retry_count: 0,
      rate_limit_count: 0,
    }
    notRun.telemetry.request_count -= 1
    notRun.telemetry.request_bytes -= 512
    notRun.telemetry.response_wire_bytes -= 1024
    notRun.telemetry.response_decoded_bytes -= 2048
    expect(parseDexAcquisitionTranscript(notRun, fixtureJson).block_catalog.state).toBe('not_run')

    notRun.block_catalog.produced_unit_count = 1
    expect(() => parseDexAcquisitionTranscript(notRun, fixtureJson)).toThrow(/must be empty/)
  })

  it('partitions candidate identities and verified execution outcomes without dropping failures', () => {
    const transcript = validTranscript()
    const row = firstRow(transcript)
    row.candidate_identity_count = 5
    row.duplicate_candidate_count = 1
    row.outside_window_candidate_count = 1
    row.unique_in_window_candidate_count = 3
    row.strict_membership_execution_success_count = 1
    row.strict_membership_execution_failure_count = 1
    row.evidence_unavailable_count = 1
    row.first_candidate_height = 101
    row.last_candidate_height = 105
    transcript.candidate_totals.candidate_identity_count = 5
    transcript.candidate_totals.duplicate_candidate_count = 1
    transcript.candidate_totals.outside_window_candidate_count = 1
    transcript.candidate_totals.unique_in_window_candidate_count = 3
    transcript.candidate_totals.strict_membership_execution_success_count = 1
    transcript.candidate_totals.strict_membership_execution_failure_count = 1
    transcript.candidate_totals.evidence_unavailable_count = 1
    transcript.structural_state = 'partial'
    recordTransactionEvidenceRequest(transcript)
    expect(parseDexAcquisitionTranscript(transcript, fixtureJson).structural_state).toBe('partial')

    const lostFailure = clone(transcript)
    firstRow(lostFailure).strict_membership_execution_failure_count = 0
    expect(() => parseDexAcquisitionTranscript(lostFailure, fixtureJson)).toThrow(
      /evidence outcomes do not partition/
    )

    const outsideHeight = clone(transcript)
    firstRow(outsideHeight).last_candidate_height = 107
    expect(() => parseDexAcquisitionTranscript(outsideHeight, fixtureJson)).toThrow(
      /outside the window/
    )

    const halfBound = validTranscript()
    firstRow(halfBound).first_candidate_height = 101
    expect(() => parseDexAcquisitionTranscript(halfBound, fixtureJson)).toThrow(
      /height bounds conflict/
    )
  })

  it('requires query states, reasons, page hashes, and checkpoints to agree', () => {
    const partial = validTranscript()
    const lane = firstLane(partial)
    lane.query_state = 'partial'
    lane.completion_reason = 'request_cap_reached'
    partial.query_totals.exhausted_lane_count = 49
    partial.query_totals.partial_lane_count = 1
    partial.structural_state = 'partial'
    expect(parseDexAcquisitionTranscript(partial, fixtureJson).structural_state).toBe('partial')

    const wrongReason = clone(partial)
    firstLane(wrongReason).completion_reason = 'cursor_exhausted'
    expect(() => parseDexAcquisitionTranscript(wrongReason, fixtureJson)).toThrow(
      /partial query lane has inconsistent/
    )

    const missingPageHash = validTranscript()
    firstLane(missingPageHash).page_chain_sha256 = null
    expect(() => parseDexAcquisitionTranscript(missingPageHash, fixtureJson)).toThrow(
      /page hash conflicts/
    )

    const noCheckpoint = validTranscript()
    firstLane(noCheckpoint).checkpoint_sha256 = null
    expect(() => parseDexAcquisitionTranscript(noCheckpoint, fixtureJson)).toThrow(
      /checkpoint presence/
    )

    const sharedPageChain = validTranscript()
    sharedPageChain.query_lanes[1].page_chain_sha256 =
      sharedPageChain.query_lanes[0].page_chain_sha256
    expect(() => parseDexAcquisitionTranscript(sharedPageChain, fixtureJson)).toThrow(
      /must not share page_chain_sha256/
    )

    const crossDomainHashReuse = validTranscript()
    firstLane(crossDomainHashReuse).checkpoint_sha256 =
      firstLane(crossDomainHashReuse).page_chain_sha256
    expect(() => parseDexAcquisitionTranscript(crossDomainHashReuse, fixtureJson)).toThrow(
      /distinct evidence domains/
    )

    const repeatedArtifactHash = validTranscript()
    repeatedArtifactHash.artifacts.query_policy_sha256 =
      repeatedArtifactHash.artifacts.run_manifest_sha256
    expect(() => parseDexAcquisitionTranscript(repeatedArtifactHash, fixtureJson)).toThrow(
      /distinct evidence domains/
    )

    const reusedGoldenHash = validTranscript()
    reusedGoldenHash.artifacts.query_policy_sha256 =
      reusedGoldenHash.golden_sample.parent_snapshot_sha256
    expect(() => parseDexAcquisitionTranscript(reusedGoldenHash, fixtureJson)).toThrow(
      /distinct evidence domains/
    )

    const reorderedLanes = validTranscript()
    ;[reorderedLanes.query_lanes[0], reorderedLanes.query_lanes[1]] = [
      reorderedLanes.query_lanes[1],
      reorderedLanes.query_lanes[0],
    ]
    expect(() => parseDexAcquisitionTranscript(reorderedLanes, fixtureJson)).toThrow(
      /exact subset wallet order/
    )

    const failedWithCommittedPage = validTranscript()
    firstLane(failedWithCommittedPage).query_state = 'failed'
    firstLane(failedWithCommittedPage).completion_reason = 'invalid_response'
    failedWithCommittedPage.query_totals.exhausted_lane_count = 49
    failedWithCommittedPage.query_totals.failed_lane_count = 1
    failedWithCommittedPage.structural_state = 'partial'
    expect(() => parseDexAcquisitionTranscript(failedWithCommittedPage, fixtureJson)).toThrow(
      /failed query lane has inconsistent/
    )
  })

  it('requires exact aggregate totals and a truthful structural state', () => {
    const drift = validTranscript()
    drift.query_totals.page_count = 49
    expect(() => parseDexAcquisitionTranscript(drift, fixtureJson)).toThrow(/query aggregate/)

    const falsePartial = validTranscript()
    falsePartial.structural_state = 'partial'
    expect(() => parseDexAcquisitionTranscript(falsePartial, fixtureJson)).toThrow(
      /structural_state must be structurally_complete/
    )

    const unknownEvidence = validTranscript()
    const row = firstRow(unknownEvidence)
    row.candidate_identity_count = 1
    row.unique_in_window_candidate_count = 1
    row.evidence_unavailable_count = 1
    row.first_candidate_height = 102
    row.last_candidate_height = 102
    unknownEvidence.candidate_totals.candidate_identity_count = 1
    unknownEvidence.candidate_totals.unique_in_window_candidate_count = 1
    unknownEvidence.candidate_totals.evidence_unavailable_count = 1
    expect(() => parseDexAcquisitionTranscript(unknownEvidence, fixtureJson)).toThrow(
      /structural_state must be partial/
    )

    const candidateWithoutPage = asSqdBatch(validTranscript())
    const lane = firstLane(candidateWithoutPage)
    lane.query_state = 'failed'
    lane.completion_reason = 'invalid_response'
    lane.page_count = 0
    lane.page_chain_sha256 = null
    candidateWithoutPage.query_totals.exhausted_lane_count = 0
    candidateWithoutPage.query_totals.failed_lane_count = 1
    candidateWithoutPage.query_totals.page_count = 0
    candidateWithoutPage.structural_state = 'failed'
    const candidate = firstRow(candidateWithoutPage)
    candidate.candidate_identity_count = 1
    candidate.unique_in_window_candidate_count = 1
    candidate.evidence_rejected_count = 1
    candidate.first_candidate_height = 101
    candidate.last_candidate_height = 101
    candidateWithoutPage.candidate_totals.candidate_identity_count = 1
    candidateWithoutPage.candidate_totals.unique_in_window_candidate_count = 1
    candidateWithoutPage.candidate_totals.evidence_rejected_count = 1
    expect(() => parseDexAcquisitionTranscript(candidateWithoutPage, fixtureJson)).toThrow(
      /require a committed shared query page/
    )

    const unqueriedWalletCandidate = validTranscript()
    const walletLane = firstLane(unqueriedWalletCandidate)
    walletLane.query_state = 'not_attempted'
    walletLane.completion_reason = 'not_started'
    walletLane.attempt_count = 0
    walletLane.page_count = 0
    walletLane.page_chain_sha256 = null
    walletLane.checkpoint_sha256 = null
    unqueriedWalletCandidate.query_totals.exhausted_lane_count = 49
    unqueriedWalletCandidate.query_totals.not_attempted_lane_count = 1
    unqueriedWalletCandidate.query_totals.attempt_count = 49
    unqueriedWalletCandidate.query_totals.page_count = 49
    unqueriedWalletCandidate.structural_state = 'partial'
    const unqueriedResult = firstRow(unqueriedWalletCandidate)
    unqueriedResult.candidate_identity_count = 1
    unqueriedResult.unique_in_window_candidate_count = 1
    unqueriedResult.evidence_rejected_count = 1
    unqueriedResult.first_candidate_height = 101
    unqueriedResult.last_candidate_height = 101
    unqueriedWalletCandidate.candidate_totals.candidate_identity_count = 1
    unqueriedWalletCandidate.candidate_totals.unique_in_window_candidate_count = 1
    unqueriedWalletCandidate.candidate_totals.evidence_rejected_count = 1
    expect(() => parseDexAcquisitionTranscript(unqueriedWalletCandidate, fixtureJson)).toThrow(
      /matching query lane/
    )
  })

  it('does not turn execution failures into incomplete acquisition evidence', () => {
    const transcript = validTranscript()
    const row = firstRow(transcript)
    row.candidate_identity_count = 1
    row.unique_in_window_candidate_count = 1
    row.strict_membership_execution_failure_count = 1
    row.first_candidate_height = 103
    row.last_candidate_height = 103
    transcript.candidate_totals.candidate_identity_count = 1
    transcript.candidate_totals.unique_in_window_candidate_count = 1
    transcript.candidate_totals.strict_membership_execution_failure_count = 1
    recordTransactionEvidenceRequest(transcript)

    expect(parseDexAcquisitionTranscript(transcript, fixtureJson).structural_state).toBe(
      'structurally_complete'
    )

    const zeroEvidenceResponse = clone(transcript)
    zeroEvidenceResponse.telemetry.phases.transaction_evidence.response_wire_bytes = 0
    zeroEvidenceResponse.telemetry.phases.transaction_evidence.response_decoded_bytes = 0
    zeroEvidenceResponse.telemetry.response_wire_bytes -= 512
    zeroEvidenceResponse.telemetry.response_decoded_bytes -= 1024
    expect(() => parseDexAcquisitionTranscript(zeroEvidenceResponse, fixtureJson)).toThrow(
      /response-backed transaction evidence/
    )
  })

  it('requires cost and request telemetry to remain internally honest', () => {
    const free = validTranscript()
    free.telemetry.cost = {
      measurement_state: 'public_tier_zero_billed',
      currency: 'USD',
      billed_usd: '0',
      pricing_evidence_sha256: HASH.pricing,
    }
    expect(parseDexAcquisitionTranscript(free, fixtureJson).telemetry.cost.billed_usd).toBe('0')

    const unsupportedFree = clone(free)
    unsupportedFree.telemetry.cost.pricing_evidence_sha256 = null
    expect(() => parseDexAcquisitionTranscript(unsupportedFree, fixtureJson)).toThrow(
      /pricing evidence/
    )

    const inventedUnknownCost = validTranscript()
    inventedUnknownCost.telemetry.cost.billed_usd = '0'
    expect(() => parseDexAcquisitionTranscript(inventedUnknownCost, fixtureJson)).toThrow(
      /unknown cost/
    )

    const impossibleRequests = validTranscript()
    impossibleRequests.telemetry.phases.discovery.request_count = 49
    impossibleRequests.telemetry.request_count = 51
    expect(() => parseDexAcquisitionTranscript(impossibleRequests, fixtureJson)).toThrow(
      /discovery requests cannot be below/
    )

    const zeroRequestBatch = asSqdBatch(validTranscript())
    zeroRequestBatch.telemetry.request_count = 0
    zeroRequestBatch.telemetry.request_bytes = 0
    zeroRequestBatch.telemetry.response_wire_bytes = 0
    zeroRequestBatch.telemetry.response_decoded_bytes = 0
    expect(() => parseDexAcquisitionTranscript(zeroRequestBatch, fixtureJson)).toThrow(
      /telemetry total does not match phase counters/
    )

    const unattemptedWithDiscoveryCost = validTranscript()
    for (const lane of unattemptedWithDiscoveryCost.query_lanes) {
      lane.query_state = 'not_attempted'
      lane.completion_reason = 'not_started'
      lane.attempt_count = 0
      lane.page_count = 0
      lane.page_chain_sha256 = null
      lane.checkpoint_sha256 = null
    }
    unattemptedWithDiscoveryCost.query_totals = {
      lane_count: 50,
      exhausted_lane_count: 0,
      partial_lane_count: 0,
      failed_lane_count: 0,
      not_attempted_lane_count: 50,
      attempt_count: 0,
      page_count: 0,
    }
    unattemptedWithDiscoveryCost.structural_state = 'partial'
    expect(() => parseDexAcquisitionTranscript(unattemptedWithDiscoveryCost, fixtureJson)).toThrow(
      /unattempted discovery lanes/
    )
  })

  it('keeps all publication and population-denominator claims closed', () => {
    const populationClaim = validTranscript() as DexAcquisitionTranscript & {
      claims: DexAcquisitionTranscript['claims'] & { population_recall: number | null }
    }
    populationClaim.claims.population_recall = 0.95
    expect(() => parseDexAcquisitionTranscript(populationClaim, fixtureJson)).toThrow()

    const rankEligible = validTranscript() as DexAcquisitionTranscript & { rank_eligible: boolean }
    rankEligible.rank_eligible = true
    expect(() => parseDexAcquisitionTranscript(rankEligible, fixtureJson)).toThrow()

    const forgedVerification = validTranscript() as DexAcquisitionTranscript & {
      claims: DexAcquisitionTranscript['claims'] & { referenced_artifacts_verified: boolean }
    }
    forgedVerification.claims.referenced_artifacts_verified = true
    expect(() => parseDexAcquisitionTranscript(forgedVerification, fixtureJson)).toThrow()

    expect(parseDexAcquisitionTranscript(validTranscript(), fixtureJson).claims).toMatchObject({
      referenced_artifacts_verified: false,
      technical_run_complete: false,
      source_independence_verified: false,
    })
  })
})
