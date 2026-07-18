#!/usr/bin/env node
/* eslint-disable no-console -- acceptance CLI intentionally streams each probe's verdict */
/**
 * Serving acceptance — the single end-to-end gate for the rebuilt data layer.
 *
 * WHY (the lesson of 2026-06-12): "unit tests green" repeatedly hid
 * user-visible breakage — empty charts, dormant pages that looked broken,
 * 404 logos, sources active-but-invisible. Three complementary probes now
 * exist; this runs all three and fails if ANY does, so "did the rebuild
 * actually work for users" is one command, not a memory of which scripts
 * to run.
 *
 *   npm run qa:serving            # all three against production
 *   npm run qa:serving -- <url>   # against a base URL
 *
 * Layers:
 *   1. pipeline-coverage-audit  — data flowed AND reached the read path
 *      (per-window snapshots, scored rows, current count cache, series) — DB-level.
 *   2. ingest-shadow-diff       — active serving registry, score-visible rows,
 *      API identity/filtering, and current leaderboard counts agree.
 *   3. serving-profiles-e2e     — real browser render per serving source
 *      (HTTP, i18n leaks, console errors, empty/dormant states).
 *
 * Coverage/series gaps (LOW-SERIES) are reported but do NOT fail the gate
 * on their own — they grow over crawl cycles and have a dedicated backfill;
 * hard failures are render breakage, diff mismatch, and missing snapshots.
 */
import { spawn } from 'node:child_process'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..', '..')
const baseUrl = process.argv[2]

function run(label, file, args = []) {
  return new Promise((res) => {
    console.log(`\n${'═'.repeat(60)}\n▶ ${label}\n${'═'.repeat(60)}`)
    // .ts probes run through tsx; .mjs through node.
    const path = resolve(here, file)
    const [cmd, baseArgs] = path.endsWith('.ts') ? ['npx', ['tsx', path]] : ['node', [path]]
    const p = spawn(cmd, [...baseArgs, ...args], { cwd: root, stdio: 'inherit' })
    p.on('close', (code) => res({ label, code: code ?? 1 }))
  })
}

const results = []
// 1. coverage audit (DB) — informational on LOW-SERIES, fails on real breaks
results.push(await run('1/3 Pipeline coverage audit', 'pipeline-coverage-audit.mjs', ['--soft']))
// 2. canonical ranking/count-cache diff (DB; legacy filename kept for operators)
results.push(await run('2/3 Serving rank/cache diff', '../ingest-shadow-diff.ts'))
// 3. real-browser render
results.push(
  await run('3/3 Serving profile render', 'serving-profiles-e2e.mjs', baseUrl ? [baseUrl] : [])
)

console.log(`\n${'═'.repeat(60)}\nACCEPTANCE SUMMARY\n${'═'.repeat(60)}`)
let hardFail = 0
for (const r of results) {
  const ok = r.code === 0
  if (!ok) hardFail++
  console.log(`${ok ? '✅' : '❌'} ${r.label} (exit ${r.code})`)
}
console.log(
  hardFail === 0
    ? '\n✅ Serving layer acceptance PASSED'
    : `\n❌ ${hardFail}/3 acceptance probes failed`
)
process.exit(hardFail ? 1 : 0)
