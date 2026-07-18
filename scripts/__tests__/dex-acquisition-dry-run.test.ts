import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

import {
  DEX_ACQUISITION_DRY_RUN_CONTRACT,
  DEX_ACQUISITION_DRY_RUN_EXIT_CODES,
  formatDexAcquisitionDryRunInternalError,
  runDexAcquisitionDryRun,
  runDexAcquisitionDryRunCli,
  type DexAcquisitionDryRunInput,
} from '../lib/dex-acquisition-dry-run'
import { inspectDexAcquisitionConsistentPair } from '../lib/dex-acquisition-binding'
import {
  makeDexAcquisitionPairFixture,
  makeDexPairParentFixture,
  recomputeDexPairQueryTotals,
  recomputeDexPairTelemetryTotals,
  type DexAcquisitionPairFixture,
  type DexPairVariant,
} from '../test-helpers/dex-acquisition-pair-fixture'
import type { DexGoldenSource } from '../lib/dex-golden-wallets'

const PARENT_PATH = 'evidence/parent.json'
const MANIFEST_PATH = 'evidence/manifest.json'
const TRANSCRIPT_PATH = 'evidence/transcript.json'
const PAIR_CASES = [
  ['binance_web3_bsc', 'direct'],
  ['binance_web3_bsc', 'sqd_wallet'],
  ['binance_web3_bsc', 'protocol_rpc'],
  ['binance_web3_bsc', 'protocol_sqd'],
  ['okx_web3_solana', 'direct'],
  ['okx_web3_solana', 'sqd_wallet'],
  ['okx_web3_solana', 'protocol_rpc'],
  ['okx_web3_solana', 'protocol_sqd'],
] as const satisfies ReadonlyArray<readonly [DexGoldenSource, DexPairVariant]>

type WrittenBundle = Readonly<{
  input: DexAcquisitionDryRunInput
  bytes: Readonly<{
    parent: Buffer
    manifest: Buffer
    transcript: Buffer
  }>
}>

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

describe('DEX local acquisition consistency dry-run', () => {
  let rootPath: string

  beforeEach(async () => {
    rootPath = await mkdtemp(join(tmpdir(), 'arena-dex-dry-run-'))
  })

  afterEach(async () => {
    await rm(rootPath, { recursive: true, force: true })
  })

  async function write(
    relativePath: string,
    value: unknown | string | Uint8Array
  ): Promise<Buffer> {
    const filePath = join(rootPath, relativePath)
    await mkdir(dirname(filePath), { recursive: true })
    const bytes =
      typeof value === 'string'
        ? Buffer.from(value, 'utf8')
        : value instanceof Uint8Array
          ? Buffer.from(value)
          : Buffer.from(`${JSON.stringify(value)}\n`, 'utf8')
    await writeFile(filePath, bytes)
    return bytes
  }

  async function writeBundle(
    source: DexGoldenSource = 'binance_web3_bsc',
    variant: DexPairVariant = 'direct',
    pair: DexAcquisitionPairFixture = makeDexAcquisitionPairFixture(source, variant),
    parent: unknown = makeDexPairParentFixture()
  ): Promise<WrittenBundle> {
    const parentBytes = await write(PARENT_PATH, parent)
    const manifestBytes = await write(MANIFEST_PATH, pair.manifest)
    const transcriptBytes = await write(TRANSCRIPT_PATH, pair.transcript)
    return {
      input: {
        rootPath,
        parentSnapshotPath: PARENT_PATH,
        runManifestPath: MANIFEST_PATH,
        transcriptPath: TRANSCRIPT_PATH,
      },
      bytes: {
        parent: parentBytes,
        manifest: manifestBytes,
        transcript: transcriptBytes,
      },
    }
  }

  function cliArgs(input: DexAcquisitionDryRunInput): string[] {
    return [
      '--root',
      input.rootPath,
      '--parent',
      input.parentSnapshotPath,
      '--manifest',
      input.runManifestPath,
      '--transcript',
      input.transcriptPath,
    ]
  }

  async function captureCli(args: unknown): Promise<{
    exitCode: number
    stdout: string
    parsed: unknown
  }> {
    let stdout = ''
    const exitCode = await runDexAcquisitionDryRunCli(args, {
      writeStdout: (line) => {
        stdout += line
      },
    })
    const parsed: unknown = JSON.parse(stdout)
    return {
      exitCode,
      stdout,
      parsed,
    }
  }

  async function runWrapper(args: readonly string[]): Promise<{
    exitCode: number | null
    stdout: string
    stderr: string
  }> {
    return new Promise((resolveRun, rejectRun) => {
      const child = spawn(
        resolve('node_modules/.bin/tsx'),
        [resolve('scripts/dex-acquisition-dry-run.mts'), ...args],
        {
          cwd: resolve('.'),
          stdio: ['ignore', 'pipe', 'pipe'],
        }
      )
      let stdout = ''
      let stderr = ''
      child.stdout.setEncoding('utf8')
      child.stderr.setEncoding('utf8')
      child.stdout.on('data', (chunk: string) => {
        stdout += chunk
      })
      child.stderr.on('data', (chunk: string) => {
        stderr += chunk
      })
      child.once('error', rejectRun)
      child.once('close', (exitCode) => {
        resolveRun({ exitCode, stdout, stderr })
      })
    })
  }

  async function runWrapperIntoClosedPipe(): Promise<{
    exitCode: number | null
    stdout: string
    stderr: string
  }> {
    return new Promise((resolveRun, rejectRun) => {
      const child = spawn(
        'bash',
        [
          '-o',
          'pipefail',
          '-c',
          'node_modules/.bin/tsx scripts/dex-acquisition-dry-run.mts | dd bs=1 count=0 2>/dev/null',
        ],
        {
          cwd: resolve('.'),
          stdio: ['ignore', 'pipe', 'pipe'],
        }
      )
      let stdout = ''
      let stderr = ''
      child.stdout.setEncoding('utf8')
      child.stderr.setEncoding('utf8')
      child.stdout.on('data', (chunk: string) => {
        stdout += chunk
      })
      child.stderr.on('data', (chunk: string) => {
        stderr += chunk
      })
      child.once('error', rejectRun)
      child.once('close', (exitCode) => {
        resolveRun({ exitCode, stdout, stderr })
      })
    })
  }

  async function runWrapperWithPreclosedStdout(): Promise<{
    exitCode: number | null
    stdout: string
    stderr: string
  }> {
    return new Promise((resolveRun, rejectRun) => {
      const child = spawn(
        'bash',
        ['-c', 'exec 1>&-; node_modules/.bin/tsx scripts/dex-acquisition-dry-run.mts'],
        {
          cwd: resolve('.'),
          stdio: ['ignore', 'pipe', 'pipe'],
        }
      )
      let stdout = ''
      let stderr = ''
      child.stdout.setEncoding('utf8')
      child.stderr.setEncoding('utf8')
      child.stdout.on('data', (chunk: string) => {
        stdout += chunk
      })
      child.stderr.on('data', (chunk: string) => {
        stderr += chunk
      })
      child.once('error', rejectRun)
      child.once('close', (exitCode) => {
        resolveRun({ exitCode, stdout, stderr })
      })
    })
  }

  it.each(PAIR_CASES)(
    'reports a valid %s %s pair as consistent but blocked and unverified',
    async (source, variant) => {
      const bundle = await writeBundle(source, variant)
      const result = await runDexAcquisitionDryRun(bundle.input)

      expect(result.exitCode).toBe(DEX_ACQUISITION_DRY_RUN_EXIT_CODES.CONSISTENT_UNVERIFIED_BLOCKED)
      expect(result.report).toMatchObject({
        schema_version: 1,
        data_contract: DEX_ACQUISITION_DRY_RUN_CONTRACT,
        operation: 'local_read_only_consistency_check',
        status: 'consistent_unverified',
        gate_state: 'blocked',
        exit_code: 2,
        stage: 'complete',
        root_trust: 'caller_containment_only',
        gate_scope: 'acquisition_evidence_pair_only',
        global_phase0_gate: 'not_evaluated',
        checks: {
          same_read_strict_documents: 'verified',
          parent_semantics: 'verified',
          manifest_semantics: 'verified',
          transcript_semantics: 'verified',
          manifest_transcript_consistency: 'verified',
          referenced_artifact_trust: 'not_evaluated',
        },
        authorization: {
          network_execution: false,
          artifact_persistence: false,
          serving: false,
          rank: false,
          score: false,
        },
        effects: {
          local_document_read_attempts: 3,
          network_request_attempts: 0,
          runtime_credential_lookup_attempts: 0,
          persistent_write_attempts: 0,
        },
        error: null,
      })
      expect(result.report.documents).toEqual({
        parent_snapshot: {
          declared_size_profile: 'golden_wallet_snapshot',
          raw_sha256: sha256(bundle.bytes.parent),
          byte_length: bundle.bytes.parent.byteLength,
        },
        run_manifest: {
          declared_size_profile: 'acquisition_run_manifest',
          raw_sha256: sha256(bundle.bytes.manifest),
          byte_length: bundle.bytes.manifest.byteLength,
        },
        transcript: {
          declared_size_profile: 'acquisition_transcript',
          raw_sha256: sha256(bundle.bytes.transcript),
          byte_length: bundle.bytes.transcript.byteLength,
        },
      })
      expect(result.report.execution_blockers).toEqual([
        'TRUSTED_ROOTS_NOT_PINNED',
        'OPERATOR_EXECUTION_AUTHORIZATION_NOT_MINTED',
        'ARTIFACT_PERSISTENCE_AUTHORIZATION_NOT_MINTED',
      ])
      expect(result.report.technical_readiness_blockers).toEqual(
        expect.arrayContaining([
          'GOLDEN_SNAPSHOT_NOT_TRUSTED',
          'ENDPOINT_REGISTRY_SCHEMA_UNAVAILABLE',
          'QUERY_TEMPLATE_SCHEMA_UNAVAILABLE',
          'ADAPTER_TOOLCHAIN_SCHEMA_UNAVAILABLE',
          'WINDOW_BOUNDARY_EVIDENCE_SCHEMA_UNAVAILABLE',
          'FINALITY_ANCHOR_SCHEMA_UNAVAILABLE',
          'GOLDEN_TRANSACTION_SET_NOT_VERIFIED',
          'RUNTIME_REVISION_NOT_VERIFIED',
        ])
      )
      expect(result.report.reference_eligibility_blockers).toEqual(
        expect.arrayContaining([
          'PAGE_LEDGER_NOT_VERIFIED',
          'CHECKPOINT_CHAIN_NOT_VERIFIED',
          'TRANSACTION_EVIDENCE_INDEX_NOT_VERIFIED',
          'WINDOW_BOUNDARY_ANCHOR_BINDING_UNDEFINED',
          'REFERENCED_ARTIFACTS_VERIFIED_FALSE',
          'TECHNICAL_RUN_COMPLETE_FALSE',
          'SOURCE_INDEPENDENCE_NOT_VERIFIED',
        ])
      )
      expect(Object.isFrozen(result.report)).toBe(true)
      expect(Object.isFrozen(result.report.checks)).toBe(true)
      expect(Object.isFrozen(result.report.documents)).toBe(true)
      expect(Object.isFrozen(result.report.plan)).toBe(true)
      expect(Object.isFrozen(result.report.execution_blockers)).toBe(true)
      expect(Object.isFrozen(result.report.authorization)).toBe(true)
      expect(() => inspectDexAcquisitionConsistentPair(result.report)).toThrow(/consistent/)

      expect(result.report.plan).toMatchObject({
        purpose: 'phase0_7d_technical_bakeoff_only',
        mode: 'shadow_only',
        technical_sample_scope: 'leaderboard_derived_stratified_50_wallets',
        wallet_count: 50,
        query_exhaustion_scope: 'provider_query_only',
        block_catalog_scope: 'bound_catalog_profile_internal_continuity_only',
        wallet_chain_history_complete: false,
        chain_population_complete: false,
        population_denominator_eligible: false,
        population_recall_measured: false,
        transcript_reference_eligible: false,
        source_independence_verified: false,
      })

      const protocolMode = variant === 'protocol_rpc' || variant === 'protocol_sqd'
      const sqdMode = variant === 'sqd_wallet' || variant === 'protocol_sqd'
      if (protocolMode) {
        const chainPrefix = source === 'binance_web3_bsc' ? 'BSC' : 'SOLANA'
        const oppositeChainPrefix = source === 'binance_web3_bsc' ? 'SOLANA' : 'BSC'
        expect(result.report.plan?.protocol_manifest_contract).toBe(
          source === 'binance_web3_bsc'
            ? 'arena.dex.bsc-protocol-manifest@1'
            : 'arena.dex.solana-protocol-manifest@1'
        )
        expect(result.report.technical_readiness_blockers).toEqual(
          expect.arrayContaining([
            `${chainPrefix}_PROTOCOL_MANIFEST_SCHEMA_UNAVAILABLE`,
            `${chainPrefix}_PROTOCOL_MANIFEST_NOT_VERIFIED`,
          ])
        )
        expect(result.report.reference_eligibility_blockers).toContain(
          'PROTOCOL_ARTIFACT_NOT_VERIFIED'
        )
        expect(result.report.technical_readiness_blockers).not.toContain(
          `${oppositeChainPrefix}_PROTOCOL_MANIFEST_SCHEMA_UNAVAILABLE`
        )
        expect(result.report.technical_readiness_blockers).not.toContain(
          `${oppositeChainPrefix}_PROTOCOL_MANIFEST_NOT_VERIFIED`
        )
      } else {
        expect(result.report.plan?.protocol_manifest_contract).toBeNull()
        expect(result.report.technical_readiness_blockers).not.toContain(
          'BSC_PROTOCOL_MANIFEST_NOT_VERIFIED'
        )
        expect(result.report.technical_readiness_blockers).not.toContain(
          'SOLANA_PROTOCOL_MANIFEST_NOT_VERIFIED'
        )
        expect(result.report.reference_eligibility_blockers).not.toContain(
          'PROTOCOL_ARTIFACT_NOT_VERIFIED'
        )
      }

      if (sqdMode) {
        expect(result.report.technical_readiness_blockers).toEqual(
          expect.arrayContaining([
            'SQD_7D_LIVE_SPIKE_NOT_VERIFIED',
            'SQD_ADAPTER_IMPLEMENTATION_NOT_VERIFIED',
          ])
        )
      } else {
        expect(result.report.technical_readiness_blockers).not.toContain(
          'SQD_7D_LIVE_SPIKE_NOT_VERIFIED'
        )
        expect(result.report.technical_readiness_blockers).not.toContain(
          'SQD_ADAPTER_IMPLEMENTATION_NOT_VERIFIED'
        )
      }

      if (source === 'okx_web3_solana') {
        expect(result.report.plan).toMatchObject({
          chain_id: 'solana:mainnet-beta',
        })
        expect(result.report.reference_eligibility_blockers).toEqual(
          expect.arrayContaining(['SOLANA_GAP_CLASSIFICATION_EVIDENCE_NOT_VERIFIED'])
        )
      } else {
        expect(result.report.plan).toMatchObject({
          chain_id: 'eip155:56',
        })
        expect(result.report.reference_eligibility_blockers).not.toContain(
          'SOLANA_GAP_CLASSIFICATION_EVIDENCE_NOT_VERIFIED'
        )
      }
    }
  )

  it.each(['partial', 'failed'] as const)(
    'keeps a consistent %s transcript unverified and blocked',
    async (structuralState) => {
      const pair = makeDexAcquisitionPairFixture('binance_web3_bsc', 'protocol_rpc')
      const lane = pair.transcript.query_lanes[0]
      pair.transcript.query_totals.exhausted_lane_count = 0
      if (structuralState === 'partial') {
        lane.query_state = 'partial'
        lane.completion_reason = 'request_cap_reached'
        pair.transcript.query_totals.partial_lane_count = 1
        pair.transcript.structural_state = 'partial'
      } else {
        lane.query_state = 'failed'
        lane.completion_reason = 'invalid_response'
        lane.page_count = 0
        lane.page_chain_sha256 = null
        pair.transcript.query_totals.failed_lane_count = 1
        pair.transcript.telemetry.phases.discovery.accepted_response_count = 0
        pair.transcript.telemetry.phases.discovery.response_wire_bytes = 0
        pair.transcript.telemetry.phases.discovery.response_decoded_bytes = 0
        pair.transcript.structural_state = 'failed'
      }
      recomputeDexPairQueryTotals(pair.transcript)
      recomputeDexPairTelemetryTotals(pair.transcript)
      const bundle = await writeBundle('binance_web3_bsc', 'protocol_rpc', pair)

      const result = await runDexAcquisitionDryRun(bundle.input)

      expect(result.exitCode).toBe(2)
      expect(result.report.status).toBe('consistent_unverified')
      expect(result.report.gate_state).toBe('blocked')
      expect(result.report.plan?.transcript_structural_state).toBe(structuralState)
      expect(result.report.reference_eligibility_blockers).toContain(
        'TRANSCRIPT_NOT_STRUCTURALLY_COMPLETE'
      )
      expect(Object.values(result.report.authorization)).toEqual([
        false,
        false,
        false,
        false,
        false,
      ])
    }
  )

  it('does not invent a Solana gap-evidence blocker when no skipped slot is recorded', async () => {
    const pair = makeDexAcquisitionPairFixture('okx_web3_solana', 'direct')
    pair.transcript.block_catalog.produced_unit_count = 7
    pair.transcript.block_catalog.verified_skipped_unit_count = 0
    pair.transcript.block_catalog.last_observed_height = 106
    pair.transcript.block_catalog.source_separated_gap_evidence_sha256 = null
    const bundle = await writeBundle('okx_web3_solana', 'direct', pair)

    const result = await runDexAcquisitionDryRun(bundle.input)

    expect(result.exitCode).toBe(2)
    expect(result.report.status).toBe('consistent_unverified')
    expect(result.report.reference_eligibility_blockers).not.toContain(
      'SOLANA_GAP_CLASSIFICATION_EVIDENCE_NOT_VERIFIED'
    )
  })

  it.each([
    ['parent_semantics', 'parent_snapshot'],
    ['manifest_semantics', 'run_manifest'],
    ['transcript_semantics', 'transcript'],
  ] as const)('sanitizes a %s rejection', async (stage, documentRole) => {
    const pair = makeDexAcquisitionPairFixture()
    const parent = makeDexPairParentFixture()
    const marker = `do-not-leak-${stage}`
    if (stage === 'parent_semantics') {
      Object.assign(parent as object, { purpose: marker })
    } else if (stage === 'manifest_semantics') {
      Object.assign(pair.manifest, { runner_git_sha: marker })
    } else {
      Object.assign(pair.transcript, { generator_git_sha: marker })
    }
    const bundle = await writeBundle('binance_web3_bsc', 'direct', pair, parent)

    const result = await runDexAcquisitionDryRun(bundle.input)
    const serialized = JSON.stringify(result.report)

    expect(result.exitCode).toBe(DEX_ACQUISITION_DRY_RUN_EXIT_CODES.EVIDENCE_REJECTED)
    expect(result.report).toMatchObject({
      status: 'rejected',
      gate_state: 'blocked',
      stage,
      documents: null,
      plan: null,
      execution_blockers: [
        'TRUSTED_ROOTS_NOT_PINNED',
        'OPERATOR_EXECUTION_AUTHORIZATION_NOT_MINTED',
        'ARTIFACT_PERSISTENCE_AUTHORIZATION_NOT_MINTED',
      ],
      technical_readiness_blockers: null,
      reference_eligibility_blockers: null,
      error: {
        code: 'DOCUMENT_SEMANTICS_REJECTED',
        document_role: documentRole,
      },
    })
    expect(serialized).not.toContain(marker)
    expect(serialized).not.toContain(rootPath)
    expect(serialized).not.toMatch(/Zod|stack|runner_git_sha|generator_git_sha/)
  })

  it('rejects individually valid but inconsistent manifest and transcript documents', async () => {
    const manifestPair = makeDexAcquisitionPairFixture('binance_web3_bsc', 'direct')
    const transcriptPair = makeDexAcquisitionPairFixture('binance_web3_bsc', 'sqd_wallet')
    await write(PARENT_PATH, makeDexPairParentFixture())
    await write(MANIFEST_PATH, manifestPair.manifest)
    await write(TRANSCRIPT_PATH, transcriptPair.transcript)

    const result = await runDexAcquisitionDryRun({
      rootPath,
      parentSnapshotPath: PARENT_PATH,
      runManifestPath: MANIFEST_PATH,
      transcriptPath: TRANSCRIPT_PATH,
    })

    expect(result.exitCode).toBe(65)
    expect(result.report).toMatchObject({
      status: 'rejected',
      stage: 'pair_consistency',
      checks: {
        same_read_strict_documents: 'verified',
        parent_semantics: 'verified',
        manifest_semantics: 'verified',
        transcript_semantics: 'verified',
        manifest_transcript_consistency: 'rejected',
        referenced_artifact_trust: 'not_evaluated',
      },
      documents: null,
      error: {
        code: 'PAIR_CONSISTENCY_REJECTED',
        document_role: null,
      },
    })
  })

  it.each([
    ['parent_document', 'parent_snapshot', PARENT_PATH],
    ['manifest_document', 'run_manifest', MANIFEST_PATH],
    ['transcript_document', 'transcript', TRANSCRIPT_PATH],
  ] as const)('sanitizes a strict %s read rejection', async (stage, role, rejectedPath) => {
    const bundle = await writeBundle()
    const marker = `strict-secret-${stage}`
    await write(rejectedPath, `{"marker":"${marker}","duplicate":1,"duplicate":2}`)

    const result = await runDexAcquisitionDryRun(bundle.input)
    const serialized = JSON.stringify(result.report)

    expect(result.exitCode).toBe(65)
    expect(result.report).toMatchObject({
      status: 'rejected',
      stage,
      documents: null,
      plan: null,
      error: {
        code: 'LOCAL_DOCUMENT_REJECTED',
        document_role: role,
      },
    })
    expect(serialized).not.toContain(marker)
    expect(serialized).not.toContain(rootPath)
    expect(serialized).not.toContain(rejectedPath)
    expect(serialized).not.toContain('duplicate')
  })

  it('rejects symlink and traversal paths without disclosing their targets', async () => {
    const bundle = await writeBundle()
    const outsideRoot = await mkdtemp(join(tmpdir(), 'arena-dex-dry-run-outside-'))
    const outsidePath = join(outsideRoot, 'outside-secret.json')
    await writeFile(outsidePath, JSON.stringify(makeDexPairParentFixture()))
    await symlink(outsidePath, join(rootPath, 'linked-parent.json'))
    try {
      for (const parentSnapshotPath of ['linked-parent.json', '../outside-secret.json']) {
        const result = await runDexAcquisitionDryRun({
          ...bundle.input,
          parentSnapshotPath,
        })
        const serialized = JSON.stringify(result.report)
        expect(result.exitCode).toBe(65)
        expect(result.report.stage).toBe('parent_document')
        expect(serialized).not.toContain(outsideRoot)
        expect(serialized).not.toContain(parentSnapshotPath)
        expect(serialized).not.toContain('outside-secret')
      }
    } finally {
      await rm(outsideRoot, { recursive: true, force: true })
    }
  })

  it.each([
    [],
    ['--root'],
    ['--root=secret'],
    ['--unknown', 'secret', '--parent', 'a.json', '--manifest', 'b.json', '--transcript', 'c.json'],
    [
      '--root',
      '/tmp/secret-root',
      '--root',
      '/tmp/second',
      '--manifest',
      'b.json',
      '--transcript',
      'c.json',
    ],
    [
      '--root',
      'relative-secret-root',
      '--parent',
      'a.json',
      '--manifest',
      'b.json',
      '--transcript',
      'c.json',
    ],
    [
      '--root',
      '/tmp/secret-root',
      '--parent',
      '',
      '--manifest',
      'b.json',
      '--transcript',
      'c.json',
    ],
    [
      '--root',
      '/tmp/secret-root',
      '--parent',
      'a.json',
      '--manifest',
      'a.json',
      '--transcript',
      'c.json',
    ],
    [
      '--root',
      '/tmp/secret-root',
      '--parent',
      `${'a'.repeat(4097)}.json`,
      '--manifest',
      'b.json',
      '--transcript',
      'c.json',
    ],
  ])('returns one fixed sanitized JSON line for invalid argv %#', async (...args) => {
    const result = await captureCli(args)

    expect(result.exitCode).toBe(DEX_ACQUISITION_DRY_RUN_EXIT_CODES.INVALID_ARGUMENTS)
    expect(result.stdout.endsWith('\n')).toBe(true)
    expect(result.stdout.slice(0, -1)).not.toContain('\n')
    expect(result.parsed).toMatchObject({
      status: 'rejected',
      gate_state: 'blocked',
      exit_code: 64,
      stage: 'arguments',
      documents: null,
      plan: null,
      error: {
        code: 'INVALID_ARGUMENTS',
        document_role: null,
      },
      effects: {
        local_document_read_attempts: 0,
        network_request_attempts: 0,
        runtime_credential_lookup_attempts: 0,
        persistent_write_attempts: 0,
      },
    })
    expect(result.stdout).not.toContain('secret')
    expect(result.stdout).not.toContain('/tmp/')
  })

  it('emits one deterministic JSON line for a valid CLI run without using fetch', async () => {
    const bundle = await writeBundle()
    const fetchSpy = jest.fn(() => {
      throw new Error('network must not be called')
    })
    const previousFetch = globalThis.fetch
    Object.defineProperty(globalThis, 'fetch', {
      configurable: true,
      value: fetchSpy,
    })
    try {
      const first = await captureCli(cliArgs(bundle.input))
      const second = await captureCli(cliArgs(bundle.input))

      expect(first.exitCode).toBe(2)
      expect(first.stdout).toBe(second.stdout)
      expect(first.stdout.endsWith('\n')).toBe(true)
      expect(first.stdout.slice(0, -1)).not.toContain('\n')
      expect(first.parsed).toMatchObject({
        data_contract: DEX_ACQUISITION_DRY_RUN_CONTRACT,
        status: 'consistent_unverified',
        gate_state: 'blocked',
        authorization: {
          network_execution: false,
          artifact_persistence: false,
          serving: false,
          rank: false,
          score: false,
        },
      })
      expect(fetchSpy).not.toHaveBeenCalled()
    } finally {
      if (previousFetch === undefined) {
        Reflect.deleteProperty(globalThis, 'fetch')
      } else {
        Object.defineProperty(globalThis, 'fetch', {
          configurable: true,
          value: previousFetch,
        })
      }
    }
  })

  it('runs the real wrapper with blocked and rejected nonzero process exits', async () => {
    const bundle = await writeBundle()
    const consistent = await runWrapper(cliArgs(bundle.input))

    expect(consistent.exitCode).toBe(2)
    expect(consistent.stderr).toBe('')
    expect(consistent.stdout.endsWith('\n')).toBe(true)
    expect(consistent.stdout.slice(0, -1)).not.toContain('\n')
    expect(JSON.parse(consistent.stdout)).toMatchObject({
      status: 'consistent_unverified',
      gate_state: 'blocked',
      exit_code: 2,
    })

    const marker = 'wrapper-secret-parent.json'
    const rejected = await runWrapper(cliArgs({ ...bundle.input, parentSnapshotPath: marker }))
    expect(rejected.exitCode).toBe(65)
    expect(rejected.stderr).toBe('')
    expect(rejected.stdout.endsWith('\n')).toBe(true)
    expect(rejected.stdout.slice(0, -1)).not.toContain('\n')
    expect(rejected.stdout).not.toContain(marker)
    expect(rejected.stdout).not.toContain(rootPath)
    expect(JSON.parse(rejected.stdout)).toMatchObject({
      status: 'rejected',
      gate_state: 'blocked',
      exit_code: 65,
      stage: 'parent_document',
      error: { code: 'LOCAL_DOCUMENT_REJECTED' },
    })
  })

  it('fails a closed stdout pipe without printing an EPIPE stack or local path', async () => {
    const result = await runWrapperIntoClosedPipe()

    expect(result.exitCode).toBe(70)
    expect(result.stdout).toBe('')
    expect(result.stderr).toBe('')
  })

  it('keeps exit 70 when stdout was closed before the wrapper started', async () => {
    const result = await runWrapperWithPreclosedStdout()

    expect(result.exitCode).toBe(70)
    expect(result.stdout).toBe('')
    expect(result.stderr).toBe('')
  })

  it('does not modify the local evidence tree', async () => {
    const bundle = await writeBundle()

    async function treeSnapshot(): Promise<string[]> {
      const files = (await readdir(join(rootPath, 'evidence'))).sort()
      return Promise.all(
        files.map(async (file) => {
          const bytes = await readFile(join(rootPath, 'evidence', file))
          return `${file}:${sha256(bytes)}`
        })
      )
    }

    const before = await treeSnapshot()
    const result = await runDexAcquisitionDryRun(bundle.input)
    const after = await treeSnapshot()

    expect(result.exitCode).toBe(2)
    expect(after).toEqual(before)
  })

  it('rejects hostile runtime inputs without invoking getters or leaking thrown values', async () => {
    const marker = 'hostile-input-secret'
    const getter = jest.fn(() => {
      throw new Error(marker)
    })
    const accessorInput = Object.defineProperties(
      {},
      {
        rootPath: { enumerable: true, get: getter },
        parentSnapshotPath: { enumerable: true, value: PARENT_PATH },
        runManifestPath: { enumerable: true, value: MANIFEST_PATH },
        transcriptPath: { enumerable: true, value: TRANSCRIPT_PATH },
      }
    )
    const proxyInput = new Proxy(
      {},
      {
        ownKeys: () => {
          throw new Error(marker)
        },
      }
    )
    const plainInput = {
      rootPath,
      parentSnapshotPath: PARENT_PATH,
      runManifestPath: MANIFEST_PATH,
      transcriptPath: TRANSCRIPT_PATH,
    }

    for (const input of [
      null,
      [],
      new Date(),
      { ...plainInput, extra: marker },
      { ...plainInput, [Symbol(marker)]: true },
      accessorInput,
      proxyInput,
    ]) {
      const result = await runDexAcquisitionDryRun(input)
      expect(result.exitCode).toBe(64)
      expect(JSON.stringify(result.report)).not.toContain(marker)
    }
    expect(getter).not.toHaveBeenCalled()
  })

  it('sanitizes a proxy-backed argv array that throws during parsing', async () => {
    const marker = 'argv-proxy-secret'
    const args = new Proxy<string[]>([], {
      get: () => {
        throw new Error(marker)
      },
    })

    const result = await captureCli(args)

    expect(result.exitCode).toBe(64)
    expect(result.stdout).not.toContain(marker)
    expect(result.parsed).toMatchObject({
      status: 'rejected',
      stage: 'arguments',
      error: { code: 'INVALID_ARGUMENTS' },
    })
  })

  it('provides the process wrapper with one fixed sanitized internal-error line', () => {
    const line = formatDexAcquisitionDryRunInternalError()
    const parsed: unknown = JSON.parse(line)

    expect(line.endsWith('\n')).toBe(true)
    expect(line.slice(0, -1)).not.toContain('\n')
    expect(parsed).toMatchObject({
      data_contract: DEX_ACQUISITION_DRY_RUN_CONTRACT,
      status: 'rejected',
      gate_state: 'blocked',
      exit_code: 70,
      stage: 'internal',
      execution_blockers: [
        'TRUSTED_ROOTS_NOT_PINNED',
        'OPERATOR_EXECUTION_AUTHORIZATION_NOT_MINTED',
        'ARTIFACT_PERSISTENCE_AUTHORIZATION_NOT_MINTED',
      ],
      technical_readiness_blockers: null,
      reference_eligibility_blockers: null,
      error: {
        code: 'INTERNAL_ERROR',
        document_role: null,
      },
    })
    expect(line).not.toMatch(/stack|cause|path|environment|process/)
  })

  it('keeps the new runtime surface free of env, network, database, subprocess, and write APIs', async () => {
    const libraryPath = resolve('scripts/lib/dex-acquisition-dry-run.ts')
    const wrapperPath = resolve('scripts/dex-acquisition-dry-run.mts')
    const [librarySource, wrapperSource, packageSource] = await Promise.all([
      readFile(libraryPath, 'utf8'),
      readFile(wrapperPath, 'utf8'),
      readFile(resolve('package.json'), 'utf8'),
    ])
    const combined = `${librarySource}\n${wrapperSource}`

    expect(librarySource).not.toMatch(
      /process\.env|dotenv|node:https?|node:net|child_process|worker_threads|supabase|clickhouse|fetch\s*\(/
    )
    expect(combined).not.toMatch(
      /writeFile|appendFile|truncate|rename|unlink|rmSync|mkdir|dynamic import|eval\s*\(|require\s*\(/
    )
    expect(wrapperSource).toContain('import.meta.url')
    expect(wrapperSource).toContain('runDexAcquisitionDryRunCli')
    expect(wrapperSource).toContain('formatDexAcquisitionDryRunInternalError')
    expect(packageSource).not.toContain('"qa:dex-acquisition-dry-run"')
  })
})
