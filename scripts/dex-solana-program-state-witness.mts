/**
 * Build a metadata-only, dual-public-RPC current-state witness for Jupiter v6.
 *
 * Usage:
 *   npm run --silent dex:solana:program-state-witness -- --protocol jupiter_swap_v6
 *
 * The command accepts no RPC URL or arbitrary program input. It emits no raw
 * request/response body and grants no decoder, serving, rank, or score access.
 */
import { fstatSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import {
  DEX_SOLANA_PROGRAM_STATE_WITNESS_EXIT_CODES,
  runDexSolanaProgramStateWitnessCli,
} from './lib/dex-solana-program-state-witness'

const isDirectRun =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href

if (isDirectRun) {
  let stdoutFailed = false
  let stderrFailed = false
  process.stdout.on('error', () => {
    stdoutFailed = true
    process.exitCode = DEX_SOLANA_PROGRAM_STATE_WITNESS_EXIT_CODES.OUTPUT_UNAVAILABLE
  })
  process.stderr.on('error', () => {
    stderrFailed = true
    process.exitCode = DEX_SOLANA_PROGRAM_STATE_WITNESS_EXIT_CODES.OUTPUT_UNAVAILABLE
  })

  try {
    const stdoutStats = fstatSync(process.stdout.fd)
    if (stdoutStats.isCharacterDevice() && process.stdout.isTTY !== true) {
      stdoutFailed = true
      process.exitCode = DEX_SOLANA_PROGRAM_STATE_WITNESS_EXIT_CODES.OUTPUT_UNAVAILABLE
    }
  } catch {
    stdoutFailed = true
    process.exitCode = DEX_SOLANA_PROGRAM_STATE_WITNESS_EXIT_CODES.OUTPUT_UNAVAILABLE
  }

  if (!stdoutFailed) {
    void runDexSolanaProgramStateWitnessCli(process.argv.slice(2), {
      writeStdout: (line) => {
        process.stdout.write(line, (error) => {
          if (error) {
            stdoutFailed = true
            process.exitCode = DEX_SOLANA_PROGRAM_STATE_WITNESS_EXIT_CODES.OUTPUT_UNAVAILABLE
          }
        })
      },
      writeStderr: (line) => {
        process.stderr.write(line, (error) => {
          if (error) {
            stderrFailed = true
            process.exitCode = DEX_SOLANA_PROGRAM_STATE_WITNESS_EXIT_CODES.OUTPUT_UNAVAILABLE
          }
        })
      },
    })
      .then((exitCode) => {
        if (!stdoutFailed && !stderrFailed) process.exitCode = exitCode
      })
      .catch(() => {
        process.exitCode = DEX_SOLANA_PROGRAM_STATE_WITNESS_EXIT_CODES.OUTPUT_UNAVAILABLE
        try {
          if (stderrFailed) return
          process.stderr.write('program_state_witness_internal_error\n')
        } catch {
          // A broken diagnostic channel cannot provide a safe failure reason.
        }
      })
  }
}
