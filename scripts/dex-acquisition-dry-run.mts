import { fstatSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import {
  formatDexAcquisitionDryRunInternalError,
  runDexAcquisitionDryRunCli,
} from './lib/dex-acquisition-dry-run'

const isDirectRun =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href

if (isDirectRun) {
  let stdoutFailed = false
  // stdout failures (notably EPIPE from a closed downstream pipe) arrive as
  // asynchronous events, not Promise rejections. Ignore the error object so
  // Node cannot print its message, stack, or local path; a broken output
  // channel cannot provide the JSON report and therefore exits fail-closed.
  process.stdout.on('error', () => {
    stdoutFailed = true
    process.exitCode = 70
  })

  try {
    const stdoutStats = fstatSync(process.stdout.fd)
    // Node replaces a stdout descriptor that was already closed before
    // startup with a non-TTY character-device sink (for example /dev/null).
    // Treat that sink as unavailable because no caller can receive the report.
    if (stdoutStats.isCharacterDevice() && process.stdout.isTTY !== true) {
      stdoutFailed = true
      process.exitCode = 70
    }
  } catch {
    stdoutFailed = true
    process.exitCode = 70
  }

  if (!stdoutFailed) {
    void runDexAcquisitionDryRunCli(process.argv.slice(2), {
      writeStdout: (line) => {
        process.stdout.write(line, (error) => {
          if (error) {
            stdoutFailed = true
            process.exitCode = 70
          }
        })
      },
    })
      .then((exitCode) => {
        if (!stdoutFailed) process.exitCode = exitCode
      })
      .catch(() => {
        process.exitCode = 70
        try {
          process.stdout.write(formatDexAcquisitionDryRunInternalError())
        } catch {
          // A broken stdout cannot satisfy the one-line output contract.
        }
      })
  }
}
