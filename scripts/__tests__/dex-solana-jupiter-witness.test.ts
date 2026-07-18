import type { SolanaEvidenceRpcOpts } from '../../lib/ingest/onchain/solana-evidence'
import type { SolanaVerifiedTransactionFinalityRawCapture } from '../../lib/ingest/onchain/solana-transaction-evidence'
import type { DexSolanaGoldenProtocolCaseV2Bundle } from '../lib/dex-solana-golden-protocol-case-v2'
import type { DexSolanaGoldenRpcMetadataCaptureInput } from '../lib/dex-solana-golden-rpc-metadata'
import { dexSolanaProtocolManifestSha256 } from '../lib/dex-solana-protocol-manifest'
import {
  DEX_SOLANA_JUPITER_WITNESS_EXIT_CODES,
  DEX_SOLANA_JUPITER_WITNESS_MANIFEST_SHA256,
  DEX_SOLANA_JUPITER_WITNESS_PROGRAM_ID,
  DEX_SOLANA_JUPITER_WITNESS_PROTOCOL_ID,
  runDexSolanaJupiterWitnessCli,
  type DexSolanaJupiterWitnessDependencies,
} from '../lib/dex-solana-jupiter-witness'

const SIGNATURE =
  'j79Ffrrm3v5mD1WoM2fNrsRsefDFoFx9DTdZARp877uZqZ3RDrXQ35yNxKZ26SBGqDCj8n358Z9GztGRFxKDpef'
const HASH = '1'.repeat(64)

type EndpointId = 'publicnode_solana_mainnet' | 'solana_official_mainnet'

function authorization(overrides: Record<string, boolean> = {}) {
  return {
    network_execution: false,
    raw_blob_persistence: false,
    decoder_fixture: false,
    serving: false,
    rank: false,
    score: false,
    ...overrides,
  }
}

function safeBundle(): DexSolanaGoldenProtocolCaseV2Bundle {
  return {
    golden_rpc_evidence: {
      data_contract: 'arena.dex.golden-rpc-transaction-evidence@3',
      generated_at: '2026-07-18T13:00:00.000Z',
      verification_state: 'declared_not_replayed',
      transaction_id: SIGNATURE,
      stable_transaction_facts_contract: 'arena.dex.solana-stable-transaction-facts@1',
      stable_transaction_facts_sha256: HASH,
      required_blockers: ['decoder_facts_unverified'],
      chain: {
        namespace: 'solana',
        cluster: 'mainnet-beta',
        genesis_hash: '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',
        product_source_slug: 'okx_web3_solana',
        chain_stream_slug: 'solana_mainnet',
      },
      captures: [
        { endpoint: { endpoint_id: 'publicnode_solana_mainnet' } },
        { endpoint: { endpoint_id: 'solana_official_mainnet' } },
      ],
      authorization: authorization(),
    },
    golden_protocol_case: {
      data_contract: 'arena.dex.solana-golden-protocol-case@2',
      generated_at: '2026-07-18T13:00:00.000Z',
      case: {
        case_id: 'solana-jupiter-explicit-d5b0c3b259975a5cff7f86b5',
        selection_state: 'explicit_signature_unbound_to_golden_wallet',
      },
      chain: {
        namespace: 'solana',
        cluster: 'mainnet-beta',
        genesis_hash: '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',
        product_source_slug: 'okx_web3_solana',
        chain_stream_slug: 'solana_mainnet',
      },
      protocol_manifest: {
        protocol_id: DEX_SOLANA_JUPITER_WITNESS_PROTOCOL_ID,
        canonical_sha256: DEX_SOLANA_JUPITER_WITNESS_MANIFEST_SHA256,
        manifest_declared_program_id: DEX_SOLANA_JUPITER_WITNESS_PROGRAM_ID,
      },
      golden_rpc_evidence: {
        canonical_sha256: HASH,
        generated_at: '2026-07-18T13:00:00.000Z',
        verification_state: 'declared_not_replayed',
        transaction_id: SIGNATURE,
        stable_facts_contract: 'arena.dex.solana-stable-transaction-facts@1',
        stable_facts_sha256: HASH,
        source_evidence_blockers: ['decoder_facts_unverified'],
      },
      common_transaction_membership: {
        stable_transaction_facts_sha256: HASH,
      },
      common_program_hit_projection: { signature: SIGNATURE },
      source_derivations: [
        { golden_rpc_evidence_sha256: HASH },
        { golden_rpc_evidence_sha256: HASH },
      ],
      authorization: authorization(),
    },
  } as unknown as DexSolanaGoldenProtocolCaseV2Bundle
}

function endpointFromOpts(opts: SolanaEvidenceRpcOpts): EndpointId {
  if (
    opts.endpointId !== 'publicnode_solana_mainnet' &&
    opts.endpointId !== 'solana_official_mainnet'
  ) {
    throw new Error('unexpected endpoint')
  }
  return opts.endpointId
}

function anchorCapture(endpointId: EndpointId, rawBytes: Uint8Array) {
  return {
    evidence: { endpoint_id: endpointId },
    verified: { endpoint_id: endpointId },
    rawExchanges: [{ request: { bytes: rawBytes } }],
  } as unknown as DexSolanaGoldenRpcMetadataCaptureInput['anchor']
}

function transactionCapture(endpointId: EndpointId, rawBytes: Uint8Array) {
  return {
    evidence: { endpoint_id: endpointId },
    verified: { endpoint_id: endpointId },
    rawExchanges: [{ response: { bytes: rawBytes } }],
  } as unknown as SolanaVerifiedTransactionFinalityRawCapture
}

function zeroOwnedBytes(value: unknown, seen = new Set<object>()): void {
  if (value instanceof Uint8Array) {
    value.fill(0)
    return
  }
  if (typeof value !== 'object' || value === null || seen.has(value)) return
  seen.add(value)
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (descriptor && 'value' in descriptor) zeroOwnedBytes(descriptor.value, seen)
  }
}

function fixtureDependencies(overrides: Partial<DexSolanaJupiterWitnessDependencies> = {}) {
  const rawBytes: Uint8Array[] = []
  const captureAnchor = jest.fn(async (opts: SolanaEvidenceRpcOpts) => {
    const bytes = Uint8Array.of(1, 2, 3)
    rawBytes.push(bytes)
    return anchorCapture(endpointFromOpts(opts), bytes)
  })
  const captureTransaction = jest.fn(
    async (_signature: string, anchorEvidence: unknown, opts: SolanaEvidenceRpcOpts) => {
      expect(anchorEvidence).toEqual({ endpoint_id: endpointFromOpts(opts) })
      const bytes = Uint8Array.of(4, 5, 6)
      rawBytes.push(bytes)
      return transactionCapture(endpointFromOpts(opts), bytes)
    }
  )
  const buildBundle = jest.fn(() => safeBundle())
  const parseRpcEvidence = jest.fn(
    (value: unknown) => value as DexSolanaGoldenProtocolCaseV2Bundle['golden_rpc_evidence']
  )
  const parseProtocolCase = jest.fn(
    (value: unknown) => value as DexSolanaGoldenProtocolCaseV2Bundle['golden_protocol_case']
  )
  const rpcEvidenceSha256 = jest.fn(() => HASH)
  const disposeBytes = jest.fn((value: unknown) => zeroOwnedBytes(value))
  const dependencies: DexSolanaJupiterWitnessDependencies = {
    now: () => new Date('2026-07-18T13:00:00.000Z'),
    captureAnchor,
    captureTransaction,
    buildBundle,
    parseRpcEvidence,
    parseProtocolCase,
    rpcEvidenceSha256,
    disposeBytes,
    ...overrides,
  }
  return {
    dependencies,
    captureAnchor,
    captureTransaction,
    buildBundle,
    parseRpcEvidence,
    parseProtocolCase,
    rpcEvidenceSha256,
    disposeBytes,
    rawBytes,
  }
}

function fixtureIo() {
  const stdout: string[] = []
  const stderr: string[] = []
  return {
    stdout,
    stderr,
    io: {
      writeStdout: (line: string) => stdout.push(line),
      writeStderr: (line: string) => stderr.push(line),
    },
  }
}

describe('explicit-signature Solana Jupiter witness CLI', () => {
  it('captures only the two pinned endpoints and emits one metadata-only closed bundle', async () => {
    const fixture = fixtureDependencies()
    const output = fixtureIo()
    output.io.writeStdout = (line: string) => {
      expect(fixture.rawBytes).toHaveLength(4)
      expect(fixture.rawBytes.every((bytes) => bytes.every((byte) => byte === 0))).toBe(true)
      output.stdout.push(line)
    }

    const exitCode = await runDexSolanaJupiterWitnessCli(
      ['--signature', SIGNATURE],
      output.io,
      fixture.dependencies
    )

    expect(exitCode).toBe(DEX_SOLANA_JUPITER_WITNESS_EXIT_CODES.SUCCESS)
    expect(output.stderr).toEqual([])
    expect(output.stdout).toHaveLength(1)
    expect(output.stdout[0].endsWith('\n')).toBe(true)
    expect(output.stdout[0]).not.toMatch(/https?:\/\//)
    expect(output.stdout[0]).not.toMatch(/"(?:body|bytes|headers|url|blob_locator)"/)
    expect(JSON.parse(output.stdout[0])).toEqual(safeBundle())

    expect(fixture.captureAnchor.mock.calls.map(([opts]) => opts)).toEqual([
      {
        endpointId: 'publicnode_solana_mainnet',
        rpcUrl: 'https://solana-rpc.publicnode.com',
      },
      {
        endpointId: 'solana_official_mainnet',
        rpcUrl: 'https://api.mainnet-beta.solana.com',
      },
    ])
    expect(fixture.captureTransaction).toHaveBeenCalledTimes(2)
    expect(fixture.buildBundle).toHaveBeenCalledTimes(1)
    expect(fixture.parseRpcEvidence).toHaveBeenCalledTimes(1)
    expect(fixture.parseProtocolCase).toHaveBeenCalledTimes(1)
    expect(fixture.rpcEvidenceSha256).toHaveBeenCalledTimes(1)
    const buildInput = fixture.buildBundle.mock.calls[0][0]
    expect(buildInput).toMatchObject({
      generated_at: '2026-07-18T13:00:00.000Z',
      case_id: expect.stringMatching(/^solana-jupiter-explicit-[0-9a-f]{24}$/),
      protocol_id: DEX_SOLANA_JUPITER_WITNESS_PROTOCOL_ID,
      manifest_input: {
        data_contract: 'arena.dex.solana-protocol-manifest@1',
      },
      metadata_input: {
        generated_at: '2026-07-18T13:00:00.000Z',
      },
    })
    expect(dexSolanaProtocolManifestSha256(buildInput.manifest_input)).toBe(
      '10e000a4b625c90da571374bdc3567e86ac01a632d1a7803da69018677d77f9a'
    )
    expect(
      buildInput.metadata_input.captures.map(
        (capture) => (capture.anchor.evidence as { endpoint_id: EndpointId }).endpoint_id
      )
    ).toEqual(['publicnode_solana_mainnet', 'solana_official_mainnet'])
    expect(fixture.rawBytes).toHaveLength(4)
    expect(fixture.rawBytes.every((bytes) => bytes.every((byte) => byte === 0))).toBe(true)
  })

  it('keeps canonical provider input order when the official source completes first', async () => {
    let releasePublicNode:
      | ((value: DexSolanaGoldenRpcMetadataCaptureInput['anchor']) => void)
      | undefined
    const publicNodeAnchor = new Promise<DexSolanaGoldenRpcMetadataCaptureInput['anchor']>(
      (resolve) => {
        releasePublicNode = resolve
      }
    )
    const publicBytes = Uint8Array.of(7)
    const fixture = fixtureDependencies({
      captureAnchor: jest.fn(async (opts) => {
        const endpointId = endpointFromOpts(opts)
        if (endpointId === 'publicnode_solana_mainnet') return publicNodeAnchor
        return anchorCapture(endpointId, Uint8Array.of(8))
      }),
    })
    const output = fixtureIo()
    const running = runDexSolanaJupiterWitnessCli(
      ['--signature', SIGNATURE],
      output.io,
      fixture.dependencies
    )

    await Promise.resolve()
    releasePublicNode?.(anchorCapture('publicnode_solana_mainnet', publicBytes))
    expect(await running).toBe(DEX_SOLANA_JUPITER_WITNESS_EXIT_CODES.SUCCESS)
    expect(
      fixture.buildBundle.mock.calls[0][0].metadata_input.captures.map(
        (capture) => (capture.anchor.evidence as { endpoint_id: EndpointId }).endpoint_id
      )
    ).toEqual(['publicnode_solana_mainnet', 'solana_official_mainnet'])
    expect(publicBytes.every((byte) => byte === 0)).toBe(true)
  })

  it.each([
    [[]],
    [['--signature']],
    [['--signature', 'not-a-signature']],
    [['--signature', SIGNATURE, '--extra']],
    [['--transaction', SIGNATURE]],
  ])('rejects invalid arguments before any network attempt: %p', async (args) => {
    const fixture = fixtureDependencies()
    const output = fixtureIo()

    const exitCode = await runDexSolanaJupiterWitnessCli(args, output.io, fixture.dependencies)

    expect(exitCode).toBe(DEX_SOLANA_JUPITER_WITNESS_EXIT_CODES.INVALID_ARGUMENTS)
    expect(output.stdout).toEqual([])
    expect(output.stderr).toEqual(['jupiter_witness_invalid_arguments\n'])
    expect(fixture.captureAnchor).not.toHaveBeenCalled()
    expect(fixture.captureTransaction).not.toHaveBeenCalled()
    expect(fixture.buildBundle).not.toHaveBeenCalled()
  })

  it('waits for both sources and zeroes every partial capture when one transaction fails', async () => {
    const rawBytes: Uint8Array[] = []
    const fixture = fixtureDependencies({
      captureAnchor: jest.fn(async (opts) => {
        const bytes = Uint8Array.of(9, 10)
        rawBytes.push(bytes)
        return anchorCapture(endpointFromOpts(opts), bytes)
      }),
      captureTransaction: jest.fn(async (_signature, _anchor, opts) => {
        const endpointId = endpointFromOpts(opts)
        if (endpointId === 'solana_official_mainnet') {
          throw new Error(`private failure from ${opts.rpcUrl}`)
        }
        const bytes = Uint8Array.of(11, 12)
        rawBytes.push(bytes)
        return transactionCapture(endpointId, bytes)
      }),
    })
    const output = fixtureIo()

    const exitCode = await runDexSolanaJupiterWitnessCli(
      ['--signature', SIGNATURE],
      output.io,
      fixture.dependencies
    )

    expect(exitCode).toBe(DEX_SOLANA_JUPITER_WITNESS_EXIT_CODES.WITNESS_REJECTED)
    expect(output.stdout).toEqual([])
    expect(output.stderr).toEqual(['jupiter_witness_rejected\n'])
    expect(fixture.buildBundle).not.toHaveBeenCalled()
    expect(rawBytes).toHaveLength(3)
    expect(rawBytes.every((bytes) => bytes.every((byte) => byte === 0))).toBe(true)
    expect(JSON.stringify(output)).not.toContain('private failure')
    expect(JSON.stringify(output)).not.toContain('solana-rpc')
  })

  it('zeroes both complete captures and emits no half document when the hit compiler rejects', async () => {
    const fixture = fixtureDependencies({
      buildBundle: jest.fn(() => {
        throw new Error('not a Jupiter transaction')
      }),
    })
    const output = fixtureIo()

    const exitCode = await runDexSolanaJupiterWitnessCli(
      ['--signature', SIGNATURE],
      output.io,
      fixture.dependencies
    )

    expect(exitCode).toBe(DEX_SOLANA_JUPITER_WITNESS_EXIT_CODES.WITNESS_REJECTED)
    expect(output.stdout).toEqual([])
    expect(output.stderr).toEqual(['jupiter_witness_rejected\n'])
    expect(fixture.rawBytes.every((bytes) => bytes.every((byte) => byte === 0))).toBe(true)
  })

  it('rejects transport fields before stdout even if a trusted local builder regresses', async () => {
    const unsafe = safeBundle() as unknown as Record<string, unknown>
    unsafe.leak = { url: 'https://private.invalid/?api-key=secret' }
    const fixture = fixtureDependencies({
      buildBundle: jest.fn(() => unsafe as unknown as DexSolanaGoldenProtocolCaseV2Bundle),
    })
    const output = fixtureIo()

    const exitCode = await runDexSolanaJupiterWitnessCli(
      ['--signature', SIGNATURE],
      output.io,
      fixture.dependencies
    )

    expect(exitCode).toBe(DEX_SOLANA_JUPITER_WITNESS_EXIT_CODES.WITNESS_REJECTED)
    expect(output.stdout).toEqual([])
    expect(output.stderr).toEqual(['jupiter_witness_rejected\n'])
  })

  it('rejects an own toJSON serializer before it can replace the inspected bundle', async () => {
    const unsafe = safeBundle() as unknown as DexSolanaGoldenProtocolCaseV2Bundle & {
      toJSON: () => unknown
    }
    unsafe.toJSON = () => ({ leak: { url: 'https://secret.invalid/key' } })
    const fixture = fixtureDependencies({
      buildBundle: jest.fn(() => unsafe),
    })
    const output = fixtureIo()

    const exitCode = await runDexSolanaJupiterWitnessCli(
      ['--signature', SIGNATURE],
      output.io,
      fixture.dependencies
    )

    expect(exitCode).toBe(DEX_SOLANA_JUPITER_WITNESS_EXIT_CODES.WITNESS_REJECTED)
    expect(output.stdout).toEqual([])
    expect(output.stderr).toEqual(['jupiter_witness_rejected\n'])
    expect(fixture.parseRpcEvidence).not.toHaveBeenCalled()
    expect(fixture.parseProtocolCase).not.toHaveBeenCalled()
  })

  it('rejects a shape regression when either strict output parser fails', async () => {
    const fixture = fixtureDependencies({
      parseRpcEvidence: jest.fn(() => {
        throw new TypeError('strict RPC evidence rejection')
      }),
    })
    const output = fixtureIo()

    const exitCode = await runDexSolanaJupiterWitnessCli(
      ['--signature', SIGNATURE],
      output.io,
      fixture.dependencies
    )

    expect(exitCode).toBe(DEX_SOLANA_JUPITER_WITNESS_EXIT_CODES.WITNESS_REJECTED)
    expect(output.stdout).toEqual([])
    expect(output.stderr).toEqual(['jupiter_witness_rejected\n'])
    expect(fixture.parseProtocolCase).not.toHaveBeenCalled()
  })

  it('rejects two individually valid documents when their transaction bindings differ', async () => {
    const mismatched = safeBundle() as unknown as {
      golden_protocol_case: {
        golden_rpc_evidence: { transaction_id: string }
      }
    }
    mismatched.golden_protocol_case.golden_rpc_evidence.transaction_id = '2'.repeat(
      SIGNATURE.length
    )
    const fixture = fixtureDependencies({
      buildBundle: jest.fn(() => mismatched as unknown as DexSolanaGoldenProtocolCaseV2Bundle),
    })
    const output = fixtureIo()

    const exitCode = await runDexSolanaJupiterWitnessCli(
      ['--signature', SIGNATURE],
      output.io,
      fixture.dependencies
    )

    expect(exitCode).toBe(DEX_SOLANA_JUPITER_WITNESS_EXIT_CODES.WITNESS_REJECTED)
    expect(output.stdout).toEqual([])
    expect(output.stderr).toEqual(['jupiter_witness_rejected\n'])
  })

  it('rejects a closed bundle for a different caller case id', async () => {
    const mismatched = safeBundle() as unknown as {
      golden_protocol_case: { case: { case_id: string } }
    }
    mismatched.golden_protocol_case.case.case_id = 'solana-jupiter-explicit-other'
    const fixture = fixtureDependencies({
      buildBundle: jest.fn(() => mismatched as unknown as DexSolanaGoldenProtocolCaseV2Bundle),
    })
    const output = fixtureIo()

    const exitCode = await runDexSolanaJupiterWitnessCli(
      ['--signature', SIGNATURE],
      output.io,
      fixture.dependencies
    )

    expect(exitCode).toBe(DEX_SOLANA_JUPITER_WITNESS_EXIT_CODES.WITNESS_REJECTED)
    expect(output.stdout).toEqual([])
    expect(output.stderr).toEqual(['jupiter_witness_rejected\n'])
  })

  it('rejects any downstream authorization before stdout', async () => {
    const unsafe = safeBundle() as unknown as {
      golden_rpc_evidence: { authorization: Record<string, boolean> }
    }
    unsafe.golden_rpc_evidence.authorization.network_execution = true
    const fixture = fixtureDependencies({
      buildBundle: jest.fn(() => unsafe as unknown as DexSolanaGoldenProtocolCaseV2Bundle),
    })
    const output = fixtureIo()

    const exitCode = await runDexSolanaJupiterWitnessCli(
      ['--signature', SIGNATURE],
      output.io,
      fixture.dependencies
    )

    expect(exitCode).toBe(DEX_SOLANA_JUPITER_WITNESS_EXIT_CODES.WITNESS_REJECTED)
    expect(output.stdout).toEqual([])
    expect(output.stderr).toEqual(['jupiter_witness_rejected\n'])
  })

  it('rejects a missing authorization field before stdout', async () => {
    const unsafe = safeBundle() as unknown as {
      golden_protocol_case: { authorization: Record<string, boolean> }
    }
    delete unsafe.golden_protocol_case.authorization.score
    const fixture = fixtureDependencies({
      buildBundle: jest.fn(() => unsafe as unknown as DexSolanaGoldenProtocolCaseV2Bundle),
    })
    const output = fixtureIo()

    const exitCode = await runDexSolanaJupiterWitnessCli(
      ['--signature', SIGNATURE],
      output.io,
      fixture.dependencies
    )

    expect(exitCode).toBe(DEX_SOLANA_JUPITER_WITNESS_EXIT_CODES.WITNESS_REJECTED)
    expect(output.stdout).toEqual([])
    expect(output.stderr).toEqual(['jupiter_witness_rejected\n'])
  })
})
