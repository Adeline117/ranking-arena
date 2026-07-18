import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

const mockVerifyConsistency = jest.fn()
jest.mock('../lib/dex-acquisition-binding', () => {
  const actual = jest.requireActual<typeof import('../lib/dex-acquisition-binding')>(
    '../lib/dex-acquisition-binding'
  )
  return {
    ...actual,
    verifyDexAcquisitionManifestTranscriptConsistency: (...args: unknown[]) =>
      mockVerifyConsistency(...args),
  }
})

import { runDexAcquisitionDryRun } from '../lib/dex-acquisition-dry-run'
import {
  makeDexAcquisitionPairFixture,
  makeDexPairParentFixture,
} from '../test-helpers/dex-acquisition-pair-fixture'

describe('DEX acquisition dry-run internal error boundary', () => {
  let rootPath: string

  beforeEach(async () => {
    rootPath = await mkdtemp(join(tmpdir(), 'arena-dex-dry-run-internal-'))
  })

  afterEach(async () => {
    await rm(rootPath, { recursive: true, force: true })
    mockVerifyConsistency.mockReset()
  })

  async function write(relativePath: string, value: unknown): Promise<void> {
    const filePath = join(rootPath, relativePath)
    await mkdir(dirname(filePath), { recursive: true })
    await writeFile(filePath, `${JSON.stringify(value)}\n`, 'utf8')
  }

  it('maps an implementation TypeError to a sanitized internal failure', async () => {
    const marker = 'internal-verifier-secret'
    const pair = makeDexAcquisitionPairFixture()
    await write('parent.json', makeDexPairParentFixture())
    await write('manifest.json', pair.manifest)
    await write('transcript.json', pair.transcript)
    mockVerifyConsistency.mockImplementation(() => {
      throw new TypeError(marker)
    })

    const result = await runDexAcquisitionDryRun({
      rootPath,
      parentSnapshotPath: 'parent.json',
      runManifestPath: 'manifest.json',
      transcriptPath: 'transcript.json',
    })
    const serialized = JSON.stringify(result.report)

    expect(mockVerifyConsistency).toHaveBeenCalledTimes(1)
    expect(result.exitCode).toBe(70)
    expect(result.report).toMatchObject({
      status: 'rejected',
      gate_state: 'blocked',
      exit_code: 70,
      stage: 'internal',
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
        code: 'INTERNAL_ERROR',
        document_role: null,
      },
    })
    expect(serialized).not.toContain(marker)
    expect(serialized).not.toContain(rootPath)
    expect(serialized).not.toMatch(/TypeError|stack|cause/)
  })
})
