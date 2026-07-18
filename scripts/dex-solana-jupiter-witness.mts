/**
 * Build one explicit-signature, dual-public-RPC Jupiter v6 manifest-program-hit witness.
 *
 * Direct usage keeps stdout machine-readable:
 *   npx tsx scripts/dex-solana-jupiter-witness.mts --signature <base58-signature>
 * or:
 *   npm run --silent dex:solana:jupiter-witness -- --signature <base58-signature>
 *
 * The command never accepts arbitrary RPC URLs, manifests, or protocols. Its
 * JSON is metadata-only and keeps decoder/serving/rank/score authorization
 * closed. A successful result is not a golden-wallet assignment, population
 * sample, protocol identity proof, or decoded swap fact.
 */
import { fstatSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import {
  DEX_SOLANA_JUPITER_WITNESS_EXIT_CODES,
  runDexSolanaJupiterWitnessCli,
} from './lib/dex-solana-jupiter-witness'

const isDirectRun =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href

if (isDirectRun) {
  let stdoutFailed = false
  let stderrFailed = false
  process.stdout.on('error', () => {
    stdoutFailed = true
    process.exitCode = DEX_SOLANA_JUPITER_WITNESS_EXIT_CODES.OUTPUT_UNAVAILABLE
  })
  process.stderr.on('error', () => {
    stderrFailed = true
    process.exitCode = DEX_SOLANA_JUPITER_WITNESS_EXIT_CODES.OUTPUT_UNAVAILABLE
  })

  try {
    const stdoutStats = fstatSync(process.stdout.fd)
    if (stdoutStats.isCharacterDevice() && process.stdout.isTTY !== true) {
      stdoutFailed = true
      process.exitCode = DEX_SOLANA_JUPITER_WITNESS_EXIT_CODES.OUTPUT_UNAVAILABLE
    }
  } catch {
    stdoutFailed = true
    process.exitCode = DEX_SOLANA_JUPITER_WITNESS_EXIT_CODES.OUTPUT_UNAVAILABLE
  }

  if (!stdoutFailed) {
    void runDexSolanaJupiterWitnessCli(process.argv.slice(2), {
      writeStdout: (line) => {
        process.stdout.write(line, (error) => {
          if (error) {
            stdoutFailed = true
            process.exitCode = DEX_SOLANA_JUPITER_WITNESS_EXIT_CODES.OUTPUT_UNAVAILABLE
          }
        })
      },
      writeStderr: (line) => {
        process.stderr.write(line, (error) => {
          if (error) {
            stderrFailed = true
            process.exitCode = DEX_SOLANA_JUPITER_WITNESS_EXIT_CODES.OUTPUT_UNAVAILABLE
          }
        })
      },
    })
      .then((exitCode) => {
        if (!stdoutFailed && !stderrFailed) process.exitCode = exitCode
      })
      .catch(() => {
        process.exitCode = DEX_SOLANA_JUPITER_WITNESS_EXIT_CODES.OUTPUT_UNAVAILABLE
        try {
          if (stderrFailed) return
          process.stderr.write('jupiter_witness_internal_error\n')
        } catch {
          // A broken diagnostic channel cannot provide a safe failure reason.
        }
      })
  }
}
