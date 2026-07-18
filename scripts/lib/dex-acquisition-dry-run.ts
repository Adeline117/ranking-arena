import { isAbsolute } from 'node:path'
import { ZodError } from 'zod'

import {
  inspectDexAcquisitionConsistentPair,
  verifyDexAcquisitionManifestTranscriptConsistency,
  type DexAcquisitionConsistentPairInspection,
} from './dex-acquisition-binding'
import {
  parseDexAcquisitionRunManifest,
  type DexAcquisitionRunManifest,
} from './dex-acquisition-run-manifest'
import {
  parseDexAcquisitionTranscript,
  type DexAcquisitionTranscript,
} from './dex-acquisition-transcript'
import { parseDexGoldenWalletSnapshot, type DexGoldenWalletSnapshot } from './dex-golden-wallets'
import {
  inspectDexStrictJsonDocument,
  readDexStrictJsonDocument,
  DexStrictJsonDocumentError,
  type DexStrictJsonDocumentInspection,
  type DexStrictJsonSizeProfile,
} from './dex-strict-json-document'

export const DEX_ACQUISITION_DRY_RUN_SCHEMA_VERSION = 1 as const
export const DEX_ACQUISITION_DRY_RUN_CONTRACT =
  'arena.dex.acquisition-consistency-dry-run@1' as const

export const DEX_ACQUISITION_DRY_RUN_EXIT_CODES = Object.freeze({
  CONSISTENT_UNVERIFIED_BLOCKED: 2,
  INVALID_ARGUMENTS: 64,
  EVIDENCE_REJECTED: 65,
  INTERNAL_ERROR: 70,
} as const)

export const DEX_ACQUISITION_DRY_RUN_EXECUTION_BLOCKERS = Object.freeze([
  'TRUSTED_ROOTS_NOT_PINNED',
  'OPERATOR_EXECUTION_AUTHORIZATION_NOT_MINTED',
  'ARTIFACT_PERSISTENCE_AUTHORIZATION_NOT_MINTED',
] as const)

const BASE_TECHNICAL_READINESS_BLOCKERS = Object.freeze([
  'GOLDEN_SNAPSHOT_NOT_TRUSTED',
  'ENDPOINT_REGISTRY_SCHEMA_UNAVAILABLE',
  'ENDPOINT_REGISTRY_ARTIFACT_NOT_VERIFIED',
  'QUERY_TEMPLATE_SCHEMA_UNAVAILABLE',
  'QUERY_TEMPLATE_ARTIFACT_NOT_VERIFIED',
  'ADAPTER_TOOLCHAIN_SCHEMA_UNAVAILABLE',
  'ADAPTER_TOOLCHAIN_ARTIFACT_NOT_VERIFIED',
  'ADAPTER_IMPLEMENTATION_NOT_VERIFIED',
  'WINDOW_BOUNDARY_EVIDENCE_SCHEMA_UNAVAILABLE',
  'WINDOW_BOUNDARY_EVIDENCE_NOT_VERIFIED',
  'FINALITY_ANCHOR_SCHEMA_UNAVAILABLE',
  'FINALITY_ANCHOR_NOT_VERIFIED',
  'GOLDEN_TRANSACTION_SET_NOT_VERIFIED',
  'RUNTIME_REVISION_NOT_VERIFIED',
] as const)

const BASE_REFERENCE_ELIGIBILITY_BLOCKERS = Object.freeze([
  'PAGE_LEDGER_NOT_VERIFIED',
  'CHECKPOINT_CHAIN_NOT_VERIFIED',
  'TRANSACTION_EVIDENCE_INDEX_NOT_VERIFIED',
  'BLOCK_CATALOG_EVIDENCE_NOT_VERIFIED',
  'PRICING_OR_COST_EVIDENCE_NOT_VERIFIED',
  'WINDOW_BOUNDARY_ANCHOR_BINDING_UNDEFINED',
  'FINALITY_ANCHOR_TRANSCRIPT_BINDING_UNDEFINED',
  'REFERENCED_ARTIFACTS_VERIFIED_FALSE',
  'TECHNICAL_RUN_COMPLETE_FALSE',
  'SOURCE_INDEPENDENCE_NOT_VERIFIED',
] as const)

type DexAcquisitionDryRunExitCode =
  (typeof DEX_ACQUISITION_DRY_RUN_EXIT_CODES)[keyof typeof DEX_ACQUISITION_DRY_RUN_EXIT_CODES]

type DexAcquisitionDryRunStage =
  | 'arguments'
  | 'parent_document'
  | 'parent_semantics'
  | 'manifest_document'
  | 'manifest_semantics'
  | 'transcript_document'
  | 'transcript_semantics'
  | 'pair_consistency'
  | 'complete'
  | 'internal'

type DexAcquisitionDryRunCheckState = 'verified' | 'rejected' | 'not_evaluated'

type DexAcquisitionDryRunChecks = Readonly<{
  same_read_strict_documents: DexAcquisitionDryRunCheckState
  parent_semantics: DexAcquisitionDryRunCheckState
  manifest_semantics: DexAcquisitionDryRunCheckState
  transcript_semantics: DexAcquisitionDryRunCheckState
  manifest_transcript_consistency: DexAcquisitionDryRunCheckState
  referenced_artifact_trust: 'not_evaluated'
}>

type DexAcquisitionDryRunDocumentSummary = Readonly<{
  declared_size_profile: DexStrictJsonSizeProfile
  raw_sha256: string
  byte_length: number
}>

type DexAcquisitionDryRunDocuments = Readonly<{
  parent_snapshot: DexAcquisitionDryRunDocumentSummary
  run_manifest: DexAcquisitionDryRunDocumentSummary
  transcript: DexAcquisitionDryRunDocumentSummary
}>

type DexAcquisitionDryRunPlan = Readonly<{
  chain_id: 'eip155:56' | 'solana:mainnet-beta'
  source_slug: 'binance_web3_bsc' | 'okx_web3_solana'
  acquisition_mode: DexAcquisitionRunManifest['query_policy']['acquisition_mode']
  query_template_contract: DexAcquisitionRunManifest['query_policy']['query_template_contract']
  protocol_manifest_contract:
    | 'arena.dex.bsc-protocol-manifest@1'
    | 'arena.dex.solana-protocol-manifest@1'
    | null
  purpose: 'phase0_7d_technical_bakeoff_only'
  mode: 'shadow_only'
  technical_sample_scope: 'leaderboard_derived_stratified_50_wallets'
  wallet_count: 50
  query_exhaustion_scope: 'provider_query_only'
  block_catalog_scope: 'bound_catalog_profile_internal_continuity_only'
  wallet_chain_history_complete: false
  chain_population_complete: false
  population_denominator_eligible: false
  population_recall_measured: false
  transcript_reference_eligible: false
  source_independence_verified: false
  transcript_structural_state: DexAcquisitionTranscript['structural_state']
  lane_count: 1 | 50
  window_start_at: string
  window_end_at: string
  height_start_inclusive: number
  height_end_exclusive: number
}>

type DexAcquisitionDryRunAuthorization = Readonly<{
  network_execution: false
  artifact_persistence: false
  serving: false
  rank: false
  score: false
}>

type DexAcquisitionDryRunEffects = Readonly<{
  local_document_read_attempts: number
  network_request_attempts: 0
  runtime_credential_lookup_attempts: 0
  persistent_write_attempts: 0
}>

export type DexAcquisitionDryRunErrorCode =
  | 'INVALID_ARGUMENTS'
  | 'LOCAL_DOCUMENT_REJECTED'
  | 'DOCUMENT_SEMANTICS_REJECTED'
  | 'PAIR_CONSISTENCY_REJECTED'
  | 'INTERNAL_ERROR'

type DexAcquisitionDryRunError = Readonly<{
  code: DexAcquisitionDryRunErrorCode
  document_role: 'parent_snapshot' | 'run_manifest' | 'transcript' | null
}>

export type DexAcquisitionDryRunReport = Readonly<{
  schema_version: typeof DEX_ACQUISITION_DRY_RUN_SCHEMA_VERSION
  data_contract: typeof DEX_ACQUISITION_DRY_RUN_CONTRACT
  operation: 'local_read_only_consistency_check'
  status: 'consistent_unverified' | 'rejected'
  gate_state: 'blocked'
  gate_scope: 'acquisition_evidence_pair_only'
  global_phase0_gate: 'not_evaluated'
  exit_code: DexAcquisitionDryRunExitCode
  stage: DexAcquisitionDryRunStage
  root_trust: 'caller_containment_only'
  checks: DexAcquisitionDryRunChecks
  documents: DexAcquisitionDryRunDocuments | null
  plan: DexAcquisitionDryRunPlan | null
  execution_blockers: readonly string[]
  technical_readiness_blockers: readonly string[] | null
  reference_eligibility_blockers: readonly string[] | null
  authorization: DexAcquisitionDryRunAuthorization
  effects: DexAcquisitionDryRunEffects
  error: DexAcquisitionDryRunError | null
}>

export type DexAcquisitionDryRunResult = Readonly<{
  exitCode: DexAcquisitionDryRunExitCode
  report: DexAcquisitionDryRunReport
}>

export type DexAcquisitionDryRunInput = Readonly<{
  rootPath: string
  parentSnapshotPath: string
  runManifestPath: string
  transcriptPath: string
}>

export type DexAcquisitionDryRunCliIo = Readonly<{
  writeStdout: (line: string) => void
}>

const AUTHORIZATION: DexAcquisitionDryRunAuthorization = Object.freeze({
  network_execution: false,
  artifact_persistence: false,
  serving: false,
  rank: false,
  score: false,
})

type MutableChecks = {
  same_read_strict_documents: DexAcquisitionDryRunCheckState
  parent_semantics: DexAcquisitionDryRunCheckState
  manifest_semantics: DexAcquisitionDryRunCheckState
  transcript_semantics: DexAcquisitionDryRunCheckState
  manifest_transcript_consistency: DexAcquisitionDryRunCheckState
  referenced_artifact_trust: 'not_evaluated'
}

type UntrustedDryRunFields = {
  rootPath: unknown
  parentSnapshotPath: unknown
  runManifestPath: unknown
  transcriptPath: unknown
}

function initialChecks(): MutableChecks {
  return {
    same_read_strict_documents: 'not_evaluated',
    parent_semantics: 'not_evaluated',
    manifest_semantics: 'not_evaluated',
    transcript_semantics: 'not_evaluated',
    manifest_transcript_consistency: 'not_evaluated',
    referenced_artifact_trust: 'not_evaluated',
  }
}

function isExpectedSemanticRejection(error: unknown): boolean {
  return (
    error instanceof ZodError ||
    (error instanceof Error && Object.getPrototypeOf(error) === Error.prototype)
  )
}

function extractUntrustedFields(input: unknown): UntrustedDryRunFields | null {
  try {
    if (input === null || typeof input !== 'object' || Array.isArray(input)) return null
    const prototype = Object.getPrototypeOf(input)
    if (prototype !== Object.prototype && prototype !== null) return null

    const expectedKeys = [
      'rootPath',
      'parentSnapshotPath',
      'runManifestPath',
      'transcriptPath',
    ] as const
    const ownKeys = Reflect.ownKeys(input)
    if (
      ownKeys.length !== expectedKeys.length ||
      ownKeys.some(
        (key) => typeof key !== 'string' || !expectedKeys.some((expected) => expected === key)
      )
    ) {
      return null
    }

    const descriptors = expectedKeys.map((key) => Object.getOwnPropertyDescriptor(input, key))
    if (
      descriptors.some(
        (descriptor) => !descriptor || !descriptor.enumerable || !('value' in descriptor)
      )
    ) {
      return null
    }
    return {
      rootPath: descriptors[0]?.value,
      parentSnapshotPath: descriptors[1]?.value,
      runManifestPath: descriptors[2]?.value,
      transcriptPath: descriptors[3]?.value,
    }
  } catch {
    return null
  }
}

function validateInput(input: unknown): DexAcquisitionDryRunInput | null {
  const fields = extractUntrustedFields(input)
  if (fields === null) return null
  const { rootPath, parentSnapshotPath, runManifestPath, transcriptPath } = fields
  if (
    typeof rootPath !== 'string' ||
    !isAbsolute(rootPath) ||
    rootPath.length === 0 ||
    rootPath.length > 4096
  ) {
    return null
  }
  const paths = [parentSnapshotPath, runManifestPath, transcriptPath]
  if (
    paths.some((value) => typeof value !== 'string' || value.length === 0 || value.length > 4096)
  ) {
    return null
  }
  const typedPaths = paths as [string, string, string]
  if (new Set(typedPaths).size !== typedPaths.length) return null
  return {
    rootPath,
    parentSnapshotPath: typedPaths[0],
    runManifestPath: typedPaths[1],
    transcriptPath: typedPaths[2],
  }
}

function parseCliArguments(args: unknown): DexAcquisitionDryRunInput | null {
  try {
    if (
      !Array.isArray(args) ||
      args.length !== 8 ||
      args.some((value) => typeof value !== 'string')
    ) {
      return null
    }
    const values: Partial<
      Record<'rootPath' | 'parentSnapshotPath' | 'runManifestPath' | 'transcriptPath', string>
    > = {}
    const flags = {
      '--root': 'rootPath',
      '--parent': 'parentSnapshotPath',
      '--manifest': 'runManifestPath',
      '--transcript': 'transcriptPath',
    } as const
    for (let index = 0; index < args.length; index += 2) {
      const flag = args[index]
      const value = args[index + 1]
      const key =
        typeof flag === 'string' && Object.prototype.hasOwnProperty.call(flags, flag)
          ? flags[flag as keyof typeof flags]
          : undefined
      if (
        key === undefined ||
        typeof value !== 'string' ||
        value.length === 0 ||
        value.startsWith('--') ||
        values[key] !== undefined
      ) {
        return null
      }
      values[key] = value
    }
    return validateInput(values)
  } catch {
    return null
  }
}

function freezeChecks(checks: MutableChecks): DexAcquisitionDryRunChecks {
  return Object.freeze({ ...checks })
}

function effects(localDocumentReadAttempts: number): DexAcquisitionDryRunEffects {
  return Object.freeze({
    local_document_read_attempts: localDocumentReadAttempts,
    network_request_attempts: 0,
    runtime_credential_lookup_attempts: 0,
    persistent_write_attempts: 0,
  })
}

function rejectedResult(input: {
  exitCode: 64 | 65 | 70
  stage: Exclude<DexAcquisitionDryRunStage, 'complete'>
  checks: MutableChecks
  readAttempts: number
  code: DexAcquisitionDryRunErrorCode
  documentRole: DexAcquisitionDryRunError['document_role']
}): DexAcquisitionDryRunResult {
  const report: DexAcquisitionDryRunReport = Object.freeze({
    schema_version: DEX_ACQUISITION_DRY_RUN_SCHEMA_VERSION,
    data_contract: DEX_ACQUISITION_DRY_RUN_CONTRACT,
    operation: 'local_read_only_consistency_check',
    status: 'rejected',
    gate_state: 'blocked',
    gate_scope: 'acquisition_evidence_pair_only',
    global_phase0_gate: 'not_evaluated',
    exit_code: input.exitCode,
    stage: input.stage,
    root_trust: 'caller_containment_only',
    checks: freezeChecks(input.checks),
    documents: null,
    plan: null,
    execution_blockers: DEX_ACQUISITION_DRY_RUN_EXECUTION_BLOCKERS,
    technical_readiness_blockers: null,
    reference_eligibility_blockers: null,
    authorization: AUTHORIZATION,
    effects: effects(input.readAttempts),
    error: Object.freeze({
      code: input.code,
      document_role: input.documentRole,
    }),
  })
  return Object.freeze({ exitCode: input.exitCode, report })
}

function summarizeDocument(
  inspection: DexStrictJsonDocumentInspection
): DexAcquisitionDryRunDocumentSummary {
  return Object.freeze({
    declared_size_profile: inspection.declared_size_profile,
    raw_sha256: inspection.raw_sha256,
    byte_length: inspection.byte_length,
  })
}

function chainId(
  namespace: DexAcquisitionRunManifest['chain']['namespace']
): DexAcquisitionDryRunPlan['chain_id'] {
  return namespace === 'eip155' ? 'eip155:56' : 'solana:mainnet-beta'
}

function buildTechnicalBlockers(pair: DexAcquisitionConsistentPairInspection): readonly string[] {
  const blockers: string[] = [...BASE_TECHNICAL_READINESS_BLOCKERS]
  if (pair.manifest.protocol_manifest.state === 'bound') {
    blockers.push(
      pair.manifest.chain.namespace === 'eip155'
        ? 'BSC_PROTOCOL_MANIFEST_SCHEMA_UNAVAILABLE'
        : 'SOLANA_PROTOCOL_MANIFEST_SCHEMA_UNAVAILABLE',
      pair.manifest.chain.namespace === 'eip155'
        ? 'BSC_PROTOCOL_MANIFEST_NOT_VERIFIED'
        : 'SOLANA_PROTOCOL_MANIFEST_NOT_VERIFIED'
    )
  }
  if (
    pair.manifest.query_policy.acquisition_mode === 'sqd_finalized_stream_wallet_locator' ||
    pair.manifest.query_policy.acquisition_mode === 'manifest_protocol_event_sqd_finalized_stream'
  ) {
    blockers.push('SQD_7D_LIVE_SPIKE_NOT_VERIFIED', 'SQD_ADAPTER_IMPLEMENTATION_NOT_VERIFIED')
  }
  return Object.freeze(blockers)
}

function buildReferenceBlockers(pair: DexAcquisitionConsistentPairInspection): readonly string[] {
  const blockers: string[] = [...BASE_REFERENCE_ELIGIBILITY_BLOCKERS]
  if (pair.manifest.protocol_manifest.state === 'bound') {
    blockers.push('PROTOCOL_ARTIFACT_NOT_VERIFIED')
  }
  if (
    pair.manifest.chain.namespace === 'solana' &&
    (pair.transcript.block_catalog.verified_skipped_unit_count > 0 ||
      pair.transcript.block_catalog.source_separated_gap_evidence_sha256 !== null)
  ) {
    blockers.push('SOLANA_GAP_CLASSIFICATION_EVIDENCE_NOT_VERIFIED')
  }
  if (pair.transcript.structural_state !== 'structurally_complete') {
    blockers.push('TRANSCRIPT_NOT_STRUCTURALLY_COMPLETE')
  }
  return Object.freeze(blockers)
}

function consistentResult(input: {
  checks: MutableChecks
  parentDocument: DexStrictJsonDocumentInspection
  manifestDocument: DexStrictJsonDocumentInspection
  transcriptDocument: DexStrictJsonDocumentInspection
  pair: DexAcquisitionConsistentPairInspection
}): DexAcquisitionDryRunResult {
  const protocolManifestContract =
    input.pair.manifest.protocol_manifest.state === 'bound'
      ? input.pair.manifest.protocol_manifest.contract_id
      : null
  const report: DexAcquisitionDryRunReport = Object.freeze({
    schema_version: DEX_ACQUISITION_DRY_RUN_SCHEMA_VERSION,
    data_contract: DEX_ACQUISITION_DRY_RUN_CONTRACT,
    operation: 'local_read_only_consistency_check',
    status: 'consistent_unverified',
    gate_state: 'blocked',
    gate_scope: 'acquisition_evidence_pair_only',
    global_phase0_gate: 'not_evaluated',
    exit_code: DEX_ACQUISITION_DRY_RUN_EXIT_CODES.CONSISTENT_UNVERIFIED_BLOCKED,
    stage: 'complete',
    root_trust: 'caller_containment_only',
    checks: freezeChecks(input.checks),
    documents: Object.freeze({
      parent_snapshot: summarizeDocument(input.parentDocument),
      run_manifest: summarizeDocument(input.manifestDocument),
      transcript: summarizeDocument(input.transcriptDocument),
    }),
    plan: Object.freeze({
      chain_id: chainId(input.pair.manifest.chain.namespace),
      source_slug: input.pair.manifest.golden_sample.source_slug,
      acquisition_mode: input.pair.manifest.query_policy.acquisition_mode,
      query_template_contract: input.pair.manifest.query_policy.query_template_contract,
      protocol_manifest_contract: protocolManifestContract,
      purpose: input.pair.manifest.purpose,
      mode: input.pair.manifest.mode,
      technical_sample_scope: input.pair.transcript.claims.technical_sample_scope,
      wallet_count: input.pair.transcript.candidate_totals.wallet_count,
      query_exhaustion_scope: input.pair.transcript.claims.query_exhaustion_scope,
      block_catalog_scope: input.pair.transcript.claims.block_catalog_scope,
      wallet_chain_history_complete: input.pair.transcript.claims.wallet_chain_history_complete,
      chain_population_complete: input.pair.transcript.claims.chain_population_complete,
      population_denominator_eligible: input.pair.transcript.claims.population_denominator_eligible,
      population_recall_measured: input.pair.transcript.claims.population_recall_measured,
      transcript_reference_eligible: input.pair.manifest.claims.transcript_reference_eligible,
      source_independence_verified: input.pair.transcript.claims.source_independence_verified,
      transcript_structural_state: input.pair.transcript.structural_state,
      lane_count: input.pair.manifest.query_policy.lane_topology.lane_count,
      window_start_at: input.pair.manifest.window.start_at,
      window_end_at: input.pair.manifest.window.end_at,
      height_start_inclusive: input.pair.manifest.window.height_range.start_inclusive,
      height_end_exclusive: input.pair.manifest.window.height_range.end_exclusive,
    }),
    execution_blockers: DEX_ACQUISITION_DRY_RUN_EXECUTION_BLOCKERS,
    technical_readiness_blockers: buildTechnicalBlockers(input.pair),
    reference_eligibility_blockers: buildReferenceBlockers(input.pair),
    authorization: AUTHORIZATION,
    effects: effects(3),
    error: null,
  })
  return Object.freeze({
    exitCode: DEX_ACQUISITION_DRY_RUN_EXIT_CODES.CONSISTENT_UNVERIFIED_BLOCKED,
    report,
  })
}

async function readDocument(
  rootPath: string,
  relativePath: string,
  sizeProfile: DexStrictJsonSizeProfile
): Promise<DexStrictJsonDocumentInspection> {
  const document = await readDexStrictJsonDocument({ rootPath, relativePath, sizeProfile })
  return inspectDexStrictJsonDocument(document)
}

/**
 * Read exactly three caller-root-contained local documents and check their
 * strict JSON, individual semantics, and manifest/transcript consistency.
 *
 * A successful result is deliberately `consistent_unverified` while its
 * readiness gate remains blocked and its process exit remains nonzero. It
 * neither verifies provenance/referenced artifacts nor authorizes network
 * execution, persistence, serving, rank, or score. The caller root must be
 * code-owned and non-adversarial while read.
 */
export async function runDexAcquisitionDryRun(input: unknown): Promise<DexAcquisitionDryRunResult> {
  const checks = initialChecks()
  const validated = validateInput(input)
  if (validated === null) {
    return rejectedResult({
      exitCode: DEX_ACQUISITION_DRY_RUN_EXIT_CODES.INVALID_ARGUMENTS,
      stage: 'arguments',
      checks,
      readAttempts: 0,
      code: 'INVALID_ARGUMENTS',
      documentRole: null,
    })
  }

  let readAttempts = 0
  try {
    readAttempts += 1
    let parentDocument: DexStrictJsonDocumentInspection
    try {
      parentDocument = await readDocument(
        validated.rootPath,
        validated.parentSnapshotPath,
        'golden_wallet_snapshot'
      )
    } catch (error) {
      if (!(error instanceof DexStrictJsonDocumentError)) throw error
      checks.same_read_strict_documents = 'rejected'
      return rejectedResult({
        exitCode: DEX_ACQUISITION_DRY_RUN_EXIT_CODES.EVIDENCE_REJECTED,
        stage: 'parent_document',
        checks,
        readAttempts,
        code: 'LOCAL_DOCUMENT_REJECTED',
        documentRole: 'parent_snapshot',
      })
    }

    let parentSnapshot: DexGoldenWalletSnapshot
    try {
      parentSnapshot = parseDexGoldenWalletSnapshot(parentDocument.value)
      checks.parent_semantics = 'verified'
    } catch (error) {
      if (!isExpectedSemanticRejection(error)) throw error
      return rejectedResult({
        exitCode: DEX_ACQUISITION_DRY_RUN_EXIT_CODES.EVIDENCE_REJECTED,
        stage: 'parent_semantics',
        checks,
        readAttempts,
        code: 'DOCUMENT_SEMANTICS_REJECTED',
        documentRole: 'parent_snapshot',
      })
    }

    readAttempts += 1
    let manifestDocument: DexStrictJsonDocumentInspection
    try {
      manifestDocument = await readDocument(
        validated.rootPath,
        validated.runManifestPath,
        'acquisition_run_manifest'
      )
    } catch (error) {
      if (!(error instanceof DexStrictJsonDocumentError)) throw error
      checks.same_read_strict_documents = 'rejected'
      return rejectedResult({
        exitCode: DEX_ACQUISITION_DRY_RUN_EXIT_CODES.EVIDENCE_REJECTED,
        stage: 'manifest_document',
        checks,
        readAttempts,
        code: 'LOCAL_DOCUMENT_REJECTED',
        documentRole: 'run_manifest',
      })
    }

    let manifest: DexAcquisitionRunManifest
    try {
      manifest = parseDexAcquisitionRunManifest(manifestDocument.value, parentSnapshot)
      checks.manifest_semantics = 'verified'
    } catch (error) {
      if (!isExpectedSemanticRejection(error)) throw error
      return rejectedResult({
        exitCode: DEX_ACQUISITION_DRY_RUN_EXIT_CODES.EVIDENCE_REJECTED,
        stage: 'manifest_semantics',
        checks,
        readAttempts,
        code: 'DOCUMENT_SEMANTICS_REJECTED',
        documentRole: 'run_manifest',
      })
    }

    readAttempts += 1
    let transcriptDocument: DexStrictJsonDocumentInspection
    try {
      transcriptDocument = await readDocument(
        validated.rootPath,
        validated.transcriptPath,
        'acquisition_transcript'
      )
      checks.same_read_strict_documents = 'verified'
    } catch (error) {
      if (!(error instanceof DexStrictJsonDocumentError)) throw error
      checks.same_read_strict_documents = 'rejected'
      return rejectedResult({
        exitCode: DEX_ACQUISITION_DRY_RUN_EXIT_CODES.EVIDENCE_REJECTED,
        stage: 'transcript_document',
        checks,
        readAttempts,
        code: 'LOCAL_DOCUMENT_REJECTED',
        documentRole: 'transcript',
      })
    }

    let transcript: DexAcquisitionTranscript
    try {
      transcript = parseDexAcquisitionTranscript(transcriptDocument.value, parentSnapshot)
      checks.transcript_semantics = 'verified'
    } catch (error) {
      if (!isExpectedSemanticRejection(error)) throw error
      return rejectedResult({
        exitCode: DEX_ACQUISITION_DRY_RUN_EXIT_CODES.EVIDENCE_REJECTED,
        stage: 'transcript_semantics',
        checks,
        readAttempts,
        code: 'DOCUMENT_SEMANTICS_REJECTED',
        documentRole: 'transcript',
      })
    }

    let pair: DexAcquisitionConsistentPairInspection
    try {
      const pairToken = verifyDexAcquisitionManifestTranscriptConsistency({
        parentSnapshotInput: parentSnapshot,
        manifestInput: manifest,
        transcriptInput: transcript,
      })
      pair = inspectDexAcquisitionConsistentPair(pairToken)
      checks.manifest_transcript_consistency = 'verified'
    } catch (error) {
      if (!isExpectedSemanticRejection(error)) throw error
      checks.manifest_transcript_consistency = 'rejected'
      return rejectedResult({
        exitCode: DEX_ACQUISITION_DRY_RUN_EXIT_CODES.EVIDENCE_REJECTED,
        stage: 'pair_consistency',
        checks,
        readAttempts,
        code: 'PAIR_CONSISTENCY_REJECTED',
        documentRole: null,
      })
    }

    return consistentResult({
      checks,
      parentDocument,
      manifestDocument,
      transcriptDocument,
      pair,
    })
  } catch {
    return rejectedResult({
      exitCode: DEX_ACQUISITION_DRY_RUN_EXIT_CODES.INTERNAL_ERROR,
      stage: 'internal',
      checks,
      readAttempts,
      code: 'INTERNAL_ERROR',
      documentRole: null,
    })
  }
}

export async function runDexAcquisitionDryRunCli(
  args: unknown,
  io: DexAcquisitionDryRunCliIo
): Promise<DexAcquisitionDryRunExitCode> {
  const parsed = parseCliArguments(args)
  const result =
    parsed === null
      ? rejectedResult({
          exitCode: DEX_ACQUISITION_DRY_RUN_EXIT_CODES.INVALID_ARGUMENTS,
          stage: 'arguments',
          checks: initialChecks(),
          readAttempts: 0,
          code: 'INVALID_ARGUMENTS',
          documentRole: null,
        })
      : await runDexAcquisitionDryRun(parsed)
  io.writeStdout(`${JSON.stringify(result.report)}\n`)
  return result.exitCode
}

/**
 * Provide the thin process wrapper with one code-owned fallback line. No
 * caller input, error value, path, stack, environment value, or runtime
 * identifier is accepted by this formatter.
 */
export function formatDexAcquisitionDryRunInternalError(): string {
  const result = rejectedResult({
    exitCode: DEX_ACQUISITION_DRY_RUN_EXIT_CODES.INTERNAL_ERROR,
    stage: 'internal',
    checks: initialChecks(),
    readAttempts: 0,
    code: 'INTERNAL_ERROR',
    documentRole: null,
  })
  return `${JSON.stringify(result.report)}\n`
}
