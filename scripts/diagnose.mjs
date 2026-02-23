#!/usr/bin/env node
/**
 * Unified diagnostics entrypoint.
 *
 * Usage:
 *   node scripts/diagnose.mjs                # run all checks
 *   node scripts/diagnose.mjs --all          # run all checks
 *   node scripts/diagnose.mjs --seasons
 *   node scripts/diagnose.mjs --status
 *   node scripts/diagnose.mjs --freshness
 *   node scripts/diagnose.mjs --platforms
 *   node scripts/diagnose.mjs --tables
 *   node scripts/diagnose.mjs --enrichment
 */

import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))

const tasks = {
  seasons: [resolve(__dirname, 'import/check_seasons.mjs')],
  status: [resolve(__dirname, 'import/check_status.mjs')],
  freshness: [resolve(__dirname, 'check-freshness.mjs'), '--basic'],
  platforms: [resolve(__dirname, 'check-freshness.mjs'), '--platform'],
  tables: [resolve(__dirname, 'check_tables.mjs')],
  enrichment: [resolve(__dirname, 'check_enrichment.mjs')],
}

function runNodeTask(name, [scriptPath, ...args]) {
  console.log(`\n>>> ${name} <<<`)
  const res = spawnSync(process.execPath, [scriptPath, ...args], {
    stdio: 'inherit',
    env: process.env,
  })
  return res.status ?? 1
}

function parseFlags(argv) {
  const flags = new Set(argv)
  const selected = Object.keys(tasks).filter((k) => flags.has(`--${k}`))
  const runAll = flags.has('--all') || selected.length === 0
  return runAll ? Object.keys(tasks) : selected
}

const selectedTasks = parseFlags(process.argv.slice(2))
let failed = false

for (const key of selectedTasks) {
  const code = runNodeTask(key, tasks[key])
  if (code !== 0) {
    failed = true
    console.error(`\n[diagnose] ${key} failed with exit code ${code}`)
  }
}

if (failed) process.exit(1)
