#!/usr/bin/env node
/**
 * Unified diagnostics entrypoint.
 *
 * Usage:
 *   node scripts/diagnose.mjs                # run all checks
 *   node scripts/diagnose.mjs --all          # run all checks
 *   node scripts/diagnose.mjs --status
 *   node scripts/diagnose.mjs --freshness
 *   node scripts/diagnose.mjs --platforms
 */

import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))

const CHECK_STATUS_PATH = resolve(__dirname, 'check_status.mjs')
const SECTIONS = ['status', 'freshness', 'platforms']

function parseArgs(argv) {
  const supported = new Set(['--all', ...SECTIONS.map((section) => `--${section}`)])
  const unsupported = argv.filter((argument) => !supported.has(argument))
  if (unsupported.length > 0) {
    throw new Error(`unsupported diagnostic option(s): ${unsupported.join(', ')}`)
  }

  const selected = SECTIONS.filter((section) => argv.includes(`--${section}`))
  return argv.includes('--all') || selected.length === 0
    ? ['--all']
    : selected.map((section) => `--${section}`)
}

function runCanonicalDiagnostics(args) {
  const result = spawnSync(process.execPath, [CHECK_STATUS_PATH, ...args], {
    stdio: 'inherit',
    env: process.env,
  })
  if (result.error) {
    throw result.error
  }
  return result.status ?? 1
}

try {
  const selectedArgs = parseArgs(process.argv.slice(2))
  const exitCode = runCanonicalDiagnostics(selectedArgs)
  if (exitCode !== 0) {
    console.error(`\n[diagnose] canonical diagnostics failed with exit code ${exitCode}`)
  }
  process.exitCode = exitCode
} catch (error) {
  console.error(`[diagnose] ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
}
