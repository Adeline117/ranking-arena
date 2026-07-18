import { spawn } from 'node:child_process'
import { resolve } from 'node:path'

interface WrapperResult {
  exitCode: number | null
  stdout: string
  stderr: string
}

function run(command: string): Promise<WrapperResult> {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn('bash', ['-o', 'pipefail', '-c', command], {
      cwd: resolve('.'),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
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

describe('Solana Jupiter witness process boundary', () => {
  it('returns a fixed argument error without stdout, stack, or local path', async () => {
    const result = await run('node_modules/.bin/tsx scripts/dex-solana-jupiter-witness.mts')

    expect(result).toEqual({
      exitCode: 64,
      stdout: '',
      stderr: 'jupiter_witness_invalid_arguments\n',
    })
  })

  it('keeps exit 70 when stdout was closed before startup and does no network work', async () => {
    const result = await run(
      'exec 1>&-; node_modules/.bin/tsx scripts/dex-solana-jupiter-witness.mts'
    )

    expect(result).toEqual({ exitCode: 70, stdout: '', stderr: '' })
  })

  it('handles a closed stderr pipe without EPIPE, a stack, or an uncontrolled exit', async () => {
    const result = await run(
      '{ node_modules/.bin/tsx scripts/dex-solana-jupiter-witness.mts; } 2>&1 | dd bs=1 count=0 2>/dev/null'
    )

    expect(result).toEqual({ exitCode: 70, stdout: '', stderr: '' })
  })
})
