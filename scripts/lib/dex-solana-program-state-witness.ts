import {
  captureSolanaV3ProgramDeploymentObservation,
  disposeSolanaV3ProgramDeploymentRawCapture,
  type SolanaV3ProgramDeploymentRawCapture,
} from '../../lib/ingest/onchain/solana-program-deployment-evidence'
import type { SolanaEvidenceRpcOpts } from '../../lib/ingest/onchain/solana-evidence-core'
import { parseStrictJson } from '../../lib/ingest/onchain/strict-json'
import {
  compileDexSolanaV3CurrentProgramStateEvidence,
  disposeDexSolanaV3ProgramStateCompilerInputBytes,
} from './dex-solana-program-deployment-metadata'
import {
  parseDexSolanaV3CurrentProgramStateEvidence,
  type DexSolanaV3CurrentProgramStateEvidence,
} from './dex-solana-v3-current-program-state-evidence'

export const DEX_SOLANA_PROGRAM_STATE_WITNESS_PROTOCOL_ID = 'jupiter_swap_v6' as const
export const DEX_SOLANA_PROGRAM_STATE_WITNESS_PROGRAM_ID =
  'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4' as const

export const DEX_SOLANA_PROGRAM_STATE_WITNESS_EXIT_CODES = Object.freeze({
  SUCCESS: 0,
  INVALID_ARGUMENTS: 64,
  WITNESS_REJECTED: 65,
  OUTPUT_UNAVAILABLE: 70,
} as const)

type WitnessExitCode =
  (typeof DEX_SOLANA_PROGRAM_STATE_WITNESS_EXIT_CODES)[keyof typeof DEX_SOLANA_PROGRAM_STATE_WITNESS_EXIT_CODES]

type WitnessEndpoint = Readonly<{
  endpointId: 'publicnode_solana_mainnet' | 'solana_official_mainnet'
  rpcUrl: string
}>

const WITNESS_ENDPOINTS: readonly [WitnessEndpoint, WitnessEndpoint] = Object.freeze([
  Object.freeze({
    endpointId: 'publicnode_solana_mainnet',
    rpcUrl: 'https://solana-rpc.publicnode.com/',
  }),
  Object.freeze({
    endpointId: 'solana_official_mainnet',
    rpcUrl: 'https://api.mainnet-beta.solana.com/',
  }),
])

const EXPECTED_AUTHORIZATION_KEYS = [
  'decoder_fixture',
  'network_execution',
  'rank',
  'raw_blob_persistence',
  'score',
  'serving',
] as const

export type DexSolanaProgramStateWitnessCliIo = Readonly<{
  writeStdout: (line: string) => void
  writeStderr: (line: string) => void
}>

export type DexSolanaProgramStateWitnessDependencies = Readonly<{
  now: () => Date
  capture: (
    programId: string,
    opts: SolanaEvidenceRpcOpts
  ) => Promise<SolanaV3ProgramDeploymentRawCapture>
  compile: typeof compileDexSolanaV3CurrentProgramStateEvidence
  parseEvidence: typeof parseDexSolanaV3CurrentProgramStateEvidence
  disposeCapture: (capture: SolanaV3ProgramDeploymentRawCapture) => void
  disposeCompilerInput: (input: unknown) => void
}>

const DEFAULT_DEPENDENCIES: DexSolanaProgramStateWitnessDependencies = Object.freeze({
  now: () => new Date(),
  capture: captureSolanaV3ProgramDeploymentObservation,
  compile: compileDexSolanaV3CurrentProgramStateEvidence,
  parseEvidence: parseDexSolanaV3CurrentProgramStateEvidence,
  disposeCapture: disposeSolanaV3ProgramDeploymentRawCapture,
  disposeCompilerInput: disposeDexSolanaV3ProgramStateCompilerInputBytes,
})

function validArguments(args: unknown): boolean {
  return (
    Array.isArray(args) &&
    args.length === 2 &&
    args[0] === '--protocol' &&
    args[1] === DEX_SOLANA_PROGRAM_STATE_WITNESS_PROTOCOL_ID
  )
}

function canonicalNow(dependencies: DexSolanaProgramStateWitnessDependencies): string {
  const now = dependencies.now()
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new TypeError('program-state witness clock did not return a valid date')
  }
  return now.toISOString()
}

function disposeCaptures(
  captures: readonly SolanaV3ProgramDeploymentRawCapture[],
  dependencies: DexSolanaProgramStateWitnessDependencies
): boolean {
  let succeeded = true
  for (const capture of captures) {
    try {
      dependencies.disposeCapture(capture)
    } catch {
      succeeded = false
    }
  }
  return succeeded
}

async function captureBothEndpoints(
  dependencies: DexSolanaProgramStateWitnessDependencies
): Promise<readonly [SolanaV3ProgramDeploymentRawCapture, SolanaV3ProgramDeploymentRawCapture]> {
  const settled = await Promise.allSettled(
    WITNESS_ENDPOINTS.map((endpoint) =>
      Promise.resolve().then(() =>
        dependencies.capture(DEX_SOLANA_PROGRAM_STATE_WITNESS_PROGRAM_ID, {
          endpointId: endpoint.endpointId,
          rpcUrl: endpoint.rpcUrl,
        })
      )
    )
  )
  const captures = settled
    .filter(
      (result): result is PromiseFulfilledResult<SolanaV3ProgramDeploymentRawCapture> =>
        result.status === 'fulfilled'
    )
    .map((result) => result.value)
  if (
    settled.some((result) => result.status === 'rejected') ||
    captures.length !== WITNESS_ENDPOINTS.length
  ) {
    disposeCaptures(captures, dependencies)
    throw new Error('both pinned Solana program-state sources are required')
  }
  return captures as [SolanaV3ProgramDeploymentRawCapture, SolanaV3ProgramDeploymentRawCapture]
}

function assertClosedAuthorization(evidence: DexSolanaV3CurrentProgramStateEvidence): void {
  const authorization = evidence.authorization
  const keys = Object.keys(authorization).sort()
  if (
    keys.length !== EXPECTED_AUTHORIZATION_KEYS.length ||
    keys.some((key, index) => key !== EXPECTED_AUTHORIZATION_KEYS[index]) ||
    EXPECTED_AUTHORIZATION_KEYS.some((key) => authorization[key] !== false)
  ) {
    throw new TypeError('program-state witness attempted to authorize a downstream capability')
  }
}

function normalizeEvidence(
  input: unknown,
  generatedAt: string,
  dependencies: DexSolanaProgramStateWitnessDependencies
): DexSolanaV3CurrentProgramStateEvidence {
  const evidence = dependencies.parseEvidence(input)
  if (
    evidence.generated_at !== generatedAt ||
    evidence.program_id !== DEX_SOLANA_PROGRAM_STATE_WITNESS_PROGRAM_ID ||
    evidence.captures.length !== WITNESS_ENDPOINTS.length ||
    evidence.captures.some(
      (capture, index) => capture.endpoint.endpoint_id !== WITNESS_ENDPOINTS[index].endpointId
    ) ||
    evidence.claims.raw_rpc_semantics_replayed_in_memory !== true ||
    evidence.claims.required_fixed_endpoint_set_matched !== true ||
    evidence.claims.current_state_projection_agreed !== true
  ) {
    throw new TypeError('program-state witness output conflicts with its fixed capture request')
  }
  assertClosedAuthorization(evidence)
  return evidence
}

function serializeEvidence(
  input: unknown,
  generatedAt: string,
  dependencies: DexSolanaProgramStateWitnessDependencies
): string {
  const evidence = normalizeEvidence(input, generatedAt, dependencies)
  const serialized = JSON.stringify(evidence)
  const reparsed = dependencies.parseEvidence(parseStrictJson(serialized))
  if (
    reparsed.evidence_closure_sha256 !== evidence.evidence_closure_sha256 ||
    reparsed.current_state_sha256 !== evidence.current_state_sha256
  ) {
    throw new TypeError('program-state witness serialization changed its evidence closure')
  }
  return `${serialized}\n`
}

export async function runDexSolanaProgramStateWitnessCli(
  args: unknown,
  io: DexSolanaProgramStateWitnessCliIo,
  dependencies: DexSolanaProgramStateWitnessDependencies = DEFAULT_DEPENDENCIES
): Promise<WitnessExitCode> {
  if (!validArguments(args)) {
    io.writeStderr('program_state_witness_invalid_arguments\n')
    return DEX_SOLANA_PROGRAM_STATE_WITNESS_EXIT_CODES.INVALID_ARGUMENTS
  }

  let captures:
    | readonly [SolanaV3ProgramDeploymentRawCapture, SolanaV3ProgramDeploymentRawCapture]
    | undefined
  try {
    captures = await captureBothEndpoints(dependencies)
    const generatedAt = canonicalNow(dependencies)
    const compilerInput = { generated_at: generatedAt, captures }
    const evidence = dependencies.compile(compilerInput)
    const line = serializeEvidence(evidence, generatedAt, dependencies)

    // The compiler owns and clears every raw body. Verify the destructive
    // cleanup again before any metadata reaches stdout.
    dependencies.disposeCompilerInput(compilerInput)
    if (!disposeCaptures(captures, dependencies)) {
      throw new TypeError('program-state witness raw captures could not all be cleared')
    }
    io.writeStdout(line)
    return DEX_SOLANA_PROGRAM_STATE_WITNESS_EXIT_CODES.SUCCESS
  } catch {
    io.writeStderr('program_state_witness_rejected\n')
    return DEX_SOLANA_PROGRAM_STATE_WITNESS_EXIT_CODES.WITNESS_REJECTED
  } finally {
    if (captures !== undefined) disposeCaptures(captures, dependencies)
  }
}
