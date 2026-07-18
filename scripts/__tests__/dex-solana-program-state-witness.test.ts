import type { SolanaV3ProgramDeploymentRawCapture } from '../../lib/ingest/onchain/solana-program-deployment-evidence'
import type { SolanaEvidenceRpcOpts } from '../../lib/ingest/onchain/solana-evidence-core'
import type { DexSolanaV3CurrentProgramStateEvidence } from '../lib/dex-solana-v3-current-program-state-evidence'
import {
  DEX_SOLANA_PROGRAM_STATE_WITNESS_EXIT_CODES,
  DEX_SOLANA_PROGRAM_STATE_WITNESS_PROGRAM_ID,
  DEX_SOLANA_PROGRAM_STATE_WITNESS_PROTOCOL_ID,
  runDexSolanaProgramStateWitnessCli,
  type DexSolanaProgramStateWitnessDependencies,
} from '../lib/dex-solana-program-state-witness'

const GENERATED_AT = '2026-07-18T23:35:10.484Z'
const HASH = '1'.repeat(64)

type EndpointId = 'publicnode_solana_mainnet' | 'solana_official_mainnet'

function safeEvidence(): DexSolanaV3CurrentProgramStateEvidence {
  const evidence = {} as DexSolanaV3CurrentProgramStateEvidence
  Object.assign(evidence, {
    generated_at: GENERATED_AT,
    program_id: DEX_SOLANA_PROGRAM_STATE_WITNESS_PROGRAM_ID,
    current_state_sha256: HASH,
    evidence_closure_sha256: HASH,
    captures: [
      { endpoint: { endpoint_id: 'publicnode_solana_mainnet' } },
      { endpoint: { endpoint_id: 'solana_official_mainnet' } },
    ],
    claims: {
      raw_rpc_semantics_replayed_in_memory: true,
      required_fixed_endpoint_set_matched: true,
      current_state_projection_agreed: true,
    },
    authorization: {
      network_execution: false,
      raw_blob_persistence: false,
      decoder_fixture: false,
      serving: false,
      rank: false,
      score: false,
    },
  })
  return evidence
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

function rawCapture(endpointId: EndpointId, bytes: Uint8Array) {
  const capture = {} as SolanaV3ProgramDeploymentRawCapture & {
    endpointId: EndpointId
    raw: { bytes: Uint8Array }
  }
  capture.endpointId = endpointId
  capture.raw = { bytes }
  return capture
}

function zeroBytes(value: unknown, seen = new Set<object>()): void {
  if (value instanceof Uint8Array) {
    value.fill(0)
    return
  }
  if (typeof value !== 'object' || value === null || seen.has(value)) return
  seen.add(value)
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (descriptor && 'value' in descriptor) zeroBytes(descriptor.value, seen)
  }
}

function fixtureDependencies(overrides: Partial<DexSolanaProgramStateWitnessDependencies> = {}) {
  const rawBytes: Uint8Array[] = []
  const capture = jest.fn(
    async (
      _programId: string,
      opts: SolanaEvidenceRpcOpts
    ): Promise<SolanaV3ProgramDeploymentRawCapture> => {
      const bytes = Uint8Array.of(1, 2, 3)
      rawBytes.push(bytes)
      return rawCapture(endpointFromOpts(opts), bytes)
    }
  )
  const compile = jest.fn(() => safeEvidence())
  const parseEvidence = jest.fn((value: unknown) => value as DexSolanaV3CurrentProgramStateEvidence)
  const disposeCapture = jest.fn((capture: SolanaV3ProgramDeploymentRawCapture) =>
    zeroBytes(capture)
  )
  const disposeCompilerInput = jest.fn((input: unknown) => zeroBytes(input))
  const dependencies: DexSolanaProgramStateWitnessDependencies = {
    now: () => new Date(GENERATED_AT),
    capture,
    compile,
    parseEvidence,
    disposeCapture,
    disposeCompilerInput,
    ...overrides,
  }
  return {
    dependencies,
    capture,
    compile,
    parseEvidence,
    disposeCapture,
    disposeCompilerInput,
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

describe('Solana current program-state witness CLI', () => {
  it('captures only the fixed roots, clears raw bytes, and emits closed metadata', async () => {
    const fixture = fixtureDependencies()
    const output = fixtureIo()
    output.io.writeStdout = (line: string) => {
      expect(fixture.rawBytes).toHaveLength(2)
      expect(fixture.rawBytes.every((bytes) => bytes.every((byte) => byte === 0))).toBe(true)
      output.stdout.push(line)
    }

    const exitCode = await runDexSolanaProgramStateWitnessCli(
      ['--protocol', DEX_SOLANA_PROGRAM_STATE_WITNESS_PROTOCOL_ID],
      output.io,
      fixture.dependencies
    )

    expect(exitCode).toBe(DEX_SOLANA_PROGRAM_STATE_WITNESS_EXIT_CODES.SUCCESS)
    expect(output.stderr).toEqual([])
    expect(output.stdout).toHaveLength(1)
    expect(output.stdout[0].endsWith('\n')).toBe(true)
    expect(output.stdout[0]).not.toMatch(/https?:\/\//)
    expect(output.stdout[0]).not.toMatch(/"(?:body|bytes|headers|rpc_url|url)"/)
    expect(JSON.parse(output.stdout[0])).toEqual(safeEvidence())
    expect(fixture.capture.mock.calls).toEqual([
      [
        DEX_SOLANA_PROGRAM_STATE_WITNESS_PROGRAM_ID,
        {
          endpointId: 'publicnode_solana_mainnet',
          rpcUrl: 'https://solana-rpc.publicnode.com/',
        },
      ],
      [
        DEX_SOLANA_PROGRAM_STATE_WITNESS_PROGRAM_ID,
        {
          endpointId: 'solana_official_mainnet',
          rpcUrl: 'https://api.mainnet-beta.solana.com/',
        },
      ],
    ])
    expect(fixture.compile).toHaveBeenCalledTimes(1)
    expect(fixture.compile.mock.calls[0][0]).toMatchObject({
      generated_at: GENERATED_AT,
      captures: [
        { endpointId: 'publicnode_solana_mainnet' },
        { endpointId: 'solana_official_mainnet' },
      ],
    })
    expect(fixture.parseEvidence).toHaveBeenCalledTimes(2)
    expect(fixture.disposeCompilerInput).toHaveBeenCalledTimes(1)
    expect(fixture.rawBytes.every((bytes) => bytes.every((byte) => byte === 0))).toBe(true)
  })

  it('preserves canonical endpoint order when the official source completes first', async () => {
    let releasePublicNode: ((capture: SolanaV3ProgramDeploymentRawCapture) => void) | undefined
    const publicBytes = Uint8Array.of(7)
    const officialBytes = Uint8Array.of(8)
    const publicCapture = new Promise<SolanaV3ProgramDeploymentRawCapture>((resolve) => {
      releasePublicNode = resolve
    })
    const fixture = fixtureDependencies({
      capture: jest.fn(async (_programId, opts) => {
        const endpointId = endpointFromOpts(opts)
        return endpointId === 'publicnode_solana_mainnet'
          ? publicCapture
          : rawCapture(endpointId, officialBytes)
      }),
    })
    const output = fixtureIo()
    const running = runDexSolanaProgramStateWitnessCli(
      ['--protocol', DEX_SOLANA_PROGRAM_STATE_WITNESS_PROTOCOL_ID],
      output.io,
      fixture.dependencies
    )

    await Promise.resolve()
    releasePublicNode?.(rawCapture('publicnode_solana_mainnet', publicBytes))
    expect(await running).toBe(DEX_SOLANA_PROGRAM_STATE_WITNESS_EXIT_CODES.SUCCESS)
    expect(fixture.compile.mock.calls[0][0].captures).toMatchObject([
      { endpointId: 'publicnode_solana_mainnet' },
      { endpointId: 'solana_official_mainnet' },
    ])
    expect([...publicBytes, ...officialBytes].every((byte) => byte === 0)).toBe(true)
  })

  it.each([
    [],
    ['--protocol'],
    ['--protocol', 'raydium_amm_v4'],
    ['--protocol', DEX_SOLANA_PROGRAM_STATE_WITNESS_PROTOCOL_ID, '--extra'],
    ['--program-id', DEX_SOLANA_PROGRAM_STATE_WITNESS_PROGRAM_ID],
  ])('rejects invalid arguments before any network attempt: %p', async (...args) => {
    const fixture = fixtureDependencies()
    const output = fixtureIo()

    const exitCode = await runDexSolanaProgramStateWitnessCli(args, output.io, fixture.dependencies)

    expect(exitCode).toBe(DEX_SOLANA_PROGRAM_STATE_WITNESS_EXIT_CODES.INVALID_ARGUMENTS)
    expect(output.stdout).toEqual([])
    expect(output.stderr).toEqual(['program_state_witness_invalid_arguments\n'])
    expect(fixture.capture).not.toHaveBeenCalled()
    expect(fixture.compile).not.toHaveBeenCalled()
  })

  it('waits for both sources and clears the fulfilled capture when its peer fails', async () => {
    const publicBytes = Uint8Array.of(9, 10)
    const fixture = fixtureDependencies({
      capture: jest.fn(async (_programId, opts) => {
        const endpointId = endpointFromOpts(opts)
        if (endpointId === 'solana_official_mainnet') {
          throw new Error(`private provider failure: ${opts.rpcUrl}`)
        }
        return rawCapture(endpointId, publicBytes)
      }),
    })
    const output = fixtureIo()

    const exitCode = await runDexSolanaProgramStateWitnessCli(
      ['--protocol', DEX_SOLANA_PROGRAM_STATE_WITNESS_PROTOCOL_ID],
      output.io,
      fixture.dependencies
    )

    expect(exitCode).toBe(DEX_SOLANA_PROGRAM_STATE_WITNESS_EXIT_CODES.WITNESS_REJECTED)
    expect(output.stdout).toEqual([])
    expect(output.stderr).toEqual(['program_state_witness_rejected\n'])
    expect(fixture.compile).not.toHaveBeenCalled()
    expect(publicBytes.every((byte) => byte === 0)).toBe(true)
    expect(JSON.stringify(output)).not.toContain('private provider failure')
    expect(JSON.stringify(output)).not.toContain('publicnode')
  })

  it('contains a synchronous source throw and still waits for and clears its peer', async () => {
    let releasePublicNode: ((capture: SolanaV3ProgramDeploymentRawCapture) => void) | undefined
    const publicBytes = Uint8Array.of(11, 12)
    const publicCapture = new Promise<SolanaV3ProgramDeploymentRawCapture>((resolve) => {
      releasePublicNode = resolve
    })
    const fixture = fixtureDependencies({
      capture: jest.fn((_programId, opts) => {
        const endpointId = endpointFromOpts(opts)
        if (endpointId === 'solana_official_mainnet') {
          throw new Error('synchronous private provider failure')
        }
        return publicCapture
      }),
    })
    const output = fixtureIo()
    const running = runDexSolanaProgramStateWitnessCli(
      ['--protocol', DEX_SOLANA_PROGRAM_STATE_WITNESS_PROTOCOL_ID],
      output.io,
      fixture.dependencies
    )

    await Promise.resolve()
    await Promise.resolve()
    releasePublicNode?.(rawCapture('publicnode_solana_mainnet', publicBytes))

    expect(await running).toBe(DEX_SOLANA_PROGRAM_STATE_WITNESS_EXIT_CODES.WITNESS_REJECTED)
    expect(output.stdout).toEqual([])
    expect(output.stderr).toEqual(['program_state_witness_rejected\n'])
    expect(publicBytes.every((byte) => byte === 0)).toBe(true)
  })

  it('clears both captures and emits no document when compilation rejects', async () => {
    const fixture = fixtureDependencies({
      compile: jest.fn(() => {
        throw new Error('sources disagree')
      }),
    })
    const output = fixtureIo()

    const exitCode = await runDexSolanaProgramStateWitnessCli(
      ['--protocol', DEX_SOLANA_PROGRAM_STATE_WITNESS_PROTOCOL_ID],
      output.io,
      fixture.dependencies
    )

    expect(exitCode).toBe(DEX_SOLANA_PROGRAM_STATE_WITNESS_EXIT_CODES.WITNESS_REJECTED)
    expect(output.stdout).toEqual([])
    expect(output.stderr).toEqual(['program_state_witness_rejected\n'])
    expect(fixture.rawBytes.every((bytes) => bytes.every((byte) => byte === 0))).toBe(true)
  })

  it('publishes nothing when the pre-stdout destructive cleanup reports failure', async () => {
    const fixture = fixtureDependencies({
      disposeCompilerInput: jest.fn(() => {
        throw new Error('cleanup verification failed')
      }),
    })
    const output = fixtureIo()

    expect(
      await runDexSolanaProgramStateWitnessCli(
        ['--protocol', DEX_SOLANA_PROGRAM_STATE_WITNESS_PROTOCOL_ID],
        output.io,
        fixture.dependencies
      )
    ).toBe(DEX_SOLANA_PROGRAM_STATE_WITNESS_EXIT_CODES.WITNESS_REJECTED)
    expect(output.stdout).toEqual([])
    expect(output.stderr).toEqual(['program_state_witness_rejected\n'])
    expect(fixture.rawBytes.every((bytes) => bytes.every((byte) => byte === 0))).toBe(true)
  })

  it('rejects a downstream authorization regression before stdout', async () => {
    const unsafe = safeEvidence()
    unsafe.authorization.score = true
    const fixture = fixtureDependencies({
      compile: jest.fn(() => unsafe),
    })
    const output = fixtureIo()

    expect(
      await runDexSolanaProgramStateWitnessCli(
        ['--protocol', DEX_SOLANA_PROGRAM_STATE_WITNESS_PROTOCOL_ID],
        output.io,
        fixture.dependencies
      )
    ).toBe(DEX_SOLANA_PROGRAM_STATE_WITNESS_EXIT_CODES.WITNESS_REJECTED)
    expect(output.stdout).toEqual([])
    expect(output.stderr).toEqual(['program_state_witness_rejected\n'])
  })

  it('rejects a different program, endpoint order, or generated time before stdout', async () => {
    for (const mutate of [
      (evidence: DexSolanaV3CurrentProgramStateEvidence) => {
        evidence.program_id = '11111111111111111111111111111111'
      },
      (evidence: DexSolanaV3CurrentProgramStateEvidence) => {
        ;[evidence.captures[0], evidence.captures[1]] = [evidence.captures[1], evidence.captures[0]]
      },
      (evidence: DexSolanaV3CurrentProgramStateEvidence) => {
        evidence.generated_at = '2026-07-18T23:35:10.485Z'
      },
    ]) {
      const unsafe = safeEvidence()
      mutate(unsafe)
      const fixture = fixtureDependencies({ compile: jest.fn(() => unsafe) })
      const output = fixtureIo()

      expect(
        await runDexSolanaProgramStateWitnessCli(
          ['--protocol', DEX_SOLANA_PROGRAM_STATE_WITNESS_PROTOCOL_ID],
          output.io,
          fixture.dependencies
        )
      ).toBe(DEX_SOLANA_PROGRAM_STATE_WITNESS_EXIT_CODES.WITNESS_REJECTED)
      expect(output.stdout).toEqual([])
    }
  })

  it('rejects an invalid clock after capture and still clears every raw byte', async () => {
    const fixture = fixtureDependencies({
      now: () => new Date(Number.NaN),
    })
    const output = fixtureIo()

    expect(
      await runDexSolanaProgramStateWitnessCli(
        ['--protocol', DEX_SOLANA_PROGRAM_STATE_WITNESS_PROTOCOL_ID],
        output.io,
        fixture.dependencies
      )
    ).toBe(DEX_SOLANA_PROGRAM_STATE_WITNESS_EXIT_CODES.WITNESS_REJECTED)
    expect(output.stdout).toEqual([])
    expect(output.stderr).toEqual(['program_state_witness_rejected\n'])
    expect(fixture.rawBytes.every((bytes) => bytes.every((byte) => byte === 0))).toBe(true)
  })

  it('rejects a serializer/parser closure drift before stdout', async () => {
    let parseCall = 0
    const fixture = fixtureDependencies({
      parseEvidence: jest.fn((value: unknown) => {
        parseCall += 1
        const evidence = value as DexSolanaV3CurrentProgramStateEvidence
        return parseCall === 1
          ? evidence
          : ({ ...evidence, current_state_sha256: '2'.repeat(64) } as typeof evidence)
      }),
    })
    const output = fixtureIo()

    expect(
      await runDexSolanaProgramStateWitnessCli(
        ['--protocol', DEX_SOLANA_PROGRAM_STATE_WITNESS_PROTOCOL_ID],
        output.io,
        fixture.dependencies
      )
    ).toBe(DEX_SOLANA_PROGRAM_STATE_WITNESS_EXIT_CODES.WITNESS_REJECTED)
    expect(output.stdout).toEqual([])
    expect(output.stderr).toEqual(['program_state_witness_rejected\n'])
  })
})
